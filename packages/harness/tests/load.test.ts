/**
 * Hermetic load / scale suite (closes the "no load tests" backlog gap).
 *
 * The goal is bounded, deterministic behavior at scales an ordinary user can
 * still reach — large sessions, large transcripts, many session files, several
 * concurrent runs, repeated compaction — without any network, server socket or
 * wall-clock assertion. Every wait here is a real condition (a run's terminal
 * promise or a barrier), never a sleep, so the suite is stable on a slow CI
 * box; the assertions are about state, bounds and ordering, not speed.
 *
 * Scales (chosen so the whole file stays well under ~10 s; runtimes are
 * reported by the runner per test):
 * 1. large session resume — 1,500 valid protocol envelopes through a real
 *    `SharedContext` + `SessionStore`, then `restoreContext` and a resumed
 *    append (no duplicate lines, dense `seq`);
 * 2. large transcript projection — 400 TUI blocks rendered at height 40 and
 *    widths 100/40: fixed height, exact row width, anchored/tail scrolling
 *    bounded to the document;
 * 3. many sessions / listing — 200 session JSONL files listed through the
 *    in-process CLI `sessions` command (JSON + human + `--limit`); repeated
 *    listings are stable and leave no filesystem handles behind;
 * 4. concurrent runs — 8 different sessions on one `RunManager` worker pool
 *    with the offline mock provider: all terminal, usage recorded, no
 *    cross-session mixing in the JSONL files or the runtime events;
 * 5. repeated compaction — 5 forced compactions over a growing synthetic
 *    context: exactly one summary event survives, the rewritten JSONL still
 *    restores, and the rendered transcript stays under a fixed budget.
 *
 * Run with: node --test tests/load.test.ts (registered in tests/run-all.ts).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { main, type CliIO } from "../src/cli.ts";
import {
  compactContext,
  compactionSummaryText,
  isCompactionSummary,
} from "../src/compaction.ts";
import { resolveConfig } from "../src/config.ts";
import { SharedContext, type ChatMessage } from "../src/context.ts";
import { TwoBrothersHarness } from "../src/harness.ts";
import { createMessage, validateMessage, type Message } from "../src/protocol.ts";
import { MockProvider, type Provider } from "../src/provider.ts";
import { RunManager, type RunJob } from "../src/runtime.ts";
import { SessionStore, restoreContext } from "../src/session.ts";
import {
  addNotice,
  addToolCall,
  addToolResult,
  addUserBlock,
  createTuiModel,
  type TuiModel,
} from "../src/tui/model.ts";
import { displayWidth } from "../src/tui/text.ts";
import {
  latestTranscriptScroll,
  scrollToBlock,
  scrollTranscript,
  transcriptView,
} from "../src/tui/view/transcript.ts";

// --------------------------------------------------------------------------- //
// helpers
// --------------------------------------------------------------------------- //

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Windows can briefly hold handles on freshly written session files. */
function cleanupDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
}

/** Deterministic config: explicit args beat any ambient TWO_BROTHERS_* env. */
function mockConsultConfig() {
  return resolveConfig({
    provider: "mock",
    mode: "consult",
    compact: false,
    compactThreshold: 0,
    compactThresholdTokens: 0,
    contextWindow: 0,
    maxRounds: 3,
    retries: 0,
    timeout: 10,
  });
}

function makeIO(): CliIO & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (line) => out.push(line), error: (line) => err.push(line) };
}

/** Active filesystem resources (sync `fs` calls leave none behind). */
function filesystemResourceCount(): number {
  return process
    .getActiveResourcesInfo()
    .filter((name) => name === "FSReqCallback" || name === "FileHandle" || name === "FSReqPromises")
    .length;
}

/** Bounded predicate wait (no fixed-sleep assertions; used as a leak guard). */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

// --------------------------------------------------------------------------- //
// 1. large session resume
// --------------------------------------------------------------------------- //

const LARGE_SESSION_EVENTS = 1_500;
const LARGE_TASK = "load-test: resume a 1,500-envelope session";

/**
 * Append `count` valid protocol envelopes through the real context/store.
 * The kind cycle is the genuine cooperation exchange shape (task, consult,
 * proposal, review, decision, follow-up), so validation and serialization run
 * exactly as in a product run.
 */
function seedLargeSession(store: SessionStore, count: number): void {
  const ctx = new SharedContext(store);
  ctx.makeAndAppend("user", "senior", "message", { text: LARGE_TASK });
  for (let index = 1; index < count; index += 1) {
    const step = index % 5;
    if (step === 0) {
      ctx.makeAndAppend("senior", "junior", "consult", {
        task: LARGE_TASK,
        ask: `question ${index}: ${"q".repeat(48)}`,
        expect: "proposal",
      });
    } else if (step === 1) {
      ctx.makeAndAppend("junior", "senior", "proposal", {
        title: `Plan ${index}`,
        answer: `answer ${index}: ${"a".repeat(64)}`,
      });
    } else if (step === 2) {
      ctx.makeAndAppend("senior", "junior", "review", {
        verdict: "accept",
        notes: `review ${index}: ${"r".repeat(32)}`,
      });
    } else if (step === 3) {
      ctx.makeAndAppend("senior", "junior", "decision", {
        decision: `decision ${index}: ${"d".repeat(32)}`,
        confidence: 0.9,
      });
    } else {
      ctx.makeAndAppend("user", "senior", "message", { text: `follow-up ${index}` });
    }
  }
}

function assertDenseSeq(events: readonly Message[], expectedCount: number): void {
  assert.equal(events.length, expectedCount);
  assert.deepEqual(
    events.map((event) => event.seq),
    Array.from({ length: expectedCount }, (_, index) => index + 1),
    "session seq must stay dense after load/append",
  );
}

test(
  "large session: 1,500 envelopes round-trip through restoreContext and resume without re-appending",
  { timeout: 15000 },
  () => {
    const dir = tmpdir("tb-load-session-");
    const file = path.join(dir, "large-session.jsonl");
    try {
      seedLargeSession(new SessionStore(file), LARGE_SESSION_EVENTS);

      const loaded = new SessionStore(file).load();
      assertDenseSeq(loaded, LARGE_SESSION_EVENTS);
      for (const event of loaded) assert.deepEqual(validateMessage(event), []);
      assert.equal(new Set(loaded.map((event) => event.id)).size, LARGE_SESSION_EVENTS);
      // Bounded serialization: one small envelope per line, no accidental blowup.
      const fileSize = fs.statSync(file).size;
      assert.ok(fileSize < LARGE_SESSION_EVENTS * 400, `JSONL size out of bounds: ${fileSize}`);
      assert.equal(
        fs.readFileSync(file, "utf-8").split("\n").filter((line) => line !== "").length,
        LARGE_SESSION_EVENTS,
      );

      const restored = restoreContext(new SessionStore(file));
      assert.equal(restored.events.length, LARGE_SESSION_EVENTS);
      assert.deepEqual(
        JSON.stringify(restored.events),
        JSON.stringify(loaded),
        "restoreContext must round-trip every envelope byte-for-byte",
      );
      assert.equal(restored.nextSeq(), LARGE_SESSION_EVENTS + 1);

      // A resumed run appends after the restored events, never re-persisting them.
      const resumed = restored.makeAndAppend("user", "senior", "message", {
        text: "resumed task after the large restore",
      });
      assert.equal(resumed.seq, LARGE_SESSION_EVENTS + 1);

      const reloaded = new SessionStore(file).load();
      assertDenseSeq(reloaded, LARGE_SESSION_EVENTS + 1);
      assert.deepEqual(reloaded.at(-1)?.payload, { text: "resumed task after the large restore" });
      assert.deepEqual(
        JSON.stringify(reloaded.slice(0, LARGE_SESSION_EVENTS)),
        JSON.stringify(loaded),
        "resuming must not rewrite or duplicate existing lines",
      );
      assert.ok(restored.renderTranscript().length > 0);
      // Linear, bounded rendering: the transcript is one line per envelope plus
      // the fixed task/marker head, never a quadratic expansion.
      const rendered = restored.renderTranscript().split("\n");
      assert.equal(rendered.length, LARGE_SESSION_EVENTS + 1 + 5);
    } finally {
      cleanupDir(dir);
    }
  },
);

// --------------------------------------------------------------------------- //
// 2. large transcript projection
// --------------------------------------------------------------------------- //

const TRANSCRIPT_BLOCKS = 400;
const TRANSCRIPT_HEIGHT = 40;

/** 400 display blocks: operator messages, tool cards, notices. */
function largeTranscriptModel(): TuiModel {
  let model = createTuiModel();
  for (let index = 0; index < TRANSCRIPT_BLOCKS / 4; index += 1) {
    model = addUserBlock(model, `Operator message ${index}: ` + "word ".repeat(24));
    model = addToolCall(model, {
      role: "junior",
      tool: "workspace_read_file",
      callId: `call-${index}`,
      args: `{"path":"file-${index}.txt"}`,
    });
    model = addToolResult(model, {
      role: "junior",
      tool: "workspace_read_file",
      status: "ok",
      callId: `call-${index}`,
      result: `contents of file-${index}.txt`,
    });
    model = addNotice(model, "info", `Notice ${index}: ` + "detail ".repeat(12));
    model = addNotice(model, "warn", `Warning ${index}: ` + "careful ".repeat(8));
  }
  return model;
}

function assertExactFrame(lines: readonly string[], width: number, height: number, label: string): void {
  assert.equal(lines.length, height, `${label}: row count`);
  for (const [index, line] of lines.entries()) {
    assert.equal(displayWidth(line), width, `${label}: row ${index} width`);
  }
}

test(
  "large transcript: 400 blocks project to a bounded fixed-height window at widths 100/40",
  { timeout: 15000 },
  () => {
    const model = largeTranscriptModel();
    assert.equal(model.blocks.length, TRANSCRIPT_BLOCKS);
    const blockIds = new Set(model.blocks.map((block) => block.id));

    for (const width of [100, 40]) {
      const view = transcriptView(model, {
        width,
        height: TRANSCRIPT_HEIGHT,
        scroll: latestTranscriptScroll(),
      });
      assertExactFrame(view.lines, width, TRANSCRIPT_HEIGHT, `latest ${width}`);
      assert.ok(view.totalRows > TRANSCRIPT_HEIGHT, "the document must overflow the window");
      assert.equal(view.startRow, view.totalRows - TRANSCRIPT_HEIGHT);
      assert.equal(view.atLatest, true);
      // Bounded projection: one block never renders an unbounded number of rows.
      assert.ok(
        view.totalRows <= model.blocks.length * 8,
        `totalRows out of bounds: ${view.totalRows}`,
      );
      for (const blockId of view.visibleBlockIds) assert.ok(blockIds.has(blockId));

      // Middle anchor: a block-anchored window stays inside the document.
      const middleId = model.blocks[Math.floor(TRANSCRIPT_BLOCKS / 2)]!.id;
      const middle = transcriptView(model, {
        width,
        height: TRANSCRIPT_HEIGHT,
        scroll: scrollToBlock(middleId),
      });
      assertExactFrame(middle.lines, width, TRANSCRIPT_HEIGHT, `middle ${width}`);
      assert.ok(middle.startRow >= 0);
      assert.ok(middle.startRow + TRANSCRIPT_HEIGHT <= middle.totalRows);
      assert.ok(middle.visibleBlockIds.includes(middleId));

      // Tail anchor clamps to the newest rows.
      const tail = transcriptView(model, {
        width,
        height: TRANSCRIPT_HEIGHT,
        scroll: scrollToBlock(model.blocks.at(-1)!.id),
      });
      assertExactFrame(tail.lines, width, TRANSCRIPT_HEIGHT, `tail ${width}`);
      assert.equal(tail.atLatest, true);
      assert.equal(tail.startRow, tail.totalRows - TRANSCRIPT_HEIGHT);

      // Paging far past either end still yields a valid bounded window.
      const up = scrollTranscript(model, latestTranscriptScroll(), -10_000, {
        width,
        height: TRANSCRIPT_HEIGHT,
      });
      const upView = transcriptView(model, {
        width,
        height: TRANSCRIPT_HEIGHT,
        scroll: up,
      });
      assertExactFrame(upView.lines, width, TRANSCRIPT_HEIGHT, `page-up ${width}`);
      assert.equal(upView.startRow, 0);
      assert.ok(upView.visibleBlockIds.includes(model.blocks[0]!.id));

      const down = scrollTranscript(model, up, 10_000, {
        width,
        height: TRANSCRIPT_HEIGHT,
      });
      const downView = transcriptView(model, {
        width,
        height: TRANSCRIPT_HEIGHT,
        scroll: down,
      });
      assertExactFrame(downView.lines, width, TRANSCRIPT_HEIGHT, `page-down ${width}`);
      assert.equal(downView.atLatest, true);
    }
  },
);

// --------------------------------------------------------------------------- //
// 3. many sessions / listing scale
// --------------------------------------------------------------------------- //

const SESSION_FILES = 200;

function sessionNameFor(index: number): string {
  return `sess-${String(index).padStart(3, "0")}.jsonl`;
}

function sessionTitleFor(index: number): string {
  return `Synthetic session ${index} for the listing scale test`;
}

/** Write one small but valid session JSONL (task envelope + decision). */
function writeSessionFile(dir: string, index: number): void {
  const task = createMessage(1, "user", "senior", "message", {
    text: sessionTitleFor(index),
  });
  const decision = createMessage(2, "senior", "junior", "decision", {
    decision: `done ${index}`,
    confidence: 0.9,
  });
  fs.writeFileSync(
    path.join(dir, sessionNameFor(index)),
    `${JSON.stringify(task)}\n${JSON.stringify(decision)}\n`,
    "utf-8",
  );
}

test(
  "many sessions: 200 files list through the CLI path in name order with correct titles",
  { timeout: 15000 },
  async () => {
    const dir = tmpdir("tb-load-sessions-");
    try {
      for (let index = 0; index < SESSION_FILES; index += 1) writeSessionFile(dir, index);

      // The exact in-process path `two-brothers sessions` uses (no subprocess).
      const jsonIO = makeIO();
      assert.equal(await main(["sessions", "--sessions-dir", dir, "--json"], jsonIO), 0);
      const listed = JSON.parse(jsonIO.out.join("\n")) as Array<{
        name: string;
        title: string;
        envelopes: number;
        updated: string;
        error: string | null;
      }>;
      assert.equal(listed.length, SESSION_FILES);
      assert.deepEqual(
        listed.map((entry) => entry.name),
        Array.from({ length: SESSION_FILES }, (_, index) => sessionNameFor(index)),
        "the listing is sorted by session file name",
      );
      for (const [index, entry] of listed.entries()) {
        assert.equal(entry.title, sessionTitleFor(index));
        assert.equal(entry.envelopes, 2);
        assert.equal(entry.error, null);
        assert.equal(typeof entry.updated, "string");
      }

      const limitedIO = makeIO();
      assert.equal(
        await main(["sessions", "--sessions-dir", dir, "--json", "--limit", "7"], limitedIO),
        0,
      );
      const limited = JSON.parse(limitedIO.out.join("\n")) as Array<{ name: string }>;
      assert.equal(limited.length, 7);
      assert.deepEqual(
        limited.map((entry) => entry.name),
        listed.slice(0, 7).map((entry) => entry.name),
      );

      // Human table: header + one row per session, sorted the same way.
      const humanIO = makeIO();
      assert.equal(await main(["sessions", "--sessions-dir", dir], humanIO), 0);
      assert.equal(humanIO.out.length, SESSION_FILES + 1);
      assert.match(humanIO.out[0]!, /session\s+title\s+envelopes\s+updated/);
      assert.ok(humanIO.out[1]!.startsWith(sessionNameFor(0)));
      assert.ok(humanIO.out.at(-1)!.startsWith(sessionNameFor(SESSION_FILES - 1)));

      // Repeated listings are stable and leak no filesystem handles: every
      // read is synchronous and closed by the time it returns, so the temp
      // directory can be removed immediately afterwards (also checked in the
      // finally block) and the active FS-resource count does not grow.
      const before = filesystemResourceCount();
      for (let pass = 0; pass < 2; pass += 1) {
        const againIO = makeIO();
        assert.equal(await main(["sessions", "--sessions-dir", dir, "--json"], againIO), 0);
        assert.deepEqual(JSON.parse(againIO.out.join("\n")), listed);
      }
      assert.ok(
        await waitFor(() => filesystemResourceCount() <= before),
        `listing leaked filesystem handles (${before} -> ${filesystemResourceCount()})`,
      );
    } finally {
      cleanupDir(dir);
    }
  },
);

// --------------------------------------------------------------------------- //
// 4. concurrent runs across sessions
// --------------------------------------------------------------------------- //

const CONCURRENT_SESSIONS = 8;

test(
  "concurrent runs: 8 sessions on one pool all complete with usage and no cross-session mixing",
  { timeout: 20000 },
  async () => {
    const dir = tmpdir("tb-load-runs-");
    const manager = new RunManager({ workers: CONCURRENT_SESSIONS });
    try {
      // Barrier: every job must be executing at the same time (proves the pool
      // dispatched all 8 different sessions concurrently) before any run does
      // its cooperation work. No sleep — the promise resolves on the 8th entry.
      let arrived = 0;
      let releaseBarrier: () => void = () => {};
      const barrier = new Promise<void>((resolve) => {
        releaseBarrier = resolve;
      });
      const arrive = (): void => {
        arrived += 1;
        if (arrived === CONCURRENT_SESSIONS) releaseBarrier();
      };

      const records = Array.from({ length: CONCURRENT_SESSIONS }, (_, index) => {
        const session = `load-run-${index}.jsonl`;
        const task = `concurrent task ${index} — ${"t".repeat(24)}`;
        const job: RunJob = async (_signal, onEnvelope) => {
          arrive();
          await barrier;
          const store = new SessionStore(path.join(dir, session));
          const context = new SharedContext(store);
          const harness = new TwoBrothersHarness(mockConsultConfig());
          const result = await harness.run(task, context);
          for (const message of result.messages) onEnvelope(message);
          return { decision: result.decision, errors: result.errors, usage: result.usage };
        };
        return { session, task, record: manager.submit(task, session, job) };
      });

      assert.equal(arrived, 0, "submit() must not execute a job inline");
      const completed = await Promise.all(
        records.map(({ record }) => manager.wait(record.runId, 15_000)),
      );
      assert.deepEqual(completed, records.map(() => true));
      assert.equal(arrived, CONCURRENT_SESSIONS, "all runs entered their jobs concurrently");

      for (const { session, task, record } of records) {
        assert.equal(record.status, "completed", `${session}: ${record.error ?? ""}`);
        assert.equal(record.session, session);
        assert.equal(record.task, task);
        assert.equal(typeof record.decision?.decision, "string");
        assert.ok((record.decision?.decision as string).length > 0);
        // The mock provider records (input 10, output 5) per call: usage is
        // present, merged across both roles, and internally consistent.
        const usage = record.usage;
        assert.ok(usage.model_calls >= 4, `${session}: expected model calls, got ${usage.model_calls}`);
        assert.equal(usage.input_tokens, usage.model_calls * 10);
        assert.equal(usage.output_tokens, usage.model_calls * 5);
        // Every runtime event belongs to this run (no event cross-talk).
        assert.ok(record.events.length > 0);
        for (const event of record.events) {
          assert.equal((event as { run_id?: string }).run_id, record.runId);
        }
        assert.equal(record.events.at(-1)?.type, "run_end");
      }

      // Newest-first listing mirrors submission order.
      const listing = manager.list();
      assert.deepEqual(
        listing.map((entry) => entry.run_id),
        records.map(({ record }) => record.runId).reverse(),
      );

      // Each session file holds exactly one valid, dense cooperation cycle for
      // its own task: no envelopes from the other concurrent runs.
      for (const [index, { session, task }] of records.entries()) {
        const file = path.join(dir, session);
        const events = new SessionStore(file).load();
        assertDenseSeq(events, 5);
        assert.deepEqual(
          events.map((event) => event.kind),
          ["message", "consult", "proposal", "review", "decision"],
        );
        assert.equal(events[0]!.payload.text, task);
        const raw = fs.readFileSync(file, "utf-8");
        for (const [otherIndex, other] of records.entries()) {
          if (otherIndex !== index && other.session !== session) {
            assert.ok(!raw.includes(other.task), `${session} contains another run's task`);
          }
        }
      }
    } finally {
      cleanupDir(dir);
    }
  },
);

// --------------------------------------------------------------------------- //
// 5. repeated compaction stress
// --------------------------------------------------------------------------- //

const COMPACTION_ROUNDS = 5;
const COMPACTION_PROPOSALS_PER_ROUND = 10;
const COMPACTION_ANSWER_CHARS = 2_000;
const COMPACTION_KEEP_RECENT = 4_000;
const COMPACTION_RENDER_BUDGET = 40_000;
const COMPACTION_SUMMARY =
  "## Goal\nKeep a long synthetic context compact under repeated stress.\n\n" +
  "## Progress\n### Done\n- [x] earlier rounds summarized\n\n" +
  "## Next Steps\n1. Append more proposals\n2. Compact again";

/** Summarizer-only provider: every call must be the compaction seam. */
class SummarizerProvider implements Provider {
  readonly calls: ChatMessage[][] = [];

  async chat(messages: ChatMessage[], responseKind = "message"): Promise<string> {
    assert.equal(responseKind, "compaction", "only the compaction seam may call the summarizer");
    this.calls.push(messages);
    return COMPACTION_SUMMARY;
  }
}

function userText(call: ChatMessage[]): string {
  return call.find((message) => message.role === "user")?.content ?? "";
}

test(
  "repeated compaction: 5 rounds keep exactly one summary, a dense session and a bounded transcript",
  { timeout: 20000 },
  async () => {
    const dir = tmpdir("tb-load-compact-");
    const file = path.join(dir, "repeated-compaction.jsonl");
    try {
      const store = new SessionStore(file);
      const ctx = new SharedContext(store);
      ctx.makeAndAppend("user", "senior", "message", { text: "repeated compaction load test" });

      const provider = new SummarizerProvider();
      const renderedLengths: number[] = [];

      for (let round = 0; round < COMPACTION_ROUNDS; round += 1) {
        for (let index = 0; index < COMPACTION_PROPOSALS_PER_ROUND; index += 1) {
          ctx.makeAndAppend("junior", "senior", "proposal", {
            title: `round ${round} proposal ${index}`,
            answer: `step-by-step plan ${round}/${index}: ` + "x".repeat(COMPACTION_ANSWER_CHARS),
          });
        }
        assert.ok(
          ctx.renderTranscript().length > COMPACTION_KEEP_RECENT,
          "the context must exceed the keep-recent budget before compacting",
        );

        assert.equal(
          await compactContext(ctx, provider, { keepRecentChars: COMPACTION_KEEP_RECENT }),
          true,
          `round ${round}: the compaction seam must fold the context`,
        );

        // Exactly one summary event survives (previous summaries chain in).
        const summaries = ctx.events.filter(isCompactionSummary);
        assert.equal(summaries.length, 1, `round ${round}: exactly one summary event`);
        assert.equal(compactionSummaryText(summaries[0]!), COMPACTION_SUMMARY);
        assertDenseSeq(ctx.events, ctx.events.length);
        for (const event of ctx.events) assert.deepEqual(validateMessage(event), []);

        // The rewritten JSONL is the same session and still loads.
        const reloaded = store.load();
        assert.deepEqual(reloaded.map((event) => event.seq), ctx.events.map((event) => event.seq));
        assert.equal(reloaded.length, ctx.events.length);
        assert.ok(fs.statSync(file).size < COMPACTION_RENDER_BUDGET);

        // No unbounded growth: the compacted context stays small (task head +
        // one summary + a bounded verbatim tail), and the rendered transcript
        // stays under a fixed, budget-derived bound that does not creep up
        // round after round.
        const rendered = ctx.renderTranscript().length;
        renderedLengths.push(rendered);
        assert.ok(
          rendered < COMPACTION_RENDER_BUDGET,
          `round ${round}: rendered transcript ${rendered} chars exceeds the budget`,
        );
        assert.ok(
          ctx.events.length <= 6,
          `round ${round}: the compacted context is not bounded (${ctx.events.length} events)`,
        );
        if (renderedLengths.length > 1) {
          assert.ok(
            rendered <= renderedLengths[0]!,
            `round ${round}: the compacted transcript grew (${renderedLengths[0]} -> ${rendered})`,
          );
        }
      }

      // One summarizer call per round; only the first is cold, later passes
      // chain the previous summary exactly like the product path.
      assert.equal(provider.calls.length, COMPACTION_ROUNDS);
      assert.ok(!userText(provider.calls[0]!).includes("<previous-summary>"));
      for (const call of provider.calls.slice(1)) {
        assert.ok(userText(call).includes("<previous-summary>"));
        assert.ok(userText(call).includes(COMPACTION_SUMMARY));
      }
      // Bounded, not growing: the last compacted transcript is no larger than
      // the first (the tail budget is fixed).
      assert.ok(renderedLengths.at(-1)! <= renderedLengths[0]!);

      // Resume/rewrite still work after the repeated stress.
      const restored = restoreContext(new SessionStore(file));
      assert.deepEqual(
        JSON.stringify(restored.events),
        JSON.stringify(ctx.events),
        "a repeatedly compacted session must restore to the same context",
      );
      const appended = restored.makeAndAppend("user", "senior", "message", {
        text: "after repeated compaction",
      });
      assert.equal(appended.seq, ctx.events.length + 1);
      assertDenseSeq(store.load(), ctx.events.length + 1);
      assert.equal(
        store.load().filter(isCompactionSummary).length,
        1,
        "resuming after repeated compaction keeps exactly one summary",
      );
    } finally {
      cleanupDir(dir);
    }
  },
);
