/**
 * Server tests: real HTTP against the TS server, started in-process on an
 * ephemeral port (no subprocess spawning). Ports the hermetic coverage of the
 * original prototype's server and HTTP E2E tests (removed 2026-11-04; see git
 * history):
 * sessions CRUD + rename, synchronous runs, background run lifecycle over
 * SSE, approvals resolved over HTTP, follow-ups, cooperative stop, settings
 * round-trip + masking + env pinning, provider presets, fs/browse, static
 * serving, and 400s on invalid bodies.
 *
 * Run with: node tests/run-all.ts (or node --test tests/)
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { isCompactionSummary } from "../src/compaction.ts";
import { resolveConfig, type Config } from "../src/config.ts";
import type { ChatMessage } from "../src/context.ts";
import {
  MockProvider,
  type Provider,
  type Tool,
  type ToolChatOptions,
  type ToolChatResponse,
} from "../src/provider.ts";
import {
  createServer,
  newSessionName,
  resolveDefaultWebDist,
  type ServerHandle,
  type ServerOptions,
} from "../src/server.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tmpdir(prefix: string): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** Mock-provider config, like Python's `lambda: Config(provider="mock", ...)`. */
function mockConfig(extra: Record<string, unknown> = {}): () => Config {
  return () => resolveConfig({ provider: "mock", mode: "consult", ...extra });
}

interface RunningServer {
  base: string;
  handle: ServerHandle;
  dir: string;
  close(): Promise<void>;
}

async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const tmp = tmpdir("tb-srv-");
  const handle = createServer({
    configFactory: mockConfig(),
    webDist: null,
    ...options,
    sessionsDir: options.sessionsDir ? path.resolve(options.sessionsDir) : tmp.root,
  });
  const server = await handle.listen("127.0.0.1", 0);
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    handle,
    dir: options.sessionsDir ? path.resolve(options.sessionsDir) : tmp.root,
    close: async () => {
      await handle.close();
      tmp.cleanup();
    },
  };
}

async function api<T = unknown>(
  base: string,
  method: string,
  route: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(base + route, init);
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed as T };
}

const post = <T = unknown>(base: string, route: string, body?: unknown) =>
  api<T>(base, "POST", route, body);
const get = <T = unknown>(base: string, route: string) => api<T>(base, "GET", route);

/** SSE reader: collects `data:` events until `stop` holds or the stream ends. */
function sseEvents(
  base: string,
  route: string,
  stop: (events: Array<Record<string, unknown>>) => boolean = () => false,
  timeoutMs = 20000,
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const events: Array<Record<string, unknown>> = [];
    const req = http.get(base + route, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`SSE GET ${route} -> HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      let buf = "";
      let done = false;
      const finish = (): void => {
        if (!done) {
          done = true;
          resolve(events);
        }
      };
      res.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf-8");
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (line.startsWith("data: ")) {
            events.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
            if (stop(events)) {
              res.destroy();
              finish();
              return;
            }
          }
        }
      });
      res.on("end", finish);
      res.on("error", finish);
    });
    req.on("error", (exc) => {
      if (events.length > 0 && stop(events)) resolve(events);
      else reject(exc);
    });
    setTimeout(() => {
      req.destroy();
      reject(
        new Error(`SSE ${route} timed out; last events: ${JSON.stringify(events.slice(-3))}`),
      );
    }, timeoutMs).unref();
  });
}

/** Read the run-event stream until `run_end` (the server closes it). */
function runUntilEnd(base: string, runId: string, after = 0): Promise<Array<Record<string, unknown>>> {
  return sseEvents(base, `/api/runs/${runId}/events?after=${after}`, (events) =>
    events.some((e) => e.type === "run_end"),
  );
}

async function waitTerminal(
  base: string,
  runId: string,
  timeoutMs = 15000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await get<Record<string, unknown>>(base, `/api/runs/${runId}`);
    if (["completed", "failed", "cancelled"].includes(String(body.status))) return body;
    if (Date.now() > deadline) throw new Error(`run ${runId} did not finish in time`);
    await sleep(50);
  }
}

/** A provider that sleeps before every mock answer (cooperative-stop window). */
function slowProvider(delayMs: number): Provider {
  const inner = new MockProvider();
  return {
    async chat(messages: ChatMessage[], responseKind?: string, signal?: AbortSignal) {
      await sleep(delayMs);
      return inner.chat(messages, responseKind);
    },
    async chatWithTools(messages: ChatMessage[], tools: Tool[], options?: ToolChatOptions) {
      await sleep(delayMs);
      return inner.chatWithTools(messages, tools, options) as Promise<ToolChatResponse>;
    },
  };
}

/** One consult cycle with the deterministic mock: 5 envelopes, usage 40/20. */
const CONSULT_KINDS = ["message", "consult", "proposal", "review", "decision"];
const EXPECTED_USAGE = { model_calls: 4, input_tokens: 40, output_tokens: 20, cached_tokens: 0 };

// ---------------------------------------------------------------------------
// Stage 1: session files + synchronous run
// ---------------------------------------------------------------------------

test("list sessions: empty, then one entry after a sync run", async () => {
  const srv = await startServer();
  try {
    assert.deepEqual((await get(srv.base, "/api/sessions")).body, []);
    const res = await post(srv.base, "/api/run", { task: "build a catalog" });
    assert.equal(res.status, 200);
    const sessions = (await get<Array<Record<string, unknown>>>(srv.base, "/api/sessions")).body;
    assert.equal(sessions.length, 1);
    assert.ok(String(sessions[0].name).endsWith(".jsonl"));
  } finally {
    await srv.close();
  }
});

test("sync run persists envelopes", async () => {
  const srv = await startServer();
  try {
    const res = await post<Record<string, any>>(srv.base, "/api/run", {
      task: "build a catalog",
      mode: "consult",
    });
    assert.equal(res.status, 200);
    const kinds = (res.body.events as Array<Record<string, unknown>>).map((e) => e.kind);
    assert.deepEqual(kinds, CONSULT_KINDS);
    assert.ok(res.body.decision.decision);

    const detail = await get<Record<string, any>>(srv.base, `/api/sessions/${res.body.session}`);
    assert.equal(detail.status, 200);
    assert.equal((detail.body.events as unknown[]).length, 5);
  } finally {
    await srv.close();
  }
});

test("sync run: server compaction option compacts the persisted context", async () => {
  // Force is a one-shot consumed at the first loop iteration (agent-designed:
  // a fresh session is only the task envelope — nothing worth compacting), so
  // seed the session with a first run; the follow-up run then restores a
  // compactable context and the forced compaction lands in the session JSONL
  // as an ordinary envelope with dense seqs after the atomic rewrite.
  const srv = await startServer({ compaction: { force: true, keepRecentChars: 10 } });
  try {
    const first = await post<Record<string, any>>(srv.base, "/api/run", {
      task: "build a catalog",
      mode: "consult",
      session: "compacted",
    });
    assert.equal(first.status, 200);

    const second = await post<Record<string, any>>(srv.base, "/api/run", {
      task: "extend the catalog",
      mode: "consult",
      session: "compacted",
    });
    assert.equal(second.status, 200);
    assert.ok(second.body.decision.decision);

    const detail = await get<Record<string, any>>(srv.base, "/api/sessions/compacted.jsonl");
    assert.equal(detail.status, 200);
    const events = detail.body.events as Array<Record<string, any>>;
    assert.ok(
      events.some((event) => isCompactionSummary(event as never)),
      "expected a compaction summary envelope in the persisted session",
    );
    assert.deepEqual(
      events.map((event) => event.seq),
      Array.from({ length: events.length }, (_, index) => index + 1),
    );
  } finally {
    await srv.close();
  }
});

test("sync run: 400 on blank task / bad mode / bad provider", async () => {
  const srv = await startServer();
  try {
    assert.equal((await post(srv.base, "/api/run", { task: "  " })).status, 400);
    assert.equal((await post(srv.base, "/api/run", { task: "x", mode: "bad" })).status, 400);
    assert.equal((await post(srv.base, "/api/run", { task: "x", provider: "nope" })).status, 400);
    assert.equal((await post(srv.base, "/api/run", { mode: "consult" })).status, 400);
    assert.equal((await api(srv.base, "POST", "/api/run", "not json")).status, 400);
  } finally {
    await srv.close();
  }
});

test("session detail: 404 for unknown session", async () => {
  const srv = await startServer();
  try {
    assert.equal((await get(srv.base, "/api/sessions/nope.jsonl")).status, 404);
  } finally {
    await srv.close();
  }
});

test("named session appends with dense seq", async () => {
  const srv = await startServer();
  try {
    await post(srv.base, "/api/run", { task: "task one", session: "demo" });
    const res = await post<Record<string, any>>(srv.base, "/api/run", {
      task: "task two",
      session: "demo.jsonl",
    });
    assert.equal((res.body.events as unknown[]).length, 5);
    const detail = await get<Record<string, any>>(srv.base, "/api/sessions/demo.jsonl");
    const events = detail.body.events as Array<Record<string, unknown>>;
    assert.equal(events.length, 10);
    assert.deepEqual(
      events.map((e) => e.seq),
      Array.from({ length: 10 }, (_, i) => i + 1),
    );
  } finally {
    await srv.close();
  }
});

test("api/stream replays existing session events", async () => {
  const srv = await startServer();
  try {
    const res = await post<Record<string, unknown>>(srv.base, "/api/run", { task: "stream me" });
    const name = res.body.session;
    const events = await sseEvents(
      srv.base,
      `/api/stream?session=${encodeURIComponent(String(name))}`,
      (all) => all.length >= 1,
      5000,
    );
    assert.ok(events.length >= 1);
    assert.equal((events[0] as Record<string, unknown>).kind, "message");
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

test("workspaces: register, list, remove + validation", async () => {
  const srv = await startServer();
  const ws = tmpdir("tb-ws-");
  try {
    assert.equal((await post(srv.base, "/api/workspaces", { name: "no-path" })).status, 400);
    assert.equal(
      (await post(srv.base, "/api/workspaces", { path: path.join(ws.root, "missing") })).status,
      400,
    );

    const created = await post<Record<string, unknown>>(srv.base, "/api/workspaces", {
      path: ws.root,
      name: "e2e-ws",
    });
    assert.equal(created.status, 201);
    assert.ok(created.body.id);
    assert.equal(created.body.name, "e2e-ws");
    assert.equal(created.body.path, path.resolve(ws.root));

    const listed = await get<Array<Record<string, unknown>>>(srv.base, "/api/workspaces");
    assert.deepEqual(
      listed.body.map((w) => w.id),
      [created.body.id],
    );

    assert.equal((await api(srv.base, "DELETE", `/api/workspaces/${created.body.id}`)).status, 200);
    assert.deepEqual((await get(srv.base, "/api/workspaces")).body, []);
    assert.equal((await api(srv.base, "DELETE", "/api/workspaces/nope")).status, 404);
  } finally {
    await srv.close();
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Session metadata (create / rename / listing titles)
// ---------------------------------------------------------------------------

test("run gets a readable title in the listing", async () => {
  const srv = await startServer();
  try {
    await post(srv.base, "/api/run", { task: "build a readable catalog today" });
    const sessions = (await get<Array<Record<string, unknown>>>(srv.base, "/api/sessions")).body;
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].title, "build a readable catalog today");
    assert.ok(String(sessions[0].name).endsWith(".jsonl"));
    assert.ok("size" in sessions[0]);
    assert.ok("mtime" in sessions[0]);
  } finally {
    await srv.close();
  }
});

test("create and rename session", async () => {
  const srv = await startServer();
  try {
    const ws = await post<Record<string, unknown>>(srv.base, "/api/workspaces", {
      path: srv.dir,
      name: "meta-ws",
    });
    const created = await post<Record<string, any>>(srv.base, "/api/sessions", {
      title: "my session",
      workspace_id: ws.body.id,
    });
    assert.equal(created.status, 201);
    const name = created.body.name as string;
    assert.equal(created.body.title, "my session");

    const detail = await get<Record<string, any>>(srv.base, `/api/sessions/${name}`);
    assert.equal(detail.body.title, "my session");
    assert.equal(detail.body.workspace_id, ws.body.id);
    assert.deepEqual(detail.body.events, []);

    const renamed = await api<Record<string, unknown>>(
      srv.base,
      "PATCH",
      `/api/sessions/${name}`,
      { title: "renamed" },
    );
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.title, "renamed");
    const after = await get<Record<string, any>>(srv.base, `/api/sessions/${name}`);
    assert.equal(after.body.title, "renamed");

    assert.equal((await api(srv.base, "PATCH", `/api/sessions/${name}`, { title: "   " })).status, 400);
    assert.equal((await api(srv.base, "PATCH", "/api/sessions/nope.jsonl", { title: "x" })).status, 404);
    assert.equal((await post(srv.base, "/api/sessions", { workspace_id: "nope" })).status, 400);
  } finally {
    await srv.close();
  }
});

test("create without title falls back to the file stem", async () => {
  const srv = await startServer();
  try {
    const created = await post<Record<string, any>>(srv.base, "/api/sessions", {});
    assert.equal(created.status, 201);
    const name = created.body.name as string;
    const stem = name.replace(/\.jsonl$/, "");
    assert.equal(created.body.title, stem);
    const listing = (await get<Array<Record<string, unknown>>>(srv.base, "/api/sessions")).body;
    assert.equal(listing.find((s) => s.name === name)?.title, stem);
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

test("settings: never expose the api key", async () => {
  const srv = await startServer();
  try {
    const res = await api<Record<string, any>>(srv.base, "PUT", "/api/settings", {
      senior: { provider: "openai", model: "m-senior", api_key: "secret-key" },
      junior: { model: "m-junior" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.senior.model, "m-senior");
    assert.equal(res.body.senior.api_key_set, true);
    assert.equal(res.body.junior.api_key_set, false);

    const leaked = JSON.stringify((await get(srv.base, "/api/settings")).body);
    assert.ok(!leaked.includes("secret-key"));
    // ... and not into any other response body either
    assert.ok(!JSON.stringify((await get(srv.base, "/api/runs")).body).includes("secret-key"));
    assert.equal(
      (await api(srv.base, "PUT", "/api/settings", { senior: { provider: "bad" } })).status,
      400,
    );
  } finally {
    await srv.close();
  }
});

test("settings: roundtrip across server restart (persisted, masked)", async () => {
  const tmp = tmpdir("tb-persist-");
  try {
    const srv = await startServer({ sessionsDir: tmp.root });
    const key = "sk-e2e-distinctive-key-7f3a9b1c";
    const put = await api<Record<string, any>>(srv.base, "PUT", "/api/settings", {
      senior: {
        provider: "mock",
        model: "senior-e2e-model",
        base_url: "http://127.0.0.1:59999/v1",
        api_key: key,
      },
      junior: { provider: "mock", model: "junior-e2e-model", base_url: "http://127.0.0.1:59998/v1" },
    });
    assert.equal(put.status, 200);
    assert.ok(!JSON.stringify(put.body).includes(key));
    await srv.close();

    const srv2 = await startServer({ sessionsDir: tmp.root });
    const after = (await get<Record<string, any>>(srv2.base, "/api/settings")).body;
    assert.equal(after.senior.provider, "mock");
    assert.equal(after.senior.model, "senior-e2e-model");
    assert.equal(after.senior.base_url, "http://127.0.0.1:59999/v1");
    assert.equal(after.senior.api_key_set, true);
    assert.equal(after.junior.model, "junior-e2e-model");
    assert.ok(!JSON.stringify(after).includes(key));
    await srv2.close();
  } finally {
    tmp.cleanup();
  }
});

test("settings: env-pinned values win at startup and are never persisted", async () => {
  const tmp = tmpdir("tb-envpin-");
  const saved = {
    TWO_BROTHERS_BASE_URL: process.env.TWO_BROTHERS_BASE_URL,
    TWO_BROTHERS_API_KEY: process.env.TWO_BROTHERS_API_KEY,
    TWO_BROTHERS_SENIOR_MODEL: process.env.TWO_BROTHERS_SENIOR_MODEL,
  };
  process.env.TWO_BROTHERS_BASE_URL = "http://127.0.0.1:59997/v1";
  process.env.TWO_BROTHERS_API_KEY = "env-pinned-secret";
  process.env.TWO_BROTHERS_SENIOR_MODEL = "env-senior-model";
  try {
    const srv = await startServer({ sessionsDir: tmp.root });
    try {
      // the startup overlay exposes the env values (env wins while set)
      const view = (await get<Record<string, any>>(srv.base, "/api/settings")).body;
      assert.equal(view.senior.base_url, "http://127.0.0.1:59997/v1");
      assert.equal(view.senior.model, "env-senior-model");
      assert.equal(view.senior.api_key_set, true);
      assert.equal(view.junior.base_url, "http://127.0.0.1:59997/v1");

      // a PUT carrying manual values updates the in-memory state (Python
      // parity — pinning protects persistence and the startup overlay, not
      // later operator edits)
      const res = await api<Record<string, any>>(srv.base, "PUT", "/api/settings", {
        senior: { model: "manual-model", base_url: "http://127.0.0.1:1/v1", api_key: "manual-key" },
      });
      assert.equal(res.status, 200);
      assert.ok(!JSON.stringify(res.body).includes("manual-key"));
      const after = (await get<Record<string, any>>(srv.base, "/api/settings")).body;
      assert.equal(after.senior.model, "manual-model");
      assert.equal(after.senior.base_url, "http://127.0.0.1:1/v1");

      // ... but neither the env values nor the pinned manual values reached
      // settings.json — env stays the source of truth for its fields
      const onDisk = fs.readFileSync(path.join(tmp.root, "settings.json"), "utf-8");
      for (const forbidden of [
        "env-pinned-secret",
        "http://127.0.0.1:59997",
        "env-senior-model",
        "manual-key",
        "manual-model",
        "http://127.0.0.1:1",
      ]) {
        assert.ok(!onDisk.includes(forbidden), `settings.json must not contain ${forbidden}`);
      }
    } finally {
      await srv.close();
    }
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    tmp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Background runs + SSE
// ---------------------------------------------------------------------------

test("background run completes and persists", async () => {
  const srv = await startServer();
  try {
    const started = await post<Record<string, unknown>>(srv.base, "/api/runs", {
      task: "run one",
    });
    assert.equal(started.status, 202);
    assert.ok(["queued", "running"].includes(String(started.body.status)));
    const record = await waitTerminal(srv.base, String(started.body.run_id));
    assert.equal(record.status, "completed");
    assert.ok((record.decision as Record<string, unknown>).decision);

    const detail = await get<Record<string, any>>(srv.base, `/api/sessions/${record.session}`);
    assert.equal((detail.body.events as unknown[]).length, 5);
  } finally {
    await srv.close();
  }
});

test("follow-up continues the session", async () => {
  const srv = await startServer();
  try {
    const first = await post<Record<string, any>>(srv.base, "/api/runs", {
      task: "first task",
      session: "chat",
    });
    await waitTerminal(srv.base, first.body.run_id);
    const second = await post<Record<string, any>>(srv.base, "/api/runs", {
      task: "second task",
      session: first.body.session,
    });
    assert.equal(second.body.session, first.body.session);
    await waitTerminal(srv.base, second.body.run_id);
    const detail = await get<Record<string, any>>(srv.base, `/api/sessions/${first.body.session}`);
    const events = detail.body.events as Array<Record<string, unknown>>;
    assert.deepEqual(
      events.map((e) => e.seq),
      Array.from({ length: 10 }, (_, i) => i + 1),
    );
  } finally {
    await srv.close();
  }
});

test("run events SSE replays envelopes and ends with run_end", async () => {
  const srv = await startServer();
  try {
    const started = await post<Record<string, any>>(srv.base, "/api/runs", {
      task: "streamed task",
    });
    const record = await waitTerminal(srv.base, started.body.run_id);
    const data = await runUntilEnd(srv.base, started.body.run_id);
    const envelopes = data.filter((e) => e.type === "envelope");
    assert.deepEqual(
      envelopes.map((e) => (e.envelope as Record<string, unknown>).kind),
      CONSULT_KINDS,
    );
    assert.equal(data.at(-1)?.type, "run_end");
    assert.equal(data.at(-1)?.status, "completed");
    // run identity is threaded through every event
    assert.ok(data.every((e) => e.run_id === started.body.run_id));
    assert.equal(record.session, started.body.session);
  } finally {
    await srv.close();
  }
});

test("run events SSE reconnect with after=N replays only the tail", async () => {
  const srv = await startServer();
  try {
    const started = await post<Record<string, any>>(srv.base, "/api/runs", {
      task: "reconnect task",
    });
    await waitTerminal(srv.base, started.body.run_id);
    const full = await runUntilEnd(srv.base, started.body.run_id);
    const tail = await runUntilEnd(srv.base, started.body.run_id, full.length - 2);
    assert.deepEqual(tail, full.slice(-2));
    assert.equal(tail.at(-1)?.type, "run_end");
    assert.equal(tail[0]?.type, "envelope");
  } finally {
    await srv.close();
  }
});

test("prompt_audit event rides the run SSE stream, one frame per provider call", async () => {
  const srv = await startServer();
  try {
    const started = await post<Record<string, any>>(srv.base, "/api/runs", { task: "audit me" });
    const record = await waitTerminal(srv.base, started.body.run_id);
    const data = await runUntilEnd(srv.base, started.body.run_id);

    const audits = data.filter((e) => e.type === "prompt_audit");
    assert.equal(audits.length, EXPECTED_USAGE.model_calls, "one frame per provider call");
    assert.deepEqual(
      audits.map((audit) => `${audit.role}/${audit.kind}`),
      ["senior/consult", "junior/proposal", "senior/review", "senior/decision"],
    );
    for (const audit of audits) {
      assert.equal(audit.run_id, started.body.run_id);
      assert.equal(typeof audit.at, "number");
      assert.ok(Array.isArray(audit.sections) && audit.sections.includes("base"));
      assert.deepEqual(audit.tools, []);
      assert.ok(Number(audit.systemChars) > 0 && Number(audit.userChars) > 0);
      // names and lengths only — the prompt bodies never cross the wire
      assert.deepEqual(Object.keys(audit).sort(), [
        "at",
        "kind",
        "role",
        "run_id",
        "sections",
        "systemChars",
        "tools",
        "type",
        "userChars",
      ]);
    }

    // each audit precedes the envelope produced by the call it describes
    const followingEnvelopeKinds = audits.map((audit) => {
      const at = data.indexOf(audit);
      const next = data.findIndex((event, index) => index > at && event.type === "envelope");
      assert.ok(next > at, `${String(audit.role)}/${String(audit.kind)}: no envelope after the audit`);
      return (data[next].envelope as Record<string, unknown>).kind;
    });
    assert.deepEqual(followingEnvelopeKinds, ["consult", "proposal", "review", "decision"]);
    assert.equal(data.at(-1)?.type, "run_end");

    // the sidecar and the session events endpoint carry the same frames
    const sidecar = path.join(srv.dir, "runtime", `${record.session}.events.jsonl`);
    const persisted = fs
      .readFileSync(sidecar, "utf-8")
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((event) => event.type === "prompt_audit");
    assert.equal(persisted.length, audits.length);
    const sessionEvents = await get<Record<string, any>>(
      srv.base,
      `/api/sessions/${record.session}/events`,
    );
    assert.equal(
      (sessionEvents.body.events as Array<Record<string, unknown>>).filter(
        (event) => event.type === "prompt_audit",
      ).length,
      audits.length,
    );
    // protocol envelopes stay untouched: the audit is a runtime event only
    const detail = await get<Record<string, any>>(srv.base, `/api/sessions/${record.session}`);
    assert.ok(
      (detail.body.events as Array<Record<string, unknown>>).every(
        (event) => !("type" in event),
      ),
    );
  } finally {
    await srv.close();
  }
});

test("stop a running run cancels it", async () => {
  const srv = await startServer({ providerOverrides: { senior: slowProvider(300) } });
  try {
    const started = await post<Record<string, any>>(srv.base, "/api/runs", { task: "stop me" });
    // wait until the run is actually running
    const deadline = Date.now() + 10000;
    let record: Record<string, unknown> = {};
    for (;;) {
      record = (await get<Record<string, unknown>>(srv.base, `/api/runs/${started.body.run_id}`))
        .body;
      if (record.status === "running") break;
      if (Date.now() > deadline) throw new Error("run never reached running");
      await sleep(20);
    }
    const stopped = await post<Record<string, unknown>>(
      srv.base,
      `/api/runs/${started.body.run_id}/stop`,
    );
    assert.equal(stopped.status, 200);
    const final = await waitTerminal(srv.base, started.body.run_id);
    assert.equal(final.status, "cancelled");
    const events = await runUntilEnd(srv.base, started.body.run_id);
    assert.equal(events.at(-1)?.type, "run_end");
    assert.equal(events.at(-1)?.status, "cancelled");
  } finally {
    await srv.close();
  }
});

test("stop: 404 for unknown run", async () => {
  const srv = await startServer();
  try {
    assert.equal((await post(srv.base, "/api/runs/nope/stop", {})).status, 404);
  } finally {
    await srv.close();
  }
});

test("background run: 400 on blank task / bad mode / bad provider", async () => {
  const srv = await startServer();
  try {
    assert.equal((await post(srv.base, "/api/runs", { task: " " })).status, 400);
    assert.equal((await post(srv.base, "/api/runs", { task: "x", mode: "bad" })).status, 400);
    assert.equal((await post(srv.base, "/api/runs", { task: "x", provider: "nope" })).status, 400);
    assert.equal((await post(srv.base, "/api/runs", { task: "x", workspace_id: "nope" })).status, 400);
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------
// Usage reaches the record, run_end and the runtime sidecar
// ---------------------------------------------------------------------------

test("usage reaches run record, run_end, sidecar and session events endpoint", async () => {
  const srv = await startServer();
  try {
    const started = await post<Record<string, any>>(srv.base, "/api/runs", { task: "meter me" });
    const record = await waitTerminal(srv.base, started.body.run_id);
    assert.equal(record.status, "completed");
    assert.deepEqual(record.usage, EXPECTED_USAGE);

    const data = await runUntilEnd(srv.base, started.body.run_id);
    assert.deepEqual(data.at(-1)?.usage, EXPECTED_USAGE);

    const sidecar = path.join(srv.dir, "runtime", `${record.session}.events.jsonl`);
    assert.ok(fs.existsSync(sidecar));
    const sidecarEvents = fs
      .readFileSync(sidecar, "utf-8")
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const ends = sidecarEvents.filter((e) => e.type === "run_end");
    assert.deepEqual(ends.at(-1)?.usage, EXPECTED_USAGE);

    const body = await get<Record<string, any>>(
      srv.base,
      `/api/sessions/${record.session}/events`,
    );
    const sessionEnds = (body.body.events as Array<Record<string, unknown>>).filter(
      (e) => e.type === "run_end",
    );
    assert.deepEqual(sessionEnds.at(-1)?.usage, EXPECTED_USAGE);
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------
// Web-run status contract: waiting on the stream, mode on the record, and a
// terminal error that survives a backend restart
// ---------------------------------------------------------------------------

test("approval park emits run_status waiting and returns to running", async () => {
  const srv = await startServer({
    providerOverrides: {
      junior: new MockProvider([
        { tool: "workspace_write_file", args: { path: "status.txt", content: "ok" } },
        {
          text: JSON.stringify({
            result: "the status file is written",
            artifacts: ["status.txt"],
            confidence: 0.8,
          }),
        },
      ]),
    },
  });
  const wsDir = tmpdir("tb-status-wait-");
  try {
    const ws = await post<Record<string, any>>(srv.base, "/api/workspaces", {
      path: wsDir.root,
      name: "status-wait",
    });
    const runId = await startApprovalRun(srv, ws.body.id, "status-wait");
    // read until the park is visible on run_status (not just the approval)
    const events = await sseEvents(
      srv.base,
      `/api/runs/${runId}/events?after=0`,
      (all) => all.some((e) => e.type === "run_status" && e.status === "waiting"),
      15000,
    );
    const requested = events.findIndex((e) => e.type === "approval_requested");
    const parked = events.findIndex((e) => e.type === "run_status" && e.status === "waiting");
    assert.ok(requested >= 0, "expected an approval_requested event");
    assert.ok(requested < parked, "expected the park transition after the request");
    assert.equal(
      (await get<Record<string, any>>(srv.base, `/api/runs/${runId}`)).body.status,
      "waiting",
    );

    const approval = events[requested] as Record<string, any>;
    const answer = await post<Record<string, unknown>>(
      srv.base,
      `/api/runs/${runId}/approvals/${approval.approval_id}`,
      { allow: true },
    );
    assert.equal(answer.status, 200);

    const rest = await runUntilEnd(srv.base, runId, events.length);
    const all = [...events, ...rest];
    assert.equal(all.at(-1)?.type, "run_end");
    assert.equal(all.at(-1)?.status, "completed");
    assert.deepEqual(
      all.filter((e) => e.type === "run_status").map((e) => e.status),
      ["queued", "running", "waiting", "running"],
    );
    // the return to running follows the resolution, before the run ends
    const resolved = all.findIndex((e) => e.type === "approval_resolved");
    const resumed = all.findIndex(
      (e, i) => i > parked && e.type === "run_status" && e.status === "running",
    );
    assert.ok(resolved >= 0 && resolved < resumed);
  } finally {
    await srv.close();
    wsDir.cleanup();
  }
});

test("run record carries the requested mode", async () => {
  const srv = await startServer();
  try {
    const started = await post<Record<string, any>>(srv.base, "/api/runs", {
      task: "mode round trip",
      mode: "work",
    });
    assert.equal(started.status, 202);
    const runId = String(started.body.run_id);
    assert.equal(
      (await get<Record<string, any>>(srv.base, `/api/runs/${runId}`)).body.mode,
      "work",
    );
    const record = await waitTerminal(srv.base, runId);
    assert.equal(record.mode, "work");
    // live in-memory records carry no rebuild marker
    assert.equal("rebuilt" in record, false);
    const listed = await get<Array<Record<string, any>>>(
      srv.base,
      `/api/runs?session=${encodeURIComponent(String(record.session))}`,
    );
    assert.equal(listed.body.find((r) => r.run_id === runId)?.mode, "work");

    // an omitted mode records the config default the job actually runs with
    const fallback = await post<Record<string, any>>(srv.base, "/api/runs", {
      task: "default mode",
    });
    assert.equal((await waitTerminal(srv.base, fallback.body.run_id)).mode, "consult");
  } finally {
    await srv.close();
  }
});

test("failed run error survives a backend restart (sidecar recovery)", async () => {
  const tmp = tmpdir("tb-restart-");
  const options: ServerOptions = {
    configFactory: mockConfig({ provider: "openai", retries: 0 }),
    sessionsDir: tmp.root,
    webDist: null,
  };
  try {
    const first = createServer(options);
    const serverA = await first.listen("127.0.0.1", 0);
    const baseA = `http://127.0.0.1:${(serverA.address() as AddressInfo).port}`;
    const started = await post<Record<string, any>>(baseA, "/api/runs", {
      task: "will fail",
      mode: "auto",
    });
    assert.equal(started.status, 202);
    const failed = await waitTerminal(baseA, started.body.run_id);
    assert.equal(failed.status, "failed");
    assert.ok(String(failed.error).includes("no base_url configured"));
    assert.equal(failed.mode, "auto");
    await first.close();

    // simulate a restart: a fresh server/manager over the same sessions dir,
    // so the in-memory record map is empty and the sidecar is all that is left
    const second = createServer(options);
    const serverB = await second.listen("127.0.0.1", 0);
    const baseB = `http://127.0.0.1:${(serverB.address() as AddressInfo).port}`;
    try {
      assert.equal(second.state.runs.get(String(started.body.run_id)), null);
      const recovered = await get<Record<string, any>>(
        baseB,
        `/api/runs/${started.body.run_id}`,
      );
      assert.equal(recovered.status, 200);
      assert.equal(recovered.body.status, "failed");
      assert.equal(recovered.body.error, failed.error);
      assert.equal(recovered.body.session, failed.session);
      assert.deepEqual(recovered.body.usage, failed.usage);
      // task and mode are not part of the event stream; the rebuild marker
      // tells the UI why they are blank (live records omit it)
      assert.equal(recovered.body.task, "");
      assert.equal(recovered.body.mode, "");
      assert.equal(recovered.body.rebuilt, true);
      assert.equal("rebuilt" in failed, false);
      // unknown ids still 404
      assert.equal((await get(baseB, "/api/runs/nope")).status, 404);
    } finally {
      await second.close();
    }
  } finally {
    tmp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// OpenAI config guard
// ---------------------------------------------------------------------------

test("openai guard: sync run 400, background run fails fast, mock override ok", async () => {
  const tmp = tmpdir("tb-openai-");
  try {
    const handle = createServer({
      configFactory: mockConfig({ provider: "openai", retries: 0 }),
      sessionsDir: tmp.root,
      webDist: null,
    });
    const server = await handle.listen("127.0.0.1", 0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const res = await post<Record<string, unknown>>(base, "/api/run", { task: "hello" });
      assert.equal(res.status, 400);
      assert.ok(String(res.body.detail).includes("base_url"));

      const bg = await post<Record<string, any>>(base, "/api/runs", { task: "hello" });
      assert.equal(bg.status, 202); // accepted; the run itself fails
      const record = await waitTerminal(base, bg.body.run_id);
      assert.equal(record.status, "failed");
      assert.ok(String(record.error).includes("no base_url configured for the senior role"));
      assert.ok(String(record.error).includes("Settings"));

      const mock = await post<Record<string, any>>(base, "/api/runs", {
        task: "hello",
        provider: "mock",
      });
      assert.equal(mock.status, 202);
      const mockRecord = await waitTerminal(base, mock.body.run_id);
      assert.equal(mockRecord.status, "completed");

      // saved settings satisfy validation; the unreachable endpoint then
      // fails as an ordinary run error
      await api(base, "PUT", "/api/settings", {
        senior: { provider: "openai", model: "m-senior", base_url: "http://127.0.0.1:9/v1" },
        junior: { model: "m-junior" },
      });
      const saved = await post<Record<string, any>>(base, "/api/runs", { task: "hello" });
      const savedRecord = await waitTerminal(base, saved.body.run_id, 30000);
      assert.equal(savedRecord.status, "failed");
      assert.ok(!String(savedRecord.error).includes("no base_url configured"));
    } finally {
      await handle.close();
    }
  } finally {
    tmp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Per-role endpoints (Stage 18): distinct endpoints per role end-to-end
// ---------------------------------------------------------------------------

interface RecordedOpenAiRequest {
  model: string;
  authorization: string | null;
}

/** Recording OpenAI-compatible endpoint with a canned per-call script. */
async function startRoleEndpoint(script: string[]): Promise<{
  baseUrl: string;
  requests: RecordedOpenAiRequest[];
  close(): Promise<void>;
}> {
  const requests: RecordedOpenAiRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, any>;
      requests.push({
        model: String(body.model ?? ""),
        authorization: (req.headers.authorization as string | undefined) ?? null,
      });
      const content = script.length > 1 ? (script.shift() as string) : script[0];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    requests,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

test("per-role endpoints: senior and junior run on different openai-compatible endpoints", async () => {
  const tmp = tmpdir("tb-roleep-");
  const seniorEp = await startRoleEndpoint([
    JSON.stringify({ task: "t", ask: "a", expect: "proposal" }),
    JSON.stringify({ verdict: "accept", notes: "ok" }),
    JSON.stringify({ decision: "done", confidence: 0.8 }),
  ]);
  const juniorEp = await startRoleEndpoint([
    JSON.stringify({ title: "P", answer: "A", confidence: 0.7 }),
  ]);
  try {
    const handle = createServer({
      configFactory: mockConfig({ provider: "openai", retries: 0 }),
      sessionsDir: tmp.root,
      webDist: null,
    });
    const server = await handle.listen("127.0.0.1", 0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      // senior via a named preset (provider_ref), junior via manual fields —
      // the two roles must talk to two different endpoints with two keys
      const preset = await post<Record<string, any>>(base, "/api/providers", {
        name: "Acme",
        base_url: seniorEp.baseUrl,
        api_key: "preset-key",
      });
      assert.equal(preset.status, 201);
      const settings = await api<Record<string, any>>(base, "PUT", "/api/settings", {
        senior: { provider: "openai", model: "spark-x", provider_ref: "Acme" },
        junior: { provider: "openai", model: "lfm3", base_url: juniorEp.baseUrl, api_key: "junior-key" },
      });
      assert.equal(settings.status, 200);

      const run = await post<Record<string, any>>(base, "/api/runs", { task: "cooperate" });
      assert.equal(run.status, 202);
      const record = await waitTerminal(base, run.body.run_id);
      assert.equal(record.status, "completed", JSON.stringify(record));

      // senior: consult, review, decision on the preset endpoint with the preset key
      assert.deepEqual(
        seniorEp.requests.map((r) => [r.model, r.authorization]),
        [["spark-x", "Bearer preset-key"], ["spark-x", "Bearer preset-key"], ["spark-x", "Bearer preset-key"]],
      );
      // junior: one proposal on its own endpoint with its own key
      assert.deepEqual(
        juniorEp.requests.map((r) => [r.model, r.authorization]),
        [["lfm3", "Bearer junior-key"]],
      );
    } finally {
      await handle.close();
    }
  } finally {
    await seniorEp.close();
    await juniorEp.close();
    tmp.cleanup();
  }
});

test("per-role endpoints: 400 names the misconfigured role (mixed providers)", async () => {
  const tmp = tmpdir("tb-rolemix-");
  try {
    const handle = createServer({
      configFactory: mockConfig({ provider: "openai", retries: 0 }),
      sessionsDir: tmp.root,
      webDist: null,
    });
    const server = await handle.listen("127.0.0.1", 0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      // senior is mock (needs nothing); junior is openai with a model but
      // no endpoint anywhere — the error must name the junior role only
      const settings = await api<Record<string, any>>(base, "PUT", "/api/settings", {
        senior: { provider: "mock", model: "m-senior" },
        junior: { provider: "openai", model: "m-junior" },
      });
      assert.equal(settings.status, 200);

      const res = await post<Record<string, unknown>>(base, "/api/run", { task: "hello" });
      assert.equal(res.status, 400);
      const detail = String(res.body.detail);
      assert.match(detail, /no base_url configured for the junior role/);
      assert.doesNotMatch(detail, /senior role/);

      const bg = await post<Record<string, any>>(base, "/api/runs", { task: "hello" });
      const record = await waitTerminal(base, bg.body.run_id);
      assert.equal(record.status, "failed");
      assert.match(String(record.error), /no base_url configured for the junior role/);
    } finally {
      await handle.close();
    }
  } finally {
    tmp.cleanup();
  }
});



test("newSessionName: unique, filesystem-safe, short", () => {
  const names = new Set(Array.from({ length: 50 }, () => newSessionName()));
  assert.equal(names.size, 50);
  const name = newSessionName();
  assert.match(name, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}-[0-9a-f]{6}\.jsonl$/);
  assert.ok(name.length <= 40);
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  const prefix =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T` +
    `${pad(now.getHours())}-${pad(now.getMinutes())}`;
  assert.ok(name.startsWith(prefix));
});

// ---------------------------------------------------------------------------
// Delete session (all traces)
// ---------------------------------------------------------------------------

test("delete session removes jsonl, metadata and runtime sidecar", async () => {
  const srv = await startServer();
  try {
    const started = await post<Record<string, any>>(srv.base, "/api/runs", { task: "delete me" });
    await waitTerminal(srv.base, started.body.run_id);
    const name = started.body.session as string;
    const stem = name.replace(/\.jsonl$/, "");
    const traces = () => ({
      jsonl: fs.existsSync(path.join(srv.dir, name)),
      meta: fs.existsSync(path.join(srv.dir, `${stem}.meta.json`)),
      runtime: fs.existsSync(path.join(srv.dir, "runtime", `${name}.events.jsonl`)),
    });
    assert.ok(Object.values(traces()).every(Boolean));

    const res = await api<Record<string, unknown>>(srv.base, "DELETE", `/api/sessions/${name}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { deleted: name });
    assert.ok(!Object.values(traces()).some(Boolean));
    assert.equal((await get(srv.base, `/api/sessions/${name}`)).status, 404);
    assert.deepEqual((await get(srv.base, "/api/sessions")).body, []);
  } finally {
    await srv.close();
  }
});

test("delete: 404 for unknown session", async () => {
  const srv = await startServer();
  try {
    assert.equal((await api(srv.base, "DELETE", "/api/sessions/nope.jsonl")).status, 404);
  } finally {
    await srv.close();
  }
});

test("delete: traversal attempts stay inside the sessions dir", async () => {
  const srv = await startServer();
  try {
    const keep = (await post<Record<string, any>>(srv.base, "/api/sessions", { title: "keep" }))
      .body.name as string;
    // encoded ".." reaches the handler; nested/escaped names are flattened to
    // a bare file name by the store, so they can only address files inside
    // sessions_dir — nothing gets deleted
    for (const raw of ["%2E%2E", "nested%2Fescape.jsonl", "..%5Cescape.jsonl"]) {
      const res = await fetch(`${srv.base}/api/sessions/${raw}`, { method: "DELETE" });
      assert.ok([404, 405].includes(res.status), `${raw} -> ${res.status}`);
    }
    assert.ok(fs.existsSync(path.join(srv.dir, keep)));
    assert.equal((await get<Array<Record<string, unknown>>>(srv.base, "/api/sessions")).body[0].name, keep);
    assert.ok(!fs.existsSync(path.join(srv.dir, "escape.jsonl")));
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------
// Approvals over HTTP resolve a parked tool
// ---------------------------------------------------------------------------

async function startApprovalRun(
  srv: RunningServer,
  wsId: string,
  session: string,
): Promise<string> {
  const started = await post<Record<string, any>>(srv.base, "/api/runs", {
    task: "Create the hello file",
    mode: "work",
    provider: "mock",
    workspace_id: wsId,
    session,
  });
  assert.equal(started.status, 202);
  return started.body.run_id;
}

async function awaitApproval(
  srv: RunningServer,
  runId: string,
): Promise<{ events: Array<Record<string, unknown>>; approval: Record<string, any> }> {
  const events = await sseEvents(
    srv.base,
    `/api/runs/${runId}/events?after=0`,
    (all) => all.some((e) => e.type === "approval_requested"),
    15000,
  );
  const requested = events.filter((e) => e.type === "approval_requested");
  assert.equal(requested.length, 1);
  return { events, approval: requested[0] as Record<string, any> };
}

test("approval allow writes the file; deny leaves it absent; stop denies", async () => {
  const srv = await startServer({
    // One (write call, deliverable text) pair per approval run — the three
    // runs below consume them in order (allow, deny, stop).
    providerOverrides: {
      junior: new MockProvider([
        { tool: "workspace_write_file", args: { path: "hello.txt", content: "hello content" } },
        { text: JSON.stringify({ result: "the hello file is written", artifacts: ["hello.txt"], confidence: 0.8 }) },
        { tool: "workspace_write_file", args: { path: "hello.txt", content: "hello content" } },
        { text: JSON.stringify({ result: "the hello file is written", artifacts: ["hello.txt"], confidence: 0.8 }) },
        { tool: "workspace_write_file", args: { path: "hello.txt", content: "hello content" } },
        { text: JSON.stringify({ result: "the hello file is written", artifacts: ["hello.txt"], confidence: 0.8 }) },
      ]),
    },
  });
  const wsDir = tmpdir("tb-approval-");
  try {
    const ws = await post<Record<string, any>>(srv.base, "/api/workspaces", {
      path: wsDir.root,
      name: "e2e-approval",
    });
    const hello = path.join(wsDir.root, "hello.txt");

    // -- allow: the write proceeds, the file appears, the run completes
    let runId = await startApprovalRun(srv, ws.body.id, "e2e-approval");
    let { events, approval } = await awaitApproval(srv, runId);
    assert.equal(approval.action, "write");
    assert.equal(approval.target, "hello.txt");

    const pending = await get<Record<string, any>>(srv.base, `/api/runs/${runId}/approvals`);
    assert.deepEqual(
      (pending.body.pending as Array<Record<string, unknown>>).map((p) => p.approval_id),
      [approval.approval_id],
    );

    const answer = await api<Record<string, unknown>>(
      srv.base,
      "POST",
      `/api/runs/${runId}/approvals/${approval.approval_id}`,
      { allow: true },
    );
    assert.equal(answer.status, 200);
    assert.equal(answer.body.decision, "allow");

    let rest = await runUntilEnd(srv.base, runId, events.length);
    const allEvents = [...events, ...rest];
    assert.equal(rest.at(-1)?.status, "completed");
    const completed = allEvents
      .filter((e) => e.type === "tool_completed")
      .map((e) => [e.tool, e.status]);
    assert.ok(completed.some(([tool, status]) => tool === "workspace_write_file" && status === "ok"));
    assert.equal(fs.readFileSync(hello, "utf-8"), "hello content");
    // already-resolved approvals answer 404
    assert.equal(
      (await post(srv.base, `/api/runs/${runId}/approvals/${approval.approval_id}`, { allow: true }))
        .status,
      404,
    );

    // -- deny: the write is refused, the file stays absent, the denial is
    //          visible in the tool/approval history
    fs.rmSync(hello);
    runId = await startApprovalRun(srv, ws.body.id, "e2e-approval-deny");
    ({ events, approval } = await awaitApproval(srv, runId));
    const deny = await api<Record<string, unknown>>(
      srv.base,
      "POST",
      `/api/runs/${runId}/approvals/${approval.approval_id}`,
      { allow: false },
    );
    assert.equal(deny.status, 200);
    assert.equal(deny.body.decision, "deny");

    rest = await runUntilEnd(srv.base, runId, events.length);
    const allDeny = [...events, ...rest];
    assert.equal(rest.at(-1)?.status, "completed");
    assert.ok(!fs.existsSync(hello));
    assert.ok(
      allDeny.some((e) => e.type === "tool_completed" && e.status === "denied"),
      "expected a denied tool_completed event",
    );
    assert.ok(
      allDeny.some(
        (e) => e.type === "approval_resolved" && e.decision === "deny" && e.approval_id === approval.approval_id,
      ),
      "expected an approval_resolved deny event",
    );

    // -- stop: a parked approval is resolved as deny and the run cancels
    runId = await startApprovalRun(srv, ws.body.id, "e2e-approval-stop");
    ({ events, approval } = await awaitApproval(srv, runId));
    const stopped = await post<Record<string, unknown>>(srv.base, `/api/runs/${runId}/stop`);
    assert.equal(stopped.status, 200);
    rest = await runUntilEnd(srv.base, runId, events.length);
    const allStopped = [...events, ...rest];
    assert.equal(rest.at(-1)?.type, "run_end");
    assert.equal(rest.at(-1)?.status, "cancelled");
    assert.ok(
      allStopped.some(
        (e) => e.type === "approval_resolved" && e.decision === "deny" && e.approval_id === approval.approval_id,
      ),
      "expected the stop to resolve the parked approval as deny",
    );
  } finally {
    await srv.close();
    wsDir.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Folder explorer
// ---------------------------------------------------------------------------

test("fs/browse: dirs only, parent, truncation-free, 400s", async () => {
  const srv = await startServer();
  const root = tmpdir("tb-browse-");
  try {
    fs.mkdirSync(path.join(root.root, "alpha"));
    fs.mkdirSync(path.join(root.root, "Beta"));
    fs.writeFileSync(path.join(root.root, "file.txt"), "x");

    const res = await get<Record<string, any>>(srv.base, `/api/fs/browse?path=${encodeURIComponent(root.root)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.path, path.resolve(root.root));
    assert.equal(res.body.truncated, false);
    assert.deepEqual(
      (res.body.entries as Array<Record<string, unknown>>).map((e) => e.name),
      ["alpha", "Beta"], // case-insensitive sort
    );
    for (const entry of res.body.entries as Array<Record<string, unknown>>) {
      assert.ok(fs.statSync(String(entry.path)).isDirectory());
    }
    const parent = res.body.parent as string;
    assert.equal(parent, path.dirname(path.resolve(root.root)));

    assert.equal((await get(srv.base, `/api/fs/browse?path=${encodeURIComponent(path.join(root.root, "file.txt"))}`)).status, 400);
    assert.equal((await get(srv.base, "/api/fs/browse?path=/no/such/dir")).status, 400);

    if (process.platform === "win32") {
      const drives = await get<Record<string, any>>(srv.base, "/api/fs/browse");
      assert.equal(drives.status, 200);
      assert.equal(drives.body.path, "");
      assert.equal(drives.body.parent, null);
      assert.ok(Array.isArray(drives.body.entries));
      assert.ok((drives.body.entries as unknown[]).length >= 1);
      for (const entry of drives.body.entries as Array<Record<string, unknown>>) {
        assert.match(String(entry.name), /^[A-Z]:\\$/);
      }
    } else {
      const cwd = await get<Record<string, any>>(srv.base, "/api/fs/browse");
      assert.equal(cwd.body.path, process.cwd());
    }
  } finally {
    await srv.close();
    root.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Provider presets
// ---------------------------------------------------------------------------

test("provider presets: CRUD, masking, duplicate 409, ref clearing", async () => {
  const srv = await startServer();
  try {
    // The curated seed table is always listed (seeded presets, `presets.ts`);
    // a fresh server has no stored presets on top of it.
    const seeded = (await get<Record<string, any>>(srv.base, "/api/providers")).body
      .providers as Array<Record<string, any>>;
    const seedNames = seeded.map((preset) => preset.name);
    for (const name of ["openai", "deepseek", "lmstudio", "custom"]) {
      assert.ok(seedNames.includes(name), `seed "${name}" is listed`);
    }
    assert.ok(!seedNames.includes("LocalLLM"), "no stored presets on a fresh server");

    const created = await post<Record<string, any>>(srv.base, "/api/providers", {
      name: "LocalLLM",
      base_url: "http://127.0.0.1:1234/v1",
      api_key: "preset-secret",
      kind: "openai-compatible",
      models: ["spark-x", "lfm3"],
    });
    assert.equal(created.status, 201);
    assert.deepEqual(created.body.provider, {
      name: "LocalLLM",
      base_url: "http://127.0.0.1:1234/v1",
      api_key_set: true,
      kind: "openai-compatible",
      models: ["spark-x", "lfm3"],
    });

    // public view never carries key material
    const listed = await get<Record<string, any>>(srv.base, "/api/providers");
    assert.equal(listed.body.providers.length, seeded.length + 1);
    assert.ok(
      (listed.body.providers as Array<Record<string, any>>).some(
        (preset) => preset.name === "LocalLLM",
      ),
    );
    assert.ok(!JSON.stringify(listed.body).includes("preset-secret"));

    // duplicate (case-insensitive) -> 409
    assert.equal(
      (await post(srv.base, "/api/providers", { name: "localllm", base_url: "http://x/v1" })).status,
      409,
    );
    assert.equal((await post(srv.base, "/api/providers", { name: "", base_url: "http://x/v1" })).status, 400);
    assert.equal((await post(srv.base, "/api/providers", { name: "x" })).status, 400);

    // update base_url only — the stored key is kept
    const updated = await api<Record<string, any>>(srv.base, "PUT", "/api/providers/LocalLLM", {
      base_url: "http://127.0.0.1:4321/v1",
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.provider.base_url, "http://127.0.0.1:4321/v1");
    assert.equal(updated.body.provider.api_key_set, true);
    // kind/models round-trip through PUT; omitted fields keep stored values
    const meta = await api<Record<string, any>>(srv.base, "PUT", "/api/providers/LocalLLM", {
      kind: "openai-compatible",
      models: ["spark-x2"],
    });
    assert.equal(meta.status, 200);
    assert.equal(meta.body.provider.kind, "openai-compatible");
    assert.deepEqual(meta.body.provider.models, ["spark-x2"]);
    // defaults when kind/models are never sent (fresh preset without them)
    const bare = await post<Record<string, any>>(srv.base, "/api/providers", {
      name: "Bare",
      base_url: "http://127.0.0.1:9/v1",
    });
    assert.equal(bare.status, 201);
    assert.equal(bare.body.provider.kind, "openai-compatible");
    assert.deepEqual(bare.body.provider.models, []);
    await api(srv.base, "DELETE", "/api/providers/Bare");
    assert.equal(
      (await post(srv.base, "/api/providers", { name: "k", base_url: "http://x/v1", kind: 42 })).status,
      400,
    );
    assert.equal((await api(srv.base, "PUT", "/api/providers/nope", { base_url: "http://y/v1" })).status, 404);

    // a role pointing at the preset resolves through it (settings accept the ref)
    const settings = await api<Record<string, any>>(srv.base, "PUT", "/api/settings", {
      senior: { provider_ref: "LocalLLM" },
    });
    assert.equal(settings.status, 200);
    assert.equal(settings.body.senior.provider_ref, "LocalLLM");
    // unknown preset ref -> 400
    assert.equal(
      (await api(srv.base, "PUT", "/api/settings", { senior: { provider_ref: "Ghost" } })).status,
      400,
    );

    // deleting the preset clears the dangling ref (persisted); the seeds stay
    const removed = await api<Record<string, unknown>>(srv.base, "DELETE", "/api/providers/LocalLLM");
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.body, { removed: "LocalLLM" });
    const afterDelete = (await get<Record<string, any>>(srv.base, "/api/providers")).body
      .providers as Array<Record<string, any>>;
    assert.ok(!afterDelete.some((preset) => preset.name === "LocalLLM"));
    assert.ok(afterDelete.some((preset) => preset.name === "openai"), "seeds remain");
    const after = (await get<Record<string, any>>(srv.base, "/api/settings")).body;
    assert.equal(after.senior.provider_ref, null);
    const onDisk = fs.readFileSync(path.join(srv.dir, "settings.json"), "utf-8");
    assert.ok(!onDisk.includes("LocalLLM"));
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------
// Misc contract endpoints
// ---------------------------------------------------------------------------

test("plugins endpoint lists the plugins discovered in the default dir", async () => {
  // The default plugins dir is the repo-root plugins/ (python
  // default_plugins_dir parity), which ships the notes example.
  const srv = await startServer();
  try {
    const res = await get<{
      plugins: Array<{ name: string; description: string; roles: string[] }>;
      errors: Array<{ plugin: string; error: string }>;
    }>(srv.base, "/api/plugins");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.errors, []);
    const notes = res.body.plugins.find((p) => p.name === "notes");
    assert.equal(notes?.description, "Keep short notes inside the workspace");
    assert.deepEqual(notes?.roles, ["shared"]);
  } finally {
    await srv.close();
  }
});

test("method mismatch answers 405", async () => {
  const srv = await startServer();
  try {
    const res = await fetch(`${srv.base}/api/sessions`, { method: "DELETE" });
    assert.equal(res.status, 405);
  } finally {
    await srv.close();
  }
});

test("unknown api route answers 404", async () => {
  const srv = await startServer();
  try {
    const res = await get<Record<string, unknown>>(srv.base, "/api/definitely-not-here");
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { detail: "Not Found" });
  } finally {
    await srv.close();
  }
});

test("static web/dist is served at / with an SPA fallback", async () => {
  const dist = tmpdir("tb-dist-");
  try {
    fs.mkdirSync(path.join(dist.root, "assets"));
    fs.writeFileSync(path.join(dist.root, "index.html"), '<div id="app">Two Brothers</div>');
    fs.writeFileSync(path.join(dist.root, "assets", "app.js"), "console.log(1)");

    const srv = await startServer({ webDist: dist.root });
    try {
      const index = await fetch(`${srv.base}/`);
      assert.equal(index.status, 200);
      assert.match(await index.text(), /<div id="app">Two Brothers<\/div>/);

      const asset = await fetch(`${srv.base}/assets/app.js`);
      assert.equal(asset.status, 200);
      assert.match(await asset.text(), /console\.log/);

      const spa = await fetch(`${srv.base}/some/client/route`);
      assert.equal(spa.status, 200);
      assert.match(await spa.text(), /<div id="app">/);

      const missingAsset = await fetch(`${srv.base}/assets/missing.js`);
      assert.equal(missingAsset.status, 404);
    } finally {
      await srv.close();
    }
  } finally {
    dist.cleanup();
  }
});

test("default web dist: packaged <package>/web wins, repo web/dist is the fallback", () => {
  const tmp = tmpdir("tb-webdist-");
  try {
    const packageDir = path.join(tmp.root, "nested", "harness");
    fs.mkdirSync(path.join(packageDir, "dist"), { recursive: true });
    const moduleUrl = pathToFileURL(path.join(packageDir, "dist", "server.js")).href;

    assert.equal(resolveDefaultWebDist(moduleUrl), null);

    // packageDir/../.. is tmp.root, so this is the repo-checkout layout.
    const repoDist = path.join(tmp.root, "web", "dist");
    fs.mkdirSync(repoDist, { recursive: true });
    fs.writeFileSync(path.join(repoDist, "index.html"), "repo build");
    assert.equal(resolveDefaultWebDist(moduleUrl), repoDist);

    const packaged = path.join(packageDir, "web");
    fs.mkdirSync(packaged, { recursive: true });
    fs.writeFileSync(path.join(packaged, "index.html"), "packaged build");
    assert.equal(resolveDefaultWebDist(moduleUrl), packaged);
  } finally {
    tmp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Run list filtering
// ---------------------------------------------------------------------------

test("run list: ?session= filters, empty means all", async () => {
  const srv = await startServer();
  try {
    const a = await post<Record<string, any>>(srv.base, "/api/runs", { task: "task a", session: "sa" });
    const b = await post<Record<string, any>>(srv.base, "/api/runs", { task: "task b", session: "sb" });
    await waitTerminal(srv.base, a.body.run_id);
    await waitTerminal(srv.base, b.body.run_id);

    const all = (await get<Array<Record<string, unknown>>>(srv.base, "/api/runs")).body;
    assert.equal(all.length, 2);
    const filtered = (
      await get<Array<Record<string, unknown>>>(srv.base, `/api/runs?session=${a.body.session}`)
    ).body;
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].session, a.body.session);
    const empty = (await get<Array<Record<string, unknown>>>(srv.base, "/api/runs?session=")).body;
    assert.equal(empty.length, 2);
  } finally {
    await srv.close();
  }
});
