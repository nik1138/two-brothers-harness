/**
 * Session rewind tests (`src/sessionrewind.ts`): the operator-turn boundary
 * rule, the backwards cut with the compaction floor, clamping/validation and
 * the real-store round trip through `SessionStore.rewrite()`.
 *
 * Hermetic: temp dirs only, no network, no harness provider calls except the
 * offline mock provider for the round-trip fixtures.
 * Run with: node --test tests/sessionrewind.test.ts (or node tests/run-all.ts)
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { resolveConfig } from "../src/config.ts";
import {
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  isCompactionSummary,
} from "../src/compaction.ts";
import { SharedContext } from "../src/context.ts";
import { TwoBrothersHarness, STEERING_PREFIX } from "../src/harness.ts";
import { renderFileBlock, renderSkillLoadedBlock } from "../src/mentions.ts";
import { SessionMetadataStore } from "../src/metadata.ts";
import {
  REPAIR_REQUEST_PREFIX,
  REPAIR_REQUEST_SUFFIX,
} from "../src/payloads.ts";
import { createMessage, type Message } from "../src/protocol.ts";
import { restoreContext, SessionError, SessionStore } from "../src/session.ts";
import {
  computeRewindCut,
  findOperatorTurns,
  MAX_REWIND_TURNS,
  MIN_REWIND_TURNS,
  rewindSession,
  validateRewindTurns,
} from "../src/sessionrewind.ts";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "two-brothers-rewind-"));
}

/** Renumber one fixture so every envelope has its dense in-array seq. */
function seqd(events: Message[]): Message[] {
  return events.map((event, index) => ({ ...event, seq: index + 1 }));
}

/** One complete cooperation turn: task + consult + proposal + review + decision. */
function turn(startSeq: number, task: string): Message[] {
  return [
    createMessage(startSeq, "user", "senior", "message", { text: task }),
    createMessage(startSeq + 1, "senior", "junior", "consult", {
      task,
      ask: "Where do we start?",
    }),
    createMessage(startSeq + 2, "junior", "senior", "proposal", {
      title: task,
      answer: "Do the work.",
    }),
    createMessage(startSeq + 3, "senior", "junior", "review", { verdict: "accept" }),
    createMessage(startSeq + 4, "senior", "user", "decision", { decision: "final" }),
  ];
}

/** A session of `tasks` complete turns, dense seq 1..N. */
function sessionOf(tasks: readonly string[]): Message[] {
  return seqd(tasks.flatMap((task, index) => turn(index * 5 + 1, task)));
}

function summaryEvent(seq: number, body = "## Goal\nrewind the last task"): Message {
  return createMessage(seq, "user", "senior", "message", {
    text: `${COMPACTION_SUMMARY_PREFIX}${body}${COMPACTION_SUMMARY_SUFFIX}`,
  });
}

function repairEvent(seq: number, to: "senior" | "junior" = "senior"): Message {
  return createMessage(seq, "user", to, "message", {
    text: `${REPAIR_REQUEST_PREFIX}\nfix the payload\n${REPAIR_REQUEST_SUFFIX}`,
  });
}

function steeringEvent(seq: number): Message {
  return createMessage(seq, "user", "senior", "message", {
    text: `${STEERING_PREFIX}also mention the tests`,
  });
}

function skillEvent(seq: number, to: "senior" | "junior" = "senior"): Message {
  return createMessage(seq, "user", to, "message", {
    text: renderSkillLoadedBlock("checklist", "1. run the tests"),
  });
}

function fileEvent(seq: number): Message {
  return createMessage(seq, "user", "senior", "message", {
    text: renderFileBlock("notes/a.txt", "hello"),
  });
}

function mockHarness(): TwoBrothersHarness {
  return new TwoBrothersHarness(resolveConfig({ provider: "mock", mode: "consult" }));
}

// --------------------------------------------------------------------------- //
// operator-turn boundary rule
// --------------------------------------------------------------------------- //

test("findOperatorTurns: returns every real operator task in file order", () => {
  const events = sessionOf(["first task", "second task", "third task"]);
  const turns = findOperatorTurns(events);
  assert.deepEqual(
    turns.map((turn) => turn.index),
    [0, 5, 10],
    "a turn starts at its task envelope",
  );
  assert.deepEqual(
    turns.map((turn) => turn.text),
    ["first task", "second task", "third task"],
  );
  assert.equal(findOperatorTurns([]).length, 0);
});

test("findOperatorTurns: harness/app-generated user envelopes are not task boundaries", () => {
  const events = seqd([
    createMessage(1, "user", "senior", "message", { text: "one" }),
    summaryEvent(2),
    repairEvent(3, "senior"),
    repairEvent(4, "junior"),
    steeringEvent(5),
    skillEvent(6, "senior"),
    skillEvent(7, "junior"),
    fileEvent(8),
    createMessage(9, "user", "junior", "message", { text: "not a task" }),
    createMessage(10, "user", "senior", "message", { text: "two" }),
  ]);
  assert.deepEqual(
    findOperatorTurns(events).map((turn) => turn.index),
    [0, 9],
    "only the two real tasks are boundaries",
  );
});

test("findOperatorTurns: blank and malformed records are tolerated, never thrown on", () => {
  const blank = seqd([createMessage(1, "user", "senior", "message", { text: "   " })]);
  assert.deepEqual(findOperatorTurns(blank), []);

  const junk = [
    null,
    undefined,
    [],
    {},
    { from: "user" },
    { from: "user", kind: "message", payload: null },
    { from: "user", to: "senior", kind: "message", payload: { text: 42 } },
    { from: "user", to: "senior", kind: "message" },
    { from: "user", to: "senior", kind: "consult", payload: { text: "x" } },
  ] as unknown as Message[];
  assert.deepEqual(findOperatorTurns(junk), []);
  const cut = computeRewindCut(junk, 1);
  assert.equal(cut.removedCount, 0);
  assert.match(cut.reason, /no operator turns/);
});

// --------------------------------------------------------------------------- //
// cut semantics
// --------------------------------------------------------------------------- //

test("computeRewindCut: rewind 1 cuts exactly the last turn and preserves the kept prefix", () => {
  const events = sessionOf(["one", "two", "three"]);
  const cut = computeRewindCut(events, 1);
  assert.equal(cut.cutIndex, 10);
  assert.equal(cut.keptCount, 10);
  assert.equal(cut.removedCount, 5);
  assert.equal(cut.turns, 1);
  assert.equal(cut.requestedTurns, 1);
  assert.equal(cut.stoppedAtCompaction, false);
  assert.equal(cut.stopsBefore, "operator-turn");
  assert.deepEqual(
    events.slice(0, cut.cutIndex).map((event) => event.seq),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    "the kept prefix is byte-identical and stays dense",
  );
  assert.equal(events[cut.cutIndex]?.payload.text, "three", "the cut starts at the task");
  assert.deepEqual(cut, computeRewindCut(events, 1), "deterministic");
});

test("computeRewindCut: rewind 2 cuts the last two turns; requested == available is not a clamp", () => {
  const events = sessionOf(["one", "two", "three"]);
  const cut = computeRewindCut(events, 2);
  assert.equal(cut.cutIndex, 5);
  assert.equal(cut.turns, 2);
  assert.equal(cut.stopsBefore, "operator-turn");
  assert.equal(cut.stoppedAtCompaction, false);
  assert.equal(events[cut.cutIndex]?.payload.text, "two");

  const all = computeRewindCut(events, 3);
  assert.equal(all.cutIndex, 0);
  assert.equal(all.removedCount, 15);
  assert.equal(all.turns, 3);
  assert.equal(all.stopsBefore, "operator-turn");
});

test("computeRewindCut: a request deeper than the session clamps at session start honestly", () => {
  const events = sessionOf(["one", "two", "three"]);
  const cut = computeRewindCut(events, 99);
  assert.equal(cut.cutIndex, 0);
  assert.equal(cut.removedCount, 15);
  assert.equal(cut.turns, 3);
  assert.equal(cut.requestedTurns, 99);
  assert.equal(cut.stopsBefore, "session-start");
  assert.equal(cut.stoppedAtCompaction, false);
  assert.match(cut.reason, /session start is the boundary/);
});

test("computeRewindCut: a single-turn session can be rewound to an empty session", () => {
  const events = sessionOf(["only task"]);
  const cut = computeRewindCut(events, 1);
  assert.equal(cut.cutIndex, 0);
  assert.equal(cut.removedCount, 5);
  assert.equal(cut.turns, 1);
  assert.equal(cut.stoppedAtCompaction, false);
  assert.equal(cut.stopsBefore, "operator-turn");
});

test("computeRewindCut: invalid depths and empty/no-turn sessions are honest no-ops", () => {
  const events = sessionOf(["one"]);
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const cut = computeRewindCut(events, bad);
    assert.equal(cut.removedCount, 0, String(bad));
    assert.equal(cut.cutIndex, events.length, String(bad));
    assert.match(cut.reason, /positive whole number/, String(bad));
  }
  const empty = computeRewindCut([], 1);
  assert.equal(empty.removedCount, 0);
  assert.equal(empty.keptCount, 0);
  assert.equal(empty.turns, 0);
  assert.match(empty.reason, /no operator turns/);

  const brotherOnly = seqd([
    createMessage(1, "senior", "junior", "consult", { task: "t", ask: "a" }),
    createMessage(2, "junior", "senior", "proposal", { title: "t", answer: "a" }),
  ]);
  const noTasks = computeRewindCut(brotherOnly, 1);
  assert.equal(noTasks.removedCount, 0);
  assert.match(noTasks.reason, /no operator turns/);
});

test("computeRewindCut: never mutates the events array or its envelopes", () => {
  const events = sessionOf(["one", "two"]);
  const before = JSON.stringify(events);
  computeRewindCut(events, 2);
  assert.equal(JSON.stringify(events), before);
});

// --------------------------------------------------------------------------- //
// compaction floor
// --------------------------------------------------------------------------- //

test("computeRewindCut: a compaction summary is never removed, and the clamp is reported", () => {
  // [turn one][summary][turn two][turn three] — the summary must stay kept.
  const events = seqd([
    ...turn(1, "one"),
    summaryEvent(6),
    ...turn(7, "two"),
    ...turn(12, "three"),
  ]);
  const summaryIndex = 5;

  const one = computeRewindCut(events, 1);
  assert.equal(one.cutIndex, 11);
  assert.equal(one.stoppedAtCompaction, false);

  const two = computeRewindCut(events, 2);
  assert.equal(two.cutIndex, 6, "turn two's task starts right after the summary");
  assert.equal(two.turns, 2);
  assert.equal(two.stoppedAtCompaction, false, "depth 2 exactly matches the rewindable turns");

  const tooDeep = computeRewindCut(events, 3);
  assert.equal(tooDeep.cutIndex, 6);
  assert.equal(tooDeep.turns, 2, "clamped to the turns after the summary");
  assert.equal(tooDeep.removedCount, events.length - 6);
  assert.equal(tooDeep.stoppedAtCompaction, true);
  assert.equal(tooDeep.stopsBefore, "compaction-summary");
  assert.match(tooDeep.reason, /compaction summary/);
  const kept = events.slice(0, tooDeep.cutIndex);
  assert.equal(kept[summaryIndex] !== undefined && isCompactionSummary(kept[summaryIndex]!), true);
  assert.equal(isCompactionSummary(kept[kept.length - 1]!), true, "the summary is the last kept row");
});

test("computeRewindCut: turns covered by the summary are not rewindable at all", () => {
  const events = seqd([...turn(1, "one"), summaryEvent(6)]);
  const cut = computeRewindCut(events, 1);
  assert.equal(cut.removedCount, 0);
  assert.equal(cut.keptCount, events.length);
  assert.equal(cut.stoppedAtCompaction, true);
  assert.equal(cut.stopsBefore, "compaction-summary");
  assert.match(cut.reason, /covered by a compaction summary/);
});

test("computeRewindCut: the last of several summaries is the floor", () => {
  const events = seqd([
    ...turn(1, "one"),
    summaryEvent(6),
    ...turn(7, "two"),
    summaryEvent(12),
    ...turn(13, "three"),
  ]);
  const cut = computeRewindCut(events, 1);
  assert.equal(cut.cutIndex, 12);
  assert.equal(cut.stoppedAtCompaction, false);
  const deeper = computeRewindCut(events, 2);
  assert.equal(deeper.cutIndex, 12, "only turn three lives after the last summary");
  assert.equal(deeper.turns, 1);
  assert.equal(deeper.stoppedAtCompaction, true);
  assert.equal(isCompactionSummary(events[deeper.cutIndex - 1]!), true);
});

// --------------------------------------------------------------------------- //
// attached-context absorption
// --------------------------------------------------------------------------- //

test("computeRewindCut: attachment blocks immediately before the removed task go with it", () => {
  const events = seqd([
    ...turn(1, "one"),
    fileEvent(6),
    skillEvent(7),
    ...turn(8, "two"),
  ]);
  const cut = computeRewindCut(events, 1);
  assert.equal(cut.cutIndex, 5, "the cut starts before both attachments");
  assert.equal(cut.removedCount, events.length - 5);
  assert.deepEqual(
    events.slice(cut.cutIndex).map((event) => event.kind),
    ["message", "message", "message", "consult", "proposal", "review", "decision"],
    "both attachments and the whole turn are removed",
  );
  assert.match(String(events[5]?.payload.text), /^<file /);
  assert.match(String(events[6]?.payload.text), /^<skill-loaded /);

  // Attachments that are not immediately before the task stay kept: no
  // backwards absorption across an unrelated envelope.
  const spaced = seqd([
    ...turn(1, "one"),
    fileEvent(6),
    createMessage(7, "senior", "user", "decision", { decision: "final" }),
    ...turn(8, "two"),
  ]);
  const spacedCut = computeRewindCut(spaced, 1);
  assert.equal(spacedCut.cutIndex, 7, "the intervening envelope stops the absorption");
});

// --------------------------------------------------------------------------- //
// depth validation
// --------------------------------------------------------------------------- //

test("validateRewindTurns: strict bounded integers only", () => {
  for (const value of [MIN_REWIND_TURNS, 2, MAX_REWIND_TURNS]) {
    assert.deepEqual(validateRewindTurns(value), { ok: true, turns: value });
  }
  for (const value of [
    0,
    -1,
    MAX_REWIND_TURNS + 1,
    1.5,
    "2",
    "",
    null,
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    {},
    [],
  ]) {
    const parsed = validateRewindTurns(value);
    assert.equal(parsed.ok, false, JSON.stringify(value));
    if (!parsed.ok) assert.match(parsed.error, /rewind turns must be/);
  }
});

// --------------------------------------------------------------------------- //
// real-store round trip
// --------------------------------------------------------------------------- //

test("rewindSession: 3-turn session, rewind 1 then 2, dense seq and resume keep working", async () => {
  const dir = tmpdir();
  try {
    const store = new SessionStore(path.join(dir, "s.jsonl"));
    const harness = mockHarness();
    // One context per session (the CLI keeps one context and appends turns to
    // it), so `seq` stays dense across the three turns like a real session.
    const ctx = new SharedContext(store);
    for (const task of ["task one", "task two", "task three"]) {
      await harness.run(task, ctx);
    }
    const original = store.load();
    assert.equal(original.length, 15);
    assert.deepEqual(original.map((event) => event.seq), Array.from({ length: 15 }, (_, i) => i + 1));
    const meta = new SessionMetadataStore(dir);
    meta.save("s.jsonl", { title: "Rewind fixture" });
    const metaPath = path.join(dir, "s.meta.json");
    const metaBefore = fs.readFileSync(metaPath, "utf-8");

    const pure = computeRewindCut(original, 1);
    const first = rewindSession(store, 1);
    assert.equal(first.rewritten, true);
    assert.deepEqual(first.cut, pure, "the store path uses the pure helper");
    assert.equal(first.path, store.path);
    const kept = store.load();
    assert.equal(kept.length, 10);
    assert.deepEqual(kept, original.slice(0, pure.cutIndex), "kept envelopes are byte-identical");
    assert.deepEqual(kept.map((event) => event.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(kept[9]?.kind, "decision");

    // Resume after a rewind: the next append continues the dense sequence.
    const restored = restoreContext(store);
    assert.equal(restored.events.length, 10);
    restored.makeAndAppend("user", "senior", "message", { text: "retyped task" });
    assert.equal(store.load().length, 11);
    assert.equal(store.load()[10]?.seq, 11);

    // Rewind 2 now removes the two older turns ("retyped task" is a third).
    const second = rewindSession(store, 2);
    assert.equal(second.rewritten, true);
    assert.equal(second.cut.turns, 2);
    assert.equal(second.cut.cutIndex, 5);
    assert.equal(store.load().length, 5);
    assert.equal(store.load().every((event) => event.seq >= 1), true);

    // Everything left is removable; a further rewind is a clean no-op.
    const third = rewindSession(store, MAX_REWIND_TURNS);
    assert.equal(third.rewritten, true);
    assert.equal(store.load().length, 0);
    const fourth = rewindSession(store, 1);
    assert.equal(fourth.rewritten, false);
    assert.equal(fourth.cut.removedCount, 0);
    assert.match(fourth.cut.reason, /no operator turns/);

    assert.equal(fs.readFileSync(metaPath, "utf-8"), metaBefore, "metadata sidecar untouched");
    assert.deepEqual(meta.get("s.jsonl"), { title: "Rewind fixture", created: JSON.parse(metaBefore).created, updated: JSON.parse(metaBefore).updated });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rewindSession: a missing session is a no-op and stays absent", () => {
  const dir = tmpdir();
  try {
    const store = new SessionStore(path.join(dir, "missing.jsonl"));
    const result = rewindSession(store, 1);
    assert.equal(result.rewritten, false);
    assert.equal(result.cut.removedCount, 0);
    assert.equal(store.exists(), false, "rewind never creates a session file");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rewindSession: invalid depth throws SessionError and leaves the file untouched", () => {
  const dir = tmpdir();
  try {
    const file = path.join(dir, "s.jsonl");
    const store = new SessionStore(file);
    new SharedContext(store).makeAndAppend("user", "senior", "message", { text: "task" });
    const before = fs.readFileSync(file, "utf-8");
    for (const bad of [0, 1.5, "2", MAX_REWIND_TURNS + 1]) {
      assert.throws(() => rewindSession(store, bad), SessionError);
      assert.equal(fs.readFileSync(file, "utf-8"), before, String(bad));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rewindSession: a torn/corrupt session errors honestly before any rewrite", () => {
  const dir = tmpdir();
  try {
    const torn = path.join(dir, "torn.jsonl");
    const good = createMessage(1, "user", "senior", "message", { text: "task" });
    fs.writeFileSync(torn, JSON.stringify(good) + "\n" + '{"v":1,"id":"msg-torn","seq":2,"ts":"2026-', "utf-8");
    const before = fs.readFileSync(torn, "utf-8");
    assert.throws(() => rewindSession(new SessionStore(torn), 1), SessionError);
    assert.equal(fs.readFileSync(torn, "utf-8"), before, "the torn file is not rewritten");

    const corrupt = path.join(dir, "corrupt.jsonl");
    fs.writeFileSync(corrupt, "not json\n", "utf-8");
    assert.throws(() => rewindSession(new SessionStore(corrupt), 1), SessionError);
    assert.equal(fs.readFileSync(corrupt, "utf-8"), "not json\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rewindSession: parseable non-turn records are tolerated and preserved in kept", () => {
  const dir = tmpdir();
  try {
    const file = path.join(dir, "s.jsonl");
    const events = seqd([
      createMessage(1, "user", "senior", "message", { text: "one" }),
      { ...createMessage(2, "senior", "junior", "consult", { task: "one", ask: "a" }), extra: "kept" } as Message,
      createMessage(3, "user", "senior", "message", { text: "two" }),
    ]);
    fs.writeFileSync(file, events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf-8");
    const result = rewindSession(new SessionStore(file), 1);
    assert.equal(result.cut.cutIndex, 2);
    const kept = new SessionStore(file).load();
    assert.deepEqual(kept, events.slice(0, 2));
    assert.equal((kept[1] as unknown as Record<string, unknown>).extra, "kept");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
