/**
 * Server-side session search + export (`src/sessionsearch.ts` wiring).
 *
 * Hermetic: `createServer` runs in-process against a temp sessions directory
 * and is exercised over real HTTP on an ephemeral port (no subprocesses, no
 * live model endpoints, no sleeps). Covers:
 * - `GET /api/search` hit shape/order, min-query 400, limit clamp (1..100),
 *   corrupt-session skipping and the missing-directory empty result;
 * - `GET /api/sessions/{name}/export` markdown/JSON bodies, sidecar titles,
 *   Content-Type / Content-Disposition headers, HEAD-without-body and the
 *   404/400 cases.
 *
 * Run with: node --test tests/serversearch.test.ts
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { createServer, type ServerHandle } from "../src/server.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface RunningServer {
  base: string;
  handle: ServerHandle;
  dir: string;
  /** Directory the server actually uses (created by `createServer`). */
  sessionsDir: string;
  close(): Promise<void>;
}

async function startServer(): Promise<RunningServer> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-srv-search-"));
  const sessionsDir = path.join(root, "sessions");
  const handle = createServer({ webDist: null, sessionsDir });
  const server = await handle.listen("127.0.0.1", 0);
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    handle,
    dir: root,
    sessionsDir,
    close: async () => {
      await handle.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

async function api<T = unknown>(
  base: string,
  route: string,
  method = "GET",
): Promise<{ status: number; body: T }> {
  const res = await fetch(base + route, { method });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed as T };
}

/** One protocol envelope line for a session fixture. */
function envelope(
  seq: number,
  from: string,
  to: string,
  kind: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    v: 1,
    id: `msg-${seq}`,
    seq,
    ts: "2026-11-06T12:00:00Z",
    from,
    to,
    kind,
    payload,
  };
}

function userTask(text: string): Record<string, unknown> {
  return envelope(1, "user", "senior", "message", { text });
}

function writeSession(
  dir: string,
  name: string,
  events: Array<Record<string, unknown>>,
  mtimeSeconds?: number,
): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf-8");
  if (mtimeSeconds !== undefined) {
    const date = new Date(mtimeSeconds * 1000);
    fs.utimesSync(file, date, date);
  }
  return file;
}

function writeSidecar(dir: string, sessionName: string, meta: Record<string, unknown>): void {
  const stem = sessionName.replace(/\.jsonl$/, "");
  fs.writeFileSync(path.join(dir, `${stem}.meta.json`), JSON.stringify(meta, null, 2), "utf-8");
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Every hit in a search response, typed for assertions. */
interface Hit {
  session: string;
  title: string;
  field: "title" | "message" | "decision";
  seq: number | null;
  role: string | null;
  kind: string | null;
  snippet: string;
  ts: string | null;
}

interface SearchBody {
  query: string;
  scanned_sessions: number;
  truncated: boolean;
  hits: Hit[];
}

// ---------------------------------------------------------------------------
// GET /api/search
// ---------------------------------------------------------------------------

test("GET /api/search: title + envelope hits, newest session first, stable field order", async () => {
  const server = await startServer();
  try {
    const now = nowSeconds();
    // alpha is newer, so `loadSessionDocs` (mtime desc) searches it first.
    writeSession(
      server.sessionsDir,
      "alpha.jsonl",
      [userTask("Redis migration plan")],
      now - 100,
    );
    writeSession(
      server.sessionsDir,
      "beta.jsonl",
      [envelope(1, "senior", "user", "decision", { decision: "We chose redis after all" })],
      now - 300,
    );

    const { status, body } = await api<SearchBody>(server.base, "/api/search?q=redis&limit=10");
    assert.equal(status, 200);
    assert.equal(body.query, "redis");
    assert.equal(body.scanned_sessions, 2);
    assert.equal(body.truncated, false);
    // alpha contributes two hits (its derived title and the user message it is
    // derived from), beta one; newest session first, title before envelopes.
    assert.equal(body.hits.length, 3, JSON.stringify(body.hits));

    const [titleHit, messageHit, decisionHit] = body.hits;
    assert.deepEqual(Object.keys(titleHit), [
      "session",
      "title",
      "field",
      "seq",
      "role",
      "kind",
      "snippet",
      "ts",
    ]);
    assert.equal(titleHit.session, "alpha.jsonl");
    assert.equal(titleHit.title, "Redis migration plan");
    assert.equal(titleHit.field, "title");
    assert.equal(titleHit.seq, null);
    assert.equal(titleHit.role, null);
    assert.equal(titleHit.kind, null);
    assert.equal(titleHit.ts, null);
    assert.equal(titleHit.snippet, "Redis migration plan");

    assert.equal(messageHit.session, "alpha.jsonl");
    assert.equal(messageHit.field, "message");
    assert.equal(messageHit.seq, 1);
    assert.equal(messageHit.role, "user");
    assert.equal(messageHit.kind, "message");
    assert.equal(messageHit.ts, "2026-11-06T12:00:00Z");
    assert.equal(messageHit.snippet, "Redis migration plan");

    assert.equal(decisionHit.session, "beta.jsonl");
    assert.equal(decisionHit.field, "decision");
    assert.equal(decisionHit.seq, 1);
    assert.equal(decisionHit.role, "senior");
    assert.equal(decisionHit.kind, "decision");
    assert.equal(decisionHit.ts, "2026-11-06T12:00:00Z");
    assert.match(decisionHit.snippet, /redis/i);
  } finally {
    await server.close();
  }
});

test("GET /api/search: trims the query and echoes the trimmed value", async () => {
  const server = await startServer();
  try {
    writeSession(server.sessionsDir, "s.jsonl", [userTask("Kubernetes rollback plan")]);
    const { status, body } = await api<SearchBody>(server.base, "/api/search?q=%20%20kubernetes%20%20");
    assert.equal(status, 200);
    assert.equal(body.query, "kubernetes");
    assert.equal(body.hits[0]?.session, "s.jsonl");
    assert.equal(body.hits[0]?.field, "title");
  } finally {
    await server.close();
  }
});

test("GET /api/search: query shorter than the minimum is a 400 with the fixed detail", async () => {
  const server = await startServer();
  try {
    writeSession(server.sessionsDir, "s.jsonl", [userTask("Searchable text")]);
    for (const route of ["/api/search", "/api/search?q=", "/api/search?q=a", "/api/search?q=%20r%20"]) {
      const { status, body } = await api<{ detail?: string }>(server.base, route);
      assert.equal(status, 400, route);
      assert.equal(body.detail, "query must be at least 2 characters", route);
    }
  } finally {
    await server.close();
  }
});

test("GET /api/search: limit clamps below 1 and above 100", async () => {
  const server = await startServer();
  try {
    // Five matching envelopes in one session: the per-session cap (3) applies,
    // so a small `limit` is the thing under test.
    const events = [userTask("Filler title")];
    for (let seq = 2; seq <= 6; seq++) {
      events.push(envelope(seq, "senior", "junior", "message", { text: `needle ${seq}` }));
    }
    writeSession(server.sessionsDir, "many.jsonl", events);

    const one = await api<SearchBody>(server.base, "/api/search?q=needle&limit=1");
    assert.equal(one.status, 200);
    assert.equal(one.body.hits.length, 1);

    const zero = await api<SearchBody>(server.base, "/api/search?q=needle&limit=0");
    assert.equal(zero.status, 200);
    assert.equal(zero.body.hits.length, 1, "limit=0 clamps up to 1");

    const bad = await api<SearchBody>(server.base, "/api/search?q=needle&limit=abc");
    assert.equal(bad.status, 200);
    assert.equal(bad.body.hits.length, 3, "non-numeric limit falls back to the 20 default");

    // 35 sessions x 3 envelope hits = 105 matches; limit=999 clamps to 100.
    for (let index = 0; index < 35; index++) {
      writeSession(server.sessionsDir, `bulk-${index}.jsonl`, [
        userTask(`Filler ${index}`),
        envelope(2, "senior", "junior", "message", { text: `zebra ${index}-a` }),
        envelope(3, "senior", "junior", "message", { text: `zebra ${index}-b` }),
        envelope(4, "senior", "junior", "message", { text: `zebra ${index}-c` }),
      ]);
    }
    const clamped = await api<SearchBody>(server.base, "/api/search?q=zebra&limit=999");
    assert.equal(clamped.status, 200);
    assert.equal(clamped.body.hits.length, 100, "limit clamps down to 100");
    assert.equal(clamped.body.truncated, true);
  } finally {
    await server.close();
  }
});

test("GET /api/search: a corrupt session file is skipped, never a 500", async () => {
  const server = await startServer();
  try {
    writeSession(server.sessionsDir, "good.jsonl", [userTask("Cobalt deployment plan")]);
    fs.writeFileSync(path.join(server.sessionsDir, "bad.jsonl"), "{not valid json\n", "utf-8");
    const { status, body } = await api<SearchBody>(server.base, "/api/search?q=cobalt");
    assert.equal(status, 200);
    // The good doc yields a title hit and the user-message it is derived from;
    // the corrupt file contributes nothing.
    assert.equal(body.hits.length, 2);
    assert.equal(body.hits[0].session, "good.jsonl");
    assert.equal(body.hits[0].field, "title");
    assert.equal(body.scanned_sessions, 1, "the corrupt file contributes no document");
  } finally {
    await server.close();
  }
});

test("GET /api/search: a missing sessions directory is an empty result, not an error", async () => {
  const server = await startServer();
  try {
    fs.rmSync(server.sessionsDir, { recursive: true, force: true });
    const { status, body } = await api<SearchBody>(server.base, "/api/search?q=anything");
    assert.equal(status, 200);
    assert.deepEqual(body, {
      query: "anything",
      scanned_sessions: 0,
      truncated: false,
      hits: [],
    });
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// GET /api/sessions/{name}/export
// ---------------------------------------------------------------------------

const EXPORT_SESSION = "export-me.jsonl";

/** Two envelopes with a readable title ("Export me nicely"). */
function writeExportSession(dir: string, mtimeSeconds?: number): void {
  writeSession(
    dir,
    EXPORT_SESSION,
    [
      userTask("Export me nicely"),
      envelope(2, "senior", "user", "decision", {
        decision: "Ship the export",
        rationale: "the reviewer asked for it",
        confidence: 0.9,
        dissent: null,
      }),
    ],
    mtimeSeconds,
  );
}

test("GET /api/sessions/{name}/export: markdown body, headers and filename", async () => {
  const server = await startServer();
  try {
    writeExportSession(server.sessionsDir);
    const res = await fetch(`${server.base}/api/sessions/${EXPORT_SESSION}/export`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/markdown; charset=utf-8");
    assert.equal(
      res.headers.get("content-disposition"),
      'attachment; filename="export-me.md"',
    );
    const body = await res.text();
    assert.equal(
      Number(res.headers.get("content-length")),
      Buffer.byteLength(body, "utf-8"),
      "Content-Length matches the body bytes",
    );
    assert.ok(body.startsWith("# Export me nicely\n"), body.slice(0, 80));
    assert.match(body, /^- session: export-me\.jsonl$/m);
    assert.match(body, /^- envelopes: 2$/m);
    assert.match(body, /^## 1\. user → senior · message$/m);
    assert.match(body, /^## 2\. senior → user · decision$/m);
    assert.match(body, /Export me nicely/);
    assert.match(body, /Ship the export/);
    assert.ok(body.endsWith("\n"), "export ends with one newline");
    assert.ok(!body.endsWith("\n\n"), "no doubled trailing newline");
  } finally {
    await server.close();
  }
});

test("GET /api/sessions/{name}/export?format=json: pretty JSON object with envelopes", async () => {
  const server = await startServer();
  try {
    writeExportSession(server.sessionsDir, nowSeconds() - 60);
    const res = await fetch(`${server.base}/api/sessions/${EXPORT_SESSION}/export?format=json`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(
      res.headers.get("content-disposition"),
      'attachment; filename="export-me.json"',
    );
    const text = await res.text();
    assert.ok(text.endsWith("\n"));
    const parsed = JSON.parse(text) as {
      name: string;
      title: string;
      workspace_id: string | null;
      updated: number | null;
      exported_at: string;
      envelopes: Array<{ seq: number; kind: string }>;
    };
    assert.equal(parsed.name, EXPORT_SESSION);
    assert.equal(parsed.title, "Export me nicely");
    assert.equal(parsed.workspace_id, null);
    assert.equal(typeof parsed.updated, "number");
    assert.match(parsed.exported_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(
      parsed.envelopes.map((event) => [event.seq, event.kind]),
      [
        [1, "message"],
        [2, "decision"],
      ],
    );
  } finally {
    await server.close();
  }
});

test("export: the metadata sidecar title is used by export and search", async () => {
  const server = await startServer();
  try {
    writeExportSession(server.sessionsDir);
    writeSidecar(server.sessionsDir, EXPORT_SESSION, {
      title: "Renamed by the operator",
      workspace_id: "ws-1",
    });

    const markdown = await api<string>(server.base, `/api/sessions/${EXPORT_SESSION}/export`);
    assert.equal(markdown.status, 200);
    assert.ok(markdown.body.startsWith("# Renamed by the operator\n"), markdown.body.slice(0, 80));

    const json = await api<{ title: string; workspace_id: string | null }>(
      server.base,
      `/api/sessions/${EXPORT_SESSION}/export?format=json`,
    );
    assert.equal(json.body.title, "Renamed by the operator");
    assert.equal(json.body.workspace_id, "ws-1");

    const search = await api<SearchBody>(server.base, "/api/search?q=renamed");
    assert.equal(search.status, 200);
    assert.equal(search.body.hits[0]?.session, EXPORT_SESSION);
    assert.equal(search.body.hits[0]?.field, "title");
  } finally {
    await server.close();
  }
});

test("export: HEAD returns the GET headers without a body", async () => {
  const server = await startServer();
  try {
    writeExportSession(server.sessionsDir);
    const get = await fetch(`${server.base}/api/sessions/${EXPORT_SESSION}/export`);
    const getBody = await get.text();

    const res = await fetch(`${server.base}/api/sessions/${EXPORT_SESSION}/export`, {
      method: "HEAD",
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/markdown; charset=utf-8");
    assert.equal(
      res.headers.get("content-disposition"),
      'attachment; filename="export-me.md"',
    );
    assert.equal(Number(res.headers.get("content-length")), Buffer.byteLength(getBody, "utf-8"));
    assert.equal(await res.text(), "", "HEAD carries no body");
  } finally {
    await server.close();
  }
});

test("export: 404 for a missing session, 400 for bad names and unknown formats", async () => {
  const server = await startServer();
  try {
    writeExportSession(server.sessionsDir);

    const missing = await api<{ detail: string }>(
      server.base,
      "/api/sessions/nope.jsonl/export",
    );
    assert.equal(missing.status, 404);
    assert.equal(missing.body.detail, "not found");

    const noExtension = await api<{ detail: string }>(
      server.base,
      "/api/sessions/export-me/export",
    );
    assert.equal(noExtension.status, 400);
    assert.equal(noExtension.body.detail, "invalid session name");

    // A path-y name is basename-flattened, so a traversal attempt can never
    // reach a sibling file (and still needs the `.jsonl` extension).
    const traversal = await api<{ detail: string }>(
      server.base,
      "/api/sessions/%2E%2E%2Fsettings.json/export",
    );
    assert.equal(traversal.status, 400);
    assert.equal(traversal.body.detail, "invalid session name");

    const badFormat = await api<{ detail: string }>(
      server.base,
      `/api/sessions/${EXPORT_SESSION}/export?format=pdf`,
    );
    assert.equal(badFormat.status, 400);
    assert.equal(badFormat.body.detail, "format must be markdown, json or html");

    // The format is trimmed/case-insensitive and the default is markdown.
    const upper = await fetch(
      `${server.base}/api/sessions/${EXPORT_SESSION}/export?format=%20JSON%20`,
    );
    assert.equal(upper.status, 200);
    assert.equal(upper.headers.get("content-type"), "application/json; charset=utf-8");
    const defaulted = await fetch(`${server.base}/api/sessions/${EXPORT_SESSION}/export`);
    assert.equal(defaulted.status, 200);
    assert.equal(defaulted.headers.get("content-type"), "text/markdown; charset=utf-8");
  } finally {
    await server.close();
  }
});
