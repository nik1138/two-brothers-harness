/**
 * Graph cooperation-loop tests (the state machine, mock/scripted providers).
 * Ports the original prototype's graph tests (removed 2026-11-04; see git
 * history; and its retry/usage tests) to node:test. Fake/stub tools stand in
 * for the real workspace tools (Stage 5). Run with: node tests/run-all.ts
 * (or node --test tests/)
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { resolveConfig } from "../src/config.ts";
import { SharedContext, type ChatMessage, type ToolCall } from "../src/context.ts";
import {
  SENIOR_VERIFY_TOOL_NAMES,
  TwoBrothersHarness,
  type HarnessResult,
} from "../src/harness.ts";
import { CLIP_ARG_CHARS, CLIP_EVIDENCE_CHARS, MAX_EVIDENCE_ENTRIES } from "../src/runevents.ts";
import {
  MockProvider,
  ProviderAbortError,
  type Provider,
  type Tool,
  type ToolChatOptions,
  type ToolChatResponse,
} from "../src/provider.ts";
import { SessionStore } from "../src/session.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const cfg = (extra: Record<string, unknown> = {}) =>
  resolveConfig({ provider: "mock", ...extra });

function fakeTool(name: string, execute?: (args: Record<string, unknown>) => string): Tool {
  return {
    name,
    description: `fake ${name}`,
    parameters: { type: "object", properties: {} },
    execute: execute ?? (() => "ok"),
  };
}

/** A MockProvider that records the tool names of every chatWithTools call. */
class ToolRecordingMock extends MockProvider {
  seenToolNames: string[][] = [];

  override async chatWithTools(
    messages: ChatMessage[],
    tools: Tool[],
    options: ToolChatOptions = {},
  ): Promise<ToolChatResponse> {
    this.seenToolNames.push(tools.map((t) => t.name));
    return super.chatWithTools(messages, tools, options);
  }
}

/** Mock provider whose review always revises (forces the revise loop). */
class ReviseProvider implements Provider {
  async chat(messages: ChatMessage[], responseKind = "message"): Promise<string> {
    if (responseKind === "review") {
      return '{"verdict": "revise", "notes": "needs rework", "points": ["details"]}';
    }
    return new MockProvider().chat(messages, responseKind);
  }
}

/** Scripted tool-calling provider: `rounds` responses with multi tool calls each. */
class MultiCallProvider implements Provider {
  calls = 0;
  private readonly rounds: number;
  private readonly names: string[];

  constructor(rounds: number, names: string[]) {
    this.rounds = rounds;
    this.names = names;
  }

  async chat(messages: ChatMessage[], responseKind = "message"): Promise<string> {
    return new MockProvider().chat(messages, responseKind);
  }

  async chatWithTools(
    _messages: ChatMessage[],
    _tools: Tool[],
  ): Promise<ToolChatResponse> {
    this.calls += 1;
    if (this.calls <= this.rounds) {
      const toolCalls: ToolCall[] = this.names.map((name, i) => ({
        id: `c${this.calls}-${i}`,
        name,
        args: {},
      }));
      return { content: "", toolCalls };
    }
    return {
      content: JSON.stringify({ result: "done", artifacts: [], notes: "", confidence: 0.9 }),
      toolCalls: [],
    };
  }
}

function kinds(result: HarnessResult): string[] {
  return result.messages.map((m) => m.kind);
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** The full junior tool belt: read-only slice + mutating tools. */
function workspaceLikeTools(exec: (name: string, args: Record<string, unknown>) => string): Tool[] {
  return [
    fakeTool("workspace_read_file", (args) => exec("workspace_read_file", args)),
    fakeTool("workspace_list_dir", (args) => exec("workspace_list_dir", args)),
    fakeTool("workspace_search_text", (args) => exec("workspace_search_text", args)),
    fakeTool("workspace_run_shell", (args) => exec("workspace_run_shell", args)),
    fakeTool("workspace_write_file", (args) => exec("workspace_write_file", args)),
    fakeTool("workspace_edit_file", (args) => exec("workspace_edit_file", args)),
    fakeTool("workspace_delete_file", (args) => exec("workspace_delete_file", args)),
  ];
}

// ---------------------------------------------------------------------------
// context / envelope sequencing (ports ConsultLoopTest details)
// ---------------------------------------------------------------------------

test("seq is dense across the run", async () => {
  const harness = new TwoBrothersHarness(cfg({ mode: "consult" }));
  const result = await harness.run("numbered events");
  assert.deepEqual(
    result.messages.map((m) => m.seq),
    [1, 2, 3, 4, 5],
  );
});

test("continuing a context keeps seq dense (resume)", async () => {
  const harness = new TwoBrothersHarness(cfg({ mode: "consult" }));
  const first = await harness.run("task one");
  const ctx = new SharedContext();
  for (const event of first.context.events) ctx.append(event);
  const second = await harness.run("task two", ctx);
  assert.deepEqual(
    second.context.events.map((e) => e.seq),
    Array.from({ length: 10 }, (_, i) => i + 1),
  );
  assert.equal(second.context.events[5].payload.text, "task two");
});

test("a resumed context is never re-appended (same-task dedup)", async () => {
  const harness = new TwoBrothersHarness(cfg({ mode: "consult" }));
  const ctx = new SharedContext();
  await harness.run("same task", ctx);
  await harness.run("same task", ctx);
  assert.equal(ctx.events.length, 9, "second run reuses the existing user message");
  assert.deepEqual(
    ctx.events.map((e) => e.seq),
    Array.from({ length: 9 }, (_, i) => i + 1),
  );
});

// ---------------------------------------------------------------------------
// junior tool loop (ports WorkspaceToolsTest with fake tools)
// ---------------------------------------------------------------------------

test("work mode: junior executes tools, evidence rides in the deliverable", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-graph-"));
  try {
    const events: Array<Record<string, any>> = [];
    const writeExec = (name: string, args: Record<string, unknown>): string => {
      const rel = String(args.path ?? "");
      const target = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, String(args.content ?? ""));
      return JSON.stringify({
        tool: name,
        status: "ok",
        path: rel,
        diff: { added_lines: 1, removed_lines: 0, unified: `+${rel}` },
      });
    };
    const tools = workspaceLikeTools((name, args) =>
      name === "workspace_write_file" ? writeExec(name, args) : "ok",
    );
    const harness = new TwoBrothersHarness(cfg({ mode: "work" }), {
      junior: new MockProvider([
        { tool: "workspace_write_file", args: { path: "out/result.txt", content: "done\n" } },
      ]),
      senior: new MockProvider(),
      tools,
      onEvent: (e) => events.push(e as Record<string, any>),
    });
    const result = await harness.run("write the result file");
    assert.deepEqual(kinds(result), ["message", "delegation", "deliverable", "review", "decision"]);
    // the mutation actually happened
    assert.equal(fs.readFileSync(path.join(tmp, "out", "result.txt"), "utf-8"), "done\n");
    // compact typed runtime events with the diff
    const started = events.filter((e) => e.type === "tool_started");
    const completed = events.filter((e) => e.type === "tool_completed");
    assert.equal(started.length, 1);
    assert.equal(completed.length, 1);
    assert.equal(started[0].tool, "workspace_write_file");
    assert.equal(started[0].args.path, "out/result.txt");
    assert.equal(completed[0].status, "ok");
    assert.equal(completed[0].result.diff.added_lines, 1);
    // the deliverable carries clipped tool evidence for the senior
    const deliverable = result.messages[2].payload;
    assert.ok(
      (deliverable.artifacts as string[]).some((a) => a.startsWith("tool: workspace_write_file")),
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("junior tool loop: unknown tool reported, loop continues", async () => {
  const harness = new TwoBrothersHarness(cfg({ mode: "work" }), {
    junior: new MockProvider([{ tool: "nonexistent", args: {} }]),
    senior: new MockProvider(),
    tools: [fakeTool("workspace_read_file")],
  });
  const result = await harness.run("call a missing tool");
  assert.deepEqual(kinds(result), ["message", "delegation", "deliverable", "review", "decision"]);
});

test("junior tool loop is bounded at 8 iterations", async () => {
  let executions = 0;
  const tool = fakeTool("workspace_read_file", () => {
    executions += 1;
    return "ok";
  });
  const harness = new TwoBrothersHarness(cfg({ mode: "work" }), {
    junior: new MockProvider(
      Array.from({ length: 12 }, () => ({ tool: "workspace_read_file", args: {} })),
    ),
    senior: new MockProvider(),
    tools: [tool],
  });
  const result = await harness.run("loop forever");
  assert.equal(executions, 8, "the hard bound caps the loop even when the model keeps calling");
  // The exhausted loop produced no final reply, so the payload repair pass
  // re-asks once for the deliverable: that adds one marked `message` repair
  // envelope (and one provider call) before the deliverable. Filter it out —
  // this test is about the tool-loop bound, not the envelope sequence.
  assert.deepEqual(
    kinds(result).filter((kind) => kind !== "message"),
    ["delegation", "deliverable", "review", "decision"],
  );
});

test("tool evidence is clipped and capped at 12 entries", async () => {
  let n = 0;
  const mk = (name: string): Tool =>
    fakeTool(name, () => {
      n += 1;
      return `result-${n}`;
    });
  const names = ["workspace_read_file", "workspace_list_dir", "workspace_search_text"];
  const harness = new TwoBrothersHarness(cfg({ mode: "work" }), {
    junior: new MultiCallProvider(6, names), // 6 rounds x 3 calls = 18 lines
    senior: new MockProvider(),
    tools: names.map(mk),
  });
  const result = await harness.run("lots of checks");
  const deliverable = result.messages[2].payload;
  const toolLines = (deliverable.artifacts as string[]).filter((a) => a.startsWith("tool: "));
  assert.equal(toolLines.length, MAX_EVIDENCE_ENTRIES);
  for (const line of toolLines) {
    assert.ok(line.length <= "tool: ".length + CLIP_EVIDENCE_CHARS);
  }
});

test("tool_started args are clipped and tool results compacted", async () => {
  const events: Array<Record<string, any>> = [];
  const longArg = "y".repeat(500);
  const longOut = "z".repeat(1000);
  const tool = fakeTool("workspace_run_shell", () =>
    JSON.stringify({ tool: "workspace_run_shell", status: "ok", stdout: longOut, exit_code: 0 }),
  );
  const harness = new TwoBrothersHarness(cfg({ mode: "work" }), {
    junior: new MockProvider([{ tool: "workspace_run_shell", args: { command: longArg } }]),
    senior: new MockProvider(),
    tools: [tool],
    onEvent: (e) => events.push(e as Record<string, any>),
  });
  await harness.run("noisy output");
  const started = events.find((e) => e.type === "tool_started");
  const completed = events.find((e) => e.type === "tool_completed");
  assert.ok(started);
  assert.ok(completed);
  assert.equal((started.args.command as string).length, CLIP_ARG_CHARS);
  assert.equal((completed.result.stdout as string).length, 800);
});

// ---------------------------------------------------------------------------
// senior verification (ports SeniorVerificationTest)
// ---------------------------------------------------------------------------

test("senior verifies the deliverable with the read-only tool slice", async () => {
  const events: Array<Record<string, any>> = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-graph-"));
  try {
    const exec = (name: string, args: Record<string, unknown>): string => {
      if (name === "workspace_write_file") {
        const target = path.join(tmp, String(args.path ?? ""));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, String(args.content ?? ""));
      }
      return JSON.stringify({ tool: name, status: "ok", path: String(args.path ?? "") });
    };
    const tools = workspaceLikeTools(exec);
    const senior = new ToolRecordingMock([
      { tool: "workspace_read_file", args: { path: "out/result.txt" } },
    ]);
    const harness = new TwoBrothersHarness(cfg({ mode: "work" }), {
      senior,
      junior: new MockProvider([
        { tool: "workspace_write_file", args: { path: "out/result.txt", content: "done\n" } },
      ]),
      tools,
      onEvent: (e) => events.push(e as Record<string, any>),
    });
    const result = await harness.run("write the result file");
    // no new envelope kinds: the verification rides inside the review
    assert.deepEqual(kinds(result), ["message", "delegation", "deliverable", "review", "decision"]);
    // the senior got only the read-only workspace slice (no write/edit/delete)
    const verifyCalls = senior.seenToolNames.filter((names) => names.length > 0);
    assert.deepEqual(new Set(verifyCalls[verifyCalls.length - 1]), SENIOR_VERIFY_TOOL_NAMES);
    // tool events attribute activity to both brothers
    const actors = new Set(
      events.filter((e) => e.type === "tool_started" || e.type === "tool_completed").map((e) => e.actor),
    );
    assert.deepEqual(actors, new Set(["junior", "senior"]));
    const juniorCompleted = events.filter((e) => e.type === "tool_completed" && e.actor === "junior");
    const seniorCompleted = events.filter((e) => e.type === "tool_completed" && e.actor === "senior");
    assert.equal(juniorCompleted[0].tool, "workspace_write_file");
    assert.equal(seniorCompleted[0].tool, "workspace_read_file");
    // the review payload is grounded in the senior's actual checks
    const review = result.messages[3].payload;
    assert.equal(review.verdict, "accept");
    assert.ok((review.points as string[]).some((p) => p.startsWith("verify: workspace_read_file")));
    assert.match(String(review.notes), /verification/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("senior verification loop is bounded at 6 iterations", async () => {
  let executions = 0;
  const tools = [fakeTool("workspace_list_dir", () => {
    executions += 1;
    return "ok";
  })];
  const harness = new TwoBrothersHarness(cfg({ mode: "work" }), {
    junior: new MockProvider(),
    senior: new MockProvider(
      Array.from({ length: 10 }, () => ({ tool: "workspace_list_dir", args: {} })),
    ),
    tools,
  });
  const result = await harness.run("verify forever");
  assert.equal(executions, 6);
  assert.deepEqual(kinds(result), ["message", "delegation", "deliverable", "review", "decision"]);
});

test("no verify-slice tools skips verification (work mode, mutating belt only)", async () => {
  const events: Array<Record<string, any>> = [];
  const senior = new ToolRecordingMock();
  const harness = new TwoBrothersHarness(cfg({ mode: "work" }), {
    senior,
    junior: new MockProvider(),
    tools: [fakeTool("workspace_write_file")],
    onEvent: (e) => events.push(e as Record<string, any>),
  });
  const result = await harness.run("no read-only tools here");
  assert.deepEqual(kinds(result), ["message", "delegation", "deliverable", "review", "decision"]);
  assert.equal(senior.seenToolNames.length, 0, "senior never entered a tool loop");
  assert.ok(!events.some((e) => e.actor === "senior"));
  const review = result.messages[3].payload;
  assert.ok(!(review.points as string[]).some((p) => p.startsWith("verify:")));
});

test("senior plugin-style extra tools join the verify slice unfiltered", async () => {
  const senior = new ToolRecordingMock();
  const harness = new TwoBrothersHarness(cfg({ mode: "work" }), {
    senior,
    junior: new MockProvider(),
    tools: [fakeTool("workspace_read_file")],
    seniorTools: [fakeTool("notes_save")],
  });
  await harness.run("senior with an extension tool");
  const verifyCalls = senior.seenToolNames.filter((names) => names.length > 0);
  assert.deepEqual(verifyCalls[verifyCalls.length - 1].sort(), ["notes_save", "workspace_read_file"]);
});

// ---------------------------------------------------------------------------
// revise loop / routing
// ---------------------------------------------------------------------------

test("revise verdict at max_rounds ends the loop (options.maxRounds)", async () => {
  const harness = new TwoBrothersHarness(cfg({ mode: "consult" }), {
    senior: new ReviseProvider(),
    maxRounds: 2,
  });
  const result = await harness.run("rework the decision");
  const ks = kinds(result);
  assert.equal(ks.filter((k) => k === "review").length, 3); // initial + 2 revisions
  assert.equal(result.rounds, 2);
  assert.equal(ks[ks.length - 1], "decision");
  assert.ok(result.decision.decision);
});

// ---------------------------------------------------------------------------
// usage snapshot (ports GraphUsageTest)
// ---------------------------------------------------------------------------

test("mock consult run aggregates usage onto the result", async () => {
  const harness = new TwoBrothersHarness(cfg({ mode: "consult" }));
  const result = await harness.run("Count the tokens");
  assert.deepEqual(result.usage, {
    model_calls: 4,
    input_tokens: 40,
    output_tokens: 20,
    cached_tokens: 0,
  });
});

test("mock work run aggregates usage", async () => {
  const harness = new TwoBrothersHarness(cfg({ mode: "work" }));
  const result = await harness.run("Delegate the tokens");
  assert.deepEqual(kinds(result), ["message", "delegation", "deliverable", "review", "decision"]);
  assert.equal(result.usage.model_calls, 4);
});

test("tool-loop calls count toward the usage snapshot", async () => {
  const harness = new TwoBrothersHarness(cfg({ mode: "work" }), {
    junior: new MockProvider([{ tool: "workspace_read_file", args: { path: "a.txt" } }]),
    senior: new MockProvider([{ tool: "workspace_list_dir", args: {} }]),
    tools: [fakeTool("workspace_read_file"), fakeTool("workspace_list_dir")],
  });
  const result = await harness.run("Count tool-loop tokens");
  // senior: delegation + 2 verify calls + review + decision = 5
  // junior: 2 tool-loop calls = 2
  assert.equal(result.usage.model_calls, 7);
  assert.equal(result.usage.input_tokens, 70);
  assert.equal(result.usage.output_tokens, 35);
});

test("custom providers without usage tracking report zeros", async () => {
  const bare: Provider = {
    async chat(messages: ChatMessage[], responseKind = "message"): Promise<string> {
      return new MockProvider().chat(messages, responseKind);
    },
  };
  const harness = new TwoBrothersHarness(cfg({ mode: "consult" }), {
    senior: bare,
    junior: bare,
  });
  const result = await harness.run("No meters here");
  assert.deepEqual(result.usage, {
    model_calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    cached_tokens: 0,
  });
});

// ---------------------------------------------------------------------------
// cancellation (ports CancellationTest)
// ---------------------------------------------------------------------------

test("cancel before the start raises and writes nothing", async () => {
  const controller = new AbortController();
  controller.abort();
  const ctx = new SharedContext();
  const harness = new TwoBrothersHarness(cfg({ mode: "consult" }), { signal: controller.signal });
  await assert.rejects(() => harness.run("must not start", ctx), ProviderAbortError);
  assert.equal(ctx.events.length, 0);
});

test("cancel mid-run returns the partial envelopes", async () => {
  const controller = new AbortController();
  const cancelAfterAnswer: Provider = {
    async chat(messages: ChatMessage[], responseKind = "message"): Promise<string> {
      controller.abort(); // stop before the *next* model call
      return new MockProvider().chat(messages, responseKind);
    },
  };
  const harness = new TwoBrothersHarness(cfg({ mode: "consult" }), {
    junior: cancelAfterAnswer,
    signal: controller.signal,
  });
  const result = await harness.run("partial run");
  assert.equal(result.cancelled, true);
  // user message + consult + proposal were emitted before the stop took
  // effect at the next check (before senior_review)
  assert.deepEqual(kinds(result), ["message", "consult", "proposal"]);
  assert.deepEqual(result.decision, {});
  assert.ok(result.errors.includes("stopped by operator"));
  // no partial state beyond the envelopes already appended
  assert.equal(result.context.events.length, 3);
});

// ---------------------------------------------------------------------------
// same-session serialization (RunManager rule, ported as an in-process mutex)
// ---------------------------------------------------------------------------

test("concurrent runs on one context serialize (seq stays dense)", async () => {
  const ctx = new SharedContext();
  let releaseSenior!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseSenior = resolve;
  });
  class GatedSenior extends MockProvider {
    override async chat(messages: ChatMessage[], responseKind = "message"): Promise<string> {
      if (responseKind === "consult") await gate;
      return super.chat(messages, responseKind);
    }
  }
  const harness = new TwoBrothersHarness(cfg({ mode: "consult" }), {
    senior: new GatedSenior(),
  });
  const first = harness.run("task one", ctx);
  await tick();
  await tick();
  const second = harness.run("task two", ctx);
  await tick();
  await tick();
  assert.equal(
    ctx.events.length,
    1,
    "the second run must wait for the session mutex before appending",
  );
  releaseSenior();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.cancelled, false);
  assert.equal(b.cancelled, false);
  assert.deepEqual(
    ctx.events.map((e) => e.seq),
    Array.from({ length: 10 }, (_, i) => i + 1),
    "no interleaved appends: seq stays dense",
  );
});

test("concurrent runs on one session-backed context serialize and leave a clean JSONL", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-graph-"));
  try {
    const store = new SessionStore(path.join(tmp, "s.jsonl"));
    const ctx = new SharedContext(store);
    let releaseSenior!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseSenior = resolve;
    });
    class GatedSenior extends MockProvider {
      override async chat(messages: ChatMessage[], responseKind = "message"): Promise<string> {
        if (responseKind === "consult") await gate;
        return super.chat(messages, responseKind);
      }
    }
    const harness = new TwoBrothersHarness(cfg({ mode: "consult" }), {
      senior: new GatedSenior(),
    });
    const first = harness.run("task one", ctx);
    await tick();
    await tick();
    const second = harness.run("task two", ctx);
    await tick();
    await tick();
    assert.equal(ctx.events.length, 1, "the second run must wait for the session mutex");
    releaseSenior();
    await Promise.all([first, second]);
    const loaded = store.load();
    assert.deepEqual(
      loaded.map((e) => e.seq),
      Array.from({ length: 10 }, (_, i) => i + 1),
    );
    assert.equal(loaded[0].payload.text, "task one");
    assert.equal(loaded[5].payload.text, "task two");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
