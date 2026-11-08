/**
 * Server integration over a migrated (directory) session store.
 *
 * Hermetic: an in-process server on an ephemeral port, the mock provider, a
 * temp sessions root with `.layout.json` set to `dirs`, and one seeded
 * workspace. Verifies the writer, sidecars, listing, fork and restart recovery
 * all follow `<project>/<session>/session.jsonl`.
 *
 * Run with: node --test tests/serverlayout.test.ts
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { resolveConfig } from "../src/config.ts";
import {
  createServer,
  type ServerHandle,
  type ServerOptions,
} from "../src/server.ts";
import { projectKeyFor, SessionLayout } from "../src/sessionlayout.ts";

interface RunningServer {
  base: string;
  handle: ServerHandle;
  close(): Promise<void>;
}

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

async function startServer(dir: string, workspacePath: string): Promise<RunningServer> {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "workspaces.json"),
    JSON.stringify({
      workspaces: [{ id: "ws-1", name: "Workspace", path: workspacePath }],
    }),
    "utf-8",
  );
  const options: ServerOptions = {
    configFactory: () => resolveConfig({ provider: "mock", mode: "consult" }),
    sessionsDir: dir,
    webDist: null,
    commandsDirs: [],
    pluginsDir: path.join(dir, "missing-plugins"),
  };
  const handle = createServer(options);
  const server = await handle.listen("127.0.0.1", 0);
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    handle,
    close: async () => {
      await handle.close();
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

async function waitTerminal(
  base: string,
  runId: string,
  timeoutMs = 15000,
): Promise<Record<string, any>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const record = (await api<Record<string, any>>(base, "GET", `/api/runs/${runId}`)).body;
    if (["completed", "failed", "cancelled"].includes(String(record.status))) return record;
    if (Date.now() > deadline) throw new Error(`run ${runId} did not finish in time`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("dirs store: create, run, sidecars, list, fork and restart recovery", async () => {
  const root = tmpdir("tb-server-layout-");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "note.txt"), "hello", "utf-8");
  const sessionsDir = path.join(root, "sessions");
  const layout = new SessionLayout(sessionsDir);
  layout.setMode("dirs");
  const key = projectKeyFor(workspace);
  let server: RunningServer | null = null;
  try {
    server = await startServer(sessionsDir, workspace);

    const created = await api<{ name: string; title: string }>(
      server.base,
      "POST",
      "/api/sessions",
      { title: "Created", workspace_id: "ws-1" },
    );
    assert.equal(created.status, 201);
    const createdDir = path.join(sessionsDir, key, created.body.name.replace(/\.jsonl$/, ""));
    assert.equal(fs.existsSync(path.join(createdDir, "session.jsonl")), true);
    const createdMeta = JSON.parse(fs.readFileSync(path.join(createdDir, "meta.json"), "utf-8"));
    assert.equal(createdMeta.title, "Created");
    assert.equal(createdMeta.workspace_id, "ws-1");

    const started = await api<{ run_id: string; session: string; status: string }>(
      server.base,
      "POST",
      "/api/runs",
      { task: "Plan the storage migration", workspace_id: "ws-1" },
    );
    assert.equal(started.status, 202);
    const finished = await waitTerminal(server.base, started.body.run_id);
    assert.equal(finished.status, "completed");

    const name = started.body.session;
    const location = layout.resolve(name);
    assert.ok(location);
    assert.equal(location.projectKey, key);
    assert.ok(location.dir);
    assert.equal(fs.existsSync(location.sessionPath), true);
    assert.equal(fs.existsSync(path.join(location.dir!, "events.jsonl")), true);
    assert.equal(fs.existsSync(path.join(sessionsDir, "runtime")), false);

    const list = await api<Array<Record<string, any>>>(server.base, "GET", "/api/sessions");
    assert.equal(list.status, 200);
    assert.ok(list.body.some((item) => item.name === name));
    assert.ok(list.body.some((item) => item.name === created.body.name));

    const forked = await api<{ name: string; title: string }>(
      server.base,
      "POST",
      `/api/sessions/${encodeURIComponent(name)}/fork`,
      {},
    );
    assert.equal(forked.status, 201);
    const forkLocation = layout.resolve(forked.body.name);
    assert.ok(forkLocation);
    assert.equal(forkLocation.projectKey, key);
    assert.equal(fs.existsSync(forkLocation.sessionPath), true);
    assert.equal(fs.readFileSync(location.sessionPath, "utf-8").length > 0, true);

    const deleted = await api<{ deleted: string }>(
      server.base,
      "DELETE",
      `/api/sessions/${encodeURIComponent(forked.body.name)}`,
    );
    assert.equal(deleted.status, 200);
    assert.equal(fs.existsSync(forkLocation.dir!), false);

    await server.close();
    server = null;

    // Fresh server over the same store: the run record is rebuilt from the
    // session-directory runtime sidecar.
    server = await startServer(sessionsDir, workspace);
    const recovered = await api<Record<string, any>>(
      server.base,
      "GET",
      `/api/runs/${started.body.run_id}`,
    );
    assert.equal(recovered.status, 200);
    assert.equal(recovered.body.status, "completed");
    assert.equal(recovered.body.session, name);
  } finally {
    if (server !== null) await server.close();
    cleanup(root);
  }
});
