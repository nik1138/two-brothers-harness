/**
 * TUI find-in-transcript suite (Ctrl+F).
 *
 * Covers the pure findbar state machine (literal case-insensitive matching,
 * Unicode offsets, match cap, live filtering, wrap-around navigation, honest
 * no-match/empty states, refresh while streaming), the exact-cell find-bar
 * renderer (width, counter, hints, preview markers, active-match cells), the
 * registry entry (Ctrl+F command, conflict freedom, help/palette exposure, the
 * `find` key scope), the transcript gutter marker/scroll anchor it drives, and
 * the assembled app over fake TTY streams (open, narrow, navigate, scroll,
 * Esc restore, no session/history mutation).
 *
 * Run with: node --test tests/tuifind.test.ts
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { resolveConfig } from "../src/config.ts";
import type { Message } from "../src/protocol.ts";
import { runTuiApp, type TuiAppOptions } from "../src/tui/app.ts";
import { createEditor } from "../src/tui/editor.ts";
import { loadHistory } from "../src/tui/historystore.ts";
import {
  TUI_COMMANDS,
  documentEntries,
  findCommand,
  findSlashCommand,
  formatChord,
  formatKeys,
  matchChord,
  paletteEntries,
  resolveKey,
  tuiHelpLines,
  type KeyLike,
} from "../src/tui/keymap.ts";
import {
  addNotice,
  addToolCall,
  addToolResult,
  addUserBlock,
  appendEnvelopeDelta,
  commitEnvelope,
  createTuiModel,
} from "../src/tui/model.ts";
import { ANSI } from "../src/tui/render.ts";
import {
  activeFindMatch,
  appendFindText,
  closeFind,
  findBarHints,
  findBarView,
  findCorpus,
  findKey,
  findStatusText,
  moveFindSelection,
  openFind,
  refreshFind,
  renderFindBar,
  searchFindMatches,
  setFindQuery,
  updateFindQuery,
  DEFAULT_FIND_MAX_MATCHES,
  type FindBlockText,
  type FindState,
} from "../src/tui/view/findbar.ts";
import { screenView } from "../src/tui/view/screen.ts";
import {
  latestTranscriptScroll,
  scrollToBlock,
  transcriptView,
} from "../src/tui/view/transcript.ts";
import { renderBlock } from "../src/tui/transcript.ts";
import { stripAnsi, styledWidth } from "../src/tui/screen.ts";
import { displayWidth } from "../src/tui/text.ts";
import { createTheme, plainTheme } from "../src/tui/theme.ts";

const AT = "2026-11-04T00:00:00Z";

function message(
  id: string,
  from: string,
  kind: string,
  payload: Record<string, unknown>,
  seq = 1,
): Message {
  return { v: 1, id, seq, ts: AT, from, to: from === "user" ? "senior" : "user", kind, payload };
}

function key(name: string, raw = name, modifiers: Partial<KeyLike> = {}): KeyLike {
  return { name, raw, ...modifiers };
}

/** A synthetic corpus: one block per text, ids `b1`, `b2`, … */
function blocksOf(...texts: string[]): FindBlockText[] {
  return texts.map((text, index) => ({ id: `b${index + 1}`, text }));
}

/** Fold one typed string into the find reducer, one grapheme/chunk per key. */
function typeFind(state: FindState, text: string, commands = TUI_COMMANDS): FindState {
  let next = state;
  for (const char of text) next = findKey(commands, next, key(char)).state;
  return next;
}

// --------------------------------------------------------------------------- //
// corpus and matching
// --------------------------------------------------------------------------- //

test("find corpus holds the full text of every block kind, streaming drafts included", () => {
  let model = createTuiModel();
  model = addUserBlock(model, "user task needle");
  model = addNotice(model, "error", "notice text", { details: "notice detail needle" });
  model = addToolCall(model, {
    role: "junior",
    tool: "echo",
    callId: "call-1",
    args: '{"a":"arg needle"}',
  });
  model = addToolResult(model, {
    role: "junior",
    tool: "echo",
    status: "ok",
    callId: "call-1",
    result: "result needle",
  });
  model = commitEnvelope(
    model,
    message("j1", "junior", "deliverable", { result: "deliverable needle" }),
  );
  model = commitEnvelope(
    model,
    message("s1", "senior", "decision", {
      decision: "decision needle",
      rationale: "rationale needle",
      dissent: "dissent needle",
    }),
  );
  model = appendEnvelopeDelta(model, { role: "senior", delta: "streaming needle" });

  const corpus = findCorpus(model);
  assert.equal(corpus.length, model.blocks.length);
  assert.deepEqual(
    corpus.map((block) => block.id),
    model.blocks.map((block) => block.id),
    "match offsets stay keyed to the document ids",
  );
  const text = corpus.map((block) => block.text).join("\n");
  for (const expected of [
    "user task needle",
    "notice detail needle",
    "arg needle",
    "result needle",
    "deliverable needle",
    "decision needle",
    "rationale needle",
    "dissent needle",
    "streaming needle",
  ]) {
    assert.ok(text.includes(expected), expected);
  }
  const result = searchFindMatches(corpus, "needle");
  assert.equal(result.total, 9);
  assert.equal(result.capped, false);
  assert.equal(new Set(result.matches.map((match) => match.blockId)).size, 6);
});

test("matching is literal, case-insensitive, non-overlapping and offset-correct", () => {
  const corpus = blocksOf("Hello HELLO hello");
  const result = searchFindMatches(corpus, "hello");
  assert.equal(result.total, 3);
  assert.deepEqual(result.matches.map((match) => match.text), ["Hello", "HELLO", "hello"]);
  assert.deepEqual(result.matches.map((match) => match.start), [0, 6, 12]);
  for (const match of result.matches) {
    assert.equal(corpus[0]?.text.slice(match.start, match.end), match.text);
    assert.equal(match.blockId, "b1");
  }

  // `.` and `(` are searched literally, never compiled as a regexp.
  assert.equal(searchFindMatches(blocksOf("axb a.b"), "a.b").total, 1);
  assert.equal(searchFindMatches(blocksOf("axb a.b"), "a.b").matches[0]?.text, "a.b");
  assert.equal(searchFindMatches(blocksOf("hello"), "(").total, 0);
  // Non-overlapping, left to right.
  assert.equal(searchFindMatches(blocksOf("aaa"), "aa").total, 1);
  // Empty query searches nothing.
  assert.deepEqual(searchFindMatches(corpus, ""), { matches: [], total: 0, capped: false });
});

test("the match cap keeps counting past the stored list and reports capped", () => {
  const capped = searchFindMatches(blocksOf("x".repeat(12)), "x", { maxMatches: 5 });
  assert.equal(capped.matches.length, 5);
  assert.equal(capped.total, 12);
  assert.equal(capped.capped, true);

  const under = searchFindMatches(blocksOf("x".repeat(12)), "x");
  assert.equal(under.matches.length, 12);
  assert.equal(under.total, 12);
  assert.equal(under.capped, false);

  const huge = searchFindMatches(blocksOf("y".repeat(DEFAULT_FIND_MAX_MATCHES + 100)), "y");
  assert.equal(huge.matches.length, DEFAULT_FIND_MAX_MATCHES);
  assert.equal(huge.total, DEFAULT_FIND_MAX_MATCHES + 100);
  assert.equal(huge.capped, true);
});

// --------------------------------------------------------------------------- //
// pure state machine
// --------------------------------------------------------------------------- //

test("open/set/append/close keep immutable state and sanitize a pasted query", () => {
  const corpus = blocksOf("Alpha beta alpha", "gamma ALPHA");
  let state = openFind(corpus);
  assert.equal(state.open, true);
  assert.equal(state.query, "");
  assert.equal(state.matches.length, 0, "an empty query searches nothing");
  assert.equal(state.total, 0);
  assert.equal(state.noMatch, false);
  assert.deepEqual(state.blocks, corpus);

  const typed = setFindQuery(state, "alpha");
  assert.equal(state.query, "", "the previous state was not mutated");
  assert.equal(typed.query, "alpha");
  assert.equal(typed.total, 3);
  assert.equal(typed.matches[0]?.blockId, "b1");
  assert.equal(typed.noMatch, false);

  const appended = appendFindText(setFindQuery(openFind(corpus), "al"), "pha");
  assert.equal(appended.query, "alpha");
  assert.equal(appended.total, 3);
  assert.deepEqual(updateFindQuery(openFind(corpus), "alpha").matches, appended.matches);

  const pasted = appendFindText(
    openFind(corpus),
    "one\ntwo\tthree\u001b[31mred",
  );
  assert.ok(!pasted.query.includes("\n"), "pastes collapse into one line");
  assert.ok(!pasted.query.includes("\t"));
  assert.ok(!pasted.query.includes("\u001b"), "escape sequences are stripped");
  assert.match(pasted.query, /one two/);

  assert.equal(closeFind(typed).open, false);
  assert.deepEqual(renderFindBar(closeFind(typed), { width: 40 }), []);
});

test("typing filters live and case-insensitively; Backspace re-widens", () => {
  const corpus = blocksOf("alpha beta", "beta gamma", "GAMMA delta");
  let state = openFind(corpus);
  for (const char of "beta") {
    const result = findKey(TUI_COMMANDS, state, key(char));
    assert.equal(result.action, "filter");
    state = result.state;
  }
  assert.equal(state.query, "beta");
  assert.equal(state.total, 2);
  assert.deepEqual(state.matches.map((match) => match.blockId), ["b1", "b2"]);

  const erased = findKey(TUI_COMMANDS, state, key("backspace", "\u007f"));
  assert.equal(erased.action, "filter");
  assert.equal(erased.state.query, "bet");
  assert.equal(erased.state.total, 2);

  state = typeFind(openFind(corpus), "GAMMA");
  assert.equal(state.query, "GAMMA");
  assert.equal(state.total, 2, "the uppercase query matches both cases");
  assert.equal(state.matches[0]?.blockId, "b2");
  assert.equal(state.matches[0]?.text, "gamma");
  assert.equal(state.matches[1]?.text, "GAMMA");
});

test("registry chords navigate matches with wrap-around; Esc and Ctrl+F close", () => {
  const corpus = blocksOf("one match", "two match", "three match");
  const state = setFindQuery(openFind(corpus), "match");
  assert.equal(state.total, 3);
  assert.equal(state.active, 0);
  assert.equal(activeFindMatch(state)?.match.blockId, "b1");

  const next = findKey(TUI_COMMANDS, state, key("return", "\r"));
  assert.equal(next.action, "move");
  assert.equal(next.state.active, 1);
  assert.equal(findKey(TUI_COMMANDS, next.state, key("down", "\u001b[B")).state.active, 2);
  const wrapped = findKey(
    TUI_COMMANDS,
    findKey(TUI_COMMANDS, next.state, key("down", "\u001b[B")).state,
    key("return", "\r"),
  );
  assert.equal(wrapped.state.active, 0, "next wraps to the first match");

  const prev = findKey(TUI_COMMANDS, state, key("return", "\r", { shift: true }));
  assert.equal(prev.action, "move");
  assert.equal(prev.state.active, 2, "previous wraps to the last match");
  assert.equal(
    findKey(TUI_COMMANDS, prev.state, key("up", "\u001b[A")).state.active,
    1,
    "Up is previous",
  );

  const escape = findKey(TUI_COMMANDS, state, key("escape", "\u001b"));
  assert.equal(escape.action, "close");
  assert.equal(escape.state, state, "closing never mutates the state");
  assert.equal(findKey(TUI_COMMANDS, state, key("f", "\u0006", { ctrl: true })).action, "close");

  // Unrelated chords (palette, editor) are not handled by the find bar.
  assert.equal(findKey(TUI_COMMANDS, state, key("p", "\u0010", { ctrl: true })).action, "none");
  assert.equal(findKey(TUI_COMMANDS, state, key("tab", "\t")).action, "none");
  assert.equal(findKey(TUI_COMMANDS, closeFind(state), key("return", "\r")).action, "none");
});

test("Enter/Down with no matches is an honest no-op with a no-match action", () => {
  const state = setFindQuery(openFind(blocksOf("alpha")), "zzz");
  assert.equal(state.total, 0);
  assert.equal(state.noMatch, true);
  assert.equal(findKey(TUI_COMMANDS, state, key("return", "\r")).action, "no-match");
  assert.equal(findKey(TUI_COMMANDS, state, key("down", "\u001b[B")).action, "no-match");
  assert.equal(findKey(TUI_COMMANDS, state, key("up", "\u001b[A")).action, "no-match");
  assert.equal(findStatusText(state), "no matches");
  assert.equal(findStatusText(openFind([])), "type to search");
});

test("Unicode matching is grapheme-safe and Backspace drops whole graphemes", () => {
  const corpus = blocksOf("Привет 你好 😀😀");
  const cyrillic = typeFind(openFind(corpus), "ПРИВЕТ");
  assert.equal(cyrillic.total, 1);
  assert.equal(cyrillic.matches[0]?.text, "Привет", "original case is preserved in the match");
  const first = cyrillic.matches[0];
  assert.ok(first);
  assert.equal(corpus[0]?.text.slice(first.start, first.end), first.text);

  const cjk = setFindQuery(openFind(corpus), "你好");
  assert.equal(cjk.total, 1);
  const cjkMatch = cjk.matches[0];
  assert.ok(cjkMatch);
  assert.equal(corpus[0]?.text.slice(cjkMatch.start, cjkMatch.end), "你好");

  assert.equal(setFindQuery(openFind(corpus), "😀").total, 2);
  assert.equal(setFindQuery(openFind(corpus), "😀😀").total, 1, "non-overlapping by grapheme");

  const family = "👨‍👩‍👧‍👦";
  let state = setFindQuery(openFind(corpus), `${family}x`);
  state = findKey(TUI_COMMANDS, state, key("backspace", "\u007f")).state;
  assert.equal(state.query, family, "an emoji ZWJ sequence is one cluster");
  state = findKey(TUI_COMMANDS, state, key("backspace", "\u007f")).state;
  assert.equal(state.query, "");
});

test("refreshFind keeps the query, adds streamed matches and clamps the active index", () => {
  let model = addUserBlock(createTuiModel(), "start of the turn");
  let state = setFindQuery(openFind(findCorpus(model)), "needle");
  assert.equal(state.total, 0);
  assert.equal(state.noMatch, true);

  model = appendEnvelopeDelta(model, { role: "senior", delta: "a needle appears" });
  state = refreshFind(state, findCorpus(model));
  assert.equal(state.query, "needle", "the query survives the refresh");
  assert.equal(state.total, 1);
  assert.equal(state.noMatch, false);
  const streamedId = model.blocks[1]?.id;
  assert.equal(activeFindMatch(state)?.match.blockId, streamedId);

  // The active index clamps when the match list shrinks under it.
  let state2 = setFindQuery(openFind(blocksOf("needle one", "needle two")), "needle");
  state2 = moveFindSelection(state2, 1);
  assert.equal(state2.active, 1);
  state2 = refreshFind(state2, blocksOf("needle only"));
  assert.equal(state2.active, 0);
  assert.equal(moveFindSelection(openFind([]), 1).active, 0);
});

// --------------------------------------------------------------------------- //
// rendering
// --------------------------------------------------------------------------- //

test("find bar hints come from the registry, in full and compact form", () => {
  assert.equal(findBarHints(TUI_COMMANDS), "Enter next · Shift+Enter prev · Esc close");
  assert.equal(findBarHints(TUI_COMMANDS, { compact: true }), "Enter next · Esc close");
  const next = findCommand(TUI_COMMANDS, "find-next");
  const close = findCommand(TUI_COMMANDS, "find-close");
  assert.ok(next && close);
  assert.equal(formatChord(next.keys![0]!), "Enter");
  assert.equal(formatChord(close.keys![0]!), "Esc");
});

test("find bar renders exact cells for empty, matching, no-match and capped states", () => {
  const corpus = blocksOf("the quick brown fox jumps over the lazy brown dog");
  const matching = setFindQuery(openFind(corpus), "brown");
  assert.equal(matching.total, 2);

  // `renderFindBar(state, width)` is the compact call shape the app uses.
  const emptyRow = renderFindBar(openFind(corpus), 60)[0] ?? "";
  assert.ok(emptyRow.includes("type to search"));
  assert.ok(emptyRow.includes("Enter next"), "empty bar still advertises navigation");
  assert.equal(displayWidth(emptyRow), 60);

  const noMatchRow = renderFindBar(setFindQuery(openFind(corpus), "zzz"), { width: 60 })[0] ?? "";
  assert.ok(noMatchRow.includes("no matches"));

  // A whitespace-only query is still searched (and counted) even though its
  // characters are invisible in the prompt; the marker stays visible.
  const spaceState = setFindQuery(openFind(blocksOf("a b c")), " ");
  assert.equal(spaceState.total, 2);
  const spaceRow = renderFindBar(spaceState, { width: 40 })[0] ?? "";
  assert.ok(spaceRow.includes("1/2"));
  assert.ok(spaceRow.includes("« »"), "a whitespace match is marked, never an empty marker");

  const cappedRow = renderFindBar(
    setFindQuery(openFind(blocksOf("x".repeat(600))), "x"),
    { width: 80 },
  )[0] ?? "";
  assert.ok(cappedRow.includes("1/500 +100"), "the cap is surfaced honestly");

  for (const width of [0, 1, 2, 5, 10, 20, 40, 80, 120, 200]) {
    for (const state of [openFind(corpus), matching, setFindQuery(openFind(corpus), "zzz")]) {
      const view = findBarView(state, { width });
      assert.equal(view.lines.length, 1, `width ${width}: one bar row`);
      const row = view.lines[0] ?? "";
      assert.equal(displayWidth(row), width, `width ${width}: exact cells`);
      assert.ok(!row.includes("\u001b"), `width ${width}: NO_COLOR output leaks no ANSI`);
    }
  }

  const narrow = renderFindBar(
    setFindQuery(openFind(corpus), "q".repeat(100)),
    { width: 20 },
  )[0] ?? "";
  assert.equal(displayWidth(narrow), 20);
  assert.ok(narrow.includes("…"), "an over-long query truncates with an ellipsis");
  assert.equal(renderFindBar(closeFind(matching), { width: 40 }).length, 0);
});

test("find bar marks the active match with «» and exposes its cells", () => {
  const corpus = blocksOf("the quick brown fox jumps over the lazy brown dog");
  const state = setFindQuery(openFind(corpus), "brown");
  const view = findBarView(state, { width: 80 });
  const row = view.lines[0] ?? "";
  assert.equal(displayWidth(row), 80);
  assert.ok(row.startsWith("FIND > brown"));
  assert.ok(row.includes("1/2"), "counter shows current/total");
  assert.ok(row.includes("«brown»"), "the active match wears the textual marker");
  assert.ok(row.includes("Enter next"));
  assert.ok(row.includes("Esc close"));
  assert.ok(view.activeSpan !== undefined);
  const span = view.activeSpan!;
  assert.equal(row.slice(span.start, span.end), "brown", "activeSpan gives the match cells");

  // Narrower widths keep the row exact and simply drop groups.
  for (const width of [10, 20, 30, 50, 60]) {
    const sized = findBarView(state, { width });
    for (const line of sized.lines) assert.equal(displayWidth(line), width);
  }

  // A color theme inverts the marked span but keeps every row exactly `width`.
  const themed = findBarView(state, { width: 80, theme: createTheme("dark") }).lines[0] ?? "";
  assert.equal(styledWidth(themed), 80);
  assert.ok(themed.includes("\u001b["), "the theme carries the highlight");
  assert.ok(stripAnsi(themed).includes("«brown»"));
});

test("the active find block wears a ▸ gutter marker without changing row width", () => {
  let model = addUserBlock(createTuiModel(), "first block");
  model = addUserBlock(model, "second block");
  const first = model.blocks[0]!;
  const second = model.blocks[1]!;

  const marked = renderBlock(first, { width: 40, activeBlockId: first.id });
  assert.ok(styledWidth(marked[0]!) <= 40);
  assert.ok(marked[0]!.startsWith("▸YOU"), "plain output still carries the marker");
  assert.equal(marked[0]!.indexOf("first block"), 8, "the label gutter keeps its exact width");
  const inactive = renderBlock(first, { width: 40 });
  assert.ok(inactive[0]!.startsWith("YOU"));
  assert.equal(inactive[0]!.indexOf("first block"), 8, "same gutter width without the marker");

  const bystander = renderBlock(second, { width: 40, activeBlockId: first.id });
  assert.ok(!bystander[0]!.includes("▸"), "only the active block is marked");

  const compact = renderBlock(first, { width: 12, activeBlockId: first.id });
  assert.ok(compact[0]!.startsWith("▸YOU"));
});

test("screenView places the find bar directly above the status bar and shrinks the body", () => {
  let model = addUserBlock(createTuiModel(), "hello world");
  model = addUserBlock(model, "second block");
  const base = {
    width: 80,
    height: 24,
    model,
    editor: createEditor("draft"),
    status: {
      mode: "consult" as const,
      seniorModel: "s",
      juniorModel: "j",
      sessionName: "new",
      cwd: "/work",
    },
    theme: plainTheme,
  };
  const plain = screenView(base);
  const found = screenView({
    ...base,
    findBar: ["FIND > hi  1/1  «hi»"],
    findBlockId: model.blocks[0]!.id,
  });
  assert.equal(found.lines.length, 24);
  for (const row of found.lines) assert.equal(styledWidth(row), 80);
  assert.ok(!found.lines.join("\n").includes("\u001b"), "NO_COLOR frames stay plain");

  const barRow = found.lines[found.lines.length - 3] ?? "";
  assert.ok(barRow.startsWith("FIND > hi"), "the bar sits above the two status rows");
  assert.equal(found.transcript?.lines.length, (plain.transcript?.lines.length ?? 0) - 1);
  assert.ok(found.lines.join("\n").includes("▸YOU"), "the active block is marked in the frame");
  assert.ok(!plain.lines.join("\n").includes("FIND >"), "a closed bar changes nothing");
});

test("scrollToBlock anchors the transcript on the active match block", () => {
  let model = createTuiModel();
  for (let index = 0; index < 8; index += 1) {
    model = addUserBlock(model, `block ${index} ${"text ".repeat(8)}`);
  }
  const target = model.blocks[3]!;
  const view = transcriptView(model, {
    width: 40,
    height: 6,
    scroll: scrollToBlock(target.id),
  });
  assert.equal(view.visibleBlockIds[0], target.id, "the match block starts the viewport");
  assert.equal(view.atLatest, false);

  const latest = transcriptView(model, {
    width: 40,
    height: 6,
    scroll: latestTranscriptScroll(),
  });
  assert.ok(!latest.visibleBlockIds.includes(model.blocks[0]!.id), "the default view is at the end");
  assert.ok(!latest.visibleBlockIds.includes(target.id));

  const missing = transcriptView(model, {
    width: 40,
    height: 6,
    scroll: scrollToBlock("does-not-exist"),
  });
  assert.equal(missing.atLatest, true, "an unknown anchor falls back to the newest rows");
});

// --------------------------------------------------------------------------- //
// registry
// --------------------------------------------------------------------------- //

test("Ctrl+F is a conflict-free registry command exposed in help, palette and slash input", () => {
  const command = findCommand(TUI_COMMANDS, "find");
  assert.ok(command);
  assert.equal(formatKeys(command), "Ctrl+F");
  assert.equal(command.when, "app");
  assert.equal(command.title, "Find in transcript");
  assert.equal(findSlashCommand(TUI_COMMANDS, "find")?.id, "find");
  assert.equal(findSlashCommand(TUI_COMMANDS, "FIND")?.id, "find");
  assert.ok(paletteEntries(TUI_COMMANDS).some((entry) => entry.id === "find"));
  assert.ok(documentEntries(TUI_COMMANDS).some((entry) => entry.id === "find"));
  assert.match(
    tuiHelpLines(TUI_COMMANDS).join("\n"),
    /Ctrl\+F\s+Search every transcript block/,
  );

  const chord = key("f", "\u0006", { ctrl: true });
  assert.equal(resolveKey(TUI_COMMANDS, chord)?.command.id, "find");
  const conflicts = TUI_COMMANDS.filter(
    (candidate) =>
      candidate.id !== "find" && (candidate.keys ?? []).some((entry) => matchChord(entry, chord)),
  );
  assert.deepEqual(conflicts.map((candidate) => candidate.id), []);

  // The existing key precedence is untouched in the app scope.
  assert.equal(resolveKey(TUI_COMMANDS, key("return", "\r"))?.command.id, "submit");
  assert.equal(resolveKey(TUI_COMMANDS, key("return", "\r", { shift: true }))?.command.id, "newline");
  assert.equal(resolveKey(TUI_COMMANDS, key("up", "\u001b[A"))?.command.id, "history");
  assert.equal(resolveKey(TUI_COMMANDS, key("escape", "\u001b"))?.command.id, "cancel");
  assert.equal(resolveKey(TUI_COMMANDS, key("r", "\u0012", { ctrl: true }))?.command.id, "history-search");
  assert.equal(resolveKey(TUI_COMMANDS, key("o", "\u000f", { ctrl: true }))?.command.id, "stash");
  assert.equal(resolveKey(TUI_COMMANDS, key("t", "\u0014", { ctrl: true }))?.command.id, "tool-expand");
  assert.equal(resolveKey(TUI_COMMANDS, key("b", "\u0002", { ctrl: true }))?.command.id, "panel");
  assert.equal(resolveKey(TUI_COMMANDS, key("p", "\u0010", { ctrl: true }))?.command.id, "palette");

  // The find scope owns only find navigation.
  assert.equal(resolveKey(TUI_COMMANDS, key("return", "\r"), "find")?.command.id, "find-next");
  assert.equal(resolveKey(TUI_COMMANDS, key("down", "\u001b[B"), "find")?.command.id, "find-next");
  assert.equal(
    resolveKey(TUI_COMMANDS, key("return", "\r", { shift: true }), "find")?.command.id,
    "find-prev",
  );
  assert.equal(resolveKey(TUI_COMMANDS, key("up", "\u001b[A"), "find")?.command.id, "find-prev");
  assert.equal(resolveKey(TUI_COMMANDS, key("escape", "\u001b"), "find")?.command.id, "find-close");
  assert.equal(resolveKey(TUI_COMMANDS, key("p", "\u0010", { ctrl: true }), "find"), null);
  assert.equal(resolveKey(TUI_COMMANDS, key("return", "\r"), "find")?.command.when, "find");
});

// --------------------------------------------------------------------------- //
// assembled app (fake TTY streams)
// --------------------------------------------------------------------------- //

class FakeInput extends EventEmitter {
  isTTY = true;
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  setEncoding(): void {}
  unref(): void {}

  type(text: string): void {
    for (const char of text) {
      this.emit("keypress", char, {
        name: char,
        ctrl: false,
        shift: char !== char.toLowerCase(),
      });
    }
  }

  key(name: string, modifiers: { ctrl?: boolean; shift?: boolean; raw?: string } = {}): void {
    this.emit("keypress", modifiers.raw ?? "", {
      name,
      ctrl: modifiers.ctrl === true,
      shift: modifiers.shift === true,
    });
  }

  enter(): void {
    this.key("return", { raw: "\r" });
  }

  ctrlF(): void {
    this.key("f", { ctrl: true, raw: "\u0006" });
  }

  ctrlP(): void {
    this.key("p", { ctrl: true, raw: "\u0010" });
  }
}

class FakeOutput extends EventEmitter {
  isTTY = true;
  columns = 80;
  rows = 24;
  data = "";
  write(chunk: string): boolean {
    this.data += chunk;
    return true;
  }
}

interface AppHarness {
  app: Promise<number>;
  input: FakeInput;
  output: FakeOutput;
}

function tmpdir(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tui-find-"));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function startApp(root: string, extra: Partial<TuiAppOptions> = {}): AppHarness {
  const input = new FakeInput();
  const output = new FakeOutput();
  const app = runTuiApp({
    cfg: resolveConfig({ provider: "mock" }),
    io: { log: () => {}, error: () => {} },
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
    pluginsDir: path.join(root, "plugins"),
    sessionsDir: path.join(root, "sessions"),
    ...extra,
  });
  return { app, input, output };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

const textOf = (output: FakeOutput): string => stripAnsi(output.data);

function lastFrameText(output: FakeOutput): string {
  const frames = output.data.split(ANSI.cursorHome);
  return stripAnsi(frames.at(-1) ?? "");
}

/** The row of the latest frame that carries the find bar, or "". */
function findBarLine(output: FakeOutput): string {
  return (
    lastFrameText(output)
      .split("\n")
      .find((line) => line.includes("FIND >")) ?? ""
  );
}

/** The `current/total` counter of the latest frame's find bar. */
function findCounter(output: FakeOutput): { current: number; total: number } | null {
  const hit = /(\d+)\/(\d+)/.exec(findBarLine(output));
  return hit === null
    ? null
    : { current: Number.parseInt(hit[1] ?? "0", 10), total: Number.parseInt(hit[2] ?? "0", 10) };
}

function waitIdle(output: FakeOutput, timeoutMs = 5_000): Promise<boolean> {
  return waitFor(
    () => /ready —|turn completed|turn failed|turn cancelled/.test(lastFrameText(output)),
    timeoutMs,
  );
}

async function quit(input: FakeInput, app: Promise<number>): Promise<number> {
  for (let press = 0; press < 8; press += 1) {
    input.key("escape");
    const settled = await Promise.race([
      app.then((code) => code as number | "pending"),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 200)),
    ]);
    if (settled !== "pending") return settled;
  }
  const code = await Promise.race([
    app,
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 10_000)),
  ]);
  if (code === "timeout") throw new Error("the TUI did not exit after repeated Escape");
  return code;
}

async function stop(harness: AppHarness, root: string): Promise<void> {
  try {
    assert.equal(await quit(harness.input, harness.app), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("Ctrl+F opens the inline bar, respects an open overlay and Esc restores the draft", async () => {
  const { root } = tmpdir();
  const harness = startApp(root);
  const { input, output } = harness;
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
    input.type("draft phrase");
    assert.ok(await waitFor(() => lastFrameText(output).includes("draft phrase")));

    // A modal overlay keeps its own key handling: Ctrl+F does not open find.
    input.ctrlP();
    assert.ok(await waitFor(() => lastFrameText(output).includes("COMMANDS")));
    input.ctrlF();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.ok(!lastFrameText(output).includes("FIND >"), "the palette keeps precedence");
    input.key("escape");
    assert.ok(await waitFor(() => !lastFrameText(output).includes("COMMANDS")));

    // Ctrl+F opens the bar; typing filters live; Esc closes without touching the draft.
    input.ctrlF();
    assert.ok(await waitFor(() => lastFrameText(output).includes("FIND > type to search")));
    assert.ok(lastFrameText(output).includes("draft phrase"), "the composer stays visible");
    input.type("zzz");
    assert.ok(await waitFor(() => lastFrameText(output).includes("FIND > zzz")));
    assert.ok(lastFrameText(output).includes("no matches"), "no match is stated honestly");
    assert.equal(findBarLine(output).includes("draft phrase"), false);
    input.key("escape");
    assert.ok(await waitFor(() => !lastFrameText(output).includes("FIND >")));
    assert.ok(lastFrameText(output).includes("draft phrase"), "Esc restores the exact draft");

    // Clearing the draft lets the slash form open the same bar.
    input.key("escape");
    assert.ok(await waitFor(() => lastFrameText(output).includes("composer cleared")));
    input.type("/find hello");
    input.enter();
    assert.ok(await waitFor(() => findBarLine(output).includes("FIND > hello")));
    assert.ok(lastFrameText(output).includes("no matches"), "the empty transcript has no matches");
    input.key("escape");
    assert.ok(await waitFor(() => !lastFrameText(output).includes("FIND >")));

    // The palette entry dispatches the same command.
    input.ctrlP();
    assert.ok(await waitFor(() => lastFrameText(output).includes("COMMANDS")));
    input.type("find");
    assert.ok(await waitFor(() => lastFrameText(output).includes("Find in transcript")));
    input.enter();
    assert.ok(await waitFor(() => lastFrameText(output).includes("FIND > type to search")));
    input.key("escape");
    assert.ok(await waitFor(() => !lastFrameText(output).includes("FIND >")));
  } finally {
    await stop(harness, root);
  }
});

test("a post-turn find narrows, navigates, scrolls and never mutates history", async () => {
  const { root } = tmpdir();
  const historyFile = path.join(root, "tui-history.json");
  const harness = startApp(root, { historyFile });
  const { input, output } = harness;
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
    input.type("say hello");
    input.enter();
    assert.ok(await waitFor(() => textOf(output).includes("decision:"), 30_000));
    assert.ok(await waitIdle(output));
    assert.deepEqual(loadHistory(historyFile), ["say hello"]);

    input.ctrlF();
    assert.ok(await waitFor(() => lastFrameText(output).includes("FIND > type to search")));
    input.type("hello");
    assert.ok(await waitFor(() => findBarLine(output).includes("FIND > hello")));
    const first = findCounter(output);
    assert.ok(first !== null, "the bar shows a counter");
    assert.equal(first.current, 1);
    assert.ok(first.total >= 2, `"hello" occurs in several envelopes (${first.total})`);
    assert.ok(findBarLine(output).includes("«hello»"), "the active match is marked in the preview");
    assert.ok(
      await waitFor(() => lastFrameText(output).includes("YOU")),
      "the first match's block was scrolled into view",
    );

    // Enter and Down walk matches; the counter follows the active index.
    input.enter();
    assert.ok(await waitFor(() => findCounter(output)?.current === 2), "Enter selects the next match");
    const second = findCounter(output);
    assert.equal(second?.total, first.total);
    input.key("down", { raw: "\u001b[B" });
    assert.ok(await waitFor(() => findCounter(output)?.current === (2 % first.total) + 1));

    // A dead-end query is honest and Backspace recovers it.
    input.type("zzz");
    assert.ok(await waitFor(() => findBarLine(output).includes("no matches")));
    for (let press = 0; press < 3; press += 1) {
      input.key("backspace", { raw: "\u007f" });
    }
    assert.ok(
      await waitFor(() => /FIND > hello\s{2}\d+\/\d+/.test(findBarLine(output))),
      "Backspace recovers the live matches",
    );
    assert.ok(findCounter(output) !== null);

    // Esc restores the composer/scroll state; no turn was submitted while finding.
    input.key("escape");
    assert.ok(await waitFor(() => !lastFrameText(output).includes("FIND >")));
    assert.deepEqual(
      loadHistory(historyFile),
      ["say hello"],
      "finding never records or mutates the prompt history",
    );
    input.type("draft after find");
    assert.ok(await waitFor(() => lastFrameText(output).includes("draft after find")));
  } finally {
    await stop(harness, root);
  }
});
