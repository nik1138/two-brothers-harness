/**
 * Session search + export (`src/sessionsearch.ts`).
 *
 * Pure search/export tests plus hermetic `loadSessionDocs` cases over temp
 * dirs under `os.tmpdir()` (cleaned up in `finally`). No network, no sleeps.
 * Run with: node --test tests/sessionsearch.test.ts
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  isWindowsReservedDeviceName,
  SESSION_NAME_MAX_CHARS,
  SessionMetadataStore,
} from "../src/metadata.ts";
import type { Message } from "../src/protocol.ts";
import {
  HTML_EXPORT_MAX_DOC_CHARS,
  HTML_EXPORT_META_CHARS,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_EVENTS_PER_SESSION,
  SEARCH_MAX_LIMIT,
  SEARCH_MAX_PER_SESSION,
  SEARCH_MAX_SESSIONS,
  SEARCH_MAX_TEXT_PER_EVENT,
  SEARCH_MIN_QUERY_CHARS,
  SEARCH_SNIPPET_CHARS,
  exportSessionFileName,
  loadSessionDocs,
  searchSessions,
  sessionToHtmlString,
  sessionToJsonString,
  sessionToMarkdown,
  type SessionSearchDoc,
} from "../src/sessionsearch.ts";

function message(overrides: Partial<Message> = {}): Message {
  return {
    v: 1,
    id: `msg-${Math.random().toString(16).slice(2, 10)}`,
    seq: 1,
    ts: "2026-11-06T12:00:00Z",
    from: "senior",
    to: "junior",
    kind: "message",
    payload: { text: "hello" },
    ...overrides,
  };
}

function doc(
  name: string,
  title: string,
  events: Message[],
  extra: Partial<SessionSearchDoc> = {},
): SessionSearchDoc {
  return { name, title, events, ...extra };
}

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "two-brothers-sessionsearch-"));
}

function writeSession(dir: string, name: string, events: Message[], mtimeSeconds?: number): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf-8");
  if (mtimeSeconds !== undefined) {
    const date = new Date(mtimeSeconds * 1000);
    fs.utimesSync(file, date, date);
  }
  return file;
}

test("search constants match the published contract", () => {
  assert.equal(SEARCH_MIN_QUERY_CHARS, 2);
  assert.equal(SEARCH_DEFAULT_LIMIT, 20);
  assert.equal(SEARCH_MAX_LIMIT, 100);
  assert.equal(SEARCH_SNIPPET_CHARS, 160);
  assert.equal(SEARCH_MAX_PER_SESSION, 3);
  assert.equal(SEARCH_MAX_SESSIONS, 200);
  assert.equal(SEARCH_MAX_EVENTS_PER_SESSION, 2000);
  assert.equal(SEARCH_MAX_TEXT_PER_EVENT, 100_000);
});

test("query shorter than the minimum returns an empty, untruncated result", () => {
  const docs = [doc("a.jsonl", "Redis migration", [message()])];
  for (const query of ["", " ", "r", "  r  "]) {
    const result = searchSessions(docs, query);
    assert.deepEqual(result.hits, []);
    assert.equal(result.truncated, false);
    assert.equal(result.scanned_sessions, docs.length);
    assert.equal(result.query, query.trim());
  }
});

test("title hit: matched title with null envelope fields", () => {
  const result = searchSessions([doc("s1.jsonl", "Redis migration plan", [])], "  redis  ");
  assert.equal(result.query, "redis");
  assert.equal(result.hits.length, 1);
  const hit = result.hits[0];
  assert.equal(hit.session, "s1.jsonl");
  assert.equal(hit.title, "Redis migration plan");
  assert.equal(hit.field, "title");
  assert.equal(hit.seq, null);
  assert.equal(hit.role, null);
  assert.equal(hit.kind, null);
  assert.equal(hit.ts, null);
  assert.equal(hit.snippet, "Redis migration plan");
  assert.equal(result.truncated, false);
});

test("message hit carries envelope seq/from/kind/ts and a snippet", () => {
  const events = [
    message({ seq: 1, payload: { text: "unrelated" } }),
    message({
      seq: 2,
      from: "user",
      ts: "2026-11-06T13:00:00Z",
      payload: { text: "Plan a migration from Redis to Valkey" },
    }),
  ];
  const result = searchSessions([doc("s2.jsonl", "Session", events)], "valkey");
  assert.equal(result.hits.length, 1);
  const hit = result.hits[0];
  assert.equal(hit.field, "message");
  assert.equal(hit.seq, 2);
  assert.equal(hit.role, "user");
  assert.equal(hit.kind, "message");
  assert.equal(hit.ts, "2026-11-06T13:00:00Z");
  assert.equal(hit.snippet, "Plan a migration from Redis to Valkey");
});

test("decision envelopes hit the decision field", () => {
  const events = [
    message({
      seq: 7,
      from: "senior",
      to: "user",
      kind: "decision",
      payload: { decision: "accept the proposal", rationale: "cheap" },
    }),
  ];
  const result = searchSessions([doc("d.jsonl", "Decision", events)], "accept");
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].field, "decision");
  assert.equal(result.hits[0].kind, "decision");
  assert.equal(result.hits[0].seq, 7);
  assert.equal(result.hits[0].role, "senior");
});

test("case-insensitive by default; caseSensitive option honored", () => {
  const docs = [
    doc("c.jsonl", "Redis Migration", [message({ payload: { text: "VALKEY plan" } })]),
  ];
  assert.equal(searchSessions(docs, "redis").hits.length, 1);
  assert.equal(searchSessions(docs, "valkey").hits.length, 1);
  assert.equal(searchSessions(docs, "redis", { caseSensitive: true }).hits.length, 0);
  assert.equal(searchSessions(docs, "valkey", { caseSensitive: true }).hits.length, 0);
  assert.equal(searchSessions(docs, "Redis", { caseSensitive: true }).hits.length, 1);
});

test("snippet is the whole whitespace-collapsed line when it fits", () => {
  const text = "Hello\n\nworld,\t  Redis   rocks";
  const result = searchSessions([doc("w.jsonl", "t", [message({ payload: { text } })])], "redis");
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].snippet, "Hello world, Redis rocks");
});

test("long snippet is centered, ellipsis-clipped, single-line and bounded", () => {
  const text = "a".repeat(400) + " needle " + "b".repeat(400);
  const result = searchSessions([doc("l.jsonl", "t", [message({ payload: { text } })])], "needle");
  const snippet = result.hits[0].snippet;
  assert.equal(snippet.length, SEARCH_SNIPPET_CHARS);
  assert.ok(snippet.startsWith("…"), snippet);
  assert.ok(snippet.endsWith("…"), snippet);
  assert.ok(snippet.includes("needle"));
  assert.ok(!/[\r\n\t]/.test(snippet));
  const matchIndex = snippet.indexOf("needle");
  assert.ok(matchIndex > 20 && matchIndex < snippet.length - 20, `match not centered: ${matchIndex}`);
});

test("per-session cap clips a session's hits and reports truncation", () => {
  const events = Array.from({ length: 5 }, (_, index) =>
    message({ seq: index + 1, payload: { text: `redis note ${index + 1}` } }),
  );
  const docs = [doc("cap.jsonl", "cap", events)];

  const capped = searchSessions(docs, "redis", { limit: 100 });
  assert.equal(capped.hits.length, SEARCH_MAX_PER_SESSION);
  assert.equal(capped.truncated, true);
  assert.deepEqual(capped.hits.map((hit) => hit.seq), [1, 2, 3]);

  const tighter = searchSessions(docs, "redis", { limit: 100, perSession: 1 });
  assert.equal(tighter.hits.length, 1);
  assert.equal(tighter.hits[0].seq, 1);
  assert.equal(tighter.truncated, true);

  // perSession is the caller's cap: a larger value is honored, not clipped
  const wider = searchSessions(docs, "redis", { limit: 100, perSession: 5 });
  assert.equal(wider.hits.length, 5);
  assert.equal(wider.truncated, false);
});

test("matches that fit under the caps are not truncation", () => {
  const docs = [
    doc("ok.jsonl", "redis plan", [
      message({ seq: 1, payload: { text: "one redis" } }),
      message({ seq: 2, payload: { text: "two redis" } }),
    ]),
  ];
  // title + two envelopes = exactly the per-session cap, nothing was dropped
  const result = searchSessions(docs, "redis", { limit: 10, perSession: 3 });
  assert.equal(result.hits.length, 3);
  assert.equal(result.truncated, false);
});

test("overall limit clips across docs; limit equal to the match count is not truncation", () => {
  const docs = [
    doc("a.jsonl", "a redis", [message({ seq: 1, payload: { text: "redis a1" } })]),
    doc("b.jsonl", "b redis", [message({ seq: 1, payload: { text: "redis b1" } })]),
  ];
  const clipped = searchSessions(docs, "redis", { limit: 2 });
  assert.equal(clipped.hits.length, 2);
  assert.deepEqual(
    clipped.hits.map((hit) => [hit.session, hit.field]),
    [
      ["a.jsonl", "title"],
      ["a.jsonl", "message"],
    ],
  );
  assert.equal(clipped.truncated, true);

  const exact = searchSessions([docs[0]], "redis", { limit: 2 });
  assert.equal(exact.hits.length, 2);
  assert.equal(exact.truncated, false);
});

test("limit is clamped to SEARCH_MAX_LIMIT and to at least 1; default is 20", () => {
  const many = Array.from({ length: 40 }, (_, index) =>
    doc(
      `s${index}.jsonl`,
      `session ${index}`,
      Array.from({ length: 3 }, (_, eventIndex) =>
        message({ seq: eventIndex + 1, payload: { text: `needle ${index}-${eventIndex}` } }),
      ),
    ),
  );
  const clamped = searchSessions(many, "needle", { limit: 1000 });
  assert.equal(clamped.hits.length, SEARCH_MAX_LIMIT);
  assert.equal(clamped.truncated, true);

  const defaultLimitDocs = Array.from({ length: 30 }, (_, index) =>
    doc(`d${index}.jsonl`, "t", [message({ seq: 1, payload: { text: `redis ${index}` } })]),
  );
  const byDefault = searchSessions(defaultLimitDocs, "redis");
  assert.equal(byDefault.hits.length, SEARCH_DEFAULT_LIMIT);
  assert.equal(byDefault.truncated, true);

  const raised = searchSessions(
    [doc("one.jsonl", "needle", [message({ seq: 1, payload: { text: "needle again" } })])],
    "needle",
    { limit: 0 },
  );
  assert.equal(raised.hits.length, 1);
  assert.equal(raised.hits[0].field, "title");
  assert.equal(raised.truncated, true);
});

test("hit order is deterministic: doc order, title first, envelope order within a doc", () => {
  const docs = [
    doc("b.jsonl", "redis doc b", [
      message({ seq: 1, payload: { text: "redis b1" } }),
      message({ seq: 2, payload: { text: "redis b2" } }),
    ]),
    doc("a.jsonl", "redis doc a", [message({ seq: 9, payload: { text: "redis a1" } })]),
  ];
  const first = searchSessions(docs, "redis", { limit: 100, perSession: 3 });
  const second = searchSessions(docs, "redis", { limit: 100, perSession: 3 });
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.hits.map((hit) => `${hit.session}:${hit.seq ?? "title"}`),
    ["b.jsonl:title", "b.jsonl:1", "b.jsonl:2", "a.jsonl:title", "a.jsonl:9"],
  );
});

test("malformed docs, envelopes and payloads are tolerated without throwing", () => {
  const weirdDocs = [
    {
      name: "m.jsonl",
      title: "malformed",
      events: [
        null,
        "not an envelope",
        { kind: "message", payload: null },
        { kind: "message", payload: {} },
        { kind: "message", payload: { count: 42, flag: true } },
        { kind: "message", payload: "bare redis string" },
        { kind: "message", payload: { nested: { deep: "redis nested" } } },
        { kind: "message", payload: { items: ["alpha", "redis in array"] } },
        { kind: "message", payload: { note: "a fourth redis match" } },
      ],
    },
    { name: 42, title: null, events: "nope" },
    null,
  ] as unknown as SessionSearchDoc[];

  const result = searchSessions(weirdDocs, "redis");
  assert.equal(result.scanned_sessions, weirdDocs.length);
  assert.equal(result.truncated, true); // 3-hit per-session cap dropped a 4th real match
  assert.equal(result.hits.length, 3);
  assert.deepEqual(result.hits.map((hit) => hit.field), ["message", "message", "message"]);
  for (const hit of result.hits) {
    assert.equal(hit.session, "m.jsonl");
    assert.equal(hit.seq, null);
    assert.equal(hit.role, null);
    assert.equal(hit.kind, "message");
    assert.equal(hit.ts, null);
    assert.ok(hit.snippet.includes("redis") || hit.snippet.includes("Redis"));
  }
});

test("depth bound, JSON keys and session names are not searched", () => {
  let deep: Record<string, unknown> = { text: "redis too deep" };
  for (let index = 0; index < 8; index += 1) deep = { nested: deep };
  const events = [
    message({ payload: deep }),
    message({ payload: { redis: "value without the term" } }),
    message({ payload: { number: 7, bool: false } }),
  ];
  const docs = [doc("redis.jsonl", "unrelated title", events)];
  const result = searchSessions(docs, "redis");
  assert.equal(result.hits.length, 0);
  assert.equal(result.truncated, false);
});

test("per-envelope leaf text is bounded by SEARCH_MAX_TEXT_PER_EVENT", () => {
  const after = "x".repeat(SEARCH_MAX_TEXT_PER_EVENT) + " needle";
  const before = "needle " + "x".repeat(SEARCH_MAX_TEXT_PER_EVENT);
  const beyond = searchSessions(
    [doc("beyond.jsonl", "t", [message({ payload: { text: after } })])],
    "needle",
  );
  assert.equal(beyond.hits.length, 0);

  const within = searchSessions(
    [doc("within.jsonl", "t", [message({ payload: { text: before } })])],
    "needle",
  );
  assert.equal(within.hits.length, 1);
});

test("markdown export: header, italic ts, verbatim message text, scalar bullets", () => {
  const events = [
    message({
      seq: 1,
      from: "user",
      to: "senior",
      ts: "2026-11-06T12:00:00Z",
      payload: { text: "First line\nsecond line" },
    }),
    message({
      seq: 2,
      from: "senior",
      to: "junior",
      kind: "delegation",
      ts: "2026-11-06T12:05:00Z",
      payload: {
        work: "check the plan",
        acceptance: "all green",
        artifacts: ["a.ts", "b.ts"],
        confidence: 0.8,
      },
    }),
  ];
  const markdown = sessionToMarkdown(
    {
      name: "s1.jsonl",
      title: "Redis migration",
      events,
      workspace_id: null,
      updated: 1_700_000_000,
    },
    { exportedAt: "2026-11-06T00:00:00.000Z" },
  );

  const lines = markdown.split("\n");
  assert.equal(lines[0], "# Redis migration");
  assert.equal(lines[1], "- session: s1.jsonl");
  assert.equal(lines[2], "- workspace: none");
  assert.equal(lines[3], "- updated: 2023-11-14T22:13:20.000Z");
  assert.equal(lines[4], "- exported: 2026-11-06T00:00:00.000Z");
  assert.equal(lines[5], "- envelopes: 2");

  assert.ok(markdown.includes("## 1. user → senior · message"));
  assert.ok(markdown.includes("_2026-11-06T12:00:00Z_"));
  assert.ok(markdown.includes("First line\nsecond line"));
  assert.ok(markdown.includes("## 2. senior → junior · delegation"));
  assert.ok(markdown.includes("- work: check the plan"));
  assert.ok(markdown.includes("- acceptance: all green"));
  assert.ok(markdown.includes("- artifacts: a.ts, b.ts"));
  assert.ok(markdown.includes("- confidence: 0.8"));
  assert.ok(markdown.endsWith("\n"));
  assert.ok(!markdown.endsWith("\n\n"));
  assert.ok(!/<[a-z][^>]*>/i.test(markdown), "markdown export must not emit HTML");
});

test("markdown export: absent workspace/updated render as none; empty title is Untitled session", () => {
  const markdown = sessionToMarkdown(
    { name: "x.jsonl", title: "", events: [] },
    { exportedAt: "2026-11-06T00:00:00Z" },
  );
  assert.ok(markdown.startsWith("# Untitled session\n"));
  assert.ok(markdown.includes("- workspace: none"));
  assert.ok(markdown.includes("- updated: none"));
  assert.ok(markdown.includes("- envelopes: 0"));
  assert.equal(markdown, markdown.trimEnd() + "\n");
});

test("markdown export bounds each payload and marks the truncation explicitly", () => {
  const longText = "z".repeat(25_000);
  const markdown = sessionToMarkdown(
    { name: "big.jsonl", title: "big", events: [message({ payload: { text: longText } })] },
    { exportedAt: "E" },
  );
  assert.ok(markdown.includes("truncated"));
  assert.ok(markdown.includes("5,000") || markdown.includes("5000"), markdown.slice(-200));
  assert.ok(markdown.length < 21_000, `unexpected export size: ${markdown.length}`);
  assert.ok(!markdown.includes("z".repeat(20_001)));
});

test("json export: stable shape, verbatim envelopes, single trailing newline", () => {
  const events = [message({ seq: 1, payload: { text: "hi" } })];
  const json = sessionToJsonString(
    {
      name: "s.jsonl",
      title: "T",
      events,
      workspace_id: "w1",
      updated: 1_700_000_000,
    },
    { exportedAt: "2026-11-06T00:00:00.000Z" },
  );
  assert.ok(json.endsWith("\n"));
  assert.ok(!json.endsWith("\n\n"));
  const parsed = JSON.parse(json);
  assert.deepEqual(Object.keys(parsed), [
    "name",
    "title",
    "workspace_id",
    "updated",
    "exported_at",
    "envelopes",
  ]);
  assert.equal(parsed.name, "s.jsonl");
  assert.equal(parsed.title, "T");
  assert.equal(parsed.workspace_id, "w1");
  assert.equal(parsed.updated, 1_700_000_000);
  assert.equal(parsed.exported_at, "2026-11-06T00:00:00.000Z");
  assert.deepEqual(parsed.envelopes, events);
  assert.ok(json.includes('\n  "name": "s.jsonl"'));

  const bare = JSON.parse(
    sessionToJsonString({ name: "x.jsonl", title: "", events: [] }, { exportedAt: "E" }),
  );
  assert.equal(bare.workspace_id, null);
  assert.equal(bare.updated, null);
});

test("export filenames strip the extension and sanitize the basename", () => {
  assert.equal(exportSessionFileName("foo.jsonl", "markdown"), "foo.md");
  assert.equal(exportSessionFileName("foo.jsonl", "json"), "foo.json");
  assert.equal(exportSessionFileName("foo.jsonl", "html"), "foo.html");
  assert.equal(exportSessionFileName("2026-11-06-abc.jsonl", "markdown"), "2026-11-06-abc.md");
  assert.equal(exportSessionFileName("../../evil.jsonl", "json"), "evil.json");
  assert.equal(exportSessionFileName("../../evil.jsonl", "html"), "evil.html");
  assert.equal(exportSessionFileName("a/c.jsonl", "markdown"), "c.md");
  assert.equal(exportSessionFileName("bad:name?.jsonl", "markdown"), "bad-name-.md");
  assert.equal(exportSessionFileName("x.html", "html"), "x.html");
  assert.equal(exportSessionFileName("", "markdown"), "session.md");
  assert.equal(exportSessionFileName("", "html"), "session.html");
  assert.equal(exportSessionFileName(".jsonl", "json"), "session.json");
});

test("loadSessionDocs: newest first, metadata title wins over the derived title", () => {
  const dir = tmpdir();
  try {
    const now = Math.floor(Date.now() / 1000);
    writeSession(
      dir,
      "old.jsonl",
      [message({ seq: 1, from: "user", to: "senior", payload: { text: "old derived title" } })],
      now - 300,
    );
    writeSession(
      dir,
      "new.jsonl",
      [message({ seq: 1, from: "user", to: "senior", payload: { text: "new derived title" } })],
      now - 60,
    );
    new SessionMetadataStore(dir).save("new.jsonl", { title: "Curated title", workspaceId: "ws-1" });

    const loaded = loadSessionDocs(dir);
    assert.equal(loaded.skipped, 0);
    assert.equal(loaded.truncated, false);
    assert.deepEqual(loaded.docs.map((item) => item.name), ["new.jsonl", "old.jsonl"]);
    assert.equal(loaded.docs[0].title, "Curated title");
    assert.equal(loaded.docs[0].workspace_id, "ws-1");
    assert.equal(loaded.docs[1].title, "old derived title");
    assert.equal(loaded.docs[1].workspace_id, null);
    assert.equal(typeof loaded.docs[0].updated, "number");
    assert.equal(loaded.docs[0].events.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadSessionDocs: session cap keeps newest files and marks truncation", () => {
  const dir = tmpdir();
  try {
    const now = Math.floor(Date.now() / 1000);
    writeSession(dir, "a.jsonl", [], now - 300);
    writeSession(dir, "b.jsonl", [], now - 200);
    writeSession(dir, "c.jsonl", [], now - 100);
    fs.writeFileSync(path.join(dir, "notes.txt"), "ignored", "utf-8");

    const loaded = loadSessionDocs(dir, { maxSessions: 2 });
    assert.deepEqual(loaded.docs.map((item) => item.name), ["c.jsonl", "b.jsonl"]);
    assert.equal(loaded.truncated, true);
    assert.equal(loaded.skipped, 0);

    const none = loadSessionDocs(dir, { maxSessions: 0 });
    assert.deepEqual(none.docs, []);
    assert.equal(none.truncated, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadSessionDocs: a corrupt session file is skipped and counted", () => {
  const dir = tmpdir();
  try {
    const now = Math.floor(Date.now() / 1000);
    writeSession(dir, "good.jsonl", [message({ seq: 1 })], now - 100);
    fs.writeFileSync(path.join(dir, "bad.jsonl"), '{"v":1}\nnot json\n', "utf-8");
    const badDate = new Date((now - 50) * 1000);
    fs.utimesSync(path.join(dir, "bad.jsonl"), badDate, badDate);

    const loaded = loadSessionDocs(dir);
    assert.equal(loaded.skipped, 1);
    assert.equal(loaded.truncated, false);
    assert.deepEqual(loaded.docs.map((item) => item.name), ["good.jsonl"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadSessionDocs: a torn final line keeps the session and never rewrites it", () => {
  const dir = tmpdir();
  try {
    const file = writeSession(dir, "torn.jsonl", [
      message({ seq: 1, from: "user", to: "senior", payload: { text: "redis needle one" } }),
      message({ seq: 2, payload: { text: "redis needle two" } }),
    ]);
    const torn = '{"v":1,"id":"msg-torn","seq":3,"ts":"2026-';
    fs.appendFileSync(file, torn, "utf-8");
    const beforeBytes = fs.readFileSync(file);
    const beforeStat = fs.statSync(file);

    const loaded = loadSessionDocs(dir);
    assert.equal(loaded.skipped, 0);
    assert.equal(loaded.truncated, false);
    assert.deepEqual(loaded.docs.map((item) => item.name), ["torn.jsonl"]);
    assert.equal(loaded.docs[0].recovered, true);
    assert.equal(loaded.docs[0].dropped_bytes, Buffer.byteLength(torn, "utf-8"));
    assert.deepEqual(
      loaded.docs[0].events.map((event) => event.seq),
      [1, 2],
    );
    const result = searchSessions(loaded.docs, "needle");
    assert.equal(result.hits.length, 3); // derived title + two envelopes
    assert.deepEqual(
      result.hits.map((hit) => hit.seq),
      [null, 1, 2],
    );

    // Read-only listing/search must leave the file byte- and mtime-identical.
    assert.deepEqual(fs.readFileSync(file), beforeBytes);
    assert.equal(fs.statSync(file).mtimeMs, beforeStat.mtimeMs);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadSessionDocs: per-session event cap keeps the leading envelopes", () => {
  const dir = tmpdir();
  try {
    const events = Array.from({ length: 5 }, (_, index) =>
      message({ seq: index + 1, payload: { text: `m${index + 1}` } }),
    );
    writeSession(dir, "long.jsonl", events);
    const loaded = loadSessionDocs(dir, { maxEventsPerSession: 2 });
    assert.equal(loaded.docs.length, 1);
    assert.deepEqual(loaded.docs[0].events.map((event) => event.seq), [1, 2]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadSessionDocs: never throws on a missing directory", () => {
  const missing = path.join(
    os.tmpdir(),
    `two-brothers-sessionsearch-missing-${process.pid}-${Date.now()}`,
  );
  assert.deepEqual(loadSessionDocs(missing), { docs: [], skipped: 0, truncated: false });
});

test("loadSessionDocs + searchSessions: metadata titles flow through, ordering preserved", () => {
  const dir = tmpdir();
  try {
    const now = Math.floor(Date.now() / 1000);
    writeSession(
      dir,
      "old.jsonl",
      [message({ seq: 1, from: "user", to: "senior", payload: { text: "Investigate Redis latency" } })],
      now - 300,
    );
    writeSession(
      dir,
      "new.jsonl",
      [message({ seq: 1, from: "user", to: "senior", payload: { text: "Redis failover plan" } })],
      now - 60,
    );
    const metadata = new SessionMetadataStore(dir);
    metadata.save("old.jsonl", { title: "Latency investigation" });
    metadata.save("new.jsonl", { title: "Failover decisions" });

    const loaded = loadSessionDocs(dir);
    const result = searchSessions(loaded.docs, "redis");
    assert.deepEqual(result.hits.map((hit) => hit.session), ["new.jsonl", "old.jsonl"]);
    assert.equal(result.hits[0].title, "Failover decisions");
    assert.equal(result.hits[0].field, "message");
    assert.equal(result.hits[0].seq, 1);
    assert.equal(result.truncated, false);
    assert.equal(result.scanned_sessions, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// -- HTML export -------------------------------------------------------------

test("html export: one self-contained document with escaped metadata and envelope sections", () => {
  const events = [
    message({
      seq: 1,
      from: "user",
      to: "senior",
      ts: "2026-11-06T12:00:00Z",
      payload: { text: "First line\nsecond line" },
    }),
    message({
      seq: 2,
      from: "senior",
      to: "junior",
      kind: "delegation",
      ts: "2026-11-06T12:05:00Z",
      payload: {
        work: "check <the> plan",
        acceptance: "all green",
        artifacts: ["a.ts", "b.ts"],
        confidence: 0.8,
      },
    }),
  ];
  const html = sessionToHtmlString(
    {
      name: "s1.jsonl",
      title: "Redis & migration",
      events,
      workspace_id: "ws-1",
      updated: 1_700_000_000,
    },
    { exportedAt: "2026-11-06T00:00:00.000Z" },
  );

  // document shape: one doctype, one document, one trailing newline
  assert.ok(html.startsWith("<!doctype html>\n"), html.slice(0, 40));
  assert.ok(html.includes('<meta charset="utf-8">'));
  assert.equal(html.split("<!doctype html>").length, 2);
  assert.equal(html.split("</html>").length, 2);
  assert.ok(html.endsWith("</html>\n"));
  assert.equal(html, html.trimEnd() + "\n");

  // header metadata, escaped
  assert.ok(html.includes("<title>Redis &amp; migration</title>"));
  assert.ok(html.includes("<h1>Redis &amp; migration</h1>"));
  assert.ok(html.includes("<dt>session</dt><dd>s1.jsonl</dd>"));
  assert.ok(html.includes("<dt>workspace</dt><dd>ws-1</dd>"));
  assert.ok(html.includes("<dt>updated</dt><dd>2023-11-14T22:13:20.000Z</dd>"));
  assert.ok(html.includes("<dt>exported</dt><dd>2026-11-06T00:00:00.000Z</dd>"));
  assert.ok(html.includes("<dt>envelopes</dt><dd>2</dd>"));

  // one section per envelope with seq/from/to/kind labels and the ts line
  assert.equal((html.match(/<section class="event"/g) ?? []).length, 2);
  assert.ok(html.includes('<section class="event" id="seq-1">'));
  assert.ok(html.includes('<h2><span class="seq">1</span> user → senior <span class="kind">message</span></h2>'));
  assert.ok(html.includes('<section class="event" id="seq-2">'));
  assert.ok(html.includes("senior → junior"));
  assert.ok(html.includes('<span class="kind">delegation</span>'));
  assert.ok(html.includes('<p class="ts">2026-11-06T12:00:00Z</p>'));

  // verbatim message text; structured payloads are pretty-printed, not bullets
  assert.ok(html.includes("First line\nsecond line"));
  assert.ok(html.includes("&quot;work&quot;: &quot;check &lt;the&gt; plan&quot;"));
  assert.ok(html.includes("&quot;artifacts&quot;: ["));
  assert.ok(!html.includes('- work:'));

  // no scripts, links, or external references of any kind
  assert.ok(!/<script/i.test(html));
  assert.ok(!/<a[\s>]/i.test(html));
  assert.ok(!/\b(href|src)=/i.test(html));
  assert.ok(!/url\(/i.test(html));
  assert.ok(!/<link\b/i.test(html));
  assert.ok(!/https?:\/\//i.test(html));
});

test("html export: hostile payloads stay literal text; ANSI and control bytes are stripped", () => {
  const hostileText = [
    'before <script>alert("x")</script> after',
    "\u001b[31mred\u001b[0m",
    "nul\u0000 bell\u0007 tab\tend",
    "<img src=x onerror=alert(1)> & </pre>",
  ].join(" ");
  const html = sessionToHtmlString(
    {
      name: "<evil>.jsonl",
      title: "<script>t</script>",
      events: [
        message({ seq: 1, payload: { text: hostileText } }),
        message({
          seq: 2,
          kind: "review",
          payload: { verdict: "bad <b>bold</b>", notes: ["</section>", "<style>"] },
        }),
      ],
    },
    { exportedAt: "E" },
  );

  // hostile markup is escaped, never emitted as markup
  assert.ok(!html.includes("<script"));
  assert.ok(!html.includes("<img"));
  assert.ok(!html.includes("<b>"));
  assert.ok(html.includes("&lt;style&gt;"));
  assert.ok(html.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"));
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(html.includes("&lt;/pre&gt;"));
  assert.ok(html.includes("&amp;"));
  assert.ok(html.includes("&quot;verdict&quot;: &quot;bad &lt;b&gt;bold&lt;/b&gt;&quot;"));
  assert.ok(html.includes("&lt;/section&gt;"));
  // the only real tags are the ones the renderer emits
  assert.equal((html.match(/<\/pre>/g) ?? []).length, 2);
  assert.equal((html.match(/<style>/g) ?? []).length, 1);

  // existing display sanitizer: ANSI CSI sequences and C0/C1 control bytes gone
  assert.ok(html.includes("red"));
  assert.ok(!html.includes("\u001b"));
  assert.ok(!html.includes("[31m"));
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(html));

  // metadata is escaped too
  assert.ok(html.includes("<title>&lt;script&gt;t&lt;/script&gt;</title>"));
  assert.ok(html.includes("<dd>&lt;evil&gt;.jsonl</dd>"));
});

test("html export: deterministic with an injected timestamp; absent metadata renders none", () => {
  const doc: SessionSearchDoc = { name: "x.jsonl", title: "", events: [message()] };
  const first = sessionToHtmlString(doc, { exportedAt: "2026-11-06T00:00:00Z" });
  const second = sessionToHtmlString(doc, { exportedAt: "2026-11-06T00:00:00Z" });
  assert.equal(first, second);
  assert.ok(first.includes("<title>Untitled session</title>"));
  assert.ok(first.includes("<dt>workspace</dt><dd>none</dd>"));
  assert.ok(first.includes("<dt>updated</dt><dd>none</dd>"));
  assert.ok(first.includes("<dt>exported</dt><dd>2026-11-06T00:00:00Z</dd>"));
  assert.ok(first.includes("<dt>envelopes</dt><dd>1</dd>"));

  const empty = sessionToHtmlString({ name: "e.jsonl", title: "E", events: [] });
  assert.ok(empty.includes("<dt>envelopes</dt><dd>0</dd>"));
  assert.equal((empty.match(/<section class="event"/g) ?? []).length, 0);
  assert.ok(!empty.includes("Document truncated"));
  assert.ok(empty.startsWith("<!doctype html>\n"));
  assert.ok(empty.endsWith("</html>\n"));
});

test("html export bounds each payload and marks the truncation explicitly", () => {
  const longText = "z".repeat(25_000);
  const html = sessionToHtmlString(
    { name: "big.jsonl", title: "big", events: [message({ payload: { text: longText } })] },
    { exportedAt: "E" },
  );
  assert.ok(html.includes("payload truncated"));
  assert.ok(html.includes("5,000") || html.includes("5000"), html.slice(-300));
  assert.ok(!html.includes("z".repeat(20_001)));
  assert.ok(html.length < 25_000, `unexpected export size: ${html.length}`);
});

test("html export bounds the whole document at envelope boundaries and reports what was omitted", () => {
  const big = "y".repeat(20_500);
  const events = Array.from({ length: 140 }, (_, index) =>
    message({ seq: index + 1, payload: { text: big } }),
  );
  const html = sessionToHtmlString(
    { name: "huge.jsonl", title: "huge", events },
    { exportedAt: "E" },
  );
  assert.ok(html.length <= HTML_EXPORT_MAX_DOC_CHARS, `document not bounded: ${html.length}`);
  assert.ok(html.includes("Document truncated"));
  const match = /showing (\d+) of 140 envelopes/.exec(html);
  assert.ok(match, "truncation note must carry the shown/total counts");
  const shown = Number(match[1]);
  assert.ok(shown > 0 && shown < 140, `unexpected shown count: ${shown}`);
  assert.equal((html.match(/<section class="event"/g) ?? []).length, shown);
  assert.ok(html.includes("payload truncated"), "the per-payload cap still applies");
  assert.ok(html.endsWith("</html>\n"), "truncated document must still close cleanly");
  assert.ok(html.startsWith("<!doctype html>\n"));
});

// ---------------------------------------------------------------------------
// review P2 fixes (wave 23): metadata cap, timestamp guards, filename safety
// ---------------------------------------------------------------------------

test("html export: unbounded metadata is clipped and the document stays under the cap", () => {
  const huge = "T".repeat(2_100_000);
  const html = sessionToHtmlString(
    {
      name: `${huge}.jsonl`,
      title: huge,
      workspace_id: huge,
      updated: 1_700_000_000,
      events: [message()],
    },
    { exportedAt: "E" },
  );

  assert.ok(html.length <= HTML_EXPORT_MAX_DOC_CHARS, `document over cap: ${html.length}`);
  assert.ok(html.startsWith("<!doctype html>\n"));
  assert.ok(html.endsWith("</html>\n"));
  assert.equal(html.split("<title>").length, 2, "exactly one title element");
  assert.equal(html.split("</html>").length, 2, "exactly one closed document");
  // The metadata fields carry the clip marker and stay small.
  assert.ok(html.includes("…"), "clipped metadata carries the ellipsis marker");
  assert.ok(
    !html.includes("T".repeat(HTML_EXPORT_META_CHARS + 1)),
    "metadata must be clipped, not emitted whole",
  );
  const title = /<title>([\s\S]*?)<\/title>/.exec(html)?.[1] ?? "";
  assert.ok(title.length <= HTML_EXPORT_META_CHARS + 10, `title too long: ${title.length}`);
  const session = /<dt>session<\/dt><dd>([\s\S]*?)<\/dd>/.exec(html)?.[1] ?? "";
  assert.ok(session.length <= HTML_EXPORT_META_CHARS + 10, `session too long: ${session.length}`);
  // Envelope content is still rendered and the truncation note is not claimed.
  assert.equal((html.match(/<section class="event"/g) ?? []).length, 1);
  assert.ok(!html.includes("Document truncated"));
});

test("export: out-of-range timestamps render as none instead of throwing", () => {
  const extremes = [1e15, 1e300, -1e300, -1e15, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER * 1000];
  for (const updated of extremes) {
    const markdown = sessionToMarkdown(
      { name: "x.jsonl", title: "t", events: [], updated },
      { exportedAt: "E" },
    );
    assert.ok(markdown.includes("- updated: none"), `markdown ${updated}: ${markdown.slice(0, 120)}`);
    const html = sessionToHtmlString(
      { name: "x.jsonl", title: "t", events: [], updated },
      { exportedAt: "E" },
    );
    assert.ok(
      html.includes("<dt>updated</dt><dd>none</dd>"),
      `html ${updated}`,
    );
  }

  // The edge of the Date range still renders (it is finite and in range).
  const edge = sessionToMarkdown(
    { name: "x.jsonl", title: "t", events: [], updated: 8.64e12 },
    { exportedAt: "E" },
  );
  assert.ok(edge.includes("275760-09-13T00:00:00.000Z"), edge.slice(0, 200));
  // One second past the edge is out of range again.
  const past = sessionToMarkdown(
    { name: "x.jsonl", title: "t", events: [], updated: 8.64e12 + 1 },
    { exportedAt: "E" },
  );
  assert.ok(past.includes("- updated: none"));
});

test("export filenames mangle Windows reserved names, stay bounded and map formats explicitly", () => {
  const reserved = ["CON.jsonl", "con", "Con.jsonl", "PRN", "AUX", "nul", "COM1.jsonl", "lpt9.jsonl", "NUL.txt"];
  for (const name of reserved) {
    const out = exportSessionFileName(name, "html");
    const stem = out.replace(/\.html$/, "");
    assert.equal(isWindowsReservedDeviceName(stem), false, `${name} -> ${out}`);
    assert.ok(out.endsWith(".html"), out);
    assert.ok(!/[\u0000-\u001f<>:"|?*]/.test(out), `unsafe characters in ${out}`);
  }

  // Explicit mapping: only html/json select their own extension; an
  // unknown/absent runtime format never silently becomes an HTML download.
  assert.equal(exportSessionFileName("foo.jsonl", "html"), "foo.html");
  assert.equal(exportSessionFileName("foo.jsonl", "json"), "foo.json");
  assert.equal(exportSessionFileName("foo.jsonl", "markdown"), "foo.md");
  assert.equal(exportSessionFileName("foo.jsonl", "pdf" as never), "foo.md");
  assert.equal(exportSessionFileName("foo.jsonl", undefined as never), "foo.md");

  // The stem is bounded; the extension stays intact.
  const long = "z".repeat(500);
  for (const format of ["markdown", "json", "html"] as const) {
    const out = exportSessionFileName(`${long}.jsonl`, format);
    const extension = path.extname(out);
    assert.ok(extension === ".md" || extension === ".json" || extension === ".html");
    assert.ok(
      out.length - extension.length <= SESSION_NAME_MAX_CHARS,
      `${format}: stem too long (${out.length - extension.length})`,
    );
  }
});
