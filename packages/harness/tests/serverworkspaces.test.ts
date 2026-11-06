/**
 * HTTP contract for workspace rename + operator ordering (`src/server.ts`).
 *
 * Hermetic: `createServer` runs in-process against a temp sessions directory
 * and is exercised over real HTTP on an ephemeral port (no subprocesses, no
 * live model endpoints, no sleeps). Covers the additive routes
 * `PATCH /api/workspaces/{id}` (rename) and `PUT /api/workspaces/order`
 * (operator order) plus the unchanged GET/POST/DELETE behavior they build on.
 *
 * Run with: node --test tests/serverworkspaces.test.ts
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { createServer, type ServerHandle } from "../src/server.ts";
import { WORKSPACE_NAME_MAX_CHARS } from "../src/workspace.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface WorkspaceJson {
  id: string;
  name: string;
  path: string;
}

interface RunningServer {
  base: string;
  handle: ServerHandle;
  sessionsDir: string;
  close(): Promise<void>;
}

/** Start one server over `sessionsDir` (the caller owns the directory). */
async function openServer(sessionsDir: string): Promise<RunningServer> {
  const handle = createServer({ webDist: null, sessionsDir });
  const server = await handle.listen("127.0.0.1", 0);
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    handle,
    sessionsDir,
    close: async () => {
      await handle.close();
    },
  };
}

interface TempServer extends RunningServer {
  root: string;
}

/** Start a server on a fresh temp root; `close()` also removes the root. */
async function startServer(): Promise<TempServer> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-srv-workspaces-"));
  const server = await openServer(path.join(root, "sessions"));
  return {
    ...server,
    root,
    close: async () => {
      await server.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

async function api<T = unknown>(
  base: string,
  route: string,
  method = "GET",
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = typeof body === "string" ? body : JSON.stringify(body);
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

/** A real directory under the temp root (the only thing `add` accepts). */
function workspaceDir(root: string, name: string): string {
  const dir = path.join(root, "workspaces", name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function register(
  base: string,
  dirPath: string,
  name?: string,
): Promise<WorkspaceJson> {
  const created = await api<WorkspaceJson>(base, "/api/workspaces", "POST", {
    path: dirPath,
    ...(name === undefined ? {} : { name }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body;
}

async function list(base: string): Promise<WorkspaceJson[]> {
  const listed = await api<WorkspaceJson[]>(base, "/api/workspaces");
  assert.equal(listed.status, 200);
  assert.ok(Array.isArray(listed.body));
  return listed.body;
}

function ids(listed: WorkspaceJson[]): string[] {
  return listed.map((workspace) => workspace.id);
}

// ---------------------------------------------------------------------------
// GET / POST (unchanged behavior the new routes build on)
// ---------------------------------------------------------------------------

test("GET /api/workspaces: empty, then registration order with the exact JSON shape", async () => {
  const server = await startServer();
  try {
    assert.deepEqual(await list(server.base), []);

    const alpha = await register(server.base, workspaceDir(server.root, "alpha"), "Alpha");
    const beta = await register(server.base, workspaceDir(server.root, "beta"), "Beta");
    const gamma = await register(server.base, workspaceDir(server.root, "gamma"));

    // gamma's name is derived from its directory basename.
    assert.equal(gamma.name, "gamma");
    assert.match(gamma.id, /^gamma-[0-9a-f]{8}$/);

    const listed = await list(server.base);
    assert.deepEqual(ids(listed), [alpha.id, beta.id, gamma.id]);
    assert.deepEqual(listed, [alpha, beta, gamma]);
    // Web-facing JSON shape: exactly id/name/path, in that order.
    for (const workspace of listed) {
      assert.deepEqual(Object.keys(workspace), ["id", "name", "path"]);
      assert.equal(typeof workspace.id, "string");
      assert.equal(typeof workspace.name, "string");
      assert.equal(workspace.path, path.resolve(workspace.path));
    }
  } finally {
    await server.close();
  }
});

test("POST /api/workspaces still derives a name and validates the path", async () => {
  const server = await startServer();
  try {
    const dir = workspaceDir(server.root, "derived-name");
    const created = await api<WorkspaceJson>(server.base, "/api/workspaces", "POST", { path: dir });
    assert.equal(created.status, 201);
    assert.equal(created.body.name, "derived-name");
    assert.match(created.body.id, /^derived-name-[0-9a-f]{8}$/);
    assert.equal(created.body.path, path.resolve(dir));

    // Re-registering the same directory is still a 400.
    const again = await api<{ detail: string }>(server.base, "/api/workspaces", "POST", {
      path: dir,
    });
    assert.equal(again.status, 400);
    assert.match(again.body.detail, /^already registered: /);

    // A missing path and a non-directory path are still 400s.
    const missing = await api<{ detail: string }>(server.base, "/api/workspaces", "POST", {});
    assert.equal(missing.status, 400);
    assert.equal(missing.body.detail, "invalid request body");
    const file = path.join(server.root, "not-a-dir.txt");
    fs.writeFileSync(file, "x", "utf-8");
    const notDir = await api<{ detail: string }>(server.base, "/api/workspaces", "POST", {
      path: file,
    });
    assert.equal(notDir.status, 400);
    assert.match(notDir.body.detail, /^not a directory: /);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/workspaces/{id} — rename
// ---------------------------------------------------------------------------

test("PATCH renames a workspace (trimmed) and GET reflects it without reordering", async () => {
  const server = await startServer();
  try {
    const alpha = await register(server.base, workspaceDir(server.root, "alpha"), "Alpha");
    const beta = await register(server.base, workspaceDir(server.root, "beta"), "Beta");

    const renamed = await api<WorkspaceJson>(
      server.base,
      `/api/workspaces/${encodeURIComponent(alpha.id)}`,
      "PATCH",
      { name: "  Alpha Renamed  " },
    );
    assert.equal(renamed.status, 200);
    assert.deepEqual(renamed.body, {
      id: alpha.id,
      name: "Alpha Renamed",
      path: alpha.path,
    });
    assert.deepEqual(Object.keys(renamed.body), ["id", "name", "path"]);

    const listed = await list(server.base);
    assert.deepEqual(listed, [{ ...alpha, name: "Alpha Renamed" }, beta]);
    assert.deepEqual(ids(listed), [alpha.id, beta.id]);
  } finally {
    await server.close();
  }
});

test("PATCH caps an over-long workspace name at the registry cap", async () => {
  const server = await startServer();
  try {
    const alpha = await register(server.base, workspaceDir(server.root, "alpha"), "Alpha");
    const long = "n".repeat(WORKSPACE_NAME_MAX_CHARS + 40);

    const renamed = await api<WorkspaceJson>(
      server.base,
      `/api/workspaces/${encodeURIComponent(alpha.id)}`,
      "PATCH",
      { name: `  ${long}  ` },
    );
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal(renamed.body.name.length, WORKSPACE_NAME_MAX_CHARS);
    assert.equal(renamed.body.name, "n".repeat(WORKSPACE_NAME_MAX_CHARS));

    // The capped value is what GET (and therefore a reload) sees.
    const listed = await list(server.base);
    assert.equal(listed[0]?.name, renamed.body.name);
  } finally {
    await server.close();
  }
});

test("PATCH 400 for a missing, blank or non-string name; 404 for an unknown id", async () => {
  const server = await startServer();
  try {
    const alpha = await register(server.base, workspaceDir(server.root, "alpha"), "Alpha");
    const route = `/api/workspaces/${encodeURIComponent(alpha.id)}`;

    for (const body of [{}, { name: null }, { name: "" }, { name: "   " }]) {
      const { status, body: detail } = await api<{ detail: string }>(
        server.base,
        route,
        "PATCH",
        body,
      );
      assert.equal(status, 400, JSON.stringify(body));
      assert.equal(detail.detail, "name must not be empty", JSON.stringify(body));
    }

    // A non-string name (or a body that is not JSON) is the generic 400.
    const numeric = await api<{ detail: string }>(server.base, route, "PATCH", { name: 5 });
    assert.equal(numeric.status, 400);
    assert.equal(numeric.body.detail, "invalid request body");
    const malformed = await api<{ detail: string }>(server.base, route, "PATCH", "{not json");
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.detail, "invalid request body");

    // The name never changed.
    assert.equal((await list(server.base))[0]?.name, "Alpha");

    // Unknown ids are 404 ("not found"), including the fixed order path.
    for (const unknown of ["nope", "order"]) {
      const { status, body } = await api<{ detail: string }>(
        server.base,
        `/api/workspaces/${unknown}`,
        "PATCH",
        { name: "Renamed" },
      );
      assert.equal(status, 404, unknown);
      assert.equal(body.detail, "not found");
    }
    assert.equal(
      (await api(server.base, "/api/workspaces/order", "PATCH", { name: "Renamed" })).status,
      404,
    );
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// PUT /api/workspaces/order — operator ordering
// ---------------------------------------------------------------------------

test("PUT order reorders the registry; GET returns the new order", async () => {
  const server = await startServer();
  try {
    const [a, b, c] = [
      await register(server.base, workspaceDir(server.root, "a"), "A"),
      await register(server.base, workspaceDir(server.root, "b"), "B"),
      await register(server.base, workspaceDir(server.root, "c"), "C"),
    ];

    const put = await api<{ workspaces: WorkspaceJson[] }>(server.base, "/api/workspaces/order", "PUT", {
      ids: [c.id, a.id, b.id],
    });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.deepEqual(Object.keys(put.body), ["workspaces"]);
    assert.deepEqual(put.body.workspaces, [c, a, b]);
    assert.deepEqual(Object.keys(put.body.workspaces[0] ?? {}), ["id", "name", "path"]);

    const listed = await list(server.base);
    assert.deepEqual(listed, [c, a, b]);
    assert.deepEqual(ids(listed), [c.id, a.id, b.id]);

    // Identity and a second permutation also work; GET follows each time.
    assert.deepEqual(
      (await api<{ workspaces: WorkspaceJson[] }>(server.base, "/api/workspaces/order", "PUT", {
        ids: [a.id, b.id, c.id],
      })).body.workspaces,
      [a, b, c],
    );
    assert.deepEqual(ids(await list(server.base)), [a.id, b.id, c.id]);
  } finally {
    await server.close();
  }
});

test("PUT order 400 for duplicate/unknown/missing ids, and no partial reorder on error", async () => {
  const server = await startServer();
  try {
    const [a, b, c] = [
      await register(server.base, workspaceDir(server.root, "a"), "A"),
      await register(server.base, workspaceDir(server.root, "b"), "B"),
      await register(server.base, workspaceDir(server.root, "c"), "C"),
    ];

    const cases: Array<{ ids: string[]; detail: string }> = [
      { ids: [a.id, b.id, a.id], detail: `duplicate workspace id: ${a.id}` },
      { ids: [a.id, b.id, "nope"], detail: "unknown workspace: nope" },
      { ids: [a.id, b.id], detail: `missing workspace: ${c.id}` },
      { ids: [], detail: `missing workspace: ${a.id}` },
    ];
    for (const item of cases) {
      const { status, body } = await api<{ detail: string }>(
        server.base,
        "/api/workspaces/order",
        "PUT",
        { ids: item.ids },
      );
      assert.equal(status, 400, JSON.stringify(item.ids));
      assert.equal(body.detail, item.detail, JSON.stringify(item.ids));
    }

    // Nothing was reordered by the rejected calls.
    assert.deepEqual(ids(await list(server.base)), [a.id, b.id, c.id]);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(server.sessionsDir, "workspaces.json"), "utf-8"))
        .workspaces.map((workspace: WorkspaceJson) => workspace.id),
      [a.id, b.id, c.id],
    );
  } finally {
    await server.close();
  }
});

test("PUT order 400 for a non-array ids body and for malformed JSON", async () => {
  const server = await startServer();
  try {
    await register(server.base, workspaceDir(server.root, "a"), "A");

    for (const body of [{}, { ids: "a" }, { ids: null }]) {
      const { status, body: detail } = await api<{ detail: string }>(
        server.base,
        "/api/workspaces/order",
        "PUT",
        body,
      );
      assert.equal(status, 400, JSON.stringify(body));
      assert.equal(detail.detail, "ids must be an array");
    }

    const mixed = await api<{ detail: string }>(server.base, "/api/workspaces/order", "PUT", {
      ids: ["a", 1],
    });
    assert.equal(mixed.status, 400);
    assert.equal(mixed.body.detail, "ids must be an array of strings");

    const malformed = await api<{ detail: string }>(
      server.base,
      "/api/workspaces/order",
      "PUT",
      "{not json",
    );
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.detail, "invalid request body");

    assert.equal((await list(server.base)).length, 1);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// unchanged DELETE + restart persistence
// ---------------------------------------------------------------------------

test("DELETE remains intact: removes one workspace, second delete is a 404", async () => {
  const server = await startServer();
  try {
    const [a, b] = [
      await register(server.base, workspaceDir(server.root, "a"), "A"),
      await register(server.base, workspaceDir(server.root, "b"), "B"),
    ];

    const removed = await api<{ removed: string }>(
      server.base,
      `/api/workspaces/${encodeURIComponent(a.id)}`,
      "DELETE",
    );
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.body, { removed: a.id });
    assert.deepEqual(await list(server.base), [b]);

    const again = await api<{ detail: string }>(
      server.base,
      `/api/workspaces/${encodeURIComponent(a.id)}`,
      "DELETE",
    );
    assert.equal(again.status, 404);
    assert.equal(again.body.detail, "not found");
  } finally {
    await server.close();
  }
});

test("renamed + reordered workspace state survives a server restart", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-srv-workspaces-"));
  const sessionsDir = path.join(root, "sessions");
  try {
    const first = await openServer(sessionsDir);
    let a: WorkspaceJson;
    let b: WorkspaceJson;
    let c: WorkspaceJson;
    try {
      a = await register(first.base, workspaceDir(root, "a"), "A");
      b = await register(first.base, workspaceDir(root, "b"), "B");
      c = await register(first.base, workspaceDir(root, "c"), "C");
      assert.equal(
        (
          await api(first.base, `/api/workspaces/${encodeURIComponent(b.id)}`, "PATCH", {
            name: "Bee Renamed",
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await api(first.base, "/api/workspaces/order", "PUT", {
            ids: [c.id, b.id, a.id],
          })
        ).status,
        200,
      );
    } finally {
      await first.close();
    }

    const second = await openServer(sessionsDir);
    try {
      assert.deepEqual(await list(second.base), [
        c,
        { ...b, name: "Bee Renamed" },
        a,
      ]);
    } finally {
      await second.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
