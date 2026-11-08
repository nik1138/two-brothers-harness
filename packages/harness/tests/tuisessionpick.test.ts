/**
 * TUI `/sessions` resume-picker helpers (`src/tui/view/sessionpick.ts`).
 *
 * Pure title/age resolution: the metadata sidecar title wins, the first
 * operator message is the bounded fallback, corrupt or short JSONL fails soft
 * to the file stem, and ages are short human strings with an honest unknown
 * when the stat failed. No filesystem, no TTY, no timers.
 *
 * Run with: node --test tests/tuisessionpick.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatSessionAge,
  parseSessionEventPrefix,
  resolveSessionTitle,
  sessionPickerItem,
  sessionPickerItems,
  sessionStem,
  SESSION_TITLE_EVENT_SCAN,
  SESSION_TITLE_PREFIX_BYTES,
  UNKNOWN_SESSION_AGE,
  type SessionPickEntry,
} from "../src/tui/view/sessionpick.ts";

/** Fixed clock so age boundaries never depend on the wall clock. */
const NOW = Date.UTC(2026, 10, 8, 12, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function userEvent(text: string): Record<string, unknown> {
  return {
    v: 1,
    id: `id-${text}`,
    seq: 1,
    ts: "2026-11-08T10:00:00Z",
    from: "user",
    to: "senior",
    kind: "message",
    payload: { text },
  };
}

function consultEvent(): Record<string, unknown> {
  return {
    v: 1,
    id: "consult",
    seq: 2,
    ts: "2026-11-08T10:01:00Z",
    from: "senior",
    to: "junior",
    kind: "consult",
    payload: { task: "t", ask: "a", expect: "proposal" },
  };
}

// ---------------------------------------------------------------------------
// file stem
// ---------------------------------------------------------------------------

test("sessionStem: strips one trailing .jsonl and keeps the rest verbatim", () => {
  assert.equal(sessionStem("2026-11-08T11-58-46-279-a05ec8.jsonl"), "2026-11-08T11-58-46-279-a05ec8");
  assert.equal(sessionStem("legacy.jsonl.jsonl"), "legacy.jsonl");
  assert.equal(sessionStem("notes"), "notes");
  assert.equal(sessionStem("nested/odd.jsonl"), "odd");
});

// ---------------------------------------------------------------------------
// title resolution
// ---------------------------------------------------------------------------

test("resolveSessionTitle: a sidecar title wins over the first operator message", () => {
  assert.equal(
    resolveSessionTitle("raw-stem.jsonl", "  Sidecar title  ", [userEvent("message title")]),
    "Sidecar title",
  );
});

test("resolveSessionTitle: a blank/non-string sidecar title falls through to the message", () => {
  for (const blank of [undefined, null, "", "   ", 42, {}]) {
    assert.equal(
      resolveSessionTitle("raw-stem.jsonl", blank, [userEvent("  many   spaces\there ")]),
      "many spaces here",
      JSON.stringify(blank),
    );
  }
});

test("resolveSessionTitle: the derived title is the first operator message, bounded at 80 chars", () => {
  const events = [
    consultEvent(),
    { from: "junior", kind: "message", payload: { text: "not from the operator" } },
    userEvent("first operator message"),
    userEvent("ignored second operator message"),
  ];
  assert.equal(resolveSessionTitle("raw-stem.jsonl", null, events), "first operator message");

  const long = "word ".repeat(30).trim(); // 149 chars
  const bounded = resolveSessionTitle("raw-stem.jsonl", null, [userEvent(long)]);
  assert.equal(bounded.length, 81, "80 chars plus the ellipsis");
  assert.ok(bounded.endsWith("…"));
});

test("resolveSessionTitle: corrupt/short JSONL fails soft to the file stem", () => {
  const stem = "2026-11-08T11-58-46-279-a05ec8";
  // Nothing parseable at all.
  assert.equal(resolveSessionTitle(`${stem}.jsonl`, undefined, []), stem);
  assert.equal(resolveSessionTitle(`${stem}.jsonl`, null, null), stem);
  // Parsed events but no operator message (e.g. a half-written delegation).
  assert.equal(resolveSessionTitle(`${stem}.jsonl`, undefined, [consultEvent()]), stem);
  // A blank first operator message is not a title either.
  assert.equal(resolveSessionTitle(`${stem}.jsonl`, undefined, [userEvent("   ")]), stem);
});

// ---------------------------------------------------------------------------
// bounded JSONL prefix parsing
// ---------------------------------------------------------------------------

test("parseSessionEventPrefix: corrupt lines and non-objects are skipped, never thrown", () => {
  const text = [
    JSON.stringify(userEvent("first")),
    "{not json",
    "[1,2,3]",
    "null",
    '"a string"',
    "42",
    "   ",
    JSON.stringify(userEvent("second")),
    '{"truncated":', // a half-written final line
  ].join("\n");
  const events = parseSessionEventPrefix(text);
  assert.equal(events.length, 2);
  assert.equal(events[0]?.payload.text, "first");
  assert.equal(events[1]?.payload.text, "second");
});

test("parseSessionEventPrefix: the scan is bounded to the first N parsed events", () => {
  const lines = Array.from({ length: SESSION_TITLE_EVENT_SCAN + 5 }, () =>
    JSON.stringify(consultEvent()),
  );
  lines.push(JSON.stringify(userEvent("late operator message")));
  const parsed = parseSessionEventPrefix(lines.join("\n"));
  assert.equal(parsed.length, SESSION_TITLE_EVENT_SCAN);
  assert.ok(parsed.every((event) => event.kind === "consult"));
  // The bound is why a very late first message can only fall back to the stem.
  assert.equal(
    resolveSessionTitle("late.jsonl", null, parsed),
    "late",
  );
  // An explicit smaller limit works too.
  assert.equal(parseSessionEventPrefix(lines.join("\n"), 1).length, 1);
  assert.deepEqual(parseSessionEventPrefix(lines.join("\n"), 0), []);
});

test("the title scan bounds are documented sizes", () => {
  assert.equal(SESSION_TITLE_EVENT_SCAN, 20);
  assert.equal(SESSION_TITLE_PREFIX_BYTES, 64 * 1024);
});

// ---------------------------------------------------------------------------
// human age
// ---------------------------------------------------------------------------

function age(ms: number): string {
  return formatSessionAge(NOW - ms, NOW);
}

test("formatSessionAge: boundaries stay short and human", () => {
  assert.equal(age(0), "just now");
  assert.equal(age(59_999), "just now");
  assert.equal(age(MINUTE), "1m ago");
  assert.equal(age(59 * MINUTE), "59m ago");
  assert.equal(age(HOUR), "1h ago");
  assert.equal(age(2 * HOUR), "2h ago");
  assert.equal(age(23 * HOUR), "23h ago");
  assert.equal(age(DAY), "1d ago");
  assert.equal(age(3 * DAY), "3d ago");
  assert.equal(age(400 * DAY), "400d ago");
});

test("formatSessionAge: a failed stat is an honest unknown", () => {
  for (const unknown of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(formatSessionAge(unknown, NOW), UNKNOWN_SESSION_AGE);
  }
  assert.equal(UNKNOWN_SESSION_AGE, "(unknown time)");
});

test("formatSessionAge: a future mtime never renders a negative age", () => {
  assert.equal(formatSessionAge(NOW + 30_000, NOW), "just now");
});

// ---------------------------------------------------------------------------
// picker rows
// ---------------------------------------------------------------------------

test("sessionPickerItem: title label, human-age description and searchable file name", () => {
  const item = sessionPickerItem(
    { name: "2026-11-08T11-58-46-279-a05ec8.jsonl", sidecarTitle: "  Plan the migration  ", mtimeMs: NOW - 2 * HOUR },
    NOW,
  );
  assert.deepEqual(item, {
    id: "2026-11-08T11-58-46-279-a05ec8.jsonl",
    label: "Plan the migration",
    description: "2h ago",
    keywords: ["2026-11-08T11-58-46-279-a05ec8.jsonl", "2026-11-08T11-58-46-279-a05ec8"],
  });

  const unknown = sessionPickerItem({ name: "legacy.jsonl", mtimeMs: null }, NOW);
  assert.equal(unknown.label, "legacy");
  assert.equal(unknown.description, "(unknown time)");

  // A stored sidecar title is display text: internal whitespace collapses to
  // one line so a newline can never split a picker row.
  const multiline = sessionPickerItem(
    { name: "lines.jsonl", sidecarTitle: "line one\nline   two", mtimeMs: NOW },
    NOW,
  );
  assert.equal(multiline.label, "line one line two");
});

test("sessionPickerItems: order is exactly the caller's order (no hidden reordering)", () => {
  const entries: SessionPickEntry[] = [
    { name: "b.jsonl", sidecarTitle: "Bee title", mtimeMs: NOW - 2 * HOUR },
    { name: "a.jsonl", events: [userEvent("Alpha derived")], mtimeMs: NOW - 3 * DAY },
    { name: "c.jsonl", sidecarTitle: null, mtimeMs: null },
  ];
  const items = sessionPickerItems(entries, NOW);
  assert.deepEqual(
    items.map((item) => item.id),
    ["b.jsonl", "a.jsonl", "c.jsonl"],
  );
  assert.deepEqual(
    items.map((item) => item.label),
    ["Bee title", "Alpha derived", "c"],
  );
  assert.deepEqual(
    items.map((item) => item.description),
    ["2h ago", "3d ago", "(unknown time)"],
  );
  // A very long sidecar title is kept whole here; the picker view clips it to
  // the terminal width, so the helper never makes a second, lossy guess.
  const longTitle = "x".repeat(300);
  const longItem = sessionPickerItem({ name: "long.jsonl", sidecarTitle: longTitle }, NOW);
  assert.equal(longItem.label, longTitle);
});
