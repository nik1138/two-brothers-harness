/**
 * Security hardening regression tests for the local single-user server and
 * the workspace execution boundary:
 *
 * - cross-origin writes: state-changing requests carrying a non-local
 *   `Origin` (a malicious web page driving the operator's browser) are
 *   refused, while local origins (the web app, the Vite dev proxy on
 *   localhost, same-origin) and non-browser clients (no `Origin`) keep
 *   working;
 * - DNS-rebinding defense: when the server is bound to a loopback address,
 *   requests whose `Host` header is not a loopback name are refused;
 * - session-file confinement: the session CRUD/stream endpoints only address
 *   `*.jsonl` files inside the sessions dir, so `settings.json` /
 *   `workspaces.json` cannot be read or deleted through the session API;
 * - approval fail-closed: a workspace whose permission manager has no broker
 *   denies every mutating action (and shell) instead of allowing it.
 *
 * Hermetic: real HTTP on an ephemeral loopback port, no subprocesses.
 * Run with: node tests/run-all.ts (or node --test tests/).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { resolveConfig, type Config } from "../src/config.ts";
import { PermissionManager } from "../src/permissions.ts";
import { createServer, type ServerHandle } from "../src/server.ts";
import { Workspace } from "../src/workspace.ts";

function removeTempDirSync(root: string): void {
  // Windows can keep a short-lived handle on the directory after a spawned
  // shell exits; Node's rmSync maxRetries does not reliably retry EPERM here,
  // so retry explicitly. Atomics.wait gives a synchronous backoff.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
      return;
    } catch (exc) {
      const code = (exc as NodeJS.ErrnoException).code;
      if (
        attempt === 49 ||
        (code !== "EPERM" && code !== "EBUSY" && code !== "ENOTEMPTY")
      ) {
        throw exc;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

function tmpdir(prefix: string): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { root, cleanup: () => removeTempDirSync(root) };
}

interface RunningServer {
  base: string;
  handle: ServerHandle;
  dir: string;
  close(): Promise<void>;
}

async function startServer(): Promise<RunningServer> {
  const tmp = tmpdir("tb-sec-");
  const handle = createServer({
    configFactory: (): Config => resolveConfig({ provider: "mock", mode: "consult" }),
    webDist: null,
    sessionsDir: tmp.root,
  });
  const server = await handle.listen("127.0.0.1", 0);
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    handle,
    dir: tmp.root,
    close: async () => {
      await handle.close();
      tmp.cleanup();
    },
  };
}

/** Raw request with explicit Host/Origin headers (undici forbids Host). */
function rawRequest(
  port: number,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: options.method ?? "GET",
        path: options.path ?? "/api/settings",
        headers: options.headers ?? {},
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString("utf-8")));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

test("cross-origin POST with a foreign Origin is refused", async () => {
  const srv = await startServer();
  try {
    const port = Number(new URL(srv.base).port);
    const res = await rawRequest(port, {
      method: "POST",
      path: "/api/workspaces",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://evil.example",
        Host: `127.0.0.1:${port}`,
      },
      body: JSON.stringify({ path: srv.dir }),
    });
    assert.equal(res.status, 403);
    // The mutation did not happen either.
    assert.equal(srv.handle.state.workspaces.list().length, 0);
  } finally {
    await srv.close();
  }
});

test("local origins (web app, Vite dev proxy) keep working", async () => {
  const srv = await startServer();
  try {
    const port = Number(new URL(srv.base).port);
    for (const origin of [
      `http://localhost:${port}`,
      `http://127.0.0.1:${port}`,
      `http://localhost:5173`,
      `http://127.0.0.1:5173`,
    ]) {
      const res = await rawRequest(port, {
        method: "POST",
        path: "/api/workspaces",
        headers: { "Content-Type": "application/json", Origin: origin, Host: `127.0.0.1:${port}` },
        body: JSON.stringify({ path: srv.dir }),
      });
      assert.equal(res.status, 201, `origin ${origin} should be accepted`);
      const removed = srv.handle.state.workspaces.remove(
        srv.handle.state.workspaces.list()[0].id,
      );
      assert.equal(removed, true);
    }
  } finally {
    await srv.close();
  }
});

test("requests without an Origin header (CLI tooling) keep working", async () => {
  const srv = await startServer();
  try {
    const port = Number(new URL(srv.base).port);
    const res = await rawRequest(port, {
      method: "POST",
      path: "/api/workspaces",
      headers: { "Content-Type": "application/json", Host: `127.0.0.1:${port}` },
      body: JSON.stringify({ path: srv.dir }),
    });
    assert.equal(res.status, 201);
  } finally {
    await srv.close();
  }
});

test("DNS-rebinding: a non-loopback Host header on a loopback bind is refused", async () => {
  const srv = await startServer();
  try {
    const port = Number(new URL(srv.base).port);
    for (const host of [`attacker.example:${port}`, `192.168.1.50:${port}`]) {
      const res = await rawRequest(port, { path: "/api/settings", headers: { Host: host } });
      assert.equal(res.status, 403, `Host ${host} should be refused`);
    }
    // Loopback Host names still work.
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
      const res = await rawRequest(port, { path: "/api/settings", headers: { Host: host } });
      assert.equal(res.status, 200, `Host ${host} should be accepted`);
    }
  } finally {
    await srv.close();
  }
});

test("session endpoints refuse non-.jsonl names (settings.json is not a session)", async () => {
  const srv = await startServer();
  try {
    // Seed a settings file the way RuntimeSettings persistence does.
    const settingsPath = path.join(srv.dir, "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({ senior: {}, junior: {} }), "utf-8");

    const port = Number(new URL(srv.base).port);
    for (const method of ["GET", "PATCH", "DELETE"]) {
      const res = await rawRequest(port, {
        method,
        path: "/api/sessions/settings.json",
        headers: { "Content-Type": "application/json", Host: `127.0.0.1:${port}` },
        body: method === "GET" ? undefined : JSON.stringify({ title: "x" }),
      });
      assert.equal(res.status, 400, `${method} settings.json should be refused`);
    }
    assert.ok(fs.existsSync(settingsPath), "settings.json must survive the API calls");

    // A real .jsonl session round-trips: create, read, delete.
    const createRes = await rawRequest(port, {
      method: "POST",
      path: "/api/sessions",
      headers: { "Content-Type": "application/json", Host: `127.0.0.1:${port}` },
      body: JSON.stringify({ title: "hello" }),
    });
    assert.equal(createRes.status, 201);
    const name = JSON.parse(createRes.body).name as string;
    assert.ok(name.endsWith(".jsonl"));
    const getRes = await rawRequest(port, {
      path: `/api/sessions/${name}`,
      headers: { Host: `127.0.0.1:${port}` },
    });
    assert.equal(getRes.status, 200);
    const delRes = await rawRequest(port, {
      method: "DELETE",
      path: `/api/sessions/${name}`,
      headers: { Host: `127.0.0.1:${port}` },
    });
    assert.equal(delRes.status, 200);
  } finally {
    await srv.close();
  }
});

test("model-supplied run_shell timeout is clamped", async () => {
  const tmp = tmpdir("tb-sec-shell-");
  try {
    // An always-allow broker: the approval gate is not what is under test.
    const { PermissionManager, StaticBroker, Decision } = await import("../src/permissions.ts");
    const ws = new Workspace(
      tmp.root,
      new PermissionManager(null, new StaticBroker(Decision.ALLOW)),
    );
    const huge = await ws.run_shell("echo hi", 60 * 60 * 24);
    assert.equal(huge.status, "ok");
    assert.match(String(huge.error ?? ""), /^$/); // no timeout error
    // A sub-floor timeout behaves as the floor (the command still runs).
    const negative = await ws.run_shell("echo hi", -5);
    assert.equal(negative.status, "ok");
  } finally {
    tmp.cleanup();
  }
});

test("workspace without an approval broker fails closed on mutations", async () => {
  const tmp = tmpdir("tb-sec-ws-");
  try {
    const ws = new Workspace(tmp.root, new PermissionManager());
    const write = await ws.write_file("a.txt", "x");
    assert.equal(write.status, "denied");
    // edit/delete resolve the target before asking permission, so seed the
    // file directly to exercise the permission denial itself
    fs.writeFileSync(path.join(tmp.root, "a.txt"), "a", "utf-8");
    const edit = await ws.edit_file("a.txt", "a", "b");
    assert.equal(edit.status, "denied");
    const del = await ws.delete_file("a.txt");
    assert.equal(del.status, "denied");
    const shell = await ws.run_shell("echo hi");
    assert.equal(shell.status, "denied");
    // nothing mutated: the seeded file is untouched
    assert.equal(fs.readFileSync(path.join(tmp.root, "a.txt"), "utf-8"), "a");
  } finally {
    tmp.cleanup();
  }
});
