/**
 * TUI session-rewind suite: the chordless `/rewind` command end to end over
 * fake TTY streams and a real temp session store, plus the pure preview /
 * confirmation / notice model.
 *
 * The destructive flow is two-step on purpose: `/rewind` runs the service's
 * pure `computeRewindCut` first and opens a confirmation dialog with **Cancel
 * preselected**; only the explicit "Rewind and delete" action reaches
 * `rewindSession`. These tests pin both halves: the accept path removes the
 * last operator turn (envelopes, dense kept `seq`, cleared runtime sidecar,
 * kept transcript, reload through `adoptSession`) and every cancel/refusal
 * path leaves the session file byte-identical.
 *
 * Everything is hermetic: the mock provider drives turns, and the compaction
 * gate uses an ephemeral loopback endpoint (the same pattern
 * `tuifork.test.ts` uses).
 *
 * Run with: node --test tests/tuirewind.test.ts
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { COMPACTION_SUMMARY_PREFIX, COMPACTION_SUMMARY_SUFFIX } from "../src/compaction.ts";
import { resolveConfig } from "../src/config.ts";
import type { Message } from "../src/protocol.ts";
import { MockProvider, type Provider } from "../src/provider.ts";
import { runTuiApp, type TuiIO } from "../src/tui/app.ts";
import { ANSI, stripAnsi } from "../src/tui/render.ts";
import {
  boundRewindNotice,
  parseRewindCommandArgs,
  previewRewind,
  rewindConfirmation,
  rewindOutcomeNotice,
  REWIND_NOTICE_MAX_CHARS,
  REWIND_USAGE,
} from "../src/tui/rewindcommand.ts";

class FakeInput extends EventEmitter {
  isTTY = true;
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  setEncoding(): void {}
  unref(): void {}

  type(text: string): void {
    for (const char of text) {
      this.emit("keypress", char, { name: char, ctrl: false, shift: char !== char.toLowerCase() });
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
  resize(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    this.emit("resize");
  }
}

function makeIO(): TuiIO & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (line) => out.push(line), error: (line) => err.push(line) };
}

interface Harness {
  app: Promise<number>;
  input: FakeInput;
  output: FakeOutput;
  io: ReturnType<typeof makeIO>;
}

/** Start the assembled TUI over fake TTYs; every call names its own store. */
function startApp(
  sessionsDir: string,
  extra: Partial<Parameters<typeof runTuiApp>[0]> = {},
): Harness {
  const input = new FakeInput();
  const output = new FakeOutput();
  const io = makeIO();
  const app = runTuiApp({
    cfg: resolveConfig({ provider: "mock" }),
    io,
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
    pluginsDir: `${process.cwd()}/does-not-exist-tui-rewind-plugins`,
    sessionsDir,
    ...extra,
  });
  return { app, input, output, io };
}

const textOf = (output: FakeOutput): string => stripAnsi(output.data);

/** All rendered text with box glyphs and whitespace collapsed (wrapped notices match). */
const flatText = (output: FakeOutput): string =>
  textOf(output)
    .replace(/[│─╭╮╰╯┌┐└┘]/g, " ")
    .replace(/\s+/g, " ");

/** Collapse ALL whitespace, so a renderer wrap cannot split an absolute path. */
const squeeze = (text: string): string => text.replace(/\s+/g, "");

/** The whole rendered text squeezed: a mid-path hard wrap still matches the notice. */
const squeezedText = (output: FakeOutput): string => squeeze(flatText(output));

/** The newest fully rendered frame (rows joined with newlines). */
const lastFrameText = (output: FakeOutput): string =>
  stripAnsi(output.data.split(ANSI.cursorHome).at(-1) ?? "");

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

async function quit(input: FakeInput, app: Promise<number>): Promise<number> {
  for (let press = 0; press < 5; press += 1) {
    input.key("escape");
    const settled = await Promise.race([
      app.then((code) => code as number | "exited"),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 250)),
    ]);
    if (settled !== "pending") return settled === "exited" ? 0 : settled;
  }
  const code = await Promise.race([
    app,
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 10_000)),
  ]);
  if (code === "timeout") throw new Error("the TUI did not exit after repeated Escape");
  return code;
}

/** Non-empty JSONL lines of a session file ([] when the file is missing). */
function sessionLines(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "");
}

/** Dense `seq` values of a session file. */
function seqsOf(file: string): number[] {
  return sessionLines(file).map((line) => (JSON.parse(line) as { seq: number }).seq);
}

/** One wire-shaped protocol envelope line, dense `seq`. */
function envelope(
  seq: number,
  from: "user" | "senior",
  to: string,
  text: string,
): string {
  return JSON.stringify({
    v: 1,
    id: `e${seq}`,
    seq,
    ts: "2026-11-19T09:00:00Z",
    from,
    to,
    kind: "message",
    payload: { text },
  });
}

/** In-memory envelope for the pure preview model. */
function event(seq: number, from: "user" | "senior", to: string, text: string): Message {
  return JSON.parse(envelope(seq, from, to, text)) as Message;
}

function summaryText(body = "condensed history"): string {
  return `${COMPACTION_SUMMARY_PREFIX}${body}${COMPACTION_SUMMARY_SUFFIX}`;
}

/** Write a session file from raw envelope lines (plus an optional sidecar title). */
function writeSession(
  sessionsDir: string,
  name: string,
  lines: string[],
  title?: string,
): { file: string; bytes: Buffer } {
  fs.mkdirSync(sessionsDir, { recursive: true });
  const file = path.join(sessionsDir, name);
  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
  if (title !== undefined) {
    fs.writeFileSync(
      path.join(sessionsDir, name.replace(/\.jsonl$/, ".meta.json")),
      JSON.stringify({ title, created: 1, updated: 2 }, null, 2),
      "utf8",
    );
  }
  return { file, bytes: fs.readFileSync(file) };
}

/** Write the session's runtime-event sidecar (the tool/approval history). */
function writeSidecar(sessionsDir: string, name: string): string {
  const runtimeDir = path.join(sessionsDir, "runtime");
  fs.mkdirSync(runtimeDir, { recursive: true });
  const file = path.join(runtimeDir, `${name}.events.jsonl`);
  fs.writeFileSync(
    file,
    `${JSON.stringify({
      type: "run_status",
      status: "completed",
      run_id: "run-1",
      at: "2026-11-19T09:00:00Z",
    })}\n`,
    "utf8",
  );
  return file;
}

const FOUR_ENVELOPES = (): string[] => [
  envelope(1, "user", "senior", "first task"),
  envelope(2, "senior", "user", "first reply"),
  envelope(3, "user", "senior", "second task"),
  envelope(4, "senior", "user", "second reply"),
  envelope(5, "senior", "user", "second decision"),
];

// --------------------------------------------------------------------------- //
// pure argument grammar, preview, confirmation and notices
// --------------------------------------------------------------------------- //

test("/rewind arguments: no args = one turn, --turns <n> validated, honest usage errors", () => {
  assert.deepEqual(parseRewindCommandArgs(""), { turns: 1, error: null });
  assert.deepEqual(parseRewindCommandArgs("   "), { turns: 1, error: null });
  assert.deepEqual(parseRewindCommandArgs("--turns 2"), { turns: 2, error: null });
  assert.deepEqual(parseRewindCommandArgs("  --turns   100 "), { turns: 100, error: null });

  for (const [args, problem] of [
    ["--turns", "--turns needs a number"],
    ["--turns abc", "--turns must be a positive integer"],
    ["--turns 1.5", "--turns must be a positive integer"],
    ["--turns -1", "--turns must be a positive integer"],
    ["--turns 0", "rewind turns must be between 1 and 100"],
    ["--turns 101", "rewind turns must be between 1 and 100"],
    ["--turns 1 2", "unexpected argument 2"],
    ["2", "unexpected argument 2"],
    ["--name x", "unknown option --name"],
    ["--turns=2", "unknown option --turns=2"],
  ] as const) {
    const parsed = parseRewindCommandArgs(args);
    assert.equal(parsed.error, `${problem} — usage: ${REWIND_USAGE}`, args);
    assert.equal(parsed.turns, 1, args);
  }
});

test("/rewind preview: the service cut names turns, envelopes, removed seq range and kept seq", () => {
  const events = FOUR_ENVELOPES().map((line) => JSON.parse(line) as Message);
  const preview = previewRewind(events, 1);
  assert.equal(preview.cut.turns, 1);
  assert.equal(preview.cut.requestedTurns, 1);
  assert.equal(preview.cut.keptCount, 2);
  assert.equal(preview.cut.removedCount, 3);
  assert.equal(preview.cut.stoppedAtCompaction, false);
  assert.equal(preview.cut.stopsBefore, "operator-turn");
  assert.equal(preview.removedSeq, "seq 3-5");
  assert.equal(preview.keptSeq, 2);
  assert.equal(preview.taskText, "second task");

  const body = rewindConfirmation({ name: "alpha.jsonl", preview });
  assert.match(body, /Remove the last 1 operator turn and everything after/);
  assert.match(body, /3 envelopes \(seq 3-5\) will be deleted from alpha\.jsonl/);
  assert.match(body, /rewritten in place/);
  assert.match(body, /2 envelopes stay \(dense seq through 2\)/);
  assert.match(body, /tool\/approval history sidecar is cleared/);
  assert.match(body, /transcript is kept/);
  assert.match(body, /This cannot be undone/);
  assert.match(body, /Selected task: .second task./);
});

test("/rewind preview: a deep request states its clamp at the compaction floor or the session start", () => {
  const compacted = [
    event(1, "user", "senior", "old task"),
    event(2, "senior", "user", "old reply"),
    event(3, "user", "senior", summaryText()),
    event(4, "user", "senior", "fresh task"),
    event(5, "senior", "user", "fresh reply"),
  ];
  const floor = previewRewind(compacted, 5);
  assert.equal(floor.cut.turns, 1);
  assert.equal(floor.cut.requestedTurns, 5);
  assert.equal(floor.cut.removedCount, 2);
  assert.equal(floor.cut.stoppedAtCompaction, true);
  assert.equal(floor.cut.stopsBefore, "compaction-summary");
  assert.match(
    rewindConfirmation({ name: "alpha.jsonl", preview: floor }),
    /Requested 5 turn\(s\); the cut stops at the compaction summary/,
  );

  const start = previewRewind([event(1, "user", "senior", "only task"), event(2, "senior", "user", "reply")], 5);
  assert.equal(start.cut.turns, 1);
  assert.equal(start.cut.stopsBefore, "session-start");
  assert.equal(start.cut.removedCount, 2);
  assert.match(
    rewindConfirmation({ name: "alpha.jsonl", preview: start }),
    /Requested 5 turn\(s\); the cut stops at the session start/,
  );
});

test("/rewind confirmation quotes a long task at the bounded snippet", () => {
  const long = "x".repeat(400);
  const events = [event(1, "user", "senior", long), event(2, "senior", "user", "reply")];
  const body = rewindConfirmation({ name: "alpha.jsonl", preview: previewRewind(events, 1) });
  assert.ok(body.includes(`${"x".repeat(159)}…`), "the quote is bounded with an ellipsis");
  assert.ok(!body.includes(long), "the full task text is never quoted");
});

test("/rewind outcome notice: success names the cut, dense seq, sidecar and kept transcript", () => {
  const events = FOUR_ENVELOPES().map((line) => JSON.parse(line) as Message);
  const preview = previewRewind(events, 1);
  const notice = rewindOutcomeNotice({
    name: "alpha.jsonl",
    cut: preview.cut,
    sidecarCleared: true,
  });
  assert.match(notice, /^rewound alpha\.jsonl: removed the last 1 operator turn\(s\) \(3 envelope\(s\)\)/);
  assert.match(notice, /2 envelope\(s\) kept/);
  assert.match(notice, /the kept prefix keeps its dense seq/);
  assert.match(notice, /cleared the tool\/approval history sidecar/);
  assert.match(notice, /the transcript is kept — reloaded the session/);

  const noSidecar = rewindOutcomeNotice({
    name: "alpha.jsonl",
    cut: preview.cut,
    sidecarCleared: false,
  });
  assert.match(noSidecar, /sidecar was already empty/);

  const failed = rewindOutcomeNotice({
    name: "alpha.jsonl",
    cut: preview.cut,
    sidecarCleared: false,
    sidecarError: "EPERM",
  });
  assert.match(failed, /could not clear the tool\/approval history sidecar: EPERM/);
});

test("/rewind outcome notice: a no-op states the service reason and that the file is unchanged", () => {
  const covered = [event(1, "user", "senior", "old task"), event(2, "user", "senior", summaryText())];
  const preview = previewRewind(covered, 1);
  assert.equal(preview.cut.removedCount, 0);
  const notice = rewindOutcomeNotice({
    name: "alpha.jsonl",
    cut: preview.cut,
    sidecarCleared: false,
  });
  assert.match(notice, /^nothing to rewind in alpha\.jsonl: the only operator turns are covered by a compaction summary/);
  assert.match(notice, /the session file is unchanged/);

  const empty = previewRewind([event(1, "senior", "user", "reply")], 1);
  assert.match(
    rewindOutcomeNotice({ name: "alpha.jsonl", cut: empty.cut, sidecarCleared: false }),
    /the session has no operator turns to rewind/,
  );
});

test("/rewind notices are bounded to one row's worth of text", () => {
  const usage = ` — usage: ${REWIND_USAGE}`;
  const long = `rewind failed: ${"x".repeat(REWIND_NOTICE_MAX_CHARS * 2)}${usage}`;
  const bounded = boundRewindNotice(long);
  assert.equal(bounded.length, REWIND_NOTICE_MAX_CHARS);
  assert.ok(bounded.startsWith("rewind failed: "), "the head is kept");
  assert.ok(bounded.endsWith(usage), "the actionable tail is kept, not dropped");
  assert.ok(bounded.includes("…"), "the middle is elided honestly");
  assert.equal(boundRewindNotice("short"), "short");
});

test("/rewind copy never invents a seq, a name, an empty quote or a sidecar error", () => {
  // A hand-written/legacy log can carry envelopes with no `seq` (the preview is
  // deliberately tolerant there). The counts stay honest and no `seq` range or
  // kept `seq` is claimed when the envelopes do not carry one.
  const legacy = [
    { v: 1, id: "a", from: "user", to: "senior", kind: "message", payload: { text: "legacy task" } },
    { v: 1, id: "b", from: "senior", to: "user", kind: "message", payload: { text: "legacy reply" } },
  ] as unknown as Message[];
  const preview = previewRewind(legacy, 1);
  assert.equal(preview.cut.removedCount, 2);
  assert.equal(preview.cut.keptCount, 0);
  assert.equal(preview.removedSeq, "", "no removed seq range is claimed");
  assert.equal(preview.keptSeq, null, "no kept seq is claimed");
  assert.equal(preview.taskText, "legacy task");

  const body = rewindConfirmation({ name: "   ", preview });
  assert.match(
    body,
    /^Remove the last 1 operator turn and everything after: 2 envelopes will be deleted from this session/,
    "a blank session name falls back instead of rendering empty",
  );
  assert.equal(body.includes("(seq "), false, "a seq-less log gets no seq range");
  assert.equal(body.includes("dense seq through"), false, "a seq-less prefix gets no kept seq");
  assert.match(body, /Selected task: .legacy task./);

  const withoutTask = rewindConfirmation({ name: "alpha.jsonl", preview: { ...preview, taskText: "" } });
  assert.equal(
    withoutTask.includes("Selected task"),
    false,
    "an empty quote is omitted rather than rendered as a pair of empty quotes",
  );

  // A whitespace-only sidecar error is not an error, and a blank name falls back.
  const notice = rewindOutcomeNotice({
    name: "  ",
    cut: preview.cut,
    sidecarCleared: false,
    sidecarError: "   ",
  });
  assert.match(notice, /^rewound the session: /, "a blank name falls back to 'the session'");
  assert.match(notice, /the tool\/approval history sidecar was already empty/);
  assert.equal(notice.includes("could not clear"), false, "whitespace is not a sidecar error");

  // The argument boundary is untrusted: a non-string body is the default depth.
  assert.deepEqual(parseRewindCommandArgs(undefined as unknown as string), {
    turns: 1,
    error: null,
  });
});

test("/rewind parser echoes are bounded and never drop the usage clause", () => {
  const longOption = parseRewindCommandArgs(`--${"y".repeat(5_000)}`);
  assert.equal(longOption.turns, 1);
  assert.ok(longOption.error !== null);
  assert.ok(longOption.error.length <= REWIND_NOTICE_MAX_CHARS);
  assert.ok(longOption.error.startsWith("unknown option --y"), "the head names the problem");
  assert.ok(longOption.error.endsWith(` — usage: ${REWIND_USAGE}`), "the usage clause survives");
  assert.ok(longOption.error.includes("…"), "the token echo itself is elided");

  const longArgument = parseRewindCommandArgs(`--turns 2 ${"z".repeat(5_000)}`);
  assert.equal(longArgument.turns, 1);
  assert.ok(longArgument.error !== null);
  assert.equal(longArgument.error.length, REWIND_NOTICE_MAX_CHARS);
  assert.ok(longArgument.error.startsWith("unexpected argument z"));
  assert.ok(longArgument.error.endsWith(` — usage: ${REWIND_USAGE}`));
});

// --------------------------------------------------------------------------- //
// assembled app: confirm, cancel and reload
// --------------------------------------------------------------------------- //

test("/rewind confirms first, removes the last operator turn, clears the sidecar and reloads", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tui-rewind-accept-"));
  const sessionsDir = path.join(root, "sessions");
  const { file: sourceFile, bytes: sourceBytes } = writeSession(
    sessionsDir,
    "alpha.jsonl",
    FOUR_ENVELOPES(),
    "Alpha source",
  );
  const sidecar = writeSidecar(sessionsDir, "alpha.jsonl");
  const keptBytes = Buffer.from(
    `${sessionLines(sourceFile).slice(0, 2).join("\n")}\n`,
    "utf8",
  );
  const { app, input, output } = startApp(sessionsDir, {
    cfg: resolveConfig({ provider: "mock", sessionFile: sourceFile, resume: true }),
  });
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
    // A narrow screen keeps the dialog and the long success notice width-safe.
    output.resize(60, 24);

    input.type("/rewind");
    input.enter();
    assert.ok(
      await waitFor(() => lastFrameText(output).includes("Rewind session")),
      "the destructive confirmation opens before any write",
    );
    const dialogFrame = flatText(output);
    assert.match(dialogFrame, /3 envelopes \(seq 3-5\) will be deleted from alpha\.jsonl/);
    assert.match(dialogFrame, /2 envelopes stay \(dense seq through 2\)/);
    assert.match(dialogFrame, /This cannot be undone/);
    assert.match(dialogFrame, /Selected task: .second task./);
    assert.ok(
      lastFrameText(output).includes("› [ Cancel ]"),
      "Cancel is preselected, so Enter cannot destroy anything by accident",
    );
    assert.deepEqual(fs.readFileSync(sourceFile), sourceBytes, "the preview wrote nothing");
    assert.ok(fs.existsSync(sidecar), "the sidecar survived the preview");

    // Move to the explicit destructive action and confirm.
    input.key("right");
    assert.ok(
      await waitFor(() => lastFrameText(output).includes("› [ Rewind and delete ]")),
      "the destructive action is selected only after an explicit move",
    );
    input.enter();
    assert.ok(
      await waitFor(() => textOf(output).includes("rewound alpha.jsonl")),
      "the success notice names the rewritten session",
    );
    const noticeFrame = flatText(output);
    assert.match(noticeFrame, /removed the last 1 operator turn\(s\) \(3 envelope\(s\)\)/);
    assert.match(noticeFrame, /2 envelope\(s\) kept/);
    assert.match(noticeFrame, /the kept prefix keeps its dense seq/);
    assert.match(noticeFrame, /cleared the tool\/approval history sidecar/);
    assert.match(noticeFrame, /the transcript is kept — reloaded the session/);

    // The session file: only the kept prefix remains, byte-identical and dense.
    assert.deepEqual(fs.readFileSync(sourceFile), keptBytes, "the kept transcript is byte-identical");
    assert.deepEqual(seqsOf(sourceFile), [1, 2], "the kept prefix keeps its dense seq");
    assert.equal(
      fs.existsSync(sidecar),
      false,
      "the tool/approval history sidecar of the removed runs is cleared",
    );
    assert.equal(
      sessionLines(sourceFile).some((line) => line.includes("second task")),
      false,
      "the removed operator task is gone",
    );

    // Reload: a new turn appends to the rewritten session with a dense seq.
    input.type("after the rewind");
    input.enter();
    assert.ok(
      await waitFor(() => textOf(output).includes("decision:"), 30_000),
      "the turn after the rewind completes on the reloaded session",
    );
    const seqs = seqsOf(sourceFile);
    assert.ok(seqs.length > 2, "the post-rewind turn appended its envelopes");
    assert.deepEqual(
      seqs,
      seqs.map((_, index) => index + 1),
      "the appended session keeps dense seq after the cut",
    );
    assert.deepEqual(
      fs.readFileSync(sourceFile).subarray(0, keptBytes.length),
      keptBytes,
      "the kept prefix is never rewritten by the later turn",
    );

    // Width safety at 60 columns for the rendered notice frame.
    assert.ok(
      lastFrameText(output)
        .split("\n")
        .every((row) => stripAnsi(row).length <= 60),
      "the rewind notice stays width-safe at 60 columns",
    );

    assert.equal(await quit(input, app), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("/rewind cancels with Escape: zero bytes changed and the session keeps working", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tui-rewind-cancel-"));
  const sessionsDir = path.join(root, "sessions");
  const { file: sourceFile, bytes: sourceBytes } = writeSession(
    sessionsDir,
    "alpha.jsonl",
    FOUR_ENVELOPES(),
  );
  const sidecar = writeSidecar(sessionsDir, "alpha.jsonl");
  const sidecarBytes = fs.readFileSync(sidecar);
  const { app, input, output } = startApp(sessionsDir, {
    cfg: resolveConfig({ provider: "mock", sessionFile: sourceFile, resume: true }),
  });
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
    input.type("/rewind");
    input.enter();
    assert.ok(await waitFor(() => lastFrameText(output).includes("Rewind session")));

    input.key("escape");
    assert.ok(
      await waitFor(() => !lastFrameText(output).includes("Rewind session")),
      "Escape closes the confirmation",
    );
    assert.deepEqual(fs.readFileSync(sourceFile), sourceBytes, "cancel changed no session byte");
    assert.deepEqual(fs.readFileSync(sidecar), sidecarBytes, "cancel kept the sidecar");
    assert.deepEqual(seqsOf(sourceFile), [1, 2, 3, 4, 5]);

    // The session still works after a cancelled rewind.
    input.type("normal turn");
    input.enter();
    assert.ok(
      await waitFor(() => textOf(output).includes("decision:"), 30_000),
      "a cancelled rewind leaves the session usable",
    );
    assert.equal(await quit(input, app), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("/rewind Enter on the preselected Cancel closes without mutating", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tui-rewind-cancel-enter-"));
  const sessionsDir = path.join(root, "sessions");
  const { file: sourceFile, bytes: sourceBytes } = writeSession(
    sessionsDir,
    "alpha.jsonl",
    FOUR_ENVELOPES(),
  );
  const { app, input, output } = startApp(sessionsDir, {
    cfg: resolveConfig({ provider: "mock", sessionFile: sourceFile, resume: true }),
  });
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
    input.type("/rewind");
    input.enter();
    assert.ok(await waitFor(() => lastFrameText(output).includes("Rewind session")));
    assert.ok(lastFrameText(output).includes("› [ Cancel ]"));

    input.enter();
    assert.ok(
      await waitFor(() => !lastFrameText(output).includes("Rewind session")),
      "Enter accepts the preselected Cancel",
    );
    assert.deepEqual(fs.readFileSync(sourceFile), sourceBytes, "nothing was rewritten");
    assert.equal(await quit(input, app), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------- //
// compaction floor and clamp honesty
// --------------------------------------------------------------------------- //

test("/rewind honors the compaction floor: the summary and everything before it stay", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tui-rewind-floor-"));
  const sessionsDir = path.join(root, "sessions");
  const lines = [
    envelope(1, "user", "senior", "old task"),
    envelope(2, "senior", "user", "old reply"),
    envelope(3, "user", "senior", summaryText()),
    envelope(4, "user", "senior", "fresh task"),
    envelope(5, "senior", "user", "fresh reply"),
  ];
  const { file: sourceFile } = writeSession(sessionsDir, "alpha.jsonl", lines);
  const { app, input, output } = startApp(sessionsDir, {
    cfg: resolveConfig({ provider: "mock", sessionFile: sourceFile, resume: true }),
  });
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
    input.type("/rewind");
    input.enter();
    assert.ok(await waitFor(() => lastFrameText(output).includes("Rewind session")));
    const frame = flatText(output);
    assert.match(frame, /2 envelopes \(seq 4-5\) will be deleted/);
    assert.match(frame, /3 envelopes stay \(dense seq through 3\)/);

    input.key("right");
    input.enter();
    assert.ok(await waitFor(() => textOf(output).includes("rewound alpha.jsonl")));
    assert.deepEqual(seqsOf(sourceFile), [1, 2, 3], "the compaction floor limited the cut");
    const kept = fs.readFileSync(sourceFile, "utf8");
    assert.match(kept, /compacted into the following summary/, "the summary itself stays");
    assert.match(kept, /old task/, "tasks folded into the summary stay");
    assert.equal(kept.includes("fresh task"), false, "only the post-summary turn is removed");
    assert.equal(await quit(input, app), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("/rewind with nothing rewindable reports the service reason and opens no dialog", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tui-rewind-noop-"));
  const sessionsDir = path.join(root, "sessions");
  const lines = [
    envelope(1, "user", "senior", "old task"),
    envelope(2, "senior", "user", "old reply"),
    envelope(3, "user", "senior", summaryText()),
  ];
  const { file: sourceFile, bytes: sourceBytes } = writeSession(sessionsDir, "alpha.jsonl", lines);
  const { app, input, output } = startApp(sessionsDir, {
    cfg: resolveConfig({ provider: "mock", sessionFile: sourceFile, resume: true }),
  });
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
    input.type("/rewind");
    input.enter();
    assert.ok(
      await waitFor(() =>
        flatText(output).includes(
          "nothing to rewind in alpha.jsonl: the only operator turns are covered by a compaction summary",
        ),
      ),
      "the honest no-op reason is surfaced",
    );
    assert.ok(
      !flatText(output).includes("Rewind session"),
      "a no-op never opens the destructive confirmation",
    );
    assert.deepEqual(fs.readFileSync(sourceFile), sourceBytes, "a no-op wrote no byte");
    assert.equal(await quit(input, app), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("/rewind --turns 5 clamps at the compaction floor and says so in the confirmation and notice", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tui-rewind-clamp-"));
  const sessionsDir = path.join(root, "sessions");
  const lines = [
    envelope(1, "user", "senior", "old task"),
    envelope(2, "senior", "user", "old reply"),
    envelope(3, "user", "senior", summaryText()),
    envelope(4, "user", "senior", "fresh task"),
    envelope(5, "senior", "user", "fresh reply"),
  ];
  const { file: sourceFile } = writeSession(sessionsDir, "alpha.jsonl", lines);
  const { app, input, output } = startApp(sessionsDir, {
    cfg: resolveConfig({ provider: "mock", sessionFile: sourceFile, resume: true }),
  });
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
    input.type("/rewind --turns 5");
    input.enter();
    assert.ok(await waitFor(() => lastFrameText(output).includes("Rewind session")));
    assert.match(
      flatText(output),
      /Requested 5 turn\(s\); the cut stops at the compaction summary/,
      "the confirmation names the clamp before the write",
    );
    input.key("right");
    input.enter();
    assert.ok(await waitFor(() => textOf(output).includes("rewound alpha.jsonl")));
    assert.match(
      flatText(output),
      /the requested 5 would cross a compaction summary/,
      "the applied outcome keeps the service's clamp wording",
    );
    assert.deepEqual(seqsOf(sourceFile), [1, 2, 3]);
    assert.equal(await quit(input, app), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------- //
// refusals
// --------------------------------------------------------------------------- //

test("/rewind refuses malformed arguments with the usage line and writes nothing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tui-rewind-args-"));
  const sessionsDir = path.join(root, "sessions");
  const { file: sourceFile, bytes: sourceBytes } = writeSession(
    sessionsDir,
    "alpha.jsonl",
    FOUR_ENVELOPES(),
  );
  const { app, input, output } = startApp(sessionsDir, {
    cfg: resolveConfig({ provider: "mock", sessionFile: sourceFile, resume: true }),
  });
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
    input.type("/rewind 2");
    input.enter();
    assert.ok(
      await waitFor(() =>
        flatText(output).includes(`unexpected argument 2 — usage: ${REWIND_USAGE}`),
      ),
      "a bare depth is a usage error naming the accepted form",
    );
    input.type("/rewind --turns 0");
    input.enter();
    assert.ok(
      await waitFor(() =>
        flatText(output).includes(
          `rewind turns must be between 1 and 100 — usage: ${REWIND_USAGE}`,
        ),
      ),
      "an out-of-range depth is a usage error",
    );
    assert.deepEqual(fs.readFileSync(sourceFile), sourceBytes, "no usage refusal wrote a byte");
    assert.equal(await quit(input, app), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("/rewind is refused while a turn runs (palette row unavailable) and writes nothing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tui-rewind-running-"));
  const sessionsDir = path.join(root, "sessions");
  const { file: sourceFile, bytes: sourceBytes } = writeSession(
    sessionsDir,
    "alpha.jsonl",
    FOUR_ENVELOPES(),
  );
  let held = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const mock = new MockProvider();
  const gatedSenior: Provider = {
    async chat(messages, responseKind, signal, options) {
      if (!held) {
        held = true;
        await gate;
      }
      return mock.chat(messages, responseKind, signal, options);
    },
  };
  const { app, input, output } = startApp(sessionsDir, {
    cfg: resolveConfig({ provider: "mock", sessionFile: sourceFile, resume: true }),
    providerOverrides: { senior: gatedSenior, junior: mock },
  });
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
    input.type("first task");
    input.enter();
    assert.ok(await waitFor(() => held), "the first senior call is held");

    input.key("p", { ctrl: true });
    assert.ok(await waitFor(() => lastFrameText(output).includes("COMMANDS")));
    input.type("rewind");
    assert.ok(await waitFor(() => lastFrameText(output).includes("> rewind")));
    assert.ok(
      await waitFor(() => lastFrameText(output).includes("› Rewind session")),
      "the palette selects the rewind row",
    );
    input.enter();
    assert.ok(
      await waitFor(() => lastFrameText(output).includes("COMMANDS")),
      "a disabled palette row keeps the palette open",
    );
    input.key("escape");
    assert.ok(
      await waitFor(() => /unavailable while a turn is running/.test(flatText(output))),
      "the idle-only row refuses with the existing reason",
    );
    assert.ok(
      !lastFrameText(output).includes("Rewind session"),
      "no confirmation dialog opens mid-turn",
    );

    release();
    assert.ok(
      await waitFor(() => textOf(output).includes("decision:"), 30_000),
      "the held turn completes after the refusal",
    );
    const after = fs.readFileSync(sourceFile);
    assert.deepEqual(after.subarray(0, sourceBytes.length), sourceBytes, "the original prefix is intact");
    assert.deepEqual(
      seqsOf(sourceFile),
      seqsOf(sourceFile).map((_, index) => index + 1),
      "the refused rewind cut nothing; the appended turn keeps dense seq",
    );
    assert.equal(await quit(input, app), 0);
  } finally {
    release();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("/rewind is refused while compaction runs (palette dispatch) and writes nothing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tui-rewind-compacting-"));
  const sessionsDir = path.join(root, "sessions");
  const { file: sourceFile, bytes: sourceBytes } = writeSession(
    sessionsDir,
    "alpha.jsonl",
    FOUR_ENVELOPES(),
  );
  const SUMMARY_TEXT = "ALPHA-REWIND-GATE-SUMMARY";
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      void gate.then(() => {
        res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
        res.end(JSON.stringify({ choices: [{ message: { content: SUMMARY_TEXT } }] }));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const { app, input, output } = startApp(sessionsDir, {
    cfg: resolveConfig({
      provider: "openai",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: "test-key",
      seniorModel: "blocked-senior",
      juniorModel: "blocked-senior",
      sessionFile: sourceFile,
      resume: true,
      compactKeepRecent: 1,
      retries: 0,
    }),
  });
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
    input.type("/compact");
    input.enter();
    assert.ok(
      await waitFor(() => lastFrameText(output).includes("compacting context…")),
      "compaction is pending on the held endpoint",
    );

    input.key("p", { ctrl: true });
    assert.ok(await waitFor(() => lastFrameText(output).includes("COMMANDS")));
    input.type("rewind");
    assert.ok(await waitFor(() => lastFrameText(output).includes("> rewind")));
    assert.ok(
      await waitFor(() => lastFrameText(output).includes("› Rewind session")),
      "the palette selects the rewind row during compaction",
    );
    input.enter();
    assert.ok(
      await waitFor(() =>
        flatText(output).includes("cannot rewind a session while compaction is running"),
      ),
      "the compacting refusal is stated honestly",
    );
    assert.deepEqual(fs.readFileSync(sourceFile), sourceBytes, "no rewind ran while compaction ran");

    release();
    assert.ok(
      await waitFor(() => textOf(output).includes("context compacted"), 30_000),
      "compaction completes once the endpoint answers",
    );
    assert.equal(await quit(input, app), 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("/rewind with no current session file refuses honestly", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tui-rewind-nosession-"));
  const sessionsDir = path.join(root, "sessions");
  const { app, input, output } = startApp(sessionsDir);
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
    input.type("/rewind");
    input.enter();
    assert.ok(
      await waitFor(() => flatText(output).includes("rewind: no session file to rewind")),
      "the in-memory session is refused with guidance",
    );
    assert.equal(await quit(input, app), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("/rewind refuses an absent current session file honestly", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tui-rewind-absent-"));
  const sessionsDir = path.join(root, "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const ghost = path.join(sessionsDir, "ghost.jsonl");
  const { app, input, output } = startApp(sessionsDir, {
    cfg: resolveConfig({ provider: "mock", sessionFile: ghost }),
  });
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
    input.type("/rewind");
    input.enter();
    assert.ok(
      await waitFor(() =>
        flatText(output).includes("rewind: the current session has no saved file yet"),
      ),
      "an unsaved current session is refused honestly",
    );
    assert.equal(fs.existsSync(ghost), false, "the refusal created no file");
    assert.equal(await quit(input, app), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("/rewind refuses a current session outside the TUI's session store", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tui-rewind-outside-"));
  const sessionsDir = path.join(root, "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const outsideFile = path.join(root, "outside.jsonl");
  fs.writeFileSync(outsideFile, `${FOUR_ENVELOPES()[0]}\n`, "utf8");
  const before = fs.readFileSync(outsideFile);
  const { app, input, output } = startApp(sessionsDir, {
    cfg: resolveConfig({ provider: "mock", sessionFile: outsideFile, resume: true }),
  });
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
    input.type("/rewind");
    input.enter();
    const expectedNotice = `rewind: the current session is not a session in ${sessionsDir}`;
    assert.ok(
      await waitFor(() => squeezedText(output).includes(squeeze(expectedNotice))),
      "a file outside the store is refused instead of rewriting a same-named stranger",
    );
    assert.deepEqual(fs.readFileSync(outsideFile), before, "the outside file is untouched");
    assert.equal(await quit(input, app), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("/rewind surfaces a corrupt current session honestly and rewrites nothing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tui-rewind-corrupt-"));
  const sessionsDir = path.join(root, "sessions");
  const { file: sourceFile } = writeSession(sessionsDir, "alpha.jsonl", FOUR_ENVELOPES());
  const { app, input, output } = startApp(sessionsDir, {
    cfg: resolveConfig({ provider: "mock", sessionFile: sourceFile, resume: true }),
  });
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
    // Damage the log after startup: the destructive read is strict and must
    // refuse before computing/rewriting anything.
    const corrupt = `${envelope(1, "user", "senior", "first task")}\nnot json\n`;
    fs.writeFileSync(sourceFile, corrupt, "utf8");

    input.type("/rewind");
    input.enter();
    assert.ok(
      await waitFor(() => flatText(output).includes("rewind failed: corrupt session file")),
      "the strict reader's real failure is surfaced",
    );
    assert.equal(fs.readFileSync(sourceFile, "utf8"), corrupt, "the failed rewind wrote no byte");
    assert.ok(!flatText(output).includes("Rewind session"), "no confirmation for a corrupt file");
    assert.equal(await quit(input, app), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("/rewind refuses a log damaged between the preview and the confirmation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tui-rewind-reread-"));
  const sessionsDir = path.join(root, "sessions");
  const five = FOUR_ENVELOPES();
  const { file: sourceFile } = writeSession(sessionsDir, "alpha.jsonl", five);
  const { app, input, output } = startApp(sessionsDir, {
    cfg: resolveConfig({ provider: "mock", sessionFile: sourceFile, resume: true }),
  });
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
    input.type("/rewind");
    input.enter();
    assert.ok(
      await waitFor(() => lastFrameText(output).includes("Rewind session")),
      "the preview runs on the log as it was",
    );

    // Damage the log while the confirmation is open. The destructive write must
    // re-read strictly: a torn final fragment is corruption here, not a
    // recoverable tail, so the rewind refuses instead of rewriting a prefix.
    const damaged = `${five.join("\n")}\nnot json`;
    fs.writeFileSync(sourceFile, damaged, "utf8");

    input.key("right");
    input.enter();
    assert.ok(
      await waitFor(() => flatText(output).includes("rewind failed: corrupt session file")),
      "the strict re-read's real failure is surfaced",
    );
    assert.equal(
      fs.readFileSync(sourceFile, "utf8"),
      damaged,
      "the refused rewind rewrote no byte of the damaged log",
    );
    assert.ok(
      !flatText(output).includes("rewound alpha.jsonl"),
      "no success is claimed for a session that was not rewritten",
    );
    assert.equal(await quit(input, app), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("/rewind discloses a sidecar clear failure and still rewrites the transcript", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tui-rewind-sidecar-fail-"));
  const sessionsDir = path.join(root, "sessions");
  const { file: sourceFile } = writeSession(sessionsDir, "alpha.jsonl", FOUR_ENVELOPES());
  const keptBytes = Buffer.from(
    `${sessionLines(sourceFile).slice(0, 2).join("\n")}\n`,
    "utf8",
  );
  // A directory where the runtime sidecar should be cannot be unlinked, so the
  // clear fails after the transcript was already rewritten.
  const sidecarPath = path.join(sessionsDir, "runtime", "alpha.jsonl.events.jsonl");
  fs.mkdirSync(sidecarPath, { recursive: true });
  fs.writeFileSync(path.join(sidecarPath, "blocker"), "x", "utf8");
  const { app, input, output } = startApp(sessionsDir, {
    cfg: resolveConfig({ provider: "mock", sessionFile: sourceFile, resume: true }),
  });
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
    input.type("/rewind");
    input.enter();
    assert.ok(await waitFor(() => lastFrameText(output).includes("Rewind session")));
    input.key("right");
    input.enter();

    assert.ok(
      await waitFor(() => flatText(output).includes("rewound alpha.jsonl")),
      "the transcript rewrite itself succeeded",
    );
    const frame = flatText(output);
    assert.match(
      frame,
      /could not clear the tool\/approval history sidecar: /,
      "a failed sidecar clear is disclosed, not hidden",
    );
    assert.equal(
      frame.includes("sidecar was already empty"),
      false,
      "a failed clear is never reported as an empty sidecar",
    );
    assert.deepEqual(fs.readFileSync(sourceFile), keptBytes, "the transcript was still rewritten");
    assert.deepEqual(seqsOf(sourceFile), [1, 2], "the kept prefix keeps its dense seq");
    assert.ok(fs.existsSync(sidecarPath), "the unremovable sidecar path is untouched");
    assert.equal(await quit(input, app), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** The toast box rows of one rendered frame ("" when no toast box is painted). */
function toastBoxText(frame: string): string {
  const rows = frame.split("\n");
  const anchor = rows.findIndex((row) => row.includes("SUCCESS  rewound"));
  if (anchor < 0) return "";
  let start = anchor;
  while (start >= 0 && !(rows[start] ?? "").includes("╭")) start -= 1;
  let end = anchor;
  while (end < rows.length && !(rows[end] ?? "").includes("╰")) end += 1;
  if (start < 0 || end >= rows.length) return "";
  return rows.slice(start, end + 1).join("\n");
}

test("/rewind keeps a long outcome notice whole in the transcript while the toast is bounded", async () => {
  // A long temp root makes the sidecar clear's error (it echoes the unlink
  // path) push the outcome notice well past the 320-char toast bound, with the
  // sidecar-disclosure clause in the middle of the text.
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), `tb-tui-rewind-notice-whole-${"p".repeat(60)}-`),
  );
  const sessionsDir = path.join(root, "sessions");
  const { file: sourceFile } = writeSession(sessionsDir, "alpha.jsonl", FOUR_ENVELOPES());
  // A directory where the runtime sidecar should be cannot be unlinked, so the
  // clear fails after the transcript was rewritten and the notice discloses it.
  const sidecarPath = path.join(sessionsDir, "runtime", "alpha.jsonl.events.jsonl");
  fs.mkdirSync(sidecarPath, { recursive: true });
  fs.writeFileSync(path.join(sidecarPath, "blocker"), "x", "utf8");
  const { app, input, output } = startApp(sessionsDir, {
    cfg: resolveConfig({ provider: "mock", sessionFile: sourceFile, resume: true }),
  });
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
    input.type("/rewind");
    input.enter();
    assert.ok(await waitFor(() => lastFrameText(output).includes("Rewind session")));
    input.key("right");
    input.enter();

    assert.ok(
      await waitFor(() => flatText(output).includes("rewound alpha.jsonl")),
      "the outcome notice was produced",
    );
    // The toast copy is bounded head-and-tail: it marks the elided middle and
    // does not carry the disclosure clause that sits there.
    const toast = toastBoxText(lastFrameText(output));
    assert.ok(toast.includes("SUCCESS  rewound"), "the outcome is toasted");
    assert.ok(toast.includes("…"), "the toast copy is bounded with an ellipsis");
    assert.equal(
      toast.includes("could not clear the tool/approval history sidecar:"),
      false,
      "the toast elides the mid-notice disclosure clause",
    );
    // The transcript keeps the same notice whole: the clause is painted, whole
    // and consecutive, even though the bounded toast elided it.
    assert.ok(
      flatText(output).includes("could not clear the tool/approval history sidecar:"),
      "the transcript keeps the whole notice, clause included",
    );
    assert.ok(
      flatText(output).includes("the transcript is kept — reloaded the session"),
      "the transcript keeps the notice's tail too",
    );
    // With the toast gone the transcript frame shows the whole notice.
    assert.ok(
      await waitFor(
        () => lastFrameText(output).includes("could not clear the tool/approval history sidecar:"),
        8_000,
      ),
      "the whole notice is visible in the transcript once the toast expires",
    );
    assert.equal(await quit(input, app), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
