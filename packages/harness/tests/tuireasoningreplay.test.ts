/**
 * TUI replay of persisted reasoning (Wave 8 lane 3).
 *
 * Wave 7 persists one bounded `{type: "reasoning", role, kind, text,
 * truncated}` runtime event per streaming provider call in the session runtime
 * sidecar, and the web replays it. The TUI now shows those records too — on
 * load/resume/session switch, read-only, as dim `THINKING (replayed)` blocks
 * above the transcript blocks in sidecar order (per role/speaker, bounded
 * preview). Live thinking is unchanged and the TUI never writes reasoning
 * events.
 *
 * Pinned here, hermetically:
 * - pure extraction from a REAL `RuntimeEventStore` round-trip: append order,
 *   role/kind preserved, only the newest bounded records, malformed/oversized
 *   rows tolerated, missing/unreadable sidecar and in-memory sessions empty;
 * - the pure renderer: header/speaker/kind, bounded preview + honest markers,
 *   width safety at two widths with CJK/emoji, plain and NO_COLOR output with
 *   no escape bytes and colored frames stripping back to the plain rows;
 * - composition: replayed rows sit above the transcript blocks, an empty
 *   option is byte-identical to the pre-replay frame, and a session with only
 *   replayed reasoning renders the transcript instead of the welcome screen;
 * - the assembled TUI over fake TTY streams: a resumed session with sidecar
 *   reasoning frames the bounded THINKING blocks in order at 40 and 120
 *   columns, a sidecar without reasoning (or none) shows none, and the sidecar
 *   is never written by the TUI.
 *
 * Run with: node --test tests/tuireasoningreplay.test.ts
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { resolveConfig } from "../src/config.ts";
import { SharedContext } from "../src/context.ts";
import { RuntimeEventStore } from "../src/runevents.ts";
import { SessionStore } from "../src/session.ts";
import { addUserBlock, createTuiModel } from "../src/tui/model.ts";
import { runTuiApp, type TuiIO } from "../src/tui/app.ts";
import { createEditor } from "../src/tui/editor.ts";
import { createTheme, plainTheme, resolveTheme } from "../src/tui/theme.ts";
import { ANSI, stripAnsi } from "../src/tui/render.ts";
import { styledWidth } from "../src/tui/screen.ts";
import {
  REPLAYED_REASONING_MAX_BLOCKS,
  REPLAYED_REASONING_MAX_CHARS,
  loadSessionReasoning,
  reasoningFromRuntimeEvents,
} from "../src/tui/reasoningPersist.ts";
import {
  REPLAYED_REASONING_BLOCK_ID,
  REPLAYED_REASONING_LABEL,
  REPLAYED_REASONING_MAX_ROWS,
  renderReplayedReasoning,
  renderReplayedReasoningBlock,
  type ReplayedReasoningBlock,
} from "../src/tui/view/reasoning.ts";
import { renderScreen, screenView } from "../src/tui/view/screen.ts";
import {
  homeTranscriptScroll,
  scrollTranscript,
  transcriptView,
} from "../src/tui/view/transcript.ts";

const SESSION_NAME = "2026-11-08-1-tui-reasoning.jsonl";

function tmpRoot(): { root: string; sessionsDir: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tui-reasoning-"));
  const sessionsDir = path.join(root, "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  return {
    root,
    sessionsDir,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/** The sidecar store directory the TUI uses: `<sessionsDir>/runtime`. */
function runtimeStoreOf(sessionsDir: string): RuntimeEventStore {
  return new RuntimeEventStore(path.join(sessionsDir, "runtime"));
}

function sidecarFileOf(sessionsDir: string, sessionName = SESSION_NAME): string {
  return path.join(sessionsDir, "runtime", `${sessionName}.events.jsonl`);
}

function writeReasoning(
  store: RuntimeEventStore,
  events: readonly unknown[],
  sessionName = SESSION_NAME,
): void {
  for (const event of events) store.append(sessionName, event);
}

function block(overrides: Partial<ReplayedReasoningBlock> = {}): ReplayedReasoningBlock {
  return {
    role: "senior",
    kind: "consult",
    text: "Think about the request first.",
    truncated: false,
    ...overrides,
  };
}

function assertRows(rows: readonly string[], width: number): void {
  for (const row of rows) {
    assert.equal(
      styledWidth(row),
      width,
      `${JSON.stringify(row)} is not exactly ${width} cells`,
    );
  }
}

// ---------------------------------------------------------------------------
// (i) pure extraction: real RuntimeEventStore round-trip
// ---------------------------------------------------------------------------

test("loadSessionReasoning replays persisted records in append order with role and kind", () => {
  const { sessionsDir, cleanup } = tmpRoot();
  try {
    const store = runtimeStoreOf(sessionsDir);
    writeReasoning(store, [
      { type: "tool_started", tool: "todo_write", args: {} },
      { type: "reasoning", role: "senior", kind: "consult", text: "First thought.", truncated: false },
      { type: "reasoning", role: "junior", kind: "proposal", text: "Second thought.", truncated: false },
      { type: "prompt_audit", role: "senior", kind: "consult", sections: [], tools: [] },
      { type: "reasoning", role: "senior", kind: "decision", text: "Third thought.", truncated: true },
    ]);
    const before = fs.readFileSync(sidecarFileOf(sessionsDir), "utf-8");

    // The TUI's loader takes a session FILE path; the store key is its basename.
    const loaded = loadSessionReasoning(store, path.join(sessionsDir, SESSION_NAME));
    assert.deepEqual(loaded, {
      blocks: [
        { role: "senior", kind: "consult", text: "First thought.", truncated: false },
        { role: "junior", kind: "proposal", text: "Second thought.", truncated: false },
        { role: "senior", kind: "decision", text: "Third thought.", truncated: true },
      ],
      hidden: 0,
    });
    assert.deepEqual(Object.keys(loaded.blocks[0] ?? {}).sort(), [
      "kind",
      "role",
      "text",
      "truncated",
    ]);
    // Read-only: loading never changes the sidecar.
    assert.equal(fs.readFileSync(sidecarFileOf(sessionsDir), "utf-8"), before);
  } finally {
    cleanup();
  }
});

test("malformed sidecar rows are dropped and oversized text is bounded", () => {
  const oversized = "x".repeat(REPLAYED_REASONING_MAX_CHARS + 500);
  const loaded = reasoningFromRuntimeEvents([
    null,
    42,
    "junk",
    { type: "reasoning" },
    { type: "reasoning", role: "operator", text: "unknown speaker" },
    { type: "reasoning", role: "senior", text: 42 },
    { type: "reasoning", role: "senior", text: "   \n\t " },
    { type: "reasoning", role: "junior", text: "ok", kind: 7, truncated: "yes" },
    { type: "reasoning", role: "senior", kind: "consult", text: oversized },
    { type: "run_end", status: "completed" },
  ]);

  assert.equal(loaded.blocks.length, 2, "unattributable/unusable rows are dropped");
  assert.deepEqual(loaded.blocks[0], {
    role: "junior",
    kind: "",
    text: "ok",
    truncated: false,
  });
  const bounded = loaded.blocks[1];
  assert.equal(bounded?.role, "senior");
  assert.equal(bounded?.kind, "consult");
  assert.equal(bounded?.text.length, REPLAYED_REASONING_MAX_CHARS, "oversized text is bounded");
  assert.equal(bounded?.truncated, true, "the loader reports its own clip honestly");
  assert.equal(loaded.hidden, 0);
});

test("only the newest records replay, with an honest hidden count", () => {
  const total = REPLAYED_REASONING_MAX_BLOCKS + 3;
  const events = Array.from({ length: total }, (_, index) => ({
    type: "reasoning",
    role: index % 2 === 0 ? "senior" : "junior",
    kind: "consult",
    text: `record ${index}`,
    truncated: false,
  }));
  const loaded = reasoningFromRuntimeEvents(events);
  assert.equal(loaded.blocks.length, REPLAYED_REASONING_MAX_BLOCKS);
  assert.equal(loaded.hidden, 3);
  assert.equal(loaded.blocks[0]?.text, "record 3", "the newest window is kept, oldest first");
  assert.equal(loaded.blocks[loaded.blocks.length - 1]?.text, `record ${total - 1}`);

  const capped = reasoningFromRuntimeEvents(events, { maxBlocks: 2 });
  assert.equal(capped.blocks.length, 2);
  assert.equal(capped.hidden, total - 2);
});

test("missing, unreadable and torn sidecars are empty/fail-soft replays", () => {
  const { sessionsDir, cleanup } = tmpRoot();
  try {
    // In-memory session: no file name, nothing to read.
    assert.deepEqual(loadSessionReasoning(runtimeStoreOf(sessionsDir), ""), {
      blocks: [],
      hidden: 0,
    });
    // No sidecar yet (old session): empty replay, never an error.
    assert.deepEqual(
      loadSessionReasoning(runtimeStoreOf(sessionsDir), path.join(sessionsDir, SESSION_NAME)),
      { blocks: [], hidden: 0 },
    );
    // A throwing store (unreadable directory) is swallowed too.
    const throwing = {
      load: () => {
        throw new Error("sidecar exploded");
      },
    } as unknown as RuntimeEventStore;
    assert.deepEqual(loadSessionReasoning(throwing, "s.jsonl"), { blocks: [], hidden: 0 });

    // A torn last line keeps the valid records before it.
    const store = runtimeStoreOf(sessionsDir);
    writeReasoning(store, [
      { type: "reasoning", role: "senior", kind: "consult", text: "kept record" },
    ]);
    fs.appendFileSync(sidecarFileOf(sessionsDir), '{"type":"reasoning","role":"junior","text":"torn', "utf-8");
    const loaded = loadSessionReasoning(
      runtimeStoreOf(sessionsDir),
      path.join(sessionsDir, SESSION_NAME),
    );
    assert.deepEqual(loaded.blocks.map((entry) => entry.text), ["kept record"]);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (ii) pure renderer: honest shape, bounds, width/plain safety
// ---------------------------------------------------------------------------

test("a replayed block renders the dim THINKING (replayed) header with speaker and kind", () => {
  const rows = renderReplayedReasoningBlock(
    block({ text: "One.\nTwo.\nThree.\nFour.\nFive.\nSix." }),
    { width: 60, theme: plainTheme },
  );
  const text = rows.join("\n");
  assert.ok(text.startsWith(`${REPLAYED_REASONING_LABEL} · SENIOR · consult`), text);
  assert.ok(text.includes("One."));
  assert.ok(!text.includes("Five."), "the preview is bounded to the first rows");
  assert.ok(text.includes(`… +${6 - REPLAYED_REASONING_MAX_ROWS} lines`), text);
  assert.ok(!text.includes("\u001b"), "plainTheme output carries no escape bytes");

  const junior = renderReplayedReasoningBlock(block({ role: "junior", kind: "" }), {
    width: 60,
  }).join("\n");
  assert.ok(junior.startsWith(`${REPLAYED_REASONING_LABEL} · JUNIOR`), junior);

  const clipped = renderReplayedReasoningBlock(block({ truncated: true }), { width: 60 }).join("\n");
  assert.ok(clipped.includes("… clipped for length"), clipped);
});

test("replayed rows are width-safe and plain/NO_COLOR-safe, with CJK and emoji", () => {
  const blocks: ReplayedReasoningBlock[] = [
    block({
      role: "senior",
      kind: "consult",
      text: "规划一次大规模迁移并验证结果，检查每个工作区与工具调用的边界。",
    }),
    block({
      role: "junior",
      kind: "proposal",
      text: "run the 🧪 verification suite 🚀 for the migration and report every failing check " +
        "日本語のタスク名がとても長い場合でも安全に折り返します",
    }),
  ];
  for (const width of [40, 80]) {
    const plain = renderReplayedReasoning(blocks, { width, theme: plainTheme });
    const noColor = renderReplayedReasoning(blocks, {
      width,
      theme: resolveTheme({ env: { NO_COLOR: "1" } }),
    });
    assert.deepEqual(noColor, plain, `NO_COLOR @${width} is byte-identical to plainTheme`);
    const colored = renderReplayedReasoning(blocks, {
      width,
      theme: createTheme("dark", { color: true }),
    });
    assert.equal(colored.length, plain.length);
    for (let index = 0; index < plain.length; index += 1) {
      assert.equal(stripAnsi(colored[index] ?? ""), plain[index], `colored row ${index} @${width}`);
    }
    for (const row of [...plain, ...colored]) {
      assert.ok(styledWidth(row) <= width, `row ${JSON.stringify(row)} exceeds ${width}`);
      assert.ok(!plain.join("\n").includes("\u001b"));
    }
  }
  assert.deepEqual(renderReplayedReasoning(blocks, { width: 0 }), []);
});

test("the section separates records and reports hidden earlier records honestly", () => {
  const blocks = [block({ text: "first" }), block({ role: "junior", text: "second" })];
  const rows = renderReplayedReasoning(blocks, {
    width: 60,
    theme: plainTheme,
    hiddenRecords: 3,
  });
  const text = rows.join("\n");
  assert.ok(text.startsWith("… +3 earlier reasoning records"), text);
  assert.ok(text.includes("first") && text.includes("second"));
  // the marker is its own row; the blocks are separated by one blank row each
  assert.equal(rows[1], "");
  assert.equal(rows.filter((row) => row === "").length, 2);
  assert.notEqual(rows[rows.length - 1], "", "the section never ends with a blank row");
  assert.deepEqual(renderReplayedReasoning([], { width: 60 }), []);
});

// ---------------------------------------------------------------------------
// (iii) composition: above the transcript, byte-identical when absent
// ---------------------------------------------------------------------------

function frameOptions(width = 80, height = 30, model = createTuiModel()) {
  return {
    width,
    height,
    model,
    editor: createEditor(""),
    status: {
      mode: "consult" as const,
      seniorModel: "s",
      juniorModel: "j",
      sessionName: "reasoning",
      cwd: "/work",
    },
    theme: plainTheme,
  };
}

test("no replay array (or an empty one) keeps the frame byte-identical", () => {
  const base = frameOptions();
  const baseline = renderScreen(base);
  assert.deepEqual(renderScreen({ ...base, replayedReasoning: [] }), baseline);
  // and the option is the only source of the new rows
  assert.ok(!baseline.join("\n").includes(REPLAYED_REASONING_LABEL));
});

test("replayed rows sit above the transcript blocks, one screen-sized frame", () => {
  const model = addUserBlock(createTuiModel(), "run the migration");
  const base = frameOptions(80, 30, model);
  const without = renderScreen(base);
  const withReplay = renderScreen({
    ...base,
    replayedReasoning: [block({ text: "plan the migration", kind: "consult" })],
  });
  assert.equal(withReplay.length, 30, "the frame height is preserved");
  assertRows(withReplay, 80);
  const text = withReplay.join("\n");
  assert.ok(text.includes(REPLAYED_REASONING_LABEL));
  assert.ok(text.includes("SENIOR · consult"));
  assert.ok(!without.join("\n").includes(REPLAYED_REASONING_LABEL));
  // the transcript block content stays visible below the replayed section
  assert.ok(text.includes("run the migration"));
  const replayRow = withReplay.findIndex((row) => row.includes(REPLAYED_REASONING_LABEL));
  const userRow = withReplay.findIndex((row) => row.includes("run the migration"));
  assert.ok(replayRow >= 0 && userRow > replayRow, "the replay section precedes the blocks");
  // chrome below the body (composer + status) is untouched by the replay rows
  assert.deepEqual(withReplay.slice(-4), without.slice(-4));
});

test("only replayed reasoning still renders the transcript (not the welcome screen)", () => {
  const view = screenView({
    ...frameOptions(80, 30),
    replayedReasoning: [block({ text: "reasoning from a previous run" })],
  });
  assert.ok(view.transcript !== null, "the transcript view is used");
  const text = view.lines.join("\n");
  assert.ok(text.includes(REPLAYED_REASONING_LABEL));
  assert.ok(!text.includes("Two models. One shared context."), "welcome screen is not shown");
  // without the replay the same empty model keeps the welcome screen
  assert.ok(renderScreen(frameOptions()).join("\n").includes("Two models. One shared context."));
});

test("the replayed section participates in scrolling and the home anchor", () => {
  const blocks = [block({ text: "first" }), block({ role: "junior", text: "second" })];
  const model = createTuiModel();
  const view = transcriptView(model, {
    width: 60,
    height: 6,
    theme: plainTheme,
    replayedReasoning: blocks,
  });
  assert.ok(view.totalRows > 0);
  assert.ok(view.lines.join("\n").includes(REPLAYED_REASONING_LABEL));
  assert.ok(view.visibleBlockIds.includes(REPLAYED_REASONING_BLOCK_ID));

  const home = homeTranscriptScroll(model, blocks);
  assert.deepEqual(home, {
    followLatest: false,
    anchorId: REPLAYED_REASONING_BLOCK_ID,
    offset: 0,
  });
  // scrolled down first, scrolling up reaches the replayed section
  const latest = transcriptView(model, {
    width: 60,
    height: 6,
    theme: plainTheme,
    replayedReasoning: blocks,
  }).scroll;
  const up = scrollTranscript(model, latest, -50, {
    width: 60,
    height: 6,
    theme: plainTheme,
    replayedReasoning: blocks,
  });
  const top = transcriptView(model, {
    width: 60,
    height: 6,
    theme: plainTheme,
    replayedReasoning: blocks,
    scroll: up,
  });
  assert.ok(top.lines.join("\n").includes(REPLAYED_REASONING_LABEL));
});

test("a window starting inside the replayed section is never gutter-marked", () => {
  const text = Array.from({ length: 8 }, (_, index) => `row ${index}`).join("\n");
  const blocks = [block({ text })];
  const view = transcriptView(createTuiModel(), {
    width: 80,
    height: 4,
    theme: plainTheme,
    replayedReasoning: blocks,
    // offset 2 = the section's second body row (the header is row 0)
    scroll: {
      followLatest: false,
      anchorId: REPLAYED_REASONING_BLOCK_ID,
      offset: 2,
    },
  });
  assert.ok(!view.lines.join("\n").includes("⋯"), "no top-slice gutter marker on replay rows");
  assert.equal(view.lines[0]?.trimEnd(), "  row 1", "the row keeps its own content");
});

// ---------------------------------------------------------------------------
// (iv) assembled TUI over fake TTY streams
// ---------------------------------------------------------------------------

class FakeInput extends EventEmitter {
  isTTY = true;
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  setEncoding(): void {}
  unref(): void {}
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
  return { out, err, log: (line: string) => out.push(line), error: (line: string) => err.push(line) };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

const frameText = (output: FakeOutput): string =>
  stripAnsi(output.data.split(ANSI.cursorHome).at(-1) ?? "");

async function quitApp(input: FakeInput, app: Promise<number>): Promise<number> {
  for (let press = 0; press < 6; press += 1) {
    input.emit("keypress", "", { name: "escape", ctrl: false, shift: false });
    const settled = await Promise.race([
      app.then((code) => code as number | "exited"),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 250)),
    ]);
    if (settled !== "pending") return settled === "exited" ? 0 : settled;
  }
  throw new Error("the TUI did not exit after repeated Escape");
}

function makeSessionFile(root: string, name = SESSION_NAME): string {
  const sessionsDir = path.join(root, "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const sessionFile = path.join(sessionsDir, name);
  const context = new SharedContext(new SessionStore(sessionFile));
  context.makeAndAppend("user", "senior", "message", { text: "seed task" });
  return sessionFile;
}

async function startReasoningApp(options: {
  root: string;
  sessionName?: string;
  sessionFile: string;
}) {
  const input = new FakeInput();
  const output = new FakeOutput();
  const io = makeIO();
  const app = runTuiApp({
    cfg: resolveConfig({
      provider: "mock",
      sessionFile: options.sessionFile,
      resume: true,
    }),
    io,
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
    sessionsDir: path.join(options.root, "sessions"),
    pluginsDir: path.join(options.root, "missing-plugins"),
    historyFile: path.join(options.root, "tui-history.json"),
  });
  return { app, input, output, io };
}

function withNoColor<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.NO_COLOR;
  const previousTerm = process.env.TERM;
  process.env.NO_COLOR = "1";
  if (previousTerm === "dumb") delete process.env.TERM;
  return run().finally(() => {
    if (previous === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous;
    if (previousTerm === undefined) delete process.env.TERM;
    else process.env.TERM = previousTerm;
  });
}

test("assembled TUI: a resumed session replays bounded THINKING blocks at two widths", async () => {
  const { root, sessionsDir, cleanup } = tmpRoot();
  try {
    await withNoColor(async () => {
      const sessionFile = makeSessionFile(root);
      const store = runtimeStoreOf(sessionsDir);
      writeReasoning(store, [
        {
          type: "reasoning",
          role: "senior",
          kind: "consult",
          text: "Look at the request and plan the work. 规划一次迁移 🧪",
          truncated: false,
        },
        {
          type: "reasoning",
          role: "junior",
          kind: "proposal",
          text: "Propose a step-by-step approach for the migration.",
          truncated: false,
        },
      ]);
      const before = fs.readFileSync(sidecarFileOf(sessionsDir), "utf-8");
      const { app, input, output } = await startReasoningApp({ root, sessionFile });
      try {
        assert.ok(
          await waitFor(() => frameText(output).includes(REPLAYED_REASONING_LABEL)),
          `replayed THINKING blocks rendered; last frame:\n${frameText(output)}`,
        );
        let text = frameText(output);
        assert.ok(text.includes("SENIOR · consult"), text);
        assert.ok(text.includes("JUNIOR · proposal"), text);
        assert.ok(
          text.indexOf("SENIOR · consult") < text.indexOf("JUNIOR · proposal"),
          "records replay in sidecar (provider-call) order",
        );
        assert.ok(text.includes("Look at the request"), "preview text is shown");
        for (const row of text.split("\n")) assert.equal(styledWidth(row), 80);

        // Resize: the replayed section stays width-safe with wide glyphs.
        output.resize(40, 24);
        await waitFor(() => frameText(output).includes("JUNIOR · proposal"));
        text = frameText(output);
        assert.ok(text.includes(REPLAYED_REASONING_LABEL), text);
        for (const row of text.split("\n")) assert.equal(styledWidth(row), 40);
        assert.ok(!text.includes("\u001b"), "NO_COLOR frames carry no escape bytes");

        output.resize(120, 24);
        await waitFor(() => frameText(output).includes("Look at the request"));
        for (const row of frameText(output).split("\n")) assert.equal(styledWidth(row), 120);
      } finally {
        const code = await quitApp(input, app);
        assert.equal(code, 0);
      }
      // Read-only: the TUI never writes reasoning events.
      assert.equal(fs.readFileSync(sidecarFileOf(sessionsDir), "utf-8"), before);
    });
  } finally {
    cleanup();
  }
});

test("assembled TUI: a sidecar without reasoning events shows no replay rows", async () => {
  const { root, sessionsDir, cleanup } = tmpRoot();
  try {
    await withNoColor(async () => {
      const sessionFile = makeSessionFile(root);
      // Old/anonymous sessions: only plan snapshots (or nothing) in the sidecar.
      runtimeStoreOf(sessionsDir).append(SESSION_NAME, {
        type: "todo_updated",
        todos: [{ content: "kept plan", status: "in_progress" }],
      });
      const { app, input, output } = await startReasoningApp({ root, sessionFile });
      try {
        assert.ok(await waitFor(() => frameText(output).includes("TODO · 0/1 done")));
        await new Promise((resolve) => setTimeout(resolve, 150));
        assert.ok(!frameText(output).includes(REPLAYED_REASONING_LABEL));
        assert.ok(!frameText(output).includes("THINKING"));
      } finally {
        assert.equal(await quitApp(input, app), 0);
      }
    });
  } finally {
    cleanup();
  }
});
