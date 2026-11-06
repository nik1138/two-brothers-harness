/**
 * TUI live thinking/response split suite.
 *
 * Covers the token-stream `kind` split in the block model (thinking never
 * leaks into the response draft; per-kind accumulation; text→thinking resets
 * for a new call; thinking→text keeps the reasoning), the settle/clear rules
 * (envelope, tool event, run end/cancel/failure/start, result), unknown-kind
 * compatibility, the compact `THINKING` renderer (width-safe, bounded rows,
 * `… +N lines`, streaming `…`, plain/NO_COLOR output), its transcript-view
 * placement above the streaming response, and one fake-TTY app test proving a
 * `streamTokens` run shows THINKING then the response and clears on the
 * envelope.
 *
 * Run with: node --test tests/tuithinking.test.ts
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { resolveConfig } from "../src/config.ts";
import { MOCK_REASONING } from "../src/provider.ts";
import type { Message } from "../src/protocol.ts";
import type {
  HarnessResultSummary,
  StreamEvent,
  TokenStreamEvent,
} from "../src/runstream.ts";
import { runTuiApp } from "../src/tui/app.ts";
import { createEditor } from "../src/tui/editor.ts";
import {
  addUserBlock,
  appendEnvelopeDelta,
  clearLiveThinking,
  createTuiModel,
  reduceModelEvent,
  type TuiModel,
} from "../src/tui/model.ts";
import { ANSI } from "../src/tui/render.ts";
import { stripAnsi, styledWidth } from "../src/tui/screen.ts";
import { displayWidth } from "../src/tui/text.ts";
import { createTheme, plainTheme } from "../src/tui/theme.ts";
import {
  DEFAULT_THINKING_MAX_ROWS,
  THINKING_LABEL,
  renderThinkingBlock,
} from "../src/tui/transcript.ts";
import { screenView } from "../src/tui/view/screen.ts";
import {
  LIVE_THINKING_BLOCK_ID,
  latestTranscriptScroll,
  transcriptView,
} from "../src/tui/view/transcript.ts";

const AT = "2026-11-06T00:00:00Z";
const REASONING = "Read the request carefully. Pick the structured reply shape.";

function token(
  role: "senior" | "junior",
  kind: "text" | "thinking",
  delta: string,
): TokenStreamEvent {
  return { type: "token", role, kind, delta, at: AT };
}

function reduceAll(model: TuiModel, events: readonly StreamEvent[]): TuiModel {
  let next = model;
  for (const event of events) next = reduceModelEvent(next, event).model;
  return next;
}

function message(
  id: string,
  from: string,
  kind: string,
  payload: Record<string, unknown>,
): Message {
  return {
    v: 1,
    id,
    seq: 1,
    ts: AT,
    from,
    to: from === "user" ? "senior" : "user",
    kind,
    payload,
  };
}

function envelope(from: string, kind: string, payload: Record<string, unknown>): StreamEvent {
  return { type: "envelope", envelope: message(`m-${from}-${kind}`, from, kind, payload), at: AT };
}

function runStatus(status: "started" | "completed" | "failed" | "cancelled"): StreamEvent {
  return { type: "run_status", status, at: AT };
}

const RESULT_SUMMARY: HarnessResultSummary = {
  decision: {},
  usage: { model_calls: 2, input_tokens: 10, output_tokens: 5, cached_tokens: 0 },
  warnings: 0,
  sessionFile: null,
};

function resultEvent(): StreamEvent {
  return { type: "result", result: RESULT_SUMMARY, at: AT };
}

/** The text of the newest streaming response draft (the visible reply). */
function responseDraft(model: TuiModel): string {
  for (let index = model.blocks.length - 1; index >= 0; index -= 1) {
    const block = model.blocks[index];
    if (block !== undefined && block.kind === "envelope") return block.text;
  }
  return "";
}

// --------------------------------------------------------------------------- //
// model: per-kind accumulation, no leakage
// --------------------------------------------------------------------------- //

test("thinking and text deltas accumulate into separate buffers; reasoning never leaks", () => {
  let model = reduceAll(createTuiModel(), [
    token("senior", "thinking", "Read the "),
    token("senior", "thinking", "request. "),
    token("senior", "text", "The answer "),
    token("senior", "text", "is 42."),
  ]);
  assert.ok(model.liveThinking);
  assert.equal(model.liveThinking.role, "senior");
  assert.equal(model.liveThinking.text, "Read the request. ");
  assert.equal(model.liveThinking.streaming, false, "reply text completed the reasoning");
  assert.equal(responseDraft(model), "The answer is 42.");
  assert.ok(!responseDraft(model).includes("Read the request"), "thinking never leaks");
  assert.deepEqual(
    model.blocks.map((block) => block.kind),
    ["envelope"],
    "thinking is live-only: it is never added as a transcript block",
  );

  // Purity: the previous model snapshot is untouched.
  const previous = reduceAll(createTuiModel(), [token("senior", "thinking", "first")]);
  const next = reduceAll(previous, [token("senior", "thinking", " second")]);
  assert.equal(previous.liveThinking?.text, "first");
  assert.equal(next.liveThinking?.text, "first second");
});

test("text→thinking starts a new call (buffer resets); thinking→text keeps the reasoning", () => {
  let model = reduceAll(createTuiModel(), [
    token("senior", "thinking", "old reasoning"),
    token("senior", "text", "visible one"),
  ]);
  assert.equal(model.liveThinking?.text, "old reasoning");
  assert.equal(model.liveThinking?.streaming, false);
  assert.equal(responseDraft(model), "visible one");

  // A text→thinking transition means the next provider call started.
  model = reduceAll(model, [token("senior", "thinking", "new reasoning")]);
  assert.equal(model.liveThinking?.text, "new reasoning", "a new call replaces the buffer");
  assert.equal(model.liveThinking?.streaming, true);
  assert.equal(responseDraft(model), "visible one", "the response draft is untouched");

  // thinking→text within the new call keeps both.
  model = reduceAll(model, [token("senior", "text", " more")]);
  assert.equal(model.liveThinking?.text, "new reasoning", "reasoning is kept above the reply");
  assert.equal(model.liveThinking?.streaming, false);
  assert.equal(responseDraft(model), "visible one more");

  // A role switch also starts a new buffer instead of concatenating.
  model = reduceAll(model, [token("junior", "thinking", "junior thought")]);
  assert.equal(model.liveThinking?.role, "junior");
  assert.equal(model.liveThinking?.text, "junior thought");
});

test("live thinking settles on envelope, tool events and every run lifecycle end", () => {
  const live = reduceAll(createTuiModel(), [
    token("senior", "thinking", REASONING),
    token("senior", "text", "reply"),
  ]);
  assert.ok(live.liveThinking);

  // Envelope: the completed transcript block is authoritative; thinking clears.
  const committed = reduceModelEvent(
    live,
    envelope("senior", "consult", { ask: "what next?", expect: "proposal" }),
  ).model;
  assert.equal(committed.liveThinking, undefined);
  assert.equal(committed.blocks[0]?.kind, "envelope");
  assert.ok(!JSON.stringify(committed.blocks).includes("structured reply shape"));

  // Tool call/result also finalize the live call.
  const toolCalled = reduceModelEvent(live, {
    type: "tool_call",
    role: "junior",
    tool: "echo",
    at: AT,
  }).model;
  assert.equal(toolCalled.liveThinking, undefined);
  const toolResult = reduceModelEvent(live, {
    type: "tool_result",
    role: "junior",
    tool: "echo",
    status: "ok",
    at: AT,
  }).model;
  assert.equal(toolResult.liveThinking, undefined);

  for (const event of [
    runStatus("started"),
    runStatus("completed"),
    runStatus("failed"),
    runStatus("cancelled"),
    resultEvent(),
  ]) {
    const settled = reduceModelEvent(live, event).model;
    assert.equal(settled.liveThinking, undefined, `${event.type} ${JSON.stringify(event)}`);
  }

  // `clearLiveThinking` is pure and idempotent.
  const bare = createTuiModel();
  assert.equal(bare.liveThinking, undefined);
  assert.equal(clearLiveThinking(bare), bare, "no live thinking: identity");
  const cleared = clearLiveThinking(live);
  assert.equal(cleared.liveThinking, undefined);
  assert.equal(live.liveThinking?.text, REASONING, "the input model was not mutated");
  assert.equal(clearLiveThinking(cleared), cleared, "clearing twice is a no-op");
});

test("a missing or unknown token kind is treated as visible text", () => {
  const missing = { type: "token", role: "senior", delta: "plain", at: AT } as unknown as StreamEvent;
  const unknown = { type: "token", role: "senior", kind: "reasoning", delta: "x", at: AT } as unknown as StreamEvent;
  let model = reduceAll(createTuiModel(), [missing, unknown]);
  assert.equal(responseDraft(model), "plainx");
  assert.equal(model.liveThinking, undefined, "unknown kinds never create reasoning state");
});

// --------------------------------------------------------------------------- //
// renderer
// --------------------------------------------------------------------------- //

test("the thinking block is labelled, width-safe and bounded with explicit markers", () => {
  const thinking = { role: "senior" as const, text: REASONING, streaming: true };
  const rows = renderThinkingBlock(thinking, { width: 60, theme: plainTheme });
  assert.ok(rows.length > 0);
  assert.ok(rows[0]?.startsWith(THINKING_LABEL), "the label opens the block");
  const text = rows.join("\n");
  assert.ok(text.includes("Read the request carefully."));
  assert.ok(text.includes("structured"), "content wraps instead of truncating");
  assert.ok(text.includes("shape."));
  assert.equal(rows.at(-1)?.endsWith("…"), true, "streaming reasoning ends with the live marker");
  for (const row of rows) {
    assert.ok(displayWidth(row) <= 60, JSON.stringify(row));
    assert.ok(!row.includes("\u001b"), "plain output leaks no ANSI");
  }

  // Widths (including the compact label-only layout) never overflow.
  for (const width of [1, 4, 8, 10, 16, 20, 40, 80, 120]) {
    for (const row of renderThinkingBlock(thinking, { width, theme: plainTheme, maxRows: 3 })) {
      assert.ok(displayWidth(row) <= width, `width ${width}: ${JSON.stringify(row)}`);
    }
  }

  // Bounded rows: only the last N content rows remain, with an explicit count.
  const manyLines = Array.from({ length: 20 }, (_, index) => `reasoning line ${index}`).join("\n");
  const bounded = renderThinkingBlock(
    { role: "senior", text: manyLines, streaming: false },
    { width: 60, theme: plainTheme, maxRows: 3 },
  );
  assert.equal(bounded[0]?.includes("… +17 lines"), true, JSON.stringify(bounded));
  assert.ok(!bounded.join("\n").includes("reasoning line 0\n"), "older rows are dropped");
  assert.ok(bounded.join("\n").includes(`reasoning line ${19}`), "newest rows stay visible");
  assert.ok(!bounded.join("\n").endsWith("…"), "settled reasoning has no live marker");
  assert.ok(bounded.length <= 3 + 2, "markers stay inside the row budget");
  assert.equal(DEFAULT_THINKING_MAX_ROWS, 6);
  assert.deepEqual(renderThinkingBlock({ role: "senior", text: "x", streaming: true }, { width: 0 }), []);
});

test("a color theme styles the thinking block without changing its geometry", () => {
  const thinking = { role: "junior" as const, text: REASONING, streaming: true };
  const themed = renderThinkingBlock(thinking, { width: 60, theme: createTheme("dark") });
  const plain = renderThinkingBlock(thinking, { width: 60, theme: plainTheme });
  assert.equal(themed.length, plain.length);
  for (let index = 0; index < themed.length; index += 1) {
    assert.equal(styledWidth(themed[index] ?? ""), styledWidth(plain[index] ?? ""));
    assert.ok(displayWidth(stripAnsi(themed[index] ?? "")) <= 60);
  }
  assert.ok(themed.some((row) => row.includes("\u001b[")), "the theme paints the block");
  assert.ok(styledWidth(themed[0] ?? "") <= 60);
});

// --------------------------------------------------------------------------- //
// transcript view and screen placement
// --------------------------------------------------------------------------- //

test("the transcript shows THINKING above the streaming response and drops it on settle", () => {
  const thinking = "consider the options ";
  const text = "the visible reply";

  let model = createTuiModel();
  model = addUserBlock(model, "earlier task");
  model = reduceAll(model, [
    token("senior", "thinking", thinking),
    token("senior", "text", text),
  ]);
  assert.ok(model.liveThinking);

  const view = transcriptView(model, {
    width: 60,
    height: 14,
    theme: plainTheme,
    scroll: latestTranscriptScroll(),
  });
  const joined = view.lines.join("\n");
  const thinkingIndex = joined.indexOf(THINKING_LABEL);
  const responseIndex = joined.indexOf(text);
  const taskIndex = joined.indexOf("earlier task");
  assert.ok(thinkingIndex >= 0, "the live thinking block is rendered");
  assert.ok(joined.includes(thinking.trim()), "the reasoning text is visible");
  assert.ok(taskIndex >= 0 && taskIndex < thinkingIndex, "committed blocks stay above");
  assert.ok(thinkingIndex < responseIndex, "thinking sits above the streaming response");
  assert.ok(view.visibleBlockIds.includes(LIVE_THINKING_BLOCK_ID));
  assert.ok(view.visibleBlockIds.includes(model.blocks[0]!.id));
  for (const line of view.lines) assert.equal(displayWidth(line), 60, "exact viewport geometry");

  // Extra rows are anchored to the live-thinking id, so scrolling stays stable.
  const withoutThinking = reduceModelEvent(model, runStatus("completed")).model;
  const settled = transcriptView(withoutThinking, {
    width: 60,
    height: 14,
    theme: plainTheme,
  });
  assert.ok(!settled.lines.join("\n").includes(THINKING_LABEL), "settled runs show no THINKING");
  assert.ok(settled.lines.join("\n").includes(text), "the response draft was finalized");

  // Regardless of the frame: the user's task block is not affected.
  assert.equal(withoutThinking.blocks[0]?.kind, "user");
});

test("a thinking-only model renders in the transcript slot, not the welcome screen", () => {
  const model = reduceAll(createTuiModel(), [token("senior", "thinking", "solo reasoning")]);
  assert.equal(model.blocks.length, 0);
  const status = {
    mode: "consult" as const,
    seniorModel: "s",
    juniorModel: "j",
    sessionName: "s1",
    cwd: "/w",
  };
  const frame = screenView({
    width: 80,
    height: 24,
    model,
    editor: createEditor(""),
    status,
    theme: plainTheme,
  });
  assert.ok(frame.transcript !== null, "the transcript slot is used");
  assert.ok(frame.lines.join("\n").includes(THINKING_LABEL));
  assert.ok(frame.lines.join("\n").includes("solo reasoning"));
  assert.equal(frame.lines.length, 24);

  // Geometry contract: footer rows and widths are unchanged by the live block.
  const plainFrame = screenView({
    width: 80,
    height: 24,
    model: createTuiModel(),
    editor: createEditor(""),
    status,
    theme: plainTheme,
  });
  assert.equal(frame.statusLines.length, plainFrame.statusLines.length);
  assert.equal(frame.composer.lines.length, plainFrame.composer.lines.length);
  for (const line of frame.lines) assert.equal(styledWidth(line), 80);
});

test("the live thinking block leaves the footer slots (picker/find/status) untouched", () => {
  const model = reduceAll(addUserBlock(createTuiModel(), "task"), [
    token("senior", "thinking", "weigh the options"),
    token("senior", "text", "answer"),
  ]);
  const base = {
    width: 80,
    height: 24,
    editor: createEditor("draft"),
    status: {
      mode: "consult" as const,
      seniorModel: "s",
      juniorModel: "j",
      sessionName: "s1",
      cwd: "/w",
    },
    theme: plainTheme,
    mentionPicker: ["COMMANDS (1)  filter: t"],
    findBar: ["FIND > x  1/1  «x»"],
  } as const;
  const withThinking = screenView({ ...base, model });
  const settled = screenView({
    ...base,
    model: reduceModelEvent(model, runStatus("completed")).model,
  });
  assert.equal(withThinking.lines.length, 24);
  assert.equal(settled.lines.length, 24);
  for (const line of withThinking.lines) assert.equal(styledWidth(line), 80);

  // The footer (picker row, composer lines, find bar, two status rows) is
  // identical in both frames: live thinking lives inside the body only.
  const footerRows = withThinking.composer.lines.length + 1 + 1 + settled.statusLines.length;
  assert.deepEqual(
    withThinking.lines.slice(-footerRows),
    settled.lines.slice(-footerRows),
    "the picker/find/status footer does not move",
  );
  assert.ok(withThinking.lines.join("\n").includes(THINKING_LABEL));
  assert.ok(!settled.lines.join("\n").includes(THINKING_LABEL));
  assert.ok(withThinking.lines.join("\n").includes("FIND > x"));
  assert.ok(withThinking.lines.join("\n").includes("COMMANDS (1)"));
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

  key(name: string, modifiers: { ctrl?: boolean; raw?: string } = {}): void {
    this.emit("keypress", modifiers.raw ?? "", {
      name,
      ctrl: modifiers.ctrl === true,
      shift: false,
    });
  }

  enter(): void {
    this.key("return", { raw: "\r" });
  }
}

class FakeOutput extends EventEmitter {
  isTTY = true;
  columns = 100;
  rows = 30;
  data = "";
  write(chunk: string): boolean {
    this.data += chunk;
    return true;
  }
}

function tmpdir(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tui-thinking-"));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
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
const framesOf = (output: FakeOutput): string[] =>
  output.data.split(ANSI.cursorHome).slice(1).map((frame) => stripAnsi(frame));
const lastFrameText = (output: FakeOutput): string => framesOf(output).at(-1) ?? "";

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

test("a streamTokens run shows a THINKING block, then the response, and clears it on the envelope", async () => {
  const { root, cleanup } = tmpdir();
  const input = new FakeInput();
  const output = new FakeOutput();
  const app = runTuiApp({
    cfg: resolveConfig({ provider: "mock" }),
    io: { log: () => {}, error: () => {} },
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
    pluginsDir: path.join(root, "plugins"),
    sessionsDir: path.join(root, "sessions"),
    streamTokens: true,
  });
  try {
    assert.ok(await waitFor(() => textOf(output).includes("Two Brothers")));
    input.type("say hello");
    input.enter();
    assert.ok(await waitFor(() => textOf(output).includes("decision:"), 30_000));
    assert.ok(
      await waitFor(() =>
        /ready —|turn completed|turn failed|turn cancelled/.test(lastFrameText(output)),
      ),
    );

    const frames = framesOf(output);
    const firstThinking = frames.findIndex((frame) => frame.includes(THINKING_LABEL));
    assert.ok(firstThinking >= 0, "a live THINKING block was rendered");
    assert.ok(
      frames[firstThinking]?.includes("Think it through"),
      "the live block shows the streamed reasoning text",
    );
    const firstDecision = frames.findIndex((frame) => frame.includes("decision:"));
    assert.ok(firstDecision > firstThinking, "THINKING came before the settled response");

    // Nothing leaked into the reply: after settle the reasoning is gone and the
    // committed transcript shows the visible content only.
    const last = lastFrameText(output);
    assert.ok(!last.includes(THINKING_LABEL), "the envelope/run end cleared the live block");
    assert.ok(!last.includes(MOCK_REASONING), "reasoning never appears in the response");
    assert.ok(last.includes("decision:"), "the visible decision is rendered");

    // Plain text was streamed into the response draft (SENIOR consult block).
    assert.ok(textOf(output).includes("consult:"), "visible reply text streamed");
    assert.ok(!frames.at(-1)?.includes(THINKING_LABEL));

    assert.equal(await quit(input, app), 0);
  } finally {
    cleanup();
  }
});
