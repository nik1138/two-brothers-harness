/**
 * TUI steering queue suite (wave 25): the pure per-turn queue behind the
 * composer's steer chord. Covers the shipped bounds, trimming, drain order,
 * turn-end cleanup and the no-append-after-abort guarantee; the assembled-app
 * path lives in `tuiintegration.test.ts` and the harness contract in
 * `steering.test.ts`.
 *
 * Run with: node --test tests/tuisteering.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { STEER_QUEUE_MAX, STEER_TEXT_MAX_CHARS } from "../src/runtime.ts";
import {
  abandonedSteersToast,
  createSteerQueue,
  steerRejectionMessage,
  steerTextError,
  steeredToast,
  STEER_EMPTY_NOTICE,
} from "../src/tui/steering.ts";

test("the queue uses the shipped backend bounds", () => {
  assert.equal(STEER_TEXT_MAX_CHARS, 4000);
  assert.equal(STEER_QUEUE_MAX, 8);
});

test("enqueue trims; a blank draft is rejected with the web copy", () => {
  const queue = createSteerQueue();
  const accepted = queue.enqueue("  look at the failing test  ");
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.accepted ? accepted.text : "", "look at the failing test");
  assert.equal(queue.pending, 1);

  const blank = queue.enqueue(" \n\t ");
  assert.equal(blank.accepted, false);
  assert.equal(blank.accepted ? "" : blank.reason, "empty");
  assert.equal(blank.accepted ? "" : blank.message, STEER_EMPTY_NOTICE);
  assert.equal(queue.pending, 1, "a rejected draft is never queued");
});

test("the character bound is inclusive and an oversize draft is refused", () => {
  const queue = createSteerQueue();
  const exactly = "x".repeat(STEER_TEXT_MAX_CHARS);
  assert.equal(steerTextError(exactly), null);
  assert.equal(queue.enqueue(exactly).accepted, true);

  const over = "y".repeat(STEER_TEXT_MAX_CHARS + 1);
  assert.equal(steerTextError(over), "too_long");
  const rejected = queue.enqueue(over);
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.accepted ? "" : rejected.reason, "too_long");
  assert.equal(
    rejected.accepted ? "" : rejected.message,
    `Steering text is limited to ${STEER_TEXT_MAX_CHARS} characters.`,
  );
  assert.equal(queue.pending, 1);
});

test("the queue accepts exactly STEER_QUEUE_MAX texts, then reports full", () => {
  const queue = createSteerQueue();
  for (let index = 0; index < STEER_QUEUE_MAX; index += 1) {
    const decision = queue.enqueue(`steer ${index + 1}`);
    assert.equal(decision.accepted, true, `text ${index + 1} is accepted`);
    assert.equal(decision.accepted ? decision.pending : -1, index + 1);
  }
  const rejected = queue.enqueue("one too many");
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.accepted ? "" : rejected.reason, "full");
  assert.equal(rejected.accepted ? -1 : rejected.pending, STEER_QUEUE_MAX);
  assert.match(
    rejected.accepted ? "" : rejected.message,
    /^steering queue is full \(8 pending\); retry after the turn's next step$/,
  );
  assert.equal(steerRejectionMessage("full", 8), rejected.accepted ? "" : rejected.message);
  assert.equal(queue.pending, STEER_QUEUE_MAX, "the full queue is unchanged");
});

test("drain returns the texts in submission order and empties the queue", () => {
  const queue = createSteerQueue();
  queue.enqueue("first");
  queue.enqueue("second");
  queue.enqueue("third");
  assert.deepEqual(queue.drain(), ["first", "second", "third"]);
  assert.equal(queue.pending, 0);
  assert.deepEqual(queue.drain(), [], "a second drain is empty");
});

test("a stopped turn's drain returns nothing and drops the queue", () => {
  const queue = createSteerQueue();
  queue.enqueue("never applied");
  assert.deepEqual(queue.drain(true), []);
  assert.equal(queue.pending, 0, "aborted drain clears instead of returning");
});

test("turn-end cleanup returns leftovers exactly once for the honest toast", () => {
  const queue = createSteerQueue();
  queue.enqueue("left over one");
  queue.enqueue("left over two");
  assert.deepEqual(queue.drain(), ["left over one", "left over two"]);
  assert.deepEqual(queue.clear(), [], "drained texts are not leftovers");

  queue.enqueue("late one");
  assert.deepEqual(queue.clear(), ["late one"]);
  assert.deepEqual(queue.clear(), [], "cleanup is idempotent");
});

test("toast copy states the pending count and the loss truthfully", () => {
  assert.equal(
    steeredToast(1),
    "Steer queued — applied at the turn's next step (1 pending)",
  );
  assert.equal(
    steeredToast(3),
    "Steer queued — applied at the turn's next step (3 pending)",
  );
  assert.equal(steeredToast(Number.NaN), "Steer queued — applied at the turn's next step (0 pending)");
  assert.equal(abandonedSteersToast(1), "turn ended before 1 queued steer was applied");
  assert.equal(abandonedSteersToast(2), "turn ended before 2 queued steers were applied");
});
