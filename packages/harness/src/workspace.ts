/**
 * Confined local workspace: read, list, search, write, edit, and shell.
 * Ports the original prototype's coding-tools module (removed 2026-11-04; see
 * git history).
 *
 * Every tool method enforces the same guarantees before touching disk:
 *
 * - **Root confinement** — the workspace root is resolved once; every target
 *   path is resolved against it and must stay inside (after symlink
 *   resolution), so `..` traversal and symlink escapes are refused.
 * - **Sensitive-file refusal** — dotfiles such as `.env`, key material
 *   (`*.pem`, `*.key`, `id_rsa`...), and VCS internals (`.git/`) are refused
 *   before any permission check, for reads as well as writes.
 * - **Central permissions** — read-only actions auto-allow; writes, edits,
 *   deletes, and shell commands go through `PermissionManager`
 *   (policy + approval broker). Fail closed: no broker means denial.
 * - **Serialized mutations** — write/edit/delete of one resolved path share
 *   a per-path promise queue (call order); reads never take the queue, so
 *   concurrent tool calls cannot interleave a file's read-modify-write.
 * - **Structured results** — every call returns a JSON-serializable object
 *   with a stable shape (tool/status/path/error/diff/...), ready to be
 *   appended to the JSONL session or streamed over SSE.
 *
 * All methods are async so a cooperation loop can await an operator's
 * approval mid-run.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import {
  Action,
  APPROVAL_DETAIL_MAX_CHARS,
  PermissionDenied,
  PermissionManager,
  type ApprovalDetail,
  type ApprovalRequest,
} from "./permissions.ts";
import { ShellRunner } from "./shell.ts";
import { boundOutput, resultSize } from "./output.ts";
import type { Tool } from "./provider.ts";

/** read_file content cap: head+tail window via `boundOutput`. */
export const DEFAULT_MAX_CHARS = 20_000;
/** read_file range mode: default page size in lines. */
export const DEFAULT_READ_LINES = 2_000;
/** read_file range mode: largest line window a model-supplied `limit` is clamped to. */
export const MAX_READ_LINES = 5_000;
/** search_text aggregate cap over the serialized match list. */
export const MAX_SEARCH_RESULT_CHARS = 20_000;
/** list_dir entry cap; the result carries `truncated` beyond it. */
export const MAX_LIST_ENTRIES = 400;
export const DEFAULT_MAX_MATCHES = 50;
export const DIFF_CONTEXT_LINES = 3;
/** run_shell timeout ceiling for model-supplied values (the default stays 30 s). */
export const MAX_SHELL_TIMEOUT_S = 600;
/** run_shell timeout floor: a non-positive value means "run without a timer". */
export const MIN_SHELL_TIMEOUT_S = 1;

/**
 * Operator-facing reasons for the approvals where the operator genuinely lacks
 * a preview. Stable, path- and secret-free English (the request already names
 * its target/path); the web approval card and the TUI approval panel render
 * them as-is. Write/edit approvals stay reason-free: their unified-diff
 * preview is the explanation, so a reason would only add noise.
 */
export const SHELL_APPROVAL_REASON =
  "runs arbitrary shell code inside the workspace — its effects cannot be previewed and may change any file the process can reach";
/** See {@link SHELL_APPROVAL_REASON}; deletion has no undo and no diff read. */
export const DELETE_APPROVAL_REASON =
  "permanently removes the file from the workspace — deletion cannot be undone";

// Refused everywhere, reads included. Patterns are matched against each path
// component (case-insensitively on case-insensitive filesystems).
const SENSITIVE_COMPONENTS = new Set([
  ".env",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".aws",
  ".ssh",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "credentials",
]);
const SENSITIVE_SUFFIXES = [".pem", ".key", ".p12", ".pfx", ".kdbx"];
const SENSITIVE_DIRS = new Set([".git", ".svn", ".hg", "__pycache__"]);

/** Raised for unrecoverable workspace misuse (bad root, I/O failure). */
export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

/** Split a workspace-relative path into components (POSIX or Windows sep). */
function pathParts(rel: string): string[] {
  return rel.split(/[\\/]+/).filter((part) => part.length > 0);
}

/**
 * Return the matched sensitive pattern for `rel`, or null if clean. Ports
 * python's is_sensitive_path; VCS internals match only when they are not the
 * final component (a bare `.git` as the whole target is resolvable, like
 * Python).
 */
export function isSensitivePath(rel: string): string | null {
  const parts = pathParts(rel);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const low = part.toLowerCase();
    if (SENSITIVE_COMPONENTS.has(low)) return part;
    if (SENSITIVE_SUFFIXES.some((suffix) => low.endsWith(suffix))) return part;
    if (low.startsWith(".env.")) return part;
    if (SENSITIVE_DIRS.has(low)) {
      // VCS internals are refused for writes only — see resolve().
      if (i < parts.length - 1 || low !== parts[parts.length - 1].toLowerCase()) {
        return part;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// unified diff — a faithful port of difflib (SequenceMatcher + unified_diff)
// so the output format is byte-compatible with Python's make_diff.
// ---------------------------------------------------------------------------

interface Match {
  ai: number;
  bj: number;
  size: number;
}

type Opcode = [tag: "replace" | "delete" | "insert" | "equal", i1: number, i2: number, j1: number, j2: number];

/**
 * difflib.SequenceMatcher (Ratcliff-Obershelp) without an isjunk predicate
 * and with Python's autojunk heuristic (popular b-elements purged when b has
 * 200+ items).
 */
class SequenceMatcher {
  private readonly a: string[];
  private readonly b: string[];
  private readonly b2j = new Map<string, number[]>();
  private readonly bjunk = new Set<string>();

  constructor(a: string[], b: string[], autojunk = true) {
    this.a = a;
    this.b = b;
    this.b.forEach((elt, i) => {
      const indices = this.b2j.get(elt);
      if (indices) indices.push(i);
      else this.b2j.set(elt, [i]);
    });
    const n = this.b.length;
    if (autojunk && n >= 200) {
      const nt = Math.floor(n / 100) + 1;
      for (const [elt, idxs] of [...this.b2j.entries()]) {
        if (idxs.length > nt) this.b2j.delete(elt);
      }
    }
  }

  findLongestMatch(alo: number, ahi: number, blo: number, bhi: number): Match {
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map<number, number>();
    const nothing: number[] = [];
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map<number, number>();
      for (const j of this.b2j.get(this.a[i]) ?? nothing) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
      j2len = newj2len;
    }
    while (
      besti > alo &&
      bestj > blo &&
      !this.bjunk.has(this.b[bestj - 1]) &&
      this.a[besti - 1] === this.b[bestj - 1]
    ) {
      besti -= 1;
      bestj -= 1;
      bestsize += 1;
    }
    while (
      besti + bestsize < ahi &&
      bestj + bestsize < bhi &&
      !this.bjunk.has(this.b[bestj + bestsize]) &&
      this.a[besti + bestsize] === this.b[bestj + bestsize]
    ) {
      bestsize += 1;
    }
    return { ai: besti, bj: bestj, size: bestsize };
  }

  getMatchingBlocks(): Match[] {
    const queue: Array<[number, number, number, number]> = [[0, this.a.length, 0, this.b.length]];
    const matchingBlocks: Match[] = [];
    while (queue.length > 0) {
      const [alo, ahi, blo, bhi] = queue.pop() as [number, number, number, number];
      const m = this.findLongestMatch(alo, ahi, blo, bhi);
      if (m.size > 0) {
        matchingBlocks.push(m);
        if (alo < m.ai && blo < m.bj) queue.push([alo, m.ai, blo, m.bj]);
        if (m.ai + m.size < ahi && m.bj + m.size < bhi) {
          queue.push([m.ai + m.size, ahi, m.bj + m.size, bhi]);
        }
      }
    }
    matchingBlocks.sort((x, y) => x.ai - y.ai);
    // sentinel, then collapse adjacent blocks
    matchingBlocks.push({ ai: this.a.length, bj: this.b.length, size: 0 });
    const nonAdjacent: Match[] = [];
    let i = 0;
    let j = 0;
    let k = 0;
    for (const m of matchingBlocks) {
      if (k > 0 && m.ai === i + k && m.bj === j + k) {
        k += m.size;
        continue;
      }
      if (k > 0) nonAdjacent.push({ ai: i, bj: j, size: k });
      i = m.ai;
      j = m.bj;
      k = m.size;
    }
    if (k > 0) nonAdjacent.push({ ai: i, bj: j, size: k });
    return nonAdjacent;
  }

  getOpcodes(): Opcode[] {
    const opcodes: Opcode[] = [];
    let i = 0;
    let j = 0;
    for (const m of this.getMatchingBlocks()) {
      let tag: Opcode[0] | null = null;
      if (i < m.ai && j < m.bj) tag = "replace";
      else if (i < m.ai) tag = "delete";
      else if (j < m.bj) tag = "insert";
      if (tag !== null) opcodes.push([tag, i, m.ai, j, m.bj]);
      opcodes.push(["equal", m.ai, m.ai + m.size, m.bj, m.bj + m.size]);
      i = m.ai + m.size;
      j = m.bj + m.size;
    }
    const la = this.a.length;
    const lb = this.b.length;
    if (i < la || j < lb) {
      const tag: Opcode[0] =
        i < la && j < lb ? "replace" : i < la ? "delete" : "insert";
      opcodes.push([tag, i, la, j, lb]);
    }
    return opcodes;
  }

  getGroupedOpcodes(n: number): Opcode[][] {
    let codes = this.getOpcodes();
    if (codes.length === 0) codes = [["equal", 0, 1, 0, 1]];
    if (codes[0][0] === "equal") {
      const c = codes[0];
      codes[0] = ["equal", Math.max(c[1], c[2] - n), c[2], Math.max(c[3], c[4] - n), c[4]];
    }
    const last = codes[codes.length - 1];
    if (last[0] === "equal") {
      codes[codes.length - 1] = ["equal", last[1], Math.min(last[2], last[1] + n), last[3], Math.min(last[4], last[3] + n)];
    }
    const nn = n + n;
    const groups: Opcode[][] = [];
    let group: Opcode[] = [];
    for (let [tag, i1, i2, j1, j2] of codes) {
      // Finish the current group and start a new one whenever there is a
      // large range with no changes.
      if (tag === "equal" && i2 - i1 > nn) {
        group.push(["equal", i1, Math.min(i2, i1 + n), j1, Math.min(j2, j1 + n)]);
        groups.push(group);
        group = [];
        i1 = Math.max(i1, i2 - n);
        j1 = Math.max(j1, j2 - n);
      }
      group.push([tag, i1, i2, j1, j2]);
    }
    if (group.length > 0 && !(group.length === 1 && group[0][0] === "equal")) {
      groups.push(group);
    }
    return groups;
  }
}

/** difflib._format_range_unified. */
function formatRangeUnified(start: number, stop: number): string {
  let beginning = start + 1; // lines start numbering with one
  const length = stop - start;
  if (length === 1) return `${beginning}`;
  if (length === 0) beginning -= 1; // empty ranges begin just before
  return `${beginning},${length}`;
}

/** str.splitlines(keepends=True) for the line breaks files actually use. */
function splitLinesKeepEnds(text: string): string[] {
  if (text === "") return [];
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n") {
      lines.push(text.slice(start, i + 1));
      start = i + 1;
    } else if (ch === "\r") {
      if (text[i + 1] === "\n") {
        lines.push(text.slice(start, i + 2));
        i += 1;
        start = i + 1;
      } else {
        lines.push(text.slice(start, i + 1));
        start = i + 1;
      }
    }
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

/** difflib.unified_diff as a joined string (headers only when hunks exist). */
function unifiedDiff(aLines: string[], bLines: string[], fromfile: string, tofile: string, n: number): string {
  const out: string[] = [];
  const matcher = new SequenceMatcher(aLines, bLines);
  let started = false;
  for (const group of matcher.getGroupedOpcodes(n)) {
    if (!started) {
      started = true;
      out.push(`--- ${fromfile}\n`, `+++ ${tofile}\n`);
    }
    const first = group[0];
    const last = group[group.length - 1];
    out.push(
      `@@ -${formatRangeUnified(first[1], last[2])} +${formatRangeUnified(first[3], last[4])} @@\n`,
    );
    for (const [tag, i1, i2, j1, j2] of group) {
      if (tag === "equal") {
        for (const line of aLines.slice(i1, i2)) out.push(` ${line}`);
      } else if (tag === "delete") {
        for (const line of aLines.slice(i1, i2)) out.push(`-${line}`);
      } else if (tag === "insert") {
        for (const line of bLines.slice(j1, j2)) out.push(`+${line}`);
      } else {
        for (const line of aLines.slice(i1, i2)) out.push(`-${line}`);
        for (const line of bLines.slice(j1, j2)) out.push(`+${line}`);
      }
    }
  }
  return out.join("");
}

/** A unified diff plus compact metadata, JSON-serializable. */
export interface DiffResult {
  unified: string;
  added_lines: number;
  removed_lines: number;
}

export function makeDiff(relPath: string, oldText: string, newText: string, context = DIFF_CONTEXT_LINES): DiffResult {
  const unified = unifiedDiff(
    splitLinesKeepEnds(oldText),
    splitLinesKeepEnds(newText),
    `a/${relPath}`,
    `b/${relPath}`,
    context,
  );
  let addedLines = 0;
  let removedLines = 0;
  for (const line of unified.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) addedLines += 1;
    if (line.startsWith("-") && !line.startsWith("---")) removedLines += 1;
  }
  return { unified, added_lines: addedLines, removed_lines: removedLines };
}

/** Files above this size are approved by path only (no content preview read). */
const MAX_APPROVAL_PREVIEW_BYTES = 200_000;

/**
 * Bounded operator-preview detail for one pending mutation: the unified diff
 * (as the tool result will carry it) clipped to the shared detail cap. Never
 * throws and never grows the event beyond `APPROVAL_DETAIL_MAX_CHARS`.
 */
function diffDetail(
  kind: string,
  relPath: string,
  oldText: string,
  newText: string,
): ApprovalDetail {
  const diff = makeDiff(relPath, oldText, newText);
  const truncated = diff.unified.length > APPROVAL_DETAIL_MAX_CHARS;
  const body = truncated
    ? diff.unified.slice(0, APPROVAL_DETAIL_MAX_CHARS - 1) + "…"
    : diff.unified;
  return {
    kind,
    diff: body,
    addedLines: diff.added_lines,
    removedLines: diff.removed_lines,
    ...(truncated ? { truncated: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// edit matching — exact first, then pi-style normalized fuzzy tiers
// ---------------------------------------------------------------------------

type LineEnding = "\r\n" | "\n";

/** Line ending used by a file: CRLF when its first break is CRLF. */
function detectLineEnding(text: string): LineEnding {
  const lf = text.indexOf("\n");
  if (lf === -1) return "\n";
  return lf > 0 && text[lf - 1] === "\r" ? "\r\n" : "\n";
}

/** Collapse CRLF/CR breaks to LF before matching (pi's `normalizeToLF`). */
function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Write an edit back in the file's own line ending style. */
function restoreLineEndings(text: string, ending: LineEnding): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/**
 * Fuzzy-matching view of a text, ported from pi's `normalizeForFuzzyMatch`:
 * NFKC, trailing whitespace stripped per line, smart quotes / dashes /
 * special spaces folded to ASCII. Line breaks are untouched, so the view
 * keeps a 1:1 line correspondence with the original.
 */
function normalizeForFuzzyMatch(text: string): string {
  return text
    .normalize("NFKC")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

/** A line of LF-normalized content and its offsets. */
interface TextLine {
  text: string;
  start: number;
  textEnd: number;
  end: number;
}

/** Split LF-normalized content, keeping break offsets (no trailing empty line). */
function splitTextLines(text: string): TextLine[] {
  const lines: TextLine[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "\n") continue;
    lines.push({ text: text.slice(start, i), start, textEnd: i, end: i + 1 });
    start = i + 1;
  }
  if (start < text.length) {
    lines.push({ text: text.slice(start), start, textEnd: text.length, end: text.length });
  }
  return lines;
}

/** Split an edit's old text into lines plus whether it ends with a break. */
function splitEditLines(text: string): { lines: string[]; includeFinalBreak: boolean } {
  const includeFinalBreak = /[\r\n]$/.test(text);
  const lines = text.split(/\r\n|\r|\n/);
  if (includeFinalBreak) lines.pop();
  return { lines, includeFinalBreak };
}

/** Non-overlapping occurrences of `needle` in `haystack`. */
function findTextOccurrences(haystack: string, needle: string): number[] {
  const indexes: number[] = [];
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) return indexes;
    indexes.push(index);
    from = index + needle.length;
  }
}

interface TextReplacement {
  matchIndex: number;
  matchLength: number;
  newText: string;
}

interface LineRange {
  startLine: number;
  endLine: number;
}

/** The line group a replacement touches (pi's `getReplacementLineRange`). */
function replacementLineRange(lines: TextLine[], replacement: TextReplacement): LineRange {
  const start = replacement.matchIndex;
  const end = replacement.matchIndex + replacement.matchLength;
  let startLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (start >= lines[i].start && start < lines[i].end) {
      startLine = i;
      break;
    }
  }
  if (startLine === -1) throw new WorkspaceError("edit range is outside the file");
  let endLine = startLine;
  while (endLine < lines.length && lines[endLine].end < end) endLine++;
  if (endLine >= lines.length) throw new WorkspaceError("edit range is outside the file");
  return { startLine, endLine: endLine + 1 };
}

/** Apply replacements to a slice, last first so offsets stay stable. */
function spliceReplacements(content: string, replacements: TextReplacement[], offset = 0): string {
  let result = content;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const replacement = replacements[i];
    const index = replacement.matchIndex - offset;
    result = result.slice(0, index) + replacement.newText + result.slice(index + replacement.matchLength);
  }
  return result;
}

/** LF content split into lines that keep their breaks. */
function splitLinesWithEndings(content: string): string[] {
  return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

/**
 * Apply replacements matched in a normalized view (`baseContent`) to the
 * original content, rewriting only the line groups they touch — pi's
 * `applyReplacementsPreservingUnchangedLines`. Untouched lines keep their
 * original bytes (trailing spaces included).
 */
function applyReplacementsPreservingUnchangedLines(
  originalContent: string,
  baseContent: string,
  replacements: TextReplacement[],
): string {
  const originalLines = splitLinesWithEndings(originalContent);
  const baseLines = splitTextLines(baseContent);
  if (originalLines.length !== baseLines.length) {
    throw new WorkspaceError("cannot preserve unchanged lines: normalized content has a different line count");
  }

  const groups: Array<LineRange & { replacements: TextReplacement[] }> = [];
  const sorted = [...replacements].sort((a, b) => a.matchIndex - b.matchIndex);
  for (const replacement of sorted) {
    const range = replacementLineRange(baseLines, replacement);
    const current = groups[groups.length - 1];
    if (current && range.startLine < current.endLine) {
      current.endLine = Math.max(current.endLine, range.endLine);
      current.replacements.push(replacement);
      continue;
    }
    groups.push({ ...range, replacements: [replacement] });
  }

  let originalLineIndex = 0;
  let result = "";
  for (const group of groups) {
    result += originalLines.slice(originalLineIndex, group.startLine).join("");
    const groupStart = baseLines[group.startLine].start;
    const groupEnd = baseLines[group.endLine - 1].end;
    result += spliceReplacements(baseContent.slice(groupStart, groupEnd), group.replacements, groupStart);
    originalLineIndex = group.endLine;
  }
  result += originalLines.slice(originalLineIndex).join("");
  return result;
}

/** Leading spaces/tabs of a line. */
function leadingWhitespace(line: string): string {
  const match = /^[ \t]*/.exec(line);
  return match ? match[0] : "";
}

/** Leading whitespace of the first non-blank line. */
function firstContentIndent(lines: string[]): string {
  const first = lines.find((line) => line.trim() !== "");
  return first === undefined ? "" : leadingWhitespace(first);
}

/**
 * Rebase replacement text authored in the matched block's indentation frame
 * onto the file's own indentation. Text written in a different frame is left
 * alone.
 */
function reindentReplacement(text: string, oldIndent: string, fileIndent: string): string {
  if (oldIndent === fileIndent) return text;
  const lines = text.split("\n");
  const first = lines.find((line) => line.trim() !== "");
  if (first === undefined || leadingWhitespace(first) !== oldIndent) return text;
  return lines
    .map((line) => {
      if (line.trim() === "") return line;
      const indent = leadingWhitespace(line);
      if (indent.length >= oldIndent.length) return fileIndent + line.slice(oldIndent.length);
      return fileIndent + line;
    })
    .join("\n");
}

/** 1-based line number of an offset. */
function lineNumberOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === "\n") line += 1;
  return line;
}

function ambiguousEdit(rel: string, lines: number[]): WorkspaceError {
  const shown = lines.slice(0, 5).join(", ");
  const more = lines.length > 5 ? ", ..." : "";
  return new WorkspaceError(
    `\`old\` text is ambiguous in ${rel}: ${lines.length} matches (lines ${shown}${more}); ` +
      "add surrounding context to make it unique, or pass replace_all=true to change all",
  );
}

interface EditPlan {
  updated: string;
  replaced: number;
  tier: "exact" | "fuzzy" | "indentation";
}

/**
 * Resolve one old/new edit against `text`: byte-exact first (Python parity),
 * then pi's whitespace/Unicode-normalized view, then an indentation-insensitive
 * line-block match. Ambiguous matches are refused unless `replaceAll`.
 */
function planEdit(text: string, oldText: string, newText: string, replaceAll: boolean, rel: string): EditPlan {
  const exact = findTextOccurrences(text, oldText);
  if (exact.length > 0) {
    if (exact.length > 1 && !replaceAll) {
      throw ambiguousEdit(rel, exact.map((index) => lineNumberOf(text, index)));
    }
    const selected = replaceAll ? exact : [exact[0]];
    let updated = text;
    for (let i = selected.length - 1; i >= 0; i--) {
      updated = updated.slice(0, selected[i]) + newText + updated.slice(selected[i] + oldText.length);
    }
    return { updated, replaced: selected.length, tier: "exact" };
  }

  const ending = detectLineEnding(text);
  const lfText = normalizeToLF(text);
  const lfOldText = normalizeToLF(oldText);

  const fuzzyText = normalizeForFuzzyMatch(lfText);
  const fuzzyOldText = normalizeForFuzzyMatch(lfOldText);
  if (fuzzyOldText.length > 0) {
    const occurrences = findTextOccurrences(fuzzyText, fuzzyOldText);
    if (occurrences.length > 0) {
      if (occurrences.length > 1 && !replaceAll) {
        throw ambiguousEdit(rel, occurrences.map((index) => lineNumberOf(fuzzyText, index)));
      }
      const selected = replaceAll ? occurrences : [occurrences[0]];
      const lfNewText = normalizeToLF(newText);
      const updatedLf = applyReplacementsPreservingUnchangedLines(
        lfText,
        fuzzyText,
        selected.map((matchIndex) => ({ matchIndex, matchLength: fuzzyOldText.length, newText: lfNewText })),
      );
      return { updated: restoreLineEndings(updatedLf, ending), replaced: selected.length, tier: "fuzzy" };
    }
  }

  // Indentation-flexible anchoring: compare whole lines with leading
  // whitespace removed, then rebase the replacement onto the file's indent.
  const contentLines = splitTextLines(lfText);
  const { lines: oldLines, includeFinalBreak } = splitEditLines(lfOldText);
  const normalizedOldLines = oldLines.map((line) => normalizeForFuzzyMatch(line).trimStart());
  const matches: Array<{ startLine: number; endLine: number; fileIndent: string }> = [];
  let coveredUntil = 0;
  for (let start = 0; start + normalizedOldLines.length <= contentLines.length; start++) {
    if (start < coveredUntil) continue;
    let matched = true;
    for (let offset = 0; offset < normalizedOldLines.length; offset++) {
      const line = contentLines[start + offset].text;
      if (normalizeForFuzzyMatch(line).trimStart() !== normalizedOldLines[offset]) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    const endLine = start + normalizedOldLines.length;
    const last = contentLines[endLine - 1];
    if (includeFinalBreak && last.end === last.textEnd) continue;
    const firstContent = contentLines.slice(start, endLine).find((line) => line.text.trim() !== "");
    matches.push({
      startLine: start,
      endLine,
      fileIndent: firstContent === undefined ? "" : leadingWhitespace(firstContent.text),
    });
    coveredUntil = endLine;
  }
  if (matches.length === 0) {
    throw new WorkspaceError(
      `\`old\` text not found in ${rel}; exact, whitespace-tolerant, and indentation-tolerant matching all failed`,
    );
  }
  if (matches.length > 1 && !replaceAll) {
    throw ambiguousEdit(rel, matches.map((match) => match.startLine + 1));
  }
  const selected = replaceAll ? matches : [matches[0]];
  const oldIndent = firstContentIndent(oldLines);
  const lfNewText = normalizeToLF(newText);
  const replacements = selected.map((match) => {
    const last = contentLines[match.endLine - 1];
    return {
      matchIndex: contentLines[match.startLine].start,
      matchLength: (includeFinalBreak ? last.end : last.textEnd) - contentLines[match.startLine].start,
      newText: reindentReplacement(lfNewText, oldIndent, match.fileIndent),
    };
  });
  let updatedLf = lfText;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const replacement = replacements[i];
    updatedLf =
      updatedLf.slice(0, replacement.matchIndex) +
      replacement.newText +
      updatedLf.slice(replacement.matchIndex + replacement.matchLength);
  }
  return { updated: restoreLineEndings(updatedLf, ending), replaced: selected.length, tier: "indentation" };
}

/** A BOM is stripped for matching and written back untouched. */
function splitBom(text: string): { bom: string; text: string } {
  return text.startsWith("\uFEFF") ? { bom: "\uFEFF", text: text.slice(1) } : { bom: "", text };
}

// ---------------------------------------------------------------------------
// per-file mutation queue (pi's file-mutation-queue.ts)
// ---------------------------------------------------------------------------

const fileMutationQueues = new Map<string, Promise<void>>();

/** Real path when it exists (symlink-aware), resolved path otherwise. */
function mutationQueueKey(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch (exc) {
    const code = (exc as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return path.resolve(target);
    throw exc;
  }
}

/**
 * Serialize mutations of one file: callers targeting the same resolved path
 * run one after another in call order; different paths stay parallel. Reads
 * never take this queue.
 */
async function withFileMutationQueue<T>(target: string, fn: () => Promise<T>): Promise<T> {
  const resolvedKey = mutationQueueKey(target);
  const key = process.platform === "win32" ? resolvedKey.toLowerCase() : resolvedKey;
  const previous = fileMutationQueues.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const tail = previous.then(() => gate);
  fileMutationQueues.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (fileMutationQueues.get(key) === tail) fileMutationQueues.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

/** Expand a leading `~` the way pathlib's expanduser does. */
function expandUser(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith(`~${path.sep}`) || p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/**
 * Resolve symlinks on the existing prefix of `target` and keep the remaining
 * (possibly not-yet-existing) suffix verbatim — pathlib's resolve(strict=False).
 */
function realpathNonStrict(target: string): string {
  let anchor = target;
  const rest: string[] = [];
  for (;;) {
    try {
      const resolved = fs.realpathSync(anchor);
      return path.resolve(resolved, ...rest.reverse());
    } catch {
      const parent = path.dirname(anchor);
      if (parent === anchor) return target;
      rest.push(path.basename(anchor));
      anchor = parent;
    }
  }
}

export type WorkspaceResult = Record<string, unknown>;

/** One captured side of a file mutation (the seam for run-scoped edit undo). */
export interface WorkspaceMutationImage {
  /** Whether the target existed when this side was captured. */
  exists: boolean;
  /** Exact file bytes, present only when the content was captured. */
  content?: Buffer;
  /** Byte size when the target existed. */
  size?: number;
  /** Why `content` is absent (oversized or unreadable); never fails the tool call. */
  skipped?: string;
  /**
   * POSIX permission word (permission bits plus setuid/setgid/sticky) of the
   * target when this side was captured. Windows omits it. Additive: old
   * recorders ignore it, and the undo store copies it into the record.
   */
  mode?: number;
  /** POSIX owner uid at capture time (Windows omits it). */
  uid?: number;
  /** POSIX owner gid at capture time (Windows omits it). */
  gid?: number;
}

/**
 * One completed workspace mutation: the file's exact bytes before and after.
 * Only successful write/edit/delete calls emit a record — a denied or failed
 * mutation emits nothing.
 */
export interface WorkspaceMutationRecord {
  action: "write" | "edit" | "delete";
  /** Workspace-relative POSIX path. */
  path: string;
  /** Canonical absolute workspace root. */
  root: string;
  pre: WorkspaceMutationImage;
  post: WorkspaceMutationImage;
}

/**
 * Optional run-scoped undo capture hook. Called synchronously on the mutation
 * path after the change succeeded; a throwing recorder is contained and
 * reported as one diagnostic, never propagated into the tool result.
 */
export type WorkspaceMutationRecorder = (record: WorkspaceMutationRecord) => void;

/** Constructor options for the optional mutation-capture seam. */
export interface WorkspaceOptions {
  /** Absent/null keeps the default path byte-identical and free of extra reads. */
  readonly mutationRecorder?: WorkspaceMutationRecorder | null;
  /** Receives one bounded line per failed capture; never throws into the tool path. */
  readonly onCaptureDiagnostic?: ((message: string) => void) | null;
}

/** One captured side of a mutation is skipped beyond this size (the undo store's bound). */
export const MAX_MUTATION_CAPTURE_BYTES = 2 * 1024 * 1024;

/** POSIX mode/ownership metadata for an undo image; Windows records none. */
function captureModeMeta(
  stat: fs.Stats,
): Pick<WorkspaceMutationImage, "mode" | "uid" | "gid"> {
  if (process.platform === "win32") return {};
  return { mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid };
}

// ---------------------------------------------------------------------------
// read_file line pages
// ---------------------------------------------------------------------------

/**
 * Optional line-range read of a workspace text file. Supplying `offset` and/or
 * `limit` switches `read_file` into range mode; `maxChars` alone keeps the
 * historical whole-file head+tail read byte-identical.
 */
export interface ReadFileOptions {
  /** Character cap for the returned content (default `DEFAULT_MAX_CHARS`). */
  maxChars?: number;
  /** First line of the page, 1-based (default 1). */
  offset?: number;
  /** Maximum lines in the page (default `DEFAULT_READ_LINES`, clamped to 1..`MAX_READ_LINES`). */
  limit?: number;
  /**
   * 0-based UTF-16 offset into the first requested line. A page that clips a
   * line returns `next_offset` plus `next_char_offset`; resume at `next_offset`
   * with `charOffset: next_char_offset` (when `next_offset` stays on the same
   * line this continues that tail). Supplying this field alone also activates
   * range mode (like `offset`/`limit`); omit all three for the historical
   * whole-file head+tail read.
   */
  charOffset?: number;
}

/** One line page plus the bookkeeping a model needs to request the next one. */
interface FilePage {
  content: string;
  offset: number;
  lines: number;
  total_lines: number;
  eof: boolean;
  next_offset?: number;
  /** Continuation offset inside the clipped line named by `next_offset` (UTF-16 units). */
  next_char_offset?: number;
  truncated: boolean;
}

/** Tolerant 1-based line offset: junk becomes 1, huge values stay safe integers. */
function clampLineOffset(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value)) return 1;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Math.floor(value)));
}

/** Tolerant line limit: junk gets the default, everything else clamps to 1..max. */
function clampLineLimit(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value)) return DEFAULT_READ_LINES;
  return Math.min(MAX_READ_LINES, Math.max(1, Math.floor(value)));
}

/** Range-mode character budget: a positive finite integer, default otherwise. */
function clampRangeChars(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_MAX_CHARS;
  return Math.max(1, Math.floor(value));
}

/** Optional 0-based character offset into the first requested line. */
function clampCharOffset(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

/** Slice a string to `maxChars` UTF-16 units without splitting a surrogate pair. */
function safeCharPrefix(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  let end = maxChars;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/**
 * Stream a file line by line and return one 1-based line page. The whole file
 * is scanned (so `total_lines` is honest) but only the current line suffix and
 * the page itself are retained: memory stays bounded by the character budget,
 * never by the file size. Lines end at `\n`, `\r\n` or `\r`; a trailing line
 * break does not create an extra empty line, matching `splitLinesKeepEnds`.
 *
 * A page that fits keeps whole lines joined by `\n`. If the character budget
 * cuts a later line, only whole lines that fit are kept and `next_offset`
 * names that line. When no whole line fits, the line's safe character prefix
 * is returned, `next_offset` names that line, and `next_char_offset` (relative
 * to `next_offset`) names the undelivered tail; passing both back continues
 * the tail and then the following lines. A page always advances at least one
 * whole code point, even when `maxChars` is 1 and the next character is astral
 * (the pair is delivered intact); a line completed by that pair advances
 * normally instead of asking for an empty continuation. `eof` is false while
 * either a line or a clipped character tail remains.
 */
async function readFilePage(
  target: string,
  offset: number,
  limit: number,
  maxChars: number,
  charOffset = 0,
): Promise<FilePage> {
  const page: string[] = [];
  let pageChars = 0;
  let totalLines = 0;
  let current = "";
  let currentLength = 0;
  let pendingLine = false;
  let swallowLF = false;
  let charClipped = false;
  let stopped = false;
  // Highest line fully delivered. A partially delivered first line leaves this
  // at `offset - 1`, so `next_offset` stays on that line.
  let lastDelivered = offset - 1;
  let nextOffsetOverride: number | null = null;
  let nextCharOffset: number | undefined;
  let partialTail = false;
  // Enough to detect that a line overflows and to clip a safe prefix; keeping
  // more than the page budget would make a single giant line unbounded.
  const retentionCap = maxChars + 2;

  const completeLine = (): void => {
    totalLines += 1;
    const lineNumber = totalLines;
    const inWindow = lineNumber >= offset && lineNumber < offset + limit;
    if (inWindow && !stopped) {
      let start = lineNumber === offset ? Math.min(charOffset, currentLength) : 0;
      // Retention starts one character before a non-zero char_offset so a
      // caller offset that lands between a surrogate pair can include the
      // high surrogate instead of emitting a lone low surrogate.
      let tail = current;
      if (lineNumber === offset && charOffset > 0 && start === charOffset && current.length > 0) {
        const previous = current.charCodeAt(0);
        const next = current.length > 1 ? current.charCodeAt(1) : -1;
        if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
          start = charOffset - 1; // deliver the whole code point, never half
        } else {
          tail = current.slice(1); // drop the extra retained character
        }
      }
      // A non-zero char_offset at/after this line's end means the first line
      // is already fully consumed; it contributes no page characters (but is
      // counted as delivered, so next_offset advances past it).
      if (lineNumber === offset && charOffset > 0 && start >= currentLength) {
        lastDelivered = lineNumber;
        current = "";
        currentLength = 0;
        pendingLine = false;
        return;
      }
      const separator = page.length > 0 ? 1 : 0;
      const available = maxChars - pageChars - separator;
      const tailLength = currentLength - start;
      const wholeTail = tail.length === tailLength;
      if (wholeTail && tailLength <= available) {
        page.push(tail);
        pageChars += separator + tailLength;
        lastDelivered = lineNumber;
      } else {
        charClipped = true;
        stopped = true;
        if (page.length === 0) {
          // No whole line fits yet (the first requested line, or the first
          // later line when the prior offset line was already consumed).
          // Deliver its safe prefix and point at the undelivered tail. The
          // only zero-length prefix is a single astral code point wider than
          // the budget; deliver that whole code point anyway, so every
          // continuation is guaranteed to advance (never a permanent page).
          const clipped = safeCharPrefix(tail, Math.max(0, available));
          const delivered =
            clipped.length > 0
              ? clipped
              : tail.slice(0, (tail.codePointAt(0) ?? 0) > 0xffff ? 2 : 1);
          if (delivered.length > 0) {
            page.push(delivered);
            pageChars += delivered.length;
          }
          const deliveredEnd = start + delivered.length;
          if (deliveredEnd < currentLength) {
            // The line's tail remains: next_offset names this line and
            // next_char_offset is relative to it.
            nextOffsetOverride = lineNumber;
            nextCharOffset = deliveredEnd;
            partialTail = true;
          } else {
            // The delivered code point completed the line even though it
            // exceeded the character budget: advance normally instead of
            // asking for an empty continuation.
            lastDelivered = lineNumber;
          }
        } else {
          // A later line does not fit: the previous whole lines are the page
          // and the next call starts at this line's beginning.
          nextOffsetOverride = lineNumber;
        }
      }
    }
    current = "";
    currentLength = 0;
    pendingLine = false;
  };

  const stream = fs.createReadStream(target, { encoding: "utf8", highWaterMark: 64 * 1024 });
  for await (const chunk of stream) {
    const text = typeof chunk === "string" ? chunk : String(chunk);
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (swallowLF) {
        swallowLF = false;
        if (ch === "\n") continue;
      }
      if (ch === "\n") {
        completeLine();
        continue;
      }
      if (ch === "\r") {
        completeLine();
        swallowLF = true;
        continue;
      }
      const prospective = totalLines + 1;
      const inWindow = prospective >= offset && prospective < offset + limit;
      const retainFrom = prospective === offset && charOffset > 0 ? charOffset - 1 : 0;
      const retain =
        !stopped && inWindow && currentLength >= retainFrom && current.length < retentionCap;
      if (retain) current += ch;
      currentLength += 1;
      pendingLine = true;
    }
  }
  if (pendingLine) completeLine();

  const eof = !partialTail && lastDelivered >= totalLines;
  const result: FilePage = {
    content: page.join("\n"),
    offset,
    lines: page.length,
    total_lines: totalLines,
    eof,
    truncated: charClipped,
  };
  if (!eof) {
    result.next_offset = nextOffsetOverride ?? lastDelivered + 1;
    if (nextCharOffset !== undefined) result.next_char_offset = nextCharOffset;
  }
  return result;
}

/** The only door between the models and the local filesystem. */
export class Workspace {
  readonly root: string;
  readonly permissions: PermissionManager;
  readonly shell: ShellRunner;

  private mutationRecorder: WorkspaceMutationRecorder | null;
  private captureDiagnosticSink: ((message: string) => void) | null;

  constructor(
    root: string,
    permissions?: PermissionManager | null,
    shell?: ShellRunner | null,
    options: WorkspaceOptions = {},
  ) {
    const rootPath = expandUser(root);
    if (!fs.existsSync(rootPath)) {
      throw new WorkspaceError(`workspace root does not exist: ${root}`);
    }
    if (!fs.statSync(rootPath).isDirectory()) {
      throw new WorkspaceError(`workspace root is not a directory: ${root}`);
    }
    this.root = fs.realpathSync(rootPath);
    this.permissions = permissions ?? new PermissionManager();
    this.shell = shell ?? new ShellRunner({ cwd: this.root });
    this.mutationRecorder = options.mutationRecorder ?? null;
    this.captureDiagnosticSink = options.onCaptureDiagnostic ?? null;
  }

  /**
   * Install or clear the run-scoped undo capture hook (tests and the server's
   * per-run wiring). Passing no diagnostic sink keeps the current one.
   */
  setMutationRecorder(
    recorder: WorkspaceMutationRecorder | null,
    onDiagnostic?: ((message: string) => void) | null,
  ): void {
    this.mutationRecorder = recorder;
    if (onDiagnostic !== undefined) this.captureDiagnosticSink = onDiagnostic;
  }

  // -- path handling ---------------------------------------------------------

  /**
   * Resolve `rel` inside the workspace or raise. Refuses absolute paths,
   * parent traversal (even through symlinks), and sensitive files. With
   * `checkExists` the target must exist.
   */
  resolve(rel: string, checkExists = true): string {
    if (path.isAbsolute(rel)) {
      throw new WorkspaceError(`absolute paths are not allowed: ${rel}`);
    }
    const candidate = realpathNonStrict(path.resolve(this.root, rel));
    if (candidate !== this.root && !candidate.startsWith(this.root + path.sep)) {
      throw new WorkspaceError(`path escapes the workspace: ${rel}`);
    }
    if (candidate === this.root && checkExists) {
      throw new WorkspaceError("the workspace root is not a file target");
    }
    if (candidate !== this.root) {
      const sensitive = isSensitivePath(path.relative(this.root, candidate));
      if (sensitive) {
        throw new WorkspaceError(`sensitive file refused (${sensitive}): ${rel}`);
      }
    }
    if (checkExists && !fs.existsSync(candidate)) {
      throw new WorkspaceError(`no such file or directory: ${rel}`);
    }
    return candidate;
  }

  /** The workspace-relative POSIX path used in events and diffs. */
  display(p: string): string {
    if (p === this.root) return ".";
    return path
      .relative(this.root, p)
      .split(path.sep)
      .join("/");
  }

  // -- structured result helpers ----------------------------------------------

  private result(tool: string, p: string | null, status: string, extra: WorkspaceResult = {}): WorkspaceResult {
    const out: WorkspaceResult = { tool, status };
    if (p !== null) out.path = this.display(p);
    Object.assign(out, extra);
    return out;
  }

  private errorResult(tool: string, p: string | null, exc: unknown): WorkspaceResult {
    const status = exc instanceof PermissionDenied ? "denied" : "error";
    const message = exc instanceof Error ? exc.message : String(exc);
    return this.result(tool, p, status, { error: message });
  }

  // -- optional mutation-capture seam -----------------------------------------

  /**
   * Capture one side of a mutation for the undo recorder. Bounded (files over
   * `MAX_MUTATION_CAPTURE_BYTES` are described, not read) and fail-soft: an
   * unreadable file becomes an image with a `skipped` reason instead of an
   * error, because capture must never fail the tool call.
   */
  private captureImage(target: string): WorkspaceMutationImage {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(target);
    } catch (exc) {
      const code = (exc as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return { exists: false };
      return {
        exists: false,
        skipped: `cannot stat the target: ${exc instanceof Error ? exc.message : String(exc)}`,
      };
    }
    if (!stat.isFile()) {
      return {
        exists: true,
        size: stat.size,
        skipped: "target is not a regular file",
        ...captureModeMeta(stat),
      };
    }
    if (stat.size > MAX_MUTATION_CAPTURE_BYTES) {
      return {
        exists: true,
        size: stat.size,
        skipped: `file size ${stat.size} exceeds the ${MAX_MUTATION_CAPTURE_BYTES}-byte capture limit`,
        ...captureModeMeta(stat),
      };
    }
    try {
      const content = fs.readFileSync(target);
      return { exists: true, content, size: content.byteLength, ...captureModeMeta(stat) };
    } catch (exc) {
      return {
        exists: true,
        size: stat.size,
        skipped: `cannot read the target: ${exc instanceof Error ? exc.message : String(exc)}`,
        ...captureModeMeta(stat),
      };
    }
  }

  /**
   * Deliver one completed mutation to the optional recorder. The recorder runs
   * outside the tool result (its failure can never fail the mutation) and after
   * the change succeeded; a throwing recorder gets exactly one diagnostic.
   */
  private recordMutation(
    action: WorkspaceMutationRecord["action"],
    target: string,
    pre: WorkspaceMutationImage,
    post: WorkspaceMutationImage,
  ): void {
    const recorder = this.mutationRecorder;
    if (recorder === null) return;
    try {
      recorder({ action, path: this.display(target), root: this.root, pre, post });
    } catch (exc) {
      this.captureDiagnostic(
        `undo capture failed for ${this.display(target)}: ${exc instanceof Error ? exc.message : String(exc)}`,
      );
    }
  }

  /** One bounded diagnostic per failed capture; a broken sink is ignored. */
  private captureDiagnostic(line: string): void {
    const sink = this.captureDiagnosticSink;
    if (sink === null) return;
    try {
      sink(line);
    } catch {
      // a broken diagnostic sink never breaks a tool call
    }
  }

  private async authorize(
    action: Action,
    p: string | null = null,
    command = "",
    reason = "",
    detail?: ApprovalDetail,
  ): Promise<void> {
    const request: ApprovalRequest = {
      action,
      target: p !== null ? this.display(p) : "",
      command,
      reason,
      ...(detail !== undefined ? { detail } : {}),
    };
    await this.permissions.require(request);
  }

  // -- read-only tools (auto-allowed) ------------------------------------------

  /**
   * Read a UTF-8 text file. Without `offset`/`limit`/`charOffset`, this is the
   * original whole-file read bounded by `maxChars` (head+tail window). With a
   * range field, it returns one 1-based line page plus `lines`, `total_lines`,
   * `eof` and (when more remains) `next_offset`; `maxChars` usually caps the
   * page characters, except that one astral code point may exceed it by one
   * UTF-16 unit so a page always advances. A clipped line additionally returns
   * `next_char_offset` relative to `next_offset`; the caller resumes at
   * `next_offset` with `charOffset: next_char_offset` to read the rest of that
   * line and then the following lines.
   */
  async read_file(rel: string, maxChars?: number): Promise<WorkspaceResult>;
  async read_file(rel: string, options?: ReadFileOptions): Promise<WorkspaceResult>;
  async read_file(
    rel: string,
    maxCharsOrOptions: number | ReadFileOptions = DEFAULT_MAX_CHARS,
  ): Promise<WorkspaceResult> {
    const tool = "read_file";
    try {
      const p = this.resolve(rel);
      if (!fs.statSync(p).isFile()) {
        throw new WorkspaceError(`not a file: ${rel}`);
      }
      const options =
        typeof maxCharsOrOptions === "number" ||
        maxCharsOrOptions === null ||
        maxCharsOrOptions === undefined
          ? null
          : maxCharsOrOptions;
      const rangeRequested =
        options !== null &&
        (options.offset !== undefined ||
          options.limit !== undefined ||
          options.charOffset !== undefined);
      if (!rangeRequested) {
        const maxChars =
          typeof maxCharsOrOptions === "number"
            ? maxCharsOrOptions
            : options?.maxChars ?? DEFAULT_MAX_CHARS;
        const text = fs.readFileSync(p, "utf-8");
        const bounded = boundOutput(text, maxChars);
        return this.result(tool, p, "ok", { content: bounded.text, truncated: bounded.truncated });
      }
      const page = await readFilePage(
        p,
        clampLineOffset(options.offset),
        clampLineLimit(options.limit),
        clampRangeChars(options.maxChars),
        clampCharOffset(options.charOffset),
      );
      return this.result(tool, p, "ok", {
        content: page.content,
        truncated: page.truncated,
        offset: page.offset,
        lines: page.lines,
        total_lines: page.total_lines,
        eof: page.eof,
        ...(page.next_offset !== undefined ? { next_offset: page.next_offset } : {}),
        ...(page.next_char_offset !== undefined
          ? { next_char_offset: page.next_char_offset }
          : {}),
      });
    } catch (exc) {
      if (exc instanceof WorkspaceError || exc instanceof PermissionDenied) {
        return this.errorResult(tool, null, exc);
      }
      throw exc;
    }
  }

  /** List one directory level: names, types, sizes. */
  async list_dir(rel: string = "."): Promise<WorkspaceResult> {
    const tool = "list_dir";
    try {
      const p = rel === "" || rel === "." ? this.root : this.resolve(rel);
      if (!fs.statSync(p).isDirectory()) {
        throw new WorkspaceError(`not a directory: ${rel}`);
      }
      const entries: Array<Record<string, unknown>> = [];
      for (const name of fs.readdirSync(p).sort()) {
        const child = path.join(p, name);
        let kind: string;
        let size: number | null;
        try {
          const st = fs.statSync(child);
          kind = st.isDirectory() ? "dir" : "file";
          size = kind === "file" ? st.size : null;
        } catch {
          kind = "other";
          size = null;
        }
        entries.push({ name, type: kind, size });
      }
      const extra: WorkspaceResult = {};
      if (entries.length > MAX_LIST_ENTRIES) {
        const omitted = entries.length - MAX_LIST_ENTRIES;
        extra.truncated = true;
        extra.omitted_entries = omitted;
        entries.length = MAX_LIST_ENTRIES;
      }
      return this.result(tool, p, "ok", { entries, ...extra });
    } catch (exc) {
      if (exc instanceof WorkspaceError || exc instanceof PermissionDenied) {
        return this.errorResult(tool, null, exc);
      }
      throw exc;
    }
  }

  /** Regex search over text files, bounded by `maxMatches`. */
  async search_text(pattern: string, rel: string = ".", maxMatches: number = DEFAULT_MAX_MATCHES): Promise<WorkspaceResult> {
    const tool = "search_text";
    let base: string;
    let regex: RegExp;
    try {
      base = rel === "" || rel === "." ? this.root : this.resolve(rel);
      if (!fs.statSync(base).isDirectory()) {
        throw new WorkspaceError(`not a directory: ${rel}`);
      }
      regex = new RegExp(pattern);
    } catch (exc) {
      // WorkspaceError, PermissionDenied, and RegExp SyntaxError alike
      // become structured error results.
      return this.errorResult(tool, null, exc);
    }

    const matches: Array<Record<string, unknown>> = [];
    let matchChars = 0;
    let omittedMatches = 0;
    let truncated = false;

    const walk = (dir: string): void => {
      if (truncated && omittedMatches === 0) return;
      let dirents;
      try {
        dirents = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      // files of this level first (os.walk order), then subdirectories
      const subdirs: string[] = [];
      for (const dirent of dirents) {
        const full = path.join(dir, dirent.name);
        let lst;
        try {
          lst = fs.lstatSync(full);
        } catch {
          continue;
        }
        if (lst.isSymbolicLink()) continue; // never follow links
        if (lst.isDirectory()) {
          if (!SENSITIVE_DIRS.has(dirent.name) && !dirent.name.startsWith(".git")) {
            subdirs.push(full);
          }
          continue;
        }
        if (!lst.isFile() || lst.size > 1_000_000) continue;
        const shown = this.display(full);
        if (isSensitivePath(shown)) continue;
        let text: string;
        try {
          text = fs.readFileSync(full, "utf-8");
        } catch {
          continue;
        }
        if (text === "") continue;
        const lines = text.split(/\r\n|\r|\n/);
        for (let lineno = 0; lineno < lines.length; lineno++) {
          if (regex.test(lines[lineno])) {
            const rec = { path: shown, line: lineno + 1, text: lines[lineno].slice(0, 500) };
            const size = resultSize(rec);
            if (matchChars + size > MAX_SEARCH_RESULT_CHARS) {
              // the aggregate result is over the cap: count further matches
              // as omitted instead of adding them
              truncated = true;
              omittedMatches += 1;
              continue;
            }
            matches.push(rec);
            matchChars += size;
            if (matches.length >= maxMatches) {
              truncated = true;
              return;
            }
          }
        }
      }
      for (const subdir of subdirs.sort()) {
        if (truncated && omittedMatches === 0) return;
        walk(subdir);
      }
    };
    walk(base);

    const extra: WorkspaceResult = { matches, truncated };
    if (omittedMatches > 0) extra.omitted_matches = omittedMatches;
    return this.result(tool, base, "ok", extra);
  }

  // -- mutating tools (approval required) ---------------------------------------

  /**
   * Create or overwrite a file and return its unified diff. Mutations of the
   * same file serialize through the per-file queue.
   */
  async write_file(rel: string, content: string): Promise<WorkspaceResult> {
    const tool = "write_file";
    let p: string | null = null;
    try {
      p = this.resolve(rel, false);
      const target = p;
      return await withFileMutationQueue(target, async () => {
        if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
          throw new WorkspaceError(`is a directory: ${rel}`);
        }
        const oldText = fs.existsSync(target) ? fs.readFileSync(target, "utf-8") : null;
        await this.authorize(
          Action.WRITE,
          target,
          "",
          "",
          diffDetail("write", this.display(target), oldText ?? "", content),
        );
        const pre = this.mutationRecorder === null ? null : this.captureImage(target);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content, "utf-8");
        const result = this.result(tool, target, "ok");
        result.bytes_written = Buffer.byteLength(content, "utf-8");
        result.diff = makeDiff(this.display(target), oldText ?? "", content);
        if (pre !== null) this.recordMutation("write", target, pre, this.captureImage(target));
        return result;
      });
    } catch (exc) {
      if (exc instanceof WorkspaceError || exc instanceof PermissionDenied) {
        return this.errorResult(tool, p, exc);
      }
      throw exc;
    }
  }

  /**
   * Edit a file by text match and return the unified diff of the change.
   * Exact matches are tried first (Python parity); whitespace/line-ending
   * drift and indentation drift are tolerated. Ambiguous matches are refused
   * unless `replaceAll`.
   */
  async edit_file(rel: string, oldText: string, newText: string, replaceAll = false): Promise<WorkspaceResult> {
    const tool = "edit_file";
    let p: string | null = null;
    try {
      if (!oldText) {
        throw new WorkspaceError("edit_file requires a non-empty `old` string");
      }
      p = this.resolve(rel);
      const target = p;
      if (!fs.statSync(target).isFile()) {
        throw new WorkspaceError(`not a file: ${rel}`);
      }
      return await withFileMutationQueue(target, async () => {
        if (!fs.existsSync(target)) {
          throw new WorkspaceError(`no such file or directory: ${rel}`);
        }
        if (!fs.statSync(target).isFile()) {
          throw new WorkspaceError(`not a file: ${rel}`);
        }
        const raw = fs.readFileSync(target, "utf-8");
        const { bom, text } = splitBom(raw);
        const plan = planEdit(text, oldText, newText, replaceAll, rel);
        const updated = bom + plan.updated;
        await this.authorize(
          Action.EDIT,
          target,
          "",
          "",
          diffDetail("edit", this.display(target), raw, updated),
        );
        const pre = this.mutationRecorder === null ? null : this.captureImage(target);
        fs.writeFileSync(target, updated, "utf-8");
        const result = this.result(tool, target, "ok", {
          replaced: plan.replaced,
          diff: makeDiff(this.display(target), raw, updated),
        });
        if (pre !== null) this.recordMutation("edit", target, pre, this.captureImage(target));
        return result;
      });
    } catch (exc) {
      if (exc instanceof WorkspaceError || exc instanceof PermissionDenied) {
        return this.errorResult(tool, p, exc);
      }
      throw exc;
    }
  }

  /** Delete one file (directories are refused); queued per path. */
  async delete_file(rel: string): Promise<WorkspaceResult> {
    const tool = "delete_file";
    let p: string | null = null;
    try {
      p = this.resolve(rel);
      const target = p;
      if (!fs.statSync(target).isFile()) {
        throw new WorkspaceError(`not a file: ${rel}`);
      }
      return await withFileMutationQueue(target, async () => {
        if (!fs.existsSync(target)) {
          throw new WorkspaceError(`no such file or directory: ${rel}`);
        }
        if (!fs.statSync(target).isFile()) {
          throw new WorkspaceError(`not a file: ${rel}`);
        }
        // The delete preview shows the removed text as a diff when the file is
        // small enough to read; a large/binary file is approved by path alone.
        let detail: ApprovalDetail = { kind: "delete" };
        try {
          const size = fs.statSync(target).size;
          if (size <= MAX_APPROVAL_PREVIEW_BYTES) {
            detail = diffDetail("delete", this.display(target), fs.readFileSync(target, "utf-8"), "");
          }
        } catch {
          // unreadable stat/read: the approval still names the target
        }
        await this.authorize(Action.DELETE, target, "", DELETE_APPROVAL_REASON, detail);
        const pre = this.mutationRecorder === null ? null : this.captureImage(target);
        fs.unlinkSync(target);
        const result = this.result(tool, target, "ok", { deleted: true });
        if (pre !== null) this.recordMutation("delete", target, pre, this.captureImage(target));
        return result;
      });
    } catch (exc) {
      if (exc instanceof WorkspaceError || exc instanceof PermissionDenied) {
        return this.errorResult(tool, p, exc);
      }
      throw exc;
    }
  }

  /** Run a bounded shell command inside the workspace (approval required). */
  async run_shell(command: string, timeout?: number, signal?: AbortSignal): Promise<WorkspaceResult> {
    try {
      await this.authorize(Action.SHELL, null, command, SHELL_APPROVAL_REASON, {
        kind: "shell",
        command,
      });
    } catch (exc) {
      if (exc instanceof PermissionDenied) {
        return { tool: "run_shell", status: "denied", command, error: (exc as Error).message };
      }
      throw exc;
    }
    // Model-supplied timeouts are clamped: a huge value would park a run (and
    // a worker-pool slot) for hours on a single shell call.
    const bounded =
      timeout === undefined
        ? undefined
        : Math.min(Math.max(timeout, MIN_SHELL_TIMEOUT_S), MAX_SHELL_TIMEOUT_S);
    const data = await this.shell.run(command, { timeout: bounded, signal });
    return { ...data, tool: "run_shell" };
  }

  // -- tool adapter -------------------------------------------------------------

  /**
   * Generic `Tool` objects wrapping the workspace for the cooperation
   * harness: same names, argument shapes, and JSON-string results as the
   * original prototype's tool adapter.
   */
  asTools(): Tool[] {
    const ws = this;
    const json = (value: unknown): string => JSON.stringify(value);
    const numOr = (value: unknown, fallback: number): number =>
      typeof value === "number" && Number.isFinite(value) ? value : fallback;
    const numOrUndef = (value: unknown): number | undefined =>
      typeof value === "number" && Number.isFinite(value) ? value : undefined;
    const pathProp: Record<string, unknown> = {
      type: "string",
      description: "workspace-relative file or directory path",
    };

    return [
      {
        name: "workspace_read_file",
        description:
          "Read a UTF-8 text file inside the workspace. Omit offset/limit for the whole file (bounded head+tail); pass either to page through a large file by lines. A page that clips a line returns next_offset and, while that line's tail is undelivered, next_char_offset; continue at next_offset with char_offset=next_char_offset (next_char_offset is relative to next_offset). Every page advances at least one whole code point.",
        parameters: {
          type: "object",
          properties: {
            path: { ...pathProp, default: "." },
            max_chars: {
              type: "integer",
              default: DEFAULT_MAX_CHARS,
              description: `maximum characters of content to return (default ${DEFAULT_MAX_CHARS})`,
            },
            offset: {
              type: "integer",
              minimum: 1,
              default: 1,
              description: "1-based line number of the first line to return (switches on line-range mode)",
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: MAX_READ_LINES,
              default: DEFAULT_READ_LINES,
              description: `maximum lines in one page (default ${DEFAULT_READ_LINES}, clamped to 1..${MAX_READ_LINES})`,
            },
            char_offset: {
              type: "integer",
              minimum: 0,
              default: 0,
              description:
                "0-based character offset into the first requested line (continue a clipped line's tail)",
            },
          },
        },
        execute: async (args) => {
          const offset = numOrUndef(args.offset);
          const limit = numOrUndef(args.limit);
          const charOffset = numOrUndef(args.char_offset);
          const maxChars = numOr(args.max_chars, DEFAULT_MAX_CHARS);
          const result =
            offset === undefined && limit === undefined && charOffset === undefined
              ? await ws.read_file(String(args.path ?? "."), maxChars)
              : await ws.read_file(String(args.path ?? "."), {
                  maxChars,
                  offset,
                  limit,
                  charOffset,
                });
          return json(result);
        },
      },
      {
        name: "workspace_list_dir",
        description: "List one directory level inside the workspace.",
        parameters: {
          type: "object",
          properties: { path: { ...pathProp, default: "." } },
        },
        execute: async (args) => json(await ws.list_dir(String(args.path ?? "."))),
      },
      {
        name: "workspace_search_text",
        description: "Regex search over workspace text files.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "regular expression to search for" },
            path: { ...pathProp, default: "." },
            max_matches: { type: "integer", default: DEFAULT_MAX_MATCHES },
          },
          required: ["pattern"],
        },
        execute: async (args) =>
          json(
            await ws.search_text(
              String(args.pattern ?? ""),
              String(args.path ?? "."),
              numOr(args.max_matches, DEFAULT_MAX_MATCHES),
            ),
          ),
      },
      {
        name: "workspace_write_file",
        description: "Create or overwrite a workspace file (requires approval).",
        parameters: {
          type: "object",
          properties: {
            path: pathProp,
            content: { type: "string", description: "full new file content (UTF-8)" },
          },
          required: ["path", "content"],
        },
        execute: async (args) =>
          json(await ws.write_file(String(args.path ?? ""), String(args.content ?? ""))),
      },
      {
        name: "workspace_edit_file",
        description:
          "Edit a workspace file by text match (requires approval). Whitespace, line-ending, and indentation drift are tolerated; an ambiguous match is refused unless replace_all is set.",
        parameters: {
          type: "object",
          properties: {
            path: pathProp,
            old: { type: "string", description: "text to replace; must identify one unique region" },
            new: { type: "string", description: "replacement text" },
            replace_all: { type: "boolean", default: false },
          },
          required: ["path", "old", "new"],
        },
        execute: async (args) =>
          json(
            await ws.edit_file(
              String(args.path ?? ""),
              String(args.old ?? ""),
              String(args.new ?? ""),
              Boolean(args.replace_all ?? false),
            ),
          ),
      },
      {
        name: "workspace_delete_file",
        description: "Delete a workspace file (requires approval).",
        parameters: {
          type: "object",
          properties: { path: pathProp },
          required: ["path"],
        },
        execute: async (args) => json(await ws.delete_file(String(args.path ?? ""))),
      },
      {
        name: "workspace_run_shell",
        description: "Run a bounded shell command in the workspace (requires approval).",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "shell command to run in the workspace" },
            timeout: { type: "number", default: null },
          },
          required: ["command"],
        },
        execute: async (args, signal) =>
          json(await ws.run_shell(String(args.command ?? ""), numOrUndef(args.timeout), signal)),
      },
    ];
  }
}

// ---------------------------------------------------------------------------
// WorkspaceRegistry: operator-registered workspace directories
// ---------------------------------------------------------------------------

/** One registered workspace (JSON shape matches python's workspace dataclass). */
export interface RegisteredWorkspace {
  id: string;
  name: string;
  /** Absolute path, resolved at registration time. */
  path: string;
}

/**
 * Stored workspace-name cap (`rename` trims to it instead of rejecting a long
 * name; the operator sees the stored value come back).
 */
export const WORKSPACE_NAME_MAX_CHARS = 120;

/** `re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")` or "workspace". */
function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "workspace";
}

function registryId(name: string): string {
  const hex =
    typeof randomUUID === "function"
      ? randomUUID().replace(/-/g, "").slice(0, 8)
      : Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
  return `${slugify(name)}-${hex}`;
}

/**
 * JSON-backed registry of operator-selected workspace directories.
 * Ports the original prototype's workspace registry (removed 2026-11-04; see
 * git history). A workspace is
 * **registered, never scanned** — the operator picks a local directory and
 * the registry validates it exists; sessions link to it through metadata.
 */
export class WorkspaceRegistry {
  readonly filePath: string;
  private readonly _workspaces = new Map<string, RegisteredWorkspace>();

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
    } catch {
      return;
    }
    if (typeof raw !== "object" || raw === null) return;
    const items = (raw as Record<string, unknown>).workspaces;
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (typeof item !== "object" || item === null) continue;
      const ws = item as Record<string, unknown>;
      if (typeof ws.id !== "string" || typeof ws.name !== "string" || typeof ws.path !== "string") {
        continue;
      }
      this._workspaces.set(ws.id, { id: ws.id, name: ws.name, path: ws.path });
    }
  }

  private persist(): void {
    const payload = {
      workspaces: [...this._workspaces.values()].map((ws) => ({ ...ws })),
    };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2), "utf-8");
  }

  list(): RegisteredWorkspace[] {
    return [...this._workspaces.values()].map((ws) => ({ ...ws }));
  }

  get(workspaceId: string): RegisteredWorkspace | null {
    return this._workspaces.get(workspaceId) ?? null;
  }

  add(pathname: string, name?: string | undefined): RegisteredWorkspace {
    if (!pathname || !pathname.trim()) {
      throw new WorkspaceError("path must not be empty");
    }
    const resolved = path.resolve(pathname);
    let isDir = false;
    try {
      isDir = fs.statSync(resolved).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) throw new WorkspaceError(`not a directory: ${resolved}`);
    for (const ws of this._workspaces.values()) {
      if (ws.path === resolved) throw new WorkspaceError(`already registered: ${resolved}`);
    }
    let base = path.basename(resolved);
    try {
      // a trailing-slash root like "C:\\" has no basename — use the drive
      const real = fs.realpathSync(resolved);
      base = path.basename(real) || base;
    } catch {
      // keep the path-based basename
    }
    const derived = name ?? (base || "workspace");
    const wsName = derived.trim() || "workspace";
    const ws: RegisteredWorkspace = { id: registryId(wsName), name: wsName, path: resolved };
    this._workspaces.set(ws.id, ws);
    this.persist();
    return { ...ws };
  }

  remove(workspaceId: string): boolean {
    if (!this._workspaces.delete(workspaceId)) return false;
    this.persist();
    return true;
  }

  /**
   * Rename one registered workspace. The name is trimmed and capped at
   * `WORKSPACE_NAME_MAX_CHARS` (a long name is stored truncated, never
   * rejected); registration order is unchanged. Throws `WorkspaceError` for
   * an unknown id or a blank name.
   */
  rename(workspaceId: string, name: string): RegisteredWorkspace {
    const existing = this._workspaces.get(workspaceId);
    if (existing === undefined) throw new WorkspaceError(`unknown workspace: ${workspaceId}`);
    const trimmed = name.trim();
    if (!trimmed) throw new WorkspaceError("name must not be empty");
    // Code points so a name that ends on an astral character is never split.
    const capped = [...trimmed].slice(0, WORKSPACE_NAME_MAX_CHARS).join("");
    const updated: RegisteredWorkspace = { ...existing, name: capped };
    // Map#set on an existing key keeps its insertion position.
    this._workspaces.set(workspaceId, updated);
    this.persist();
    return { ...updated };
  }

  /**
   * Operator-controlled ordering: `ids` must be an exact permutation of the
   * registered ids. Validated fully before anything is mutated, so an error
   * never leaves a partial order behind; success persists and returns the
   * whole list in the new order.
   */
  reorder(ids: string[]): RegisteredWorkspace[] {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) throw new WorkspaceError(`duplicate workspace id: ${id}`);
      if (!this._workspaces.has(id)) throw new WorkspaceError(`unknown workspace: ${id}`);
      seen.add(id);
    }
    for (const id of this._workspaces.keys()) {
      if (!seen.has(id)) throw new WorkspaceError(`missing workspace: ${id}`);
    }
    const ordered = ids.map((id) => this._workspaces.get(id) as RegisteredWorkspace);
    this._workspaces.clear();
    for (const ws of ordered) this._workspaces.set(ws.id, ws);
    this.persist();
    return this.list();
  }
}
