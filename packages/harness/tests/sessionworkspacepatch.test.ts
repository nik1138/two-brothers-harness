/**
 * `PATCH /api/sessions/{name}` can bind (or clear) a session's workspace link.
 *
 * The web needs a way to attach a workspace to an existing session — old
 * sessions created before a workspace was selected, or one whose link was
 * cleared. The route now accepts `{title?, workspace_id?}` (at least one):
 * `title` keeps its historical rename contract, a registered `workspace_id`
 * persists the link, and `workspace_id: null` removes it from the sidecar.
 * Unknown ids are a 400; an unknown session is a 404.
 *
 * Hermetic: mock providers over an in-process server on an ephemeral loopback
 * port; temp sessions/workspace dirs. Run with:
 *   node --test tests/sessionworkspacepatch.test.ts
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { resolveConfig } from "../src/config.ts";
import { MockProvider } from "../src/provider.ts";
import { createServer, type ServerHandle, type ServerOptions } from "../src/server.ts";

function tmpdir(prefix: string): { root: string; cleanup(): void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

interface RunningServer {
  base: string;
  handle: ServerHandle;
  close(): Promise<void>;
}

async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const tmp = tmpdir("tb-session-patch-");
  const handle = createServer({
    configFactory: () => resolveConfig({ provider: "mock", mode: "consult" }),
    webDist: null,
    ...options,
    sessionsDir: options.sessionsDir ? path.resolve(options.sessionsDir) : tmp.root,
  });
  const server = await handle.listen("127.0.0.1", 0);
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    handle,
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
const patch = <T = unknown>(base: string, route: string, body?: unknown) =>
  api<T>(base, "PATCH", route, body);

async function waitTerminal(
  base: string,
  runId: string,
  timeoutMs = 15_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await get<Record<string, unknown>>(base, `/api/runs/${runId}`);
    if (["completed", "failed", "cancelled"].includes(String(body.status))) return body;
    if (Date.now() > deadline) throw new Error(`run ${runId} did not finish in time`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function registerWorkspace(base: string, root: string): Promise<string> {
  const created = await post<Record<string, unknown>>(base, "/api/workspaces", {
    path: root,
    name: "test",
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return String(created.body.id);
}

test("PATCH binds a workspace to an existing session and a later run uses it", async () => {
  const srv = await startServer({
    providerOverrides: {
      junior: new MockProvider([
        { tool: "workspace_list_dir", args: { path: "." } },
        {
          text: JSON.stringify({
            result: "listed the workspace",
            artifacts: ["notes.txt"],
            notes: "",
            confidence: 0.8,
          }),
        },
      ]),
    },
  });
  const ws = tmpdir("tb-session-patch-ws-");
  try {
    fs.writeFileSync(path.join(ws.root, "notes.txt"), "hello");
    const workspaceId = await registerWorkspace(srv.base, ws.root);
    const created = await post<Record<string, unknown>>(srv.base, "/api/sessions", {
      title: "old unbound session",
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const name = String(created.body.name);
    assert.equal("workspace_id" in created.body, false, "the session starts unbound");

    const patched = await patch<Record<string, unknown>>(
      srv.base,
      `/api/sessions/${name}`,
      { workspace_id: workspaceId },
    );
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.workspace_id, workspaceId);

    const detail = await get<Record<string, unknown>>(srv.base, `/api/sessions/${name}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.workspace_id, workspaceId, "the link is persisted");

    // A run that names no workspace now inherits the freshly bound link.
    const started = await post<Record<string, unknown>>(srv.base, "/api/runs", {
      task: "List the files",
      mode: "work",
      provider: "mock",
      session: name,
    });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const record = await waitTerminal(srv.base, String(started.body.run_id));
    assert.equal(record.status, "completed");
  } finally {
    await srv.close();
    ws.cleanup();
  }
});

test("PATCH workspace_id null clears the link (the key is removed)", async () => {
  const srv = await startServer();
  const ws = tmpdir("tb-session-patch-clear-");
  try {
    const workspaceId = await registerWorkspace(srv.base, ws.root);
    const created = await post<Record<string, unknown>>(srv.base, "/api/sessions", {
      title: "clear me",
      workspace_id: workspaceId,
    });
    const name = String(created.body.name);
    assert.equal(created.body.workspace_id, workspaceId);

    const patched = await patch<Record<string, unknown>>(
      srv.base,
      `/api/sessions/${name}`,
      { workspace_id: null },
    );
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal("workspace_id" in patched.body, false);
    const detail = await get<Record<string, unknown>>(srv.base, `/api/sessions/${name}`);
    assert.equal("workspace_id" in detail.body, false);
  } finally {
    await srv.close();
    ws.cleanup();
  }
});

test("PATCH keeps the historical title-only behavior and accepts both fields", async () => {
  const srv = await startServer();
  const ws = tmpdir("tb-session-patch-title-");
  try {
    const workspaceId = await registerWorkspace(srv.base, ws.root);
    const created = await post<Record<string, unknown>>(srv.base, "/api/sessions", {
      title: "forms",
    });
    const name = String(created.body.name);

    const renamed = await patch<Record<string, unknown>>(
      srv.base,
      `/api/sessions/${name}`,
      { title: "renamed session" },
    );
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal(renamed.body.title, "renamed session");
    assert.equal("workspace_id" in renamed.body, false);

    const both = await patch<Record<string, unknown>>(
      srv.base,
      `/api/sessions/${name}`,
      { title: "bound session", workspace_id: workspaceId },
    );
    assert.equal(both.status, 200, JSON.stringify(both.body));
    assert.equal(both.body.title, "bound session");
    assert.equal(both.body.workspace_id, workspaceId);
  } finally {
    await srv.close();
    ws.cleanup();
  }
});

test("PATCH rejects an empty body, a blank/invalid workspace id and an unknown session", async () => {
  const srv = await startServer();
  try {
    const created = await post<Record<string, unknown>>(srv.base, "/api/sessions", {
      title: "validation",
    });
    const name = String(created.body.name);

    for (const [body, expected] of [
      [{}, /provide title or workspace_id/],
      [{ title: "" }, /title must not be empty/],
      [{ workspace_id: "" }, /workspace_id must not be empty/],
      [{ workspace_id: "nope" }, /unknown workspace_id/],
    ] as const) {
      const invalid = await patch<Record<string, unknown>>(
        srv.base,
        `/api/sessions/${name}`,
        body,
      );
      assert.equal(invalid.status, 400, `${JSON.stringify(body)} -> ${invalid.status}`);
      assert.match(String(invalid.body.detail), expected);
    }

    const unknown = await patch<Record<string, unknown>>(
      srv.base,
      "/api/sessions/does-not-exist.jsonl",
      { title: "x" },
    );
    assert.equal(unknown.status, 404);
  } finally {
    await srv.close();
  }
});
