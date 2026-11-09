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
  UsageTracker,
  type MockScriptStep,
  type Provider,
  type Tool,
  type ToolChatOptions,
  type ToolChatResponse,
  type UsageTotals,
} from "../src/provider.ts";
import {
  createServer,
  newSessionName,
  resolveDefaultWebDist,
  type ServerHandle,
  type ServerOptions,
} from "../src/server.ts";
import type { RunCost } from "../src/runtime.ts";

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

/**
 * A mock provider with deterministic per-call usage, including cache counters
 * (wave 24 cost mapping tests). The harness reads `usageSnapshot()` after the
 * run, so this wrapper's tracker — not the inner MockProvider's — is the run's
 * usage source.
 */
function meteredMockProvider(
  input: number,
  output: number,
  cached: number,
  cacheWrite: number,
): Provider & { usageSnapshot(): UsageTotals } {
  const inner = new MockProvider();
  const tracker = new UsageTracker();
  const record = (): void => tracker.record(input, output, cached, cacheWrite);
  return {
    async chat(messages: ChatMessage[], responseKind?: string, _signal?: AbortSignal) {
      record();
      return inner.chat(messages, responseKind);
    },
    async chatWithTools(messages: ChatMessage[], tools: Tool[], options?: ToolChatOptions) {
      record();
      return inner.chatWithTools(messages, tools, options) as Promise<ToolChatResponse>;
    },
    usageSnapshot: () => tracker.snapshot(),
  };
}

/** One consult cycle with the deterministic mock: 5 envelopes, usage 40/20. */
const CONSULT_KINDS = ["message", "consult", "proposal", "review", "decision"];
const EXPECTED_USAGE = {
  model_calls: 4,
  input_tokens: 40,
  output_tokens: 20,
  cached_tokens: 0,
  cache_write_tokens: 0,
};

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

test("api/stream answers with the standard SSE headers", async () => {
  const srv = await startServer();
  try {
    const res = await post<Record<string, unknown>>(srv.base, "/api/run", { task: "stream me" });
    const name = String(res.body.session);
    const headers = await new Promise<http.IncomingHttpHeaders>((resolve, reject) => {
      const req = http.get(
        `${srv.base}/api/stream?session=${encodeURIComponent(name)}`,
        (incoming) => {
          incoming.once("data", () => {
            req.destroy();
            resolve(incoming.headers);
          });
          incoming.on("error", () => {
            // the destroyed socket may error after the headers were captured
          });
        },
      );
      req.on("error", reject);
    });
    assert.equal(headers["content-type"], "text/event-stream");
    assert.equal(headers["cache-control"], "no-cache");
    assert.equal(headers["x-accel-buffering"], "no");
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

test("a run inherits the session's linked workspace for tool calling", async () => {
  const srv = await startServer({
    providerOverrides: {
      junior: new MockProvider([
        { tool: "workspace_list_dir", args: { path: "." } },
        {
          text: JSON.stringify({
            result: "listed the linked workspace",
            artifacts: ["notes.txt"],
            notes: "",
            confidence: 0.8,
          }),
        },
      ]),
    },
  });
  const ws = tmpdir("tb-linked-tools-");
  try {
    fs.writeFileSync(path.join(ws.root, "notes.txt"), "hello from the linked workspace");
    const registered = await post<Record<string, any>>(srv.base, "/api/workspaces", {
      path: ws.root,
      name: "linked-tools",
    });
    assert.equal(registered.status, 201);
    const session = await post<Record<string, any>>(srv.base, "/api/sessions", {
      title: "linked tools",
      workspace_id: registered.body.id,
    });
    assert.equal(session.status, 201);

    // Exact web-composer shape when the sidebar filter is "all": the session
    // link is the only workspace source, so the run must inherit it.
    const started = await post<Record<string, any>>(srv.base, "/api/runs", {
      task: "List the files in the folder",
      mode: "work",
      provider: "mock",
      session: session.body.name,
      workspace_id: null,
    });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const events = await runUntilEnd(srv.base, started.body.run_id);
    assert.equal(events.at(-1)?.status, "completed");

    const audit = events.find(
      (event) => event.type === "prompt_audit" && event.role === "junior",
    );
    assert.ok(audit, "expected a junior prompt audit");
    assert.ok(
      (audit.tools as string[]).includes("workspace_list_dir"),
      `offered tools: ${JSON.stringify(audit.tools)}`,
    );
    const completed = events.find(
      (event) => event.type === "tool_completed" && event.tool === "workspace_list_dir",
    );
    assert.equal(completed?.status, "ok", JSON.stringify(completed));
  } finally {
    await srv.close();
    ws.cleanup();
  }
});

test("a file mention on a linked session reads through its workspace", async () => {
  const srv = await startServer();
  const ws = tmpdir("tb-linked-mention-");
  try {
    fs.writeFileSync(path.join(ws.root, "notes.txt"), "hello from the linked workspace");
    const registered = await post<Record<string, any>>(srv.base, "/api/workspaces", {
      path: ws.root,
      name: "linked-mention",
    });
    const session = await post<Record<string, any>>(srv.base, "/api/sessions", {
      title: "linked mention",
      workspace_id: registered.body.id,
    });

    const started = await post<Record<string, any>>(srv.base, "/api/runs", {
      task: "Use @./notes.txt",
      provider: "mock",
      session: session.body.name,
    });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const events = await runUntilEnd(srv.base, started.body.run_id);
    assert.equal(events.at(-1)?.status, "completed");

    const detail = await get<Record<string, any>>(
      srv.base,
      `/api/sessions/${encodeURIComponent(session.body.name)}`,
    );
    const first = detail.body.events[0] as Record<string, any>;
    assert.match(
      String(first?.payload?.text),
      /^<file path="notes.txt">\nhello from the linked workspace\n<\/file>$/,
    );
  } finally {
    await srv.close();
    ws.cleanup();
  }
});

test("legacy /api/run inherits the linked workspace for tools and file mentions", async () => {
  const srv = await startServer({
    providerOverrides: {
      junior: new MockProvider([
        { tool: "workspace_list_dir", args: { path: "." } },
        {
          text: JSON.stringify({
            result: "listed the linked workspace",
            artifacts: [],
            notes: "",
            confidence: 0.8,
          }),
        },
      ]),
    },
  });
  const ws = tmpdir("tb-sync-linked-");
  try {
    fs.writeFileSync(path.join(ws.root, "notes.txt"), "hello from the linked workspace");
    const registered = await post<Record<string, any>>(srv.base, "/api/workspaces", {
      path: ws.root,
      name: "sync-linked",
    });
    const session = await post<Record<string, any>>(srv.base, "/api/sessions", {
      title: "sync linked",
      workspace_id: registered.body.id,
    });

    const res = await post<Record<string, any>>(srv.base, "/api/run", {
      task: "Use @./notes.txt then list the files",
      mode: "work",
      provider: "mock",
      session: session.body.name,
      workspace_id: null,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const events = res.body.events as Array<Record<string, any>>;
    const detail = await get<Record<string, any>>(
      srv.base,
      `/api/sessions/${encodeURIComponent(session.body.name)}`,
    );
    assert.match(
      String((detail.body.events[0] as Record<string, any>)?.payload?.text),
      /^<file path="notes.txt">\nhello from the linked workspace\n<\/file>$/,
    );
    const deliverable = events.find((event) => event.kind === "deliverable");
    assert.ok(deliverable, JSON.stringify(events.map((event) => event.kind)));
    const artifacts = deliverable.payload.artifacts as string[];
    assert.ok(
      artifacts.some((line) => line.startsWith("tool: workspace_list_dir")),
      JSON.stringify(artifacts),
    );
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

test("settings: schema state is additive and future-version writes are 409", async () => {
  const tmp = tmpdir("tb-settings-schema-");
  const settingsPath = path.join(tmp.root, "settings.json");
  try {
    // No file: a legacy/unversioned store is writable and reports null; the
    // first save creates a v1 document.
    const empty = await startServer({ sessionsDir: tmp.root });
    try {
      const view = await get<Record<string, any>>(empty.base, "/api/settings");
      assert.equal(view.status, 200);
      assert.deepEqual(view.body.schema, { version: null, supported: 1, writable: true });
      const put = await api<Record<string, any>>(empty.base, "PUT", "/api/settings", {
        junior: { model: "first-model" },
      });
      assert.equal(put.status, 200);
      assert.deepEqual((await get<Record<string, any>>(empty.base, "/api/settings")).body.schema, {
        version: 1,
        supported: 1,
        writable: true,
      });
      assert.equal(
        (JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as Record<string, unknown>).version,
        1,
      );
    } finally {
      await empty.close();
    }

    // A legacy file keeps reading its known sections; the startup normalization
    // (and any later write) stamps v1 while preserving a same-version extension.
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ senior: { model: "legacy-model" }, future_extension: { keep: true } }),
      "utf-8",
    );
    const legacy = await startServer({ sessionsDir: tmp.root });
    try {
      const view = await get<Record<string, any>>(legacy.base, "/api/settings");
      assert.equal(view.status, 200);
      assert.deepEqual(view.body.schema, { version: 1, supported: 1, writable: true });
      assert.equal(view.body.senior.model, "legacy-model");
      const put = await api<Record<string, any>>(legacy.base, "PUT", "/api/settings", {
        junior: { model: "junior-model" },
      });
      assert.equal(put.status, 200);
      assert.deepEqual((await get<Record<string, any>>(legacy.base, "/api/settings")).body.schema, {
        version: 1,
        supported: 1,
        writable: true,
      });
      const onDisk = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as Record<string, any>;
      assert.equal(onDisk.version, 1);
      assert.deepEqual(onDisk.future_extension, { keep: true });
    } finally {
      await legacy.close();
    }

    // A newer release's document: reads work, every settings write is a 409.
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        version: 2,
        senior: { model: "future-model" },
        future_extension: { from: "newer-release" },
      }),
      "utf-8",
    );
    const future = await startServer({ sessionsDir: tmp.root });
    try {
      const view = await get<Record<string, any>>(future.base, "/api/settings");
      assert.equal(view.status, 200);
      assert.deepEqual(view.body.schema, { version: 2, supported: 1, writable: false });
      assert.equal(view.body.senior.model, "future-model");

      const before = fs.readFileSync(settingsPath, "utf-8");
      const writes: Array<[string, string, unknown?]> = [
        ["PUT", "/api/settings", { senior: { model: "downgraded" } }],
        ["PUT", "/api/settings", { approval_policy: { mode: "allow-all" } }],
        ["PUT", "/api/settings", { compaction: { threshold_chars: 1 } }],
        ["POST", "/api/providers", { name: "new", base_url: "https://new.example/v1" }],
        ["DELETE", "/api/providers/acme"],
        ["DELETE", "/api/sessions/s.jsonl"],
      ];
      for (const [method, route, body] of writes) {
        const res = await api<Record<string, unknown>>(future.base, method, route, body);
        assert.equal(res.status, 409, `${method} ${route} must refuse a future document`);
        assert.match(String(res.body.detail), /newer release/);
        assert.match(String(res.body.detail), /version 2/);
        assert.equal(
          fs.readFileSync(settingsPath, "utf-8"),
          before,
          `${method} ${route} must leave the newer document byte-identical`,
        );
      }
      assert.equal(fs.existsSync(settingsPath + ".tmp"), false);
    } finally {
      await future.close();
    }
  } finally {
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
// Run cost (wave 24): additive USD estimate on the run public view, honestly
// null when the merged usage cannot be attributed to one priced model
// ---------------------------------------------------------------------------

test("run cost: same priced model on both roles yields an additive USD estimate", async () => {
  const srv = await startServer({
    configFactory: mockConfig({ seniorModel: "gpt-4o", juniorModel: "gpt-4o" }),
  });
  try {
    const started = await post<Record<string, any>>(srv.base, "/api/runs", { task: "price me" });
    const record = await waitTerminal(srv.base, started.body.run_id);
    assert.equal(record.status, "completed");
    assert.ok(record.cost, "same-model priced run should carry a cost estimate");
    const cost = record.cost as RunCost;
    assert.equal(cost.currency, "USD");
    assert.equal(cost.model, "gpt-4o");
    // mock usage: 4 calls × (10 in / 5 out) = 40/20 at gpt-4o's $2.5/$10 per 1M
    assert.ok(
      Math.abs(cost.total - 0.0003) < 1e-9,
      `unexpected cost total: ${String(cost.total)}`,
    );
    // the public view is shared by the list route (same shape, same value)
    const listed = await get<Array<Record<string, any>>>(
      srv.base,
      `/api/runs?session=${encodeURIComponent(String(record.session))}`,
    );
    assert.deepEqual(listed.body.find((r) => r.run_id === record.run_id)?.cost, record.cost);
  } finally {
    await srv.close();
  }
});

test("run cost: different role models stay honestly null", async () => {
  const srv = await startServer({
    configFactory: mockConfig({ seniorModel: "gpt-4o", juniorModel: "gpt-4o-mini" }),
  });
  try {
    const started = await post<Record<string, any>>(srv.base, "/api/runs", { task: "mixed" });
    const record = await waitTerminal(srv.base, started.body.run_id);
    assert.equal(record.status, "completed");
    // the field is always present (additive public view), but never invented
    assert.ok("cost" in record);
    assert.equal(record.cost, null);
  } finally {
    await srv.close();
  }
});

test("run cost: an unknown price row stays null (never $0)", async () => {
  const srv = await startServer({
    configFactory: mockConfig({
      seniorModel: "unpriced-model-xyz",
      juniorModel: "unpriced-model-xyz",
    }),
  });
  try {
    const started = await post<Record<string, any>>(srv.base, "/api/runs", { task: "unknown" });
    const record = await waitTerminal(srv.base, started.body.run_id);
    assert.equal(record.status, "completed");
    assert.equal(record.cost, null);
  } finally {
    await srv.close();
  }
});

test("run cost: cache counters are priced with the run's provider family", async () => {
  // Anthropic semantics: input_tokens is uncached-only, cache reads/writes are
  // disjoint counters, and the total prompt is input + reads + writes.
  const srv = await startServer({
    configFactory: mockConfig({
      provider: "mock",
      kind: "anthropic",
      seniorModel: "claude-sonnet-4",
      juniorModel: "claude-sonnet-4",
    }),
    providerOverrides: {
      senior: meteredMockProvider(1000, 100, 800, 100),
      junior: meteredMockProvider(1000, 100, 800, 100),
    },
  });
  try {
    const started = await post<Record<string, any>>(srv.base, "/api/runs", { task: "cache me" });
    const record = await waitTerminal(srv.base, started.body.run_id);
    assert.equal(record.status, "completed");
    assert.deepEqual(record.usage, {
      model_calls: 4,
      input_tokens: 4000,
      output_tokens: 400,
      cached_tokens: 3200,
      cache_write_tokens: 400,
    });
    assert.ok(record.cost);
    const cost = record.cost as RunCost;
    assert.equal(cost.model, "claude-sonnet-4");
    // total prompt 7600 = 4000 uncached × $3 + 3200 reads × $0.30 + 400
    // writes × $3.75, plus 400 completion tokens × $15 (all per 1M).
    const expected = (4000 * 3 + 3200 * 0.3 + 400 * 3.75 + 400 * 15) / 1_000_000;
    assert.ok(
      Math.abs(cost.total - expected) < 1e-12,
      `expected ${String(expected)}, got ${String(cost.total)}`,
    );
  } finally {
    await srv.close();
  }
});

test("run cost: sidecar-rebuilt record recomputes from current models + usage", async () => {
  const tmp = tmpdir("tb-cost-recover-");
  const options: ServerOptions = {
    configFactory: mockConfig({ seniorModel: "gpt-4o", juniorModel: "gpt-4o" }),
    sessionsDir: tmp.root,
    webDist: null,
  };
  try {
    const first = createServer(options);
    const serverA = await first.listen("127.0.0.1", 0);
    const baseA = `http://127.0.0.1:${(serverA.address() as AddressInfo).port}`;
    const started = await post<Record<string, any>>(baseA, "/api/runs", { task: "recover cost" });
    const live = await waitTerminal(baseA, started.body.run_id);
    assert.equal(live.status, "completed");
    assert.ok(live.cost);
    const liveCost = live.cost as RunCost;
    await first.close();

    // same config after the restart → the recomputation matches the live record
    const second = createServer(options);
    const serverB = await second.listen("127.0.0.1", 0);
    const baseB = `http://127.0.0.1:${(serverB.address() as AddressInfo).port}`;
    try {
      const recovered = await get<Record<string, any>>(baseB, `/api/runs/${started.body.run_id}`);
      assert.equal(recovered.status, 200);
      assert.equal(recovered.body.rebuilt, true);
      assert.deepEqual(recovered.body.usage, live.usage);
      assert.deepEqual(recovered.body.cost, live.cost);
    } finally {
      await second.close();
    }

    // A model change between the run and the read can change the estimate (the
    // persisted usage counters are never rewritten) — documented behavior.
    const third = createServer({
      ...options,
      configFactory: mockConfig({ seniorModel: "gpt-4o-mini", juniorModel: "gpt-4o-mini" }),
    });
    const serverC = await third.listen("127.0.0.1", 0);
    const baseC = `http://127.0.0.1:${(serverC.address() as AddressInfo).port}`;
    try {
      const repriced = await get<Record<string, any>>(baseC, `/api/runs/${started.body.run_id}`);
      assert.deepEqual(repriced.body.usage, live.usage);
      assert.equal(repriced.body.cost.model, "gpt-4o-mini");
      assert.notEqual(repriced.body.cost.total, liveCost.total);
    } finally {
      await third.close();
    }
  } finally {
    tmp.cleanup();
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
// Approval scope: once | session ("always allow for this session")
// ---------------------------------------------------------------------------

/** A mock junior scripted for one workspace write + its deliverable. */
function writeDeliverableScript(): MockScriptStep[] {
  return [
    { tool: "workspace_write_file", args: { path: "hello.txt", content: "hello content" } },
    {
      text: JSON.stringify({
        result: "the hello file is written",
        artifacts: ["hello.txt"],
        confidence: 0.8,
      }),
    },
  ];
}

test("approval route: strict scope validation, one-shot default, unknown ids", async () => {
  const srv = await startServer({
    providerOverrides: { junior: new MockProvider(writeDeliverableScript()) },
  });
  const wsDir = tmpdir("tb-approval-scope-");
  try {
    const ws = await post<Record<string, any>>(srv.base, "/api/workspaces", {
      path: wsDir.root,
      name: "scope-validation",
    });
    const runId = await startApprovalRun(srv, ws.body.id, "e2e-approval-scope");
    const { events, approval } = await awaitApproval(srv, runId);
    const route = `/api/runs/${runId}/approvals/${approval.approval_id}`;

    // -- invalid bodies never resolve the pending request
    for (const body of [
      { allow: true, scope: "always" },
      { allow: true, scope: 1 },
      { allow: true, scope: {} },
      { allow: false, scope: "session" }, // a session deny does not exist
      { allow: "yes" },
    ]) {
      const rejected = await post(srv.base, route, body);
      assert.equal(rejected.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    }
    const stillPending = await get<Record<string, any>>(srv.base, `/api/runs/${runId}/approvals`);
    assert.deepEqual(
      (stillPending.body.pending as Array<Record<string, unknown>>).map((p) => p.approval_id),
      [approval.approval_id],
      "rejected answers leave the approval pending",
    );

    // -- unknown run / approval ids are 404s (and persist nothing)
    assert.equal(
      (await post(srv.base, "/api/runs/no-such-run/approvals/x", { allow: true })).status,
      404,
    );
    assert.equal(
      (await post(srv.base, `/api/runs/${runId}/approvals/no-such-approval`, { allow: true })).status,
      404,
    );
    assert.equal(
      (
        await post(srv.base, `/api/runs/${runId}/approvals/no-such-approval`, {
          allow: true,
          scope: "session",
        })
      ).status,
      404,
      "a session-scope answer for an unknown id persists nothing",
    );

    // -- a failed settings write is a 500 and leaves the approval pending:
    //    the in-memory auto-allow must never run ahead of the persisted list.
    const store = srv.handle.state.settingsStore;
    const realAdd = store.addSessionApproval.bind(store);
    store.addSessionApproval = () => {
      throw new Error("disk full");
    };
    try {
      const failed = await post<Record<string, any>>(srv.base, route, {
        allow: true,
        scope: "session",
      });
      assert.equal(failed.status, 500);
      assert.match(String(failed.body.detail), /persist/);
    } finally {
      store.addSessionApproval = realAdd;
    }
    const afterFailedWrite = await get<Record<string, any>>(srv.base, `/api/runs/${runId}/approvals`);
    assert.deepEqual(
      (afterFailedWrite.body.pending as Array<Record<string, unknown>>).map((p) => p.approval_id),
      [approval.approval_id],
      "the failed session answer did not resolve the request",
    );
    assert.deepEqual(store.readSessionApprovals("e2e-approval-scope.jsonl"), []);

    // -- the old body (no scope) keeps the one-shot behavior, echoed as "once"
    const answer = await post<Record<string, any>>(srv.base, route, { allow: true });
    assert.equal(answer.status, 200);
    assert.deepEqual(Object.keys(answer.body).sort(), ["approval_id", "decision", "scope"]);
    assert.equal(answer.body.decision, "allow");
    assert.equal(answer.body.scope, "once");

    // One-shot never persists anything for later runs.
    assert.deepEqual(store.readSessionApprovals("e2e-approval-scope.jsonl"), []);
    // and an already-answered approval stays a 404
    assert.equal((await post(srv.base, route, { allow: true })).status, 404);

    const rest = await runUntilEnd(srv.base, runId, events.length);
    assert.equal(rest.at(-1)?.status, "completed");
  } finally {
    await srv.close();
    wsDir.cleanup();
  }
});

test("session-scope approval persists first, auto-allows repeats, isolates sessions, survives restart", async () => {
  const sessions = tmpdir("tb-approval-session-");
  const wsDir = tmpdir("tb-approval-session-ws-");
  let srv: RunningServer | null = await startServer({
    sessionsDir: sessions.root,
    providerOverrides: {
      junior: new MockProvider([
        ...writeDeliverableScript(),
        ...writeDeliverableScript(),
        ...writeDeliverableScript(),
      ]),
    },
  });
  try {
    const ws = await post<Record<string, any>>(srv.base, "/api/workspaces", {
      path: wsDir.root,
      name: "session-approval",
    });
    const session = "e2e-session-allow";
    const hello = path.join(wsDir.root, "hello.txt");

    // -- run 1: park, then answer "always allow this session"
    let runId = await startApprovalRun(srv, ws.body.id, session);
    let { events, approval } = await awaitApproval(srv, runId);
    const answer = await post<Record<string, any>>(
      srv.base,
      `/api/runs/${runId}/approvals/${approval.approval_id}`,
      { allow: true, scope: "session" },
    );
    assert.equal(answer.status, 200);
    assert.equal(answer.body.decision, "allow");
    assert.equal(answer.body.scope, "session");
    let rest = await runUntilEnd(srv.base, runId, events.length);
    assert.equal(rest.at(-1)?.status, "completed");
    assert.equal(fs.readFileSync(hello, "utf-8"), "hello content");

    // Persisted immediately, keyed by the session file; the value is the
    // action + target pair only (no request payload, no secret).
    const pair = "write\u0000hello.txt";
    assert.deepEqual(srv.handle.state.settingsStore.readSessionApprovals(`${session}.jsonl`), [pair]);
    const rawSettings = JSON.parse(
      fs.readFileSync(path.join(sessions.root, "settings.json"), "utf-8"),
    ) as Record<string, unknown>;
    assert.deepEqual(rawSettings.approvals, { [`${session}.jsonl`]: [pair] });

    // -- run 2: identical request in the same session never parks
    fs.rmSync(hello);
    runId = await startApprovalRun(srv, ws.body.id, session);
    const autoEvents = await runUntilEnd(srv.base, runId);
    assert.equal(autoEvents.at(-1)?.status, "completed");
    assert.ok(
      !autoEvents.some((event) => event.type === "approval_requested"),
      "no second prompt for the allowed pair",
    );
    const auto = autoEvents.filter((event) => event.type === "approval_auto_allowed");
    assert.equal(auto.length, 1);
    assert.deepEqual(Object.keys(auto[0]).sort(), ["action", "at", "run_id", "target", "type"]);
    assert.equal(auto[0].action, "write");
    assert.equal(auto[0].target, "hello.txt");
    assert.equal(fs.readFileSync(hello, "utf-8"), "hello content");

    // -- cross-session: the allow is per session, a different session asks
    runId = await startApprovalRun(srv, ws.body.id, "e2e-session-other");
    ({ events, approval } = await awaitApproval(srv, runId));
    assert.equal(approval.action, "write");
    assert.equal(approval.target, "hello.txt");
    const denied = await post(srv.base, `/api/runs/${runId}/approvals/${approval.approval_id}`, {
      allow: false,
    });
    assert.equal(denied.status, 200);
    rest = await runUntilEnd(srv.base, runId, events.length);
    assert.equal(rest.at(-1)?.type, "run_end");
    assert.deepEqual(
      srv.handle.state.settingsStore.readSessionApprovals("e2e-session-other.jsonl"),
      [],
      "another session's answer never writes this session's allow list",
    );

    // -- survive a backend restart against the same sessions directory
    const before = srv.handle.state.settingsStore.readSessionApprovals(`${session}.jsonl`);
    assert.deepEqual(before, [pair]);
    await srv.close();
    srv = null;
    srv = await startServer({ sessionsDir: sessions.root });
    assert.deepEqual(
      srv.handle.state.settingsStore.readSessionApprovals(`${session}.jsonl`),
      before,
    );
  } finally {
    if (srv !== null) await srv.close();
    sessions.cleanup();
    wsDir.cleanup();
  }
});

test("deleting a session clears its persisted session allows and keeps other sections", async () => {
  const srv = await startServer();
  try {
    const store = srv.handle.state.settingsStore;
    store.write({ senior: { model: "kept-model" } }, ["notes"]);
    store.addSessionApproval("gone.jsonl", "write\u0000hello.txt");
    store.addSessionApproval("kept.jsonl", "shell\u0000echo hi");
    // The delete route requires an existing session file.
    fs.writeFileSync(path.join(srv.dir, "gone.jsonl"), "");

    const deleted = await api<Record<string, unknown>>(
      srv.base,
      "DELETE",
      "/api/sessions/gone.jsonl",
    );
    assert.equal(deleted.status, 200);
    assert.deepEqual(store.readSessionApprovals("gone.jsonl"), []);
    assert.deepEqual(store.readSessionApprovals("kept.jsonl"), ["shell\u0000echo hi"]);
    // The clear is a normal settings write: every other section survives.
    assert.deepEqual(store.readPlugins(), ["notes"]);
    assert.equal(store.read().senior?.model, "kept-model");
    // The settings API stays secret-free and does not expose the allow lists.
    const view = await get<Record<string, unknown>>(srv.base, "/api/settings");
    assert.equal("approvals" in view.body, false);
  } finally {
    await srv.close();
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

test("provider presets: context_window round-trips, validates and clears", async () => {
  const srv = await startServer();
  try {
    const created = await post<Record<string, any>>(srv.base, "/api/providers", {
      name: "Windowed",
      base_url: "http://127.0.0.1:1234/v1",
      context_window: 8192,
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.provider.context_window, 8192);

    // GET exposes the window; seed rows that never set one omit the field, so
    // the old response shape stays byte-compatible.
    const list = (await get<Record<string, any>>(srv.base, "/api/providers")).body
      .providers as Array<Record<string, any>>;
    assert.equal(list.find((preset) => preset.name === "Windowed")?.context_window, 8192);
    assert.ok(
      !("context_window" in (list.find((preset) => preset.name === "openai") ?? {})),
      "a preset without a window keeps the old shape",
    );

    // omitting the field keeps it; sending a new value updates it
    const kept = await api<Record<string, any>>(srv.base, "PUT", "/api/providers/Windowed", {
      models: ["m"],
    });
    assert.equal(kept.status, 200);
    assert.equal(kept.body.provider.context_window, 8192);
    const changed = await api<Record<string, any>>(srv.base, "PUT", "/api/providers/Windowed", {
      context_window: 16384,
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.provider.context_window, 16384);

    // invalid values are 400s and never touch the stored window
    for (const bad of [-1, 1.5, "8192", true, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(
        (
          await api(srv.base, "PUT", "/api/providers/Windowed", {
            context_window: bad,
          })
        ).status,
        400,
        `PUT context_window=${String(bad)}`,
      );
      assert.equal(
        (
          await post(srv.base, "/api/providers", {
            name: `bad-${String(bad).replace(/[^a-z0-9]/gi, "")}`,
            base_url: "http://127.0.0.1:9/v1",
            context_window: bad,
          })
        ).status,
        400,
        `POST context_window=${String(bad)}`,
      );
    }
    const afterBad = (await get<Record<string, any>>(srv.base, "/api/providers")).body
      .providers as Array<Record<string, any>>;
    assert.equal(afterBad.find((preset) => preset.name === "Windowed")?.context_window, 16384);

    // 0 clears the window (unknown == absent)
    const cleared = await api<Record<string, any>>(srv.base, "PUT", "/api/providers/Windowed", {
      context_window: 0,
    });
    assert.equal(cleared.status, 200);
    assert.ok(!("context_window" in cleared.body.provider));
    const afterClear = (await get<Record<string, any>>(srv.base, "/api/providers")).body
      .providers as Array<Record<string, any>>;
    assert.ok(!("context_window" in (afterClear.find((preset) => preset.name === "Windowed") ?? {})));
  } finally {
    await srv.close();
  }
});

test("provider presets: GET exposes additive seed/customized flags", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-provider-flags-"));
  try {
    const first = await startServer({ sessionsDir: dir });
    try {
      // Fresh server: every listed row is an untouched seed, and the two flags
      // are appended after the existing fields (order and values unchanged).
      const seeded = (await get<Record<string, any>>(first.base, "/api/providers")).body
        .providers as Array<Record<string, any>>;
      const openai = seeded.find((preset) => preset.name === "openai");
      assert.ok(openai);
      assert.deepEqual(Object.keys(openai), [
        "name",
        "base_url",
        "api_key_set",
        "kind",
        "models",
        "seed",
        "customized",
      ]);
      assert.equal(openai.seed, true);
      assert.equal(openai.customized, false);
      assert.equal(seeded.find((preset) => preset.name === "custom")?.seed, true);
      assert.equal(seeded.find((preset) => preset.name === "custom")?.customized, false);

      // A POST-created provider is not a seed; its key is masked, never echoed.
      const created = await post<Record<string, any>>(first.base, "/api/providers", {
        name: "Mine",
        base_url: "http://127.0.0.1:5555/v1",
        api_key: "provider-secret",
        models: ["m1"],
      });
      assert.equal(created.status, 201);
      const withCustom = (await get<Record<string, any>>(first.base, "/api/providers")).body
        .providers as Array<Record<string, any>>;
      const mine = withCustom.find((preset) => preset.name === "Mine");
      assert.ok(mine);
      assert.equal(mine.seed, false);
      assert.equal(mine.customized, true);
      assert.equal(mine.api_key_set, true);
      assert.ok(!JSON.stringify(withCustom).includes("provider-secret"));

      // PUT-editing a seed materializes a stored override: still a seed row,
      // now customized, and the edited values win in place.
      const edited = await api<Record<string, any>>(
        first.base,
        "PUT",
        "/api/providers/DeepSeek",
        { base_url: "https://proxy.example/v1", models: ["deepseek-chat"] },
      );
      assert.equal(edited.status, 200);
      const afterEdit = (await get<Record<string, any>>(first.base, "/api/providers")).body
        .providers as Array<Record<string, any>>;
      const deepseek = afterEdit.find((preset) => preset.name === "deepseek");
      assert.ok(deepseek);
      assert.equal(deepseek.seed, true);
      assert.equal(deepseek.customized, true);
      assert.equal(deepseek.base_url, "https://proxy.example/v1");
      assert.deepEqual(deepseek.models, ["deepseek-chat"]);
      assert.equal(
        afterEdit.filter((preset) => preset.name.toLowerCase() === "deepseek").length,
        1,
        "the override replaces the seed row instead of duplicating it",
      );
    } finally {
      await first.close();
    }

    // The stored override survives a restart over the same sessions directory.
    const second = await startServer({ sessionsDir: dir });
    try {
      const restarted = (await get<Record<string, any>>(second.base, "/api/providers")).body
        .providers as Array<Record<string, any>>;
      const deepseek = restarted.find((preset) => preset.name === "deepseek");
      assert.ok(deepseek);
      assert.equal(deepseek.seed, true);
      assert.equal(deepseek.customized, true);
      assert.equal(deepseek.base_url, "https://proxy.example/v1");
      assert.deepEqual(deepseek.models, ["deepseek-chat"]);
      assert.equal(restarted.find((preset) => preset.name === "Mine")?.customized, true);
      assert.equal(restarted.find((preset) => preset.name === "Mine")?.seed, false);

      // Deleting the override restores the pristine seed row (values included).
      assert.equal((await api(second.base, "DELETE", "/api/providers/deepseek")).status, 200);
      const restored = (await get<Record<string, any>>(second.base, "/api/providers")).body
        .providers as Array<Record<string, any>>;
      const seedAgain = restored.find((preset) => preset.name === "deepseek");
      assert.ok(seedAgain);
      assert.equal(seedAgain.seed, true);
      assert.equal(seedAgain.customized, false);
      assert.equal(seedAgain.base_url, "https://api.deepseek.com/v1");
      assert.deepEqual(seedAgain.models, ["deepseek-chat", "deepseek-reasoner"]);

      // Deleting the custom provider removes the row entirely.
      assert.equal((await api(second.base, "DELETE", "/api/providers/mine")).status, 200);
      const final = (await get<Record<string, any>>(second.base, "/api/providers")).body
        .providers as Array<Record<string, any>>;
      assert.ok(!final.some((preset) => preset.name === "Mine"));
      assert.ok(
        final.every((preset) => preset.customized === false),
        "only pristine seed rows remain",
      );
    } finally {
      await second.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("provider presets: reset restores the canonical seed and preserves refs/settings/plugins", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-provider-reset-"));
  const savedEnvKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "reset-env-secret";
  const canonical = {
    name: "deepseek",
    base_url: "https://api.deepseek.com/v1",
    api_key_set: true,
    kind: "openai-compatible",
    models: ["deepseek-chat", "deepseek-reasoner"],
    seed: true,
    customized: false,
  };
  let expectedSettings: Record<string, any> = {};
  let expectedNames: string[] = [];
  try {
    const first = await startServer({ sessionsDir: dir });
    try {
      const initial = await get<Record<string, any>>(first.base, "/api/providers");
      assert.equal(initial.status, 200);
      const seeded = initial.body.providers as Array<Record<string, any>>;
      const seedNames = seeded.map((preset) => preset.name);
      assert.deepEqual(seeded.find((preset) => preset.name === "deepseek"), canonical);

      const unrelated = await post<Record<string, any>>(first.base, "/api/providers", {
        name: "Unrelated",
        base_url: "http://127.0.0.1:5555/v1",
        api_key: "unrelated-provider-secret",
        models: ["unrelated-model"],
      });
      assert.equal(unrelated.status, 201);
      const configured = await api<Record<string, any>>(first.base, "PUT", "/api/settings", {
        senior: {
          provider: "mock",
          model: "senior-before-reset",
          base_url: "http://127.0.0.1:6001/v1",
          api_key: "senior-role-secret",
          provider_ref: "deepseek",
        },
        junior: {
          provider: "mock",
          model: "junior-before-reset",
          provider_ref: "deepseek",
        },
        plugins: ["notes"],
      });
      assert.equal(configured.status, 200);
      expectedSettings = configured.body;
      assert.equal(expectedSettings.senior.provider_ref, "deepseek");
      assert.equal(expectedSettings.junior.provider_ref, "deepseek");
      // GET adds the additive schema view on top of the PUT response shape.
      expectedSettings.schema = { version: 1, supported: 1, writable: true };

      const customized = await api<Record<string, any>>(first.base, "PUT", "/api/providers/deepseek", {
        base_url: "https://proxy.example/v1",
        api_key: "reset-override-secret",
        kind: "anthropic",
        models: ["proxy-model", "proxy-model-2"],
      });
      assert.equal(customized.status, 200);
      assert.equal(customized.body.provider.api_key_set, true);

      // Legacy files may contain more than one case-variant override. Reset
      // must remove all of them, not merely the row that currently wins.
      const stored = first.handle.state.settingsStore.readProviders();
      const override = stored.find((preset) => preset.name.toLowerCase() === "deepseek");
      assert.ok(override);
      first.handle.state.settingsStore.write(first.handle.state.settings.snapshot(), undefined, [
        ...stored,
        { ...override, name: "DeepSeek", api_key: "" },
        {
          ...override,
          name: "DEEPSEEK",
          base_url: "https://legacy.example/v1",
          api_key: "",
          models: ["legacy-model"],
        },
      ]);

      const reset = await post<Record<string, any>>(first.base, "/api/providers/DeepSeek/reset");
      assert.equal(reset.status, 200);
      assert.deepEqual(reset.body, { provider: canonical });
      assert.deepEqual(Object.keys(reset.body), ["provider"]);
      assert.deepEqual(Object.keys(reset.body.provider), [
        "name",
        "base_url",
        "api_key_set",
        "kind",
        "models",
        "seed",
        "customized",
      ]);
      const serializedReset = JSON.stringify(reset.body);
      for (const secret of ["reset-env-secret", "reset-override-secret"]) {
        assert.ok(!serializedReset.includes(secret), "reset response must not contain key material");
      }

      // Both role refs survive in memory and through the public settings view.
      assert.equal(first.handle.state.settings.public().senior.provider_ref, "deepseek");
      assert.equal(first.handle.state.settings.public().junior.provider_ref, "deepseek");
      const settingsAfter = await get<Record<string, any>>(first.base, "/api/settings");
      assert.deepEqual(settingsAfter.body, expectedSettings);

      const onDisk = fs.readFileSync(path.join(dir, "settings.json"), "utf-8");
      for (const secret of [
        "reset-env-secret",
        "reset-override-secret",
        "unrelated-provider-secret",
        "senior-role-secret",
      ]) {
        assert.ok(!onDisk.includes(secret), "settings.json must not contain plaintext key material");
      }
      const raw = JSON.parse(onDisk) as Record<string, any>;
      assert.equal(raw.senior.provider_ref, "deepseek");
      assert.equal(raw.junior.provider_ref, "deepseek");
      assert.deepEqual(raw.plugins, ["notes"]);
      const rawProviders = raw.providers as Array<Record<string, any>>;
      assert.ok(!rawProviders.some((preset) => preset.name.toLowerCase() === "deepseek"));
      assert.equal(rawProviders.filter((preset) => preset.name === "Unrelated").length, 1);
      assert.equal(rawProviders[0].base_url, "http://127.0.0.1:5555/v1");

      const listed = await get<Record<string, any>>(first.base, "/api/providers");
      const providers = listed.body.providers as Array<Record<string, any>>;
      expectedNames = [...seedNames, "Unrelated"];
      assert.deepEqual(providers.map((preset) => preset.name), expectedNames);
      assert.deepEqual(providers.find((preset) => preset.name === "deepseek"), canonical);
      assert.deepEqual(providers.find((preset) => preset.name === "Unrelated"), {
        name: "Unrelated",
        base_url: "http://127.0.0.1:5555/v1",
        api_key_set: true,
        kind: "openai-compatible",
        models: ["unrelated-model"],
        seed: false,
        customized: true,
      });
    } finally {
      await first.close();
    }

    // A fresh server over the same directory sees the pristine seed and the
    // unchanged role refs/settings; no canonical seed override was persisted.
    const second = await startServer({ sessionsDir: dir });
    try {
      const restartedSettings = await get<Record<string, any>>(second.base, "/api/settings");
      assert.deepEqual(restartedSettings.body, expectedSettings);
      assert.equal(second.handle.state.settings.public().senior.provider_ref, "deepseek");
      assert.equal(second.handle.state.settings.public().junior.provider_ref, "deepseek");
      const restarted = await get<Record<string, any>>(second.base, "/api/providers");
      const providers = restarted.body.providers as Array<Record<string, any>>;
      assert.deepEqual(providers.map((preset) => preset.name), expectedNames);
      assert.deepEqual(providers.find((preset) => preset.name === "deepseek"), canonical);
    } finally {
      await second.close();
    }
  } finally {
    if (savedEnvKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = savedEnvKey;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("provider presets: reset errors are stable and DELETE semantics are unchanged", async () => {
  const srv = await startServer();
  try {
    const pristine = await post<Record<string, any>>(srv.base, "/api/providers/openai/reset");
    assert.equal(pristine.status, 409);
    assert.deepEqual(pristine.body, { detail: "provider is not customized: openai" });

    const unknown = await post<Record<string, any>>(srv.base, "/api/providers/Ghost/reset");
    assert.equal(unknown.status, 404);
    assert.deepEqual(unknown.body, { detail: "not found" });

    const created = await post<Record<string, any>>(srv.base, "/api/providers", {
      name: "Mine",
      base_url: "http://127.0.0.1:5555/v1",
    });
    assert.equal(created.status, 201);
    const nonSeed = await post<Record<string, any>>(srv.base, "/api/providers/mine/reset");
    assert.equal(nonSeed.status, 400);
    assert.deepEqual(nonSeed.body, { detail: "only built-in provider presets can be reset: mine" });

    // A failed reset does not remove a custom provider or change DELETE's
    // existing custom-provider ref clearing behavior.
    assert.equal(
      (await api(srv.base, "PUT", "/api/settings", { senior: { provider_ref: "Mine" } })).status,
      200,
    );
    const removedCustom = await api<Record<string, any>>(srv.base, "DELETE", "/api/providers/mine");
    assert.equal(removedCustom.status, 200);
    assert.deepEqual(removedCustom.body, { removed: "mine" });
    assert.equal((await get<Record<string, any>>(srv.base, "/api/settings")).body.senior.provider_ref, null);

    // DELETE of a seed override still restores the seed and clears refs; the
    // new reset route is the non-destructive operation that preserves them.
    assert.equal(
      (await api(srv.base, "PUT", "/api/providers/openai", { base_url: "https://proxy.example/v1" })).status,
      200,
    );
    assert.equal(
      (await api(srv.base, "PUT", "/api/settings", { senior: { provider_ref: "openai" } })).status,
      200,
    );
    const removedOverride = await api<Record<string, any>>(srv.base, "DELETE", "/api/providers/OpenAI");
    assert.equal(removedOverride.status, 200);
    assert.deepEqual(removedOverride.body, { removed: "OpenAI" });
    assert.equal((await get<Record<string, any>>(srv.base, "/api/settings")).body.senior.provider_ref, null);
    const providers = (await get<Record<string, any>>(srv.base, "/api/providers")).body
      .providers as Array<Record<string, any>>;
    const openai = providers.find((preset) => preset.name === "openai");
    assert.equal(openai?.base_url, "https://api.openai.com/v1");
    assert.equal(openai?.seed, true);
    assert.equal(openai?.customized, false);
    assert.equal((await api(srv.base, "DELETE", "/api/providers/Ghost")).status, 404);
  } finally {
    await srv.close();
  }
});

test("provider presets: reset clears a literal stored key and reports the env-backed key as unset", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-provider-reset-env-"));
  // Env isolation: the deepseek seed resolves DEEPSEEK_API_KEY at use time, so
  // the variable must be absent for this test only (restored in the finally).
  const savedEnvKey = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  const literalSecret = "reset-literal-secret";
  const canonical = {
    name: "deepseek",
    base_url: "https://api.deepseek.com/v1",
    api_key_set: false,
    kind: "openai-compatible",
    models: ["deepseek-chat", "deepseek-reasoner"],
    seed: true,
    customized: false,
  };
  try {
    const first = await startServer({ sessionsDir: dir });
    try {
      // A literal stored key on the seed override reports as set even though
      // the seed's env-backed key is absent.
      const customized = await api<Record<string, any>>(
        first.base,
        "PUT",
        "/api/providers/deepseek",
        {
          base_url: "https://proxy.example/v1",
          api_key: literalSecret,
          models: ["proxy-model"],
        },
      );
      assert.equal(customized.status, 200);
      assert.equal(customized.body.provider.api_key_set, true);
      assert.ok(!JSON.stringify(customized.body).includes(literalSecret));

      const stored = first.handle.state.settingsStore.readProviders();
      assert.equal(
        stored.find((preset) => preset.name.toLowerCase() === "deepseek")?.api_key,
        literalSecret,
        "the literal key is stored (decrypted in memory)",
      );
      const beforeDisk = fs.readFileSync(path.join(dir, "settings.json"), "utf-8");
      assert.ok(!beforeDisk.includes(literalSecret), "settings.json encrypts the stored key");

      const before = await get<Record<string, any>>(first.base, "/api/providers");
      const beforePreset = (before.body.providers as Array<Record<string, any>>).find(
        (preset) => preset.name === "deepseek",
      );
      assert.equal(beforePreset?.api_key_set, true);
      assert.equal(beforePreset?.customized, true);
      assert.ok(!JSON.stringify(before.body).includes(literalSecret));

      const reset = await post<Record<string, any>>(first.base, "/api/providers/DeepSeek/reset");
      assert.equal(reset.status, 200);
      // Back to the canonical seed: no stored key and no env key -> unset.
      assert.deepEqual(reset.body, { provider: canonical });
      assert.equal(reset.body.provider.api_key_set, false);
      assert.ok(
        !JSON.stringify(reset.body).includes(literalSecret),
        "the reset response must not echo key material",
      );

      const after = await get<Record<string, any>>(first.base, "/api/providers");
      const afterPreset = (after.body.providers as Array<Record<string, any>>).find(
        (preset) => preset.name === "deepseek",
      );
      assert.deepEqual(afterPreset, canonical);
      assert.ok(!JSON.stringify(after.body).includes(literalSecret));

      const onDisk = fs.readFileSync(path.join(dir, "settings.json"), "utf-8");
      assert.ok(
        !onDisk.includes(literalSecret),
        "settings.json must not contain plaintext key material",
      );
      const raw = JSON.parse(onDisk) as Record<string, any>;
      assert.deepEqual(raw.providers, [], "the canonical seed is never persisted");
    } finally {
      await first.close();
    }

    // Still unset after a restart: neither the override nor an env key came back.
    const second = await startServer({ sessionsDir: dir });
    try {
      const restarted = await get<Record<string, any>>(second.base, "/api/providers");
      const deepseek = (restarted.body.providers as Array<Record<string, any>>).find(
        (preset) => preset.name === "deepseek",
      );
      assert.deepEqual(deepseek, canonical);
    } finally {
      await second.close();
    }
  } finally {
    if (savedEnvKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = savedEnvKey;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("provider presets: reset preserves options-carrying plugin entries in memory and on disk", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-provider-reset-plugins-"));
  // The store accepts `{path, options}` entries; reset rewrites only the
  // provider section, so the exact entry (options included) must survive.
  const pluginEntry = { path: "notes", options: { foo: 1 } };
  try {
    const first = await startServer({ sessionsDir: dir });
    try {
      const configured = await api<Record<string, any>>(first.base, "PUT", "/api/settings", {
        plugins: [pluginEntry],
      });
      assert.equal(configured.status, 200);
      assert.deepEqual(configured.body.plugins, [pluginEntry]);
      assert.deepEqual(first.handle.state.pluginSelection, [pluginEntry]);

      const customized = await api<Record<string, any>>(
        first.base,
        "PUT",
        "/api/providers/deepseek",
        { base_url: "https://proxy.example/v1", models: ["proxy-model"] },
      );
      assert.equal(customized.status, 200);
      const beforeRaw = JSON.parse(
        fs.readFileSync(path.join(dir, "settings.json"), "utf-8"),
      ) as Record<string, any>;
      assert.deepEqual(beforeRaw.plugins, [pluginEntry]);

      const reset = await post<Record<string, any>>(first.base, "/api/providers/DeepSeek/reset");
      assert.equal(reset.status, 200);
      const resetPreset = reset.body.provider;
      assert.equal(resetPreset.name, "deepseek");
      assert.equal(resetPreset.customized, false);
      assert.equal(resetPreset.base_url, "https://api.deepseek.com/v1");
      assert.deepEqual(resetPreset.models, ["deepseek-chat", "deepseek-reasoner"]);

      // In memory: the manager's selection and the stored list keep the exact
      // options-carrying entry (never flattened to a bare name).
      assert.deepEqual(first.handle.state.pluginSelection, [pluginEntry]);
      assert.deepEqual(first.handle.state.settingsStore.readPlugins(), [pluginEntry]);
      const settingsAfter = await get<Record<string, any>>(first.base, "/api/settings");
      assert.deepEqual(settingsAfter.body.plugins, [pluginEntry]);

      // On disk: the same entry, and the seed override is gone.
      const onDisk = JSON.parse(
        fs.readFileSync(path.join(dir, "settings.json"), "utf-8"),
      ) as Record<string, any>;
      assert.deepEqual(onDisk.plugins, [pluginEntry]);
      assert.ok(
        !(onDisk.providers as Array<Record<string, any>>).some(
          (preset) => preset.name.toLowerCase() === "deepseek",
        ),
      );
    } finally {
      await first.close();
    }

    // The plugin entry also round-trips through a fresh server over the same dir.
    const second = await startServer({ sessionsDir: dir });
    try {
      assert.deepEqual(second.handle.state.settingsStore.readPlugins(), [pluginEntry]);
      assert.deepEqual(second.handle.state.pluginSelection, [pluginEntry]);
      const restarted = await get<Record<string, any>>(second.base, "/api/settings");
      assert.deepEqual(restarted.body.plugins, [pluginEntry]);
      const providers = (await get<Record<string, any>>(second.base, "/api/providers")).body
        .providers as Array<Record<string, any>>;
      const deepseek = providers.find((preset) => preset.name === "deepseek");
      assert.equal(deepseek?.customized, false);
      assert.equal(deepseek?.base_url, "https://api.deepseek.com/v1");
    } finally {
      await second.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Provider model discovery (`POST /api/providers/{name}/discover`)
// ---------------------------------------------------------------------------

interface FakeModelsEndpoint {
  baseUrl: string;
  requests: Array<{ url: string; authorization: string | undefined }>;
  close(): Promise<void>;
}

/**
 * Hermetic OpenAI-compatible `/models` endpoint on a loopback ephemeral port.
 * Records every request so a test can assert which endpoint was probed and
 * which credential header arrived — no real network.
 */
async function startFakeModelsEndpoint(
  handler?: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<FakeModelsEndpoint> {
  const requests: Array<{ url: string; authorization: string | undefined }> = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url ?? "", authorization: req.headers.authorization });
    if (handler) {
      handler(req, res);
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b", owned_by: "org" }] }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

test("provider model discovery: probes the stored endpoint/key and persists nothing", async () => {
  const srv = await startServer();
  const fake = await startFakeModelsEndpoint();
  try {
    const created = await post<Record<string, any>>(srv.base, "/api/providers", {
      name: "LocalLLM",
      base_url: fake.baseUrl,
      api_key: "stored-secret",
      models: ["manual-model"],
    });
    assert.equal(created.status, 201);
    const settingsPath = path.join(srv.dir, "settings.json");
    const settingsBefore = fs.readFileSync(settingsPath, "utf-8");

    // No body at all: the stored base URL + stored key are the probe source.
    const discovered = await post<Record<string, any>>(srv.base, "/api/providers/localllm/discover");
    assert.equal(discovered.status, 200);
    assert.deepEqual(discovered.body.models, [
      { id: "model-a" },
      { id: "model-b", owned_by: "org" },
    ]);
    assert.equal(discovered.body.base_url, fake.baseUrl);
    assert.equal(discovered.body.kind, "openai-compatible");
    // One `GET {base}/models` with the stored key as a Bearer token.
    assert.equal(fake.requests.length, 1);
    assert.equal(fake.requests[0]?.url, "/v1/models");
    assert.equal(fake.requests[0]?.authorization, "Bearer stored-secret");
    // A blank/whitespace typed key is "no replacement": the stored key is used.
    const blankKey = await post<Record<string, any>>(srv.base, "/api/providers/LocalLLM/discover", {
      api_key: "   ",
    });
    assert.equal(blankKey.status, 200);
    assert.equal(fake.requests.length, 2);
    assert.equal(fake.requests[1]?.authorization, "Bearer stored-secret");
    // Trailing slashes do not make it a "different" endpoint: the comparison is
    // trimmed and slash-normalized, so the stored key still applies.
    const slashVariant = await post<Record<string, any>>(
      srv.base,
      "/api/providers/LocalLLM/discover",
      { base_url: `${fake.baseUrl}///` },
    );
    assert.equal(slashVariant.status, 200);
    assert.equal(fake.requests.length, 3);
    assert.equal(fake.requests[2]?.authorization, "Bearer stored-secret");
    // Discovery is not Apply: settings are byte-identical and no key is echoed.
    assert.equal(fs.readFileSync(settingsPath, "utf-8"), settingsBefore);
    assert.ok(!JSON.stringify(discovered.body).includes("stored-secret"));
    const listed = (await get<Record<string, any>>(srv.base, "/api/providers")).body
      .providers as Array<Record<string, any>>;
    const provider = listed.find((entry) => entry.name === "LocalLLM");
    assert.deepEqual(provider?.models, ["manual-model"], "the catalog is never rewritten");
    assert.equal(provider?.base_url, fake.baseUrl);
    assert.equal(provider?.api_key_set, true);
  } finally {
    await fake.close();
    await srv.close();
  }
});

test("provider model discovery: a saved key never goes to a different base URL", async () => {
  const srv = await startServer();
  const storedEndpoint = await startFakeModelsEndpoint();
  const otherEndpoint = await startFakeModelsEndpoint();
  try {
    await post(srv.base, "/api/providers", {
      name: "Mine",
      base_url: storedEndpoint.baseUrl,
      api_key: "stored-secret",
      models: ["keep-me"],
    });
    // Different URL + no typed key: a clear 400, and neither endpoint is
    // contacted — the saved secret cannot leak to another host.
    const refused = await post<Record<string, any>>(srv.base, "/api/providers/Mine/discover", {
      base_url: otherEndpoint.baseUrl,
    });
    assert.equal(refused.status, 400);
    assert.equal(
      refused.body.detail,
      "a typed API key is required when probing a different base URL",
    );
    assert.equal(otherEndpoint.requests.length, 0, "the other endpoint is not contacted");
    assert.equal(storedEndpoint.requests.length, 0);
    assert.ok(!JSON.stringify(refused.body).includes("stored-secret"));
    // The draft catalog is untouched by the refusal.
    const listed = (await get<Record<string, any>>(srv.base, "/api/providers")).body
      .providers as Array<Record<string, any>>;
    assert.deepEqual(listed.find((entry) => entry.name === "Mine")?.models, ["keep-me"]);

    // The typed one-shot key path is unchanged: an explicit key may probe a
    // different URL, and only that endpoint is contacted.
    const typed = await post<Record<string, any>>(srv.base, "/api/providers/Mine/discover", {
      base_url: otherEndpoint.baseUrl,
      api_key: "typed-secret",
    });
    assert.equal(typed.status, 200);
    assert.deepEqual(typed.body.models, [
      { id: "model-a" },
      { id: "model-b", owned_by: "org" },
    ]);
    assert.equal(otherEndpoint.requests.length, 1);
    assert.equal(otherEndpoint.requests[0]?.authorization, "Bearer typed-secret");
    assert.equal(storedEndpoint.requests.length, 0);
    assert.ok(!JSON.stringify(typed.body).includes("typed-secret"));

    // A keyless preset has no stored/env secret to protect, so probing a
    // different base URL stays unauthenticated instead of demanding a key.
    await post(srv.base, "/api/providers", {
      name: "Local",
      base_url: storedEndpoint.baseUrl,
      models: [],
    });
    const keyless = await post<Record<string, any>>(srv.base, "/api/providers/Local/discover", {
      base_url: otherEndpoint.baseUrl,
    });
    assert.equal(keyless.status, 200);
    assert.equal(otherEndpoint.requests.length, 2);
    assert.equal(otherEndpoint.requests[1]?.authorization, undefined);
  } finally {
    await storedEndpoint.close();
    await otherEndpoint.close();
    await srv.close();
  }
});

test("provider model discovery: draft URL and one-shot key are used, never stored or echoed", async () => {
  const srv = await startServer();
  const storedEndpoint = await startFakeModelsEndpoint();
  const draftEndpoint = await startFakeModelsEndpoint((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ models: ["draft-model"] }));
  });
  try {
    const created = await post<Record<string, any>>(srv.base, "/api/providers", {
      name: "Mine",
      base_url: storedEndpoint.baseUrl,
      api_key: "stored-secret",
      models: [],
    });
    assert.equal(created.status, 201);

    const discovered = await post<Record<string, any>>(srv.base, "/api/providers/Mine/discover", {
      base_url: draftEndpoint.baseUrl,
      api_key: "typed-secret",
      kind: "openai-compatible",
    });
    assert.equal(discovered.status, 200);
    assert.deepEqual(discovered.body.models, [{ id: "draft-model" }]);
    assert.equal(discovered.body.base_url, draftEndpoint.baseUrl);
    // The draft endpoint receives the typed one-shot key; the stored endpoint
    // is never contacted.
    assert.equal(draftEndpoint.requests.length, 1);
    assert.equal(draftEndpoint.requests[0]?.authorization, "Bearer typed-secret");
    assert.equal(storedEndpoint.requests.length, 0);
    // Neither the response nor the persisted settings file contains the key.
    assert.ok(!JSON.stringify(discovered.body).includes("typed-secret"));
    const settingsPath = path.join(srv.dir, "settings.json");
    assert.ok(!fs.readFileSync(settingsPath, "utf-8").includes("typed-secret"));
    const listed = (await get<Record<string, any>>(srv.base, "/api/providers")).body
      .providers as Array<Record<string, any>>;
    const provider = listed.find((entry) => entry.name === "Mine");
    assert.equal(provider?.base_url, storedEndpoint.baseUrl, "the stored URL is unchanged");
    assert.equal(provider?.api_key_set, true);
    assert.deepEqual(provider?.models, []);
  } finally {
    await storedEndpoint.close();
    await draftEndpoint.close();
    await srv.close();
  }
});

test("provider model discovery: an empty answer is valid and leaves the catalog untouched", async () => {
  const srv = await startServer();
  const empty = await startFakeModelsEndpoint((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [] }));
  });
  try {
    await post(srv.base, "/api/providers", {
      name: "Empty",
      base_url: empty.baseUrl,
      models: ["keep-me"],
    });
    const discovered = await post<Record<string, any>>(srv.base, "/api/providers/Empty/discover");
    assert.equal(discovered.status, 200);
    assert.deepEqual(discovered.body.models, []);
    assert.equal(discovered.body.base_url, empty.baseUrl);
    // An empty result must never erase the saved catalog (the client decides).
    const listed = (await get<Record<string, any>>(srv.base, "/api/providers")).body
      .providers as Array<Record<string, any>>;
    const provider = listed.find((entry) => entry.name === "Empty");
    assert.deepEqual(provider?.models, ["keep-me"]);
  } finally {
    await empty.close();
    await srv.close();
  }
});

test("provider model discovery: unsupported wire kinds are an honest 400", async () => {
  const srv = await startServer();
  try {
    // Built-in seeds with native wire families: no OpenAI-compatible /models
    // listing exists, so probing is refused BEFORE any request is attempted.
    for (const [name, kind] of [
      ["anthropic", "anthropic"],
      ["gemini", "google"],
    ] as const) {
      const res = await post<Record<string, any>>(srv.base, `/api/providers/${name}/discover`);
      assert.equal(res.status, 400);
      assert.match(String(res.body.detail), /not supported/);
      assert.match(String(res.body.detail), new RegExp(kind));
      assert.match(String(res.body.detail), /openai-compatible\|anthropic\|google/);
    }
    // A draft kind override is checked the same way, even on an OpenAI kind.
    const viaDraft = await post<Record<string, any>>(srv.base, "/api/providers/lmstudio/discover", {
      kind: "anthropic",
    });
    assert.equal(viaDraft.status, 400);
    assert.match(String(viaDraft.body.detail), /not supported for the anthropic provider kind/);
    // An unknown kind value is rejected with the accepted values.
    const unknown = await post<Record<string, any>>(srv.base, "/api/providers/lmstudio/discover", {
      kind: "wat",
    });
    assert.equal(unknown.status, 400);
    assert.match(String(unknown.body.detail), /unknown provider kind: wat/);
    assert.match(String(unknown.body.detail), /openai-compatible\|anthropic\|google/);
  } finally {
    await srv.close();
  }
});

test("provider model discovery: unknown provider 404 and invalid bodies 400", async () => {
  const srv = await startServer();
  try {
    const unknown = await post<Record<string, any>>(srv.base, "/api/providers/Ghost/discover");
    assert.equal(unknown.status, 404);
    assert.deepEqual(unknown.body, { detail: "not found" });

    const typedKey = await post<Record<string, any>>(srv.base, "/api/providers/lmstudio/discover", {
      api_key: 42,
    });
    assert.equal(typedKey.status, 400);
    assert.deepEqual(typedKey.body, { detail: "invalid request body" });

    const kindType = await post<Record<string, any>>(srv.base, "/api/providers/lmstudio/discover", {
      kind: ["anthropic"],
    });
    assert.equal(kindType.status, 400);
    assert.deepEqual(kindType.body, { detail: "invalid request body" });

    const emptyUrl = await post<Record<string, any>>(srv.base, "/api/providers/lmstudio/discover", {
      base_url: "   ",
    });
    assert.equal(emptyUrl.status, 400);
    assert.match(String(emptyUrl.body.detail), /base_url must not be empty/);

    const scheme = await post<Record<string, any>>(srv.base, "/api/providers/lmstudio/discover", {
      base_url: "localhost:1234/v1",
    });
    assert.equal(scheme.status, 400);
    assert.match(String(scheme.body.detail), /must start with http/);

    // Non-object JSON bodies are the generic 400 (readBody contract).
    const arrayBody = await post<Record<string, any>>(srv.base, "/api/providers/lmstudio/discover", []);
    assert.equal(arrayBody.status, 400);
    assert.deepEqual(arrayBody.body, { detail: "invalid request body" });
  } finally {
    await srv.close();
  }
});

test("provider model discovery: upstream failures are a clean 502 with no key material", async () => {
  const srv = await startServer();
  try {
    const http500 = await startFakeModelsEndpoint((_req, res) => {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("boom");
    });
    try {
      await post(srv.base, "/api/providers", {
        name: "Failing",
        base_url: http500.baseUrl,
        api_key: "stored-secret",
      });
      const failed = await post<Record<string, any>>(srv.base, "/api/providers/Failing/discover", {
        api_key: "typed-secret",
      });
      assert.equal(failed.status, 502);
      assert.match(String(failed.body.detail), /model discovery failed/);
      assert.match(String(failed.body.detail), /HTTP 500/);
      assert.ok(!JSON.stringify(failed.body).includes("typed-secret"));
      assert.ok(!JSON.stringify(failed.body).includes("stored-secret"));
    } finally {
      await http500.close();
    }

    const notJson = await startFakeModelsEndpoint((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("definitely not json");
    });
    try {
      const bad = await post<Record<string, any>>(srv.base, "/api/providers/Failing/discover", {
        base_url: notJson.baseUrl,
        // a different endpoint needs an explicit one-shot key (saved-key guard)
        api_key: "typed-secret",
      });
      assert.equal(bad.status, 502);
      assert.match(String(bad.body.detail), /not JSON/);
    } finally {
      await notJson.close();
    }

    const unexpectedShape = await startFakeModelsEndpoint((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ unexpected: true }));
    });
    try {
      const bad = await post<Record<string, any>>(srv.base, "/api/providers/Failing/discover", {
        base_url: unexpectedShape.baseUrl,
        // a different endpoint needs an explicit one-shot key (saved-key guard)
        api_key: "typed-secret",
      });
      assert.equal(bad.status, 502);
      assert.match(String(bad.body.detail), /expected an array/);
    } finally {
      await unexpectedShape.close();
    }

    // A refused connection is an upstream failure too, not a 500.
    const gone = await startFakeModelsEndpoint();
    const goneUrl = gone.baseUrl;
    await gone.close();
    const unreachable = await post<Record<string, any>>(
      srv.base,
      "/api/providers/Failing/discover",
      // a different endpoint needs an explicit one-shot key (saved-key guard)
      { base_url: goneUrl, api_key: "typed-secret" },
    );
    assert.equal(unreachable.status, 502);
    assert.match(String(unreachable.body.detail), /cannot reach/);
  } finally {
    await srv.close();
  }
});

test("provider model discovery: a seed's env-backed key is resolved server-side", async () => {
  const srv = await startServer();
  const fake = await startFakeModelsEndpoint();
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "env-openai-secret";
  try {
    // Materialize the override (the seed itself is never persisted), then probe
    // by the case-insensitive seed name without ever sending a key.
    const customized = await api<Record<string, any>>(srv.base, "PUT", "/api/providers/openai", {
      base_url: fake.baseUrl,
    });
    assert.equal(customized.status, 200);
    assert.equal(customized.body.provider.api_key_set, true);
    const discovered = await post<Record<string, any>>(srv.base, "/api/providers/OpenAI/discover");
    assert.equal(discovered.status, 200);
    assert.equal(fake.requests.length, 1);
    assert.equal(fake.requests[0]?.authorization, "Bearer env-openai-secret");
    assert.ok(!JSON.stringify(discovered.body).includes("env-openai-secret"));
    const settingsPath = path.join(srv.dir, "settings.json");
    assert.ok(!fs.readFileSync(settingsPath, "utf-8").includes("env-openai-secret"));
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
    await fake.close();
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

// ---------------------------------------------------------------------------
// Approval policy (Wave 4, lane C): settings API + run seeding
// ---------------------------------------------------------------------------

test("settings: approval_policy defaults to ask and roundtrips across a restart", async () => {
  const tmp = tmpdir("tb-approval-policy-");
  try {
    const srv = await startServer({ sessionsDir: tmp.root });
    const initial = await get<Record<string, any>>(srv.base, "/api/settings");
    assert.equal(initial.status, 200);
    assert.deepEqual(initial.body.approval_policy, { mode: "ask", pinned: false });
    // reading never writes a settings file
    assert.equal(fs.existsSync(path.join(tmp.root, "settings.json")), false);

    const put = await api<Record<string, any>>(srv.base, "PUT", "/api/settings", {
      approval_policy: { mode: "readonly" },
    });
    assert.equal(put.status, 200);
    assert.deepEqual(put.body.approval_policy, { mode: "readonly", pinned: false });
    // the additive section rides the same PUT as the role settings
    assert.equal(put.body.senior.provider, null);
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(tmp.root, "settings.json"), "utf-8"),
    ) as Record<string, unknown>;
    assert.deepEqual(onDisk.approval_policy, { mode: "readonly" });
    assert.ok(!JSON.stringify(onDisk).includes("secret"), "the policy section is secret-free");
    await srv.close();

    const restarted = await startServer({ sessionsDir: tmp.root });
    try {
      const after = await get<Record<string, any>>(restarted.base, "/api/settings");
      assert.deepEqual(after.body.approval_policy, { mode: "readonly", pinned: false });
    } finally {
      await restarted.close();
    }
  } finally {
    tmp.cleanup();
  }
});

test("settings: invalid approval_policy bodies are 400s and change nothing", async () => {
  const srv = await startServer();
  try {
    assert.equal(
      (await api(srv.base, "PUT", "/api/settings", { approval_policy: { mode: "edits" } })).status,
      200,
    );
    for (const bad of [
      { approval_policy: { mode: "auto" } },
      { approval_policy: { mode: "ASK" } },
      { approval_policy: { mode: 42 } },
      { approval_policy: { mode: "" } },
      { approval_policy: { mode: null } },
      { approval_policy: {} },
      { approval_policy: "readonly" },
      { approval_policy: null },
      { approval_policy: ["edits"] },
    ]) {
      const res = await api(srv.base, "PUT", "/api/settings", bad);
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
    }
    // neither a bad body nor a body without the section changes the stored mode
    assert.equal(
      (await api(srv.base, "PUT", "/api/settings", { senior: { model: "m-model" } })).status,
      200,
    );
    const after = await get<Record<string, any>>(srv.base, "/api/settings");
    assert.deepEqual(after.body.approval_policy, { mode: "edits", pinned: false });
  } finally {
    await srv.close();
  }
});

test("readonly serve run: the workspace write is denied with no parked approval", async () => {
  const srv = await startServer({
    providerOverrides: { junior: new MockProvider(writeDeliverableScript()) },
  });
  const wsDir = tmpdir("tb-mode-readonly-");
  try {
    assert.equal(
      (await api(srv.base, "PUT", "/api/settings", { approval_policy: { mode: "readonly" } }))
        .status,
      200,
    );
    const ws = await post<Record<string, any>>(srv.base, "/api/workspaces", {
      path: wsDir.root,
      name: "mode-readonly",
    });
    const runId = await startApprovalRun(srv, ws.body.id, "mode-readonly-run");
    const events = await runUntilEnd(srv.base, runId);
    assert.equal(events.at(-1)?.type, "run_end");
    assert.equal(events.at(-1)?.status, "completed", "the run finishes, it never parks");
    assert.equal(
      events.filter((event) => event.type === "approval_requested").length,
      0,
      "readonly never asks the operator",
    );
    assert.equal(
      events.filter((event) => event.type === "run_status" && event.status === "waiting").length,
      0,
    );
    const completed = events
      .filter((event) => event.type === "tool_completed")
      .map((event) => [event.tool, event.status]);
    assert.ok(
      completed.some(([tool, status]) => tool === "workspace_write_file" && status === "denied"),
      `expected a denied write, got ${JSON.stringify(completed)}`,
    );
    assert.equal(fs.existsSync(path.join(wsDir.root, "hello.txt")), false);
  } finally {
    await srv.close();
    wsDir.cleanup();
  }
});

test("allow-all serve run: the workspace write proceeds without any approval", async () => {
  const srv = await startServer({
    providerOverrides: { junior: new MockProvider(writeDeliverableScript()) },
  });
  const wsDir = tmpdir("tb-mode-allow-all-");
  try {
    assert.equal(
      (await api(srv.base, "PUT", "/api/settings", { approval_policy: { mode: "allow-all" } }))
        .status,
      200,
    );
    const ws = await post<Record<string, any>>(srv.base, "/api/workspaces", {
      path: wsDir.root,
      name: "mode-allow-all",
    });
    const runId = await startApprovalRun(srv, ws.body.id, "mode-allow-all-run");
    const events = await runUntilEnd(srv.base, runId);
    assert.equal(events.at(-1)?.status, "completed");
    assert.equal(events.filter((event) => event.type === "approval_requested").length, 0);
    const completed = events
      .filter((event) => event.type === "tool_completed")
      .map((event) => [event.tool, event.status]);
    assert.ok(
      completed.some(([tool, status]) => tool === "workspace_write_file" && status === "ok"),
      `expected an ok write, got ${JSON.stringify(completed)}`,
    );
    assert.equal(fs.readFileSync(path.join(wsDir.root, "hello.txt"), "utf-8"), "hello content");
  } finally {
    await srv.close();
    wsDir.cleanup();
  }
});

test("default ask serve run still parks: an explicit ask policy keeps the operator in the loop", async () => {
  const srv = await startServer({
    providerOverrides: { junior: new MockProvider(writeDeliverableScript()) },
  });
  const wsDir = tmpdir("tb-mode-ask-");
  try {
    assert.equal(
      (await api(srv.base, "PUT", "/api/settings", { approval_policy: { mode: "ask" } })).status,
      200,
    );
    const ws = await post<Record<string, any>>(srv.base, "/api/workspaces", {
      path: wsDir.root,
      name: "mode-ask",
    });
    const runId = await startApprovalRun(srv, ws.body.id, "mode-ask-run");
    const { events, approval } = await awaitApproval(srv, runId);
    assert.equal(approval.action, "write");
    assert.equal(approval.target, "hello.txt");
    const answer = await api<Record<string, unknown>>(
      srv.base,
      "POST",
      `/api/runs/${runId}/approvals/${approval.approval_id}`,
      { allow: true },
    );
    assert.equal(answer.status, 200);
    const rest = await runUntilEnd(srv.base, runId, events.length);
    assert.equal(rest.at(-1)?.status, "completed");
    assert.equal(fs.readFileSync(path.join(wsDir.root, "hello.txt"), "utf-8"), "hello content");
  } finally {
    await srv.close();
    wsDir.cleanup();
  }
});

test("a pinned server approval mode wins over the persisted setting and is never persisted", async () => {
  // No flag/env reaches settings.json: the pin lives only in ServerOptions.
  const srv = await startServer({
    approvalPolicy: "readonly",
    providerOverrides: { junior: new MockProvider(writeDeliverableScript()) },
  });
  const wsDir = tmpdir("tb-mode-pinned-");
  try {
    const view = await get<Record<string, any>>(srv.base, "/api/settings");
    assert.deepEqual(view.body.approval_policy, { mode: "readonly", pinned: true });
    // An operator save is stored but cannot unpin the running server.
    const put = await api<Record<string, any>>(srv.base, "PUT", "/api/settings", {
      approval_policy: { mode: "allow-all" },
    });
    assert.equal(put.status, 200);
    assert.deepEqual(put.body.approval_policy, { mode: "readonly", pinned: true });
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(srv.dir, "settings.json"), "utf-8"),
    ) as Record<string, unknown>;
    assert.deepEqual(onDisk.approval_policy, { mode: "allow-all" }, "the save is persisted");
    // ... and the pinned readonly still denies the write.
    const ws = await post<Record<string, any>>(srv.base, "/api/workspaces", {
      path: wsDir.root,
      name: "mode-pinned",
    });
    const runId = await startApprovalRun(srv, ws.body.id, "mode-pinned-run");
    const events = await runUntilEnd(srv.base, runId);
    assert.equal(events.at(-1)?.status, "completed");
    assert.equal(events.filter((event) => event.type === "approval_requested").length, 0);
    assert.equal(fs.existsSync(path.join(wsDir.root, "hello.txt")), false);
  } finally {
    await srv.close();
    wsDir.cleanup();
  }
});
