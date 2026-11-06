/**
 * WorkspaceRegistry rename + operator ordering (`src/workspace.ts`).
 *
 * Unit tests against a temp `workspaces.json`: rename persists across registry
 * reloads (same code path the server takes on restart), names trim/cap, and
 * `reorder` requires an exact permutation — rejected inputs never mutate the
 * in-memory order or the persisted file.
 *
 * Run with: node --test tests/workspaceorder.test.ts
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  WORKSPACE_NAME_MAX_CHARS,
  WorkspaceError,
  WorkspaceRegistry,
  type RegisteredWorkspace,
} from "../src/workspace.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface Fixture {
  root: string;
  file: string;
  registry: WorkspaceRegistry;
  /** Create a real directory under the temp root and return its path. */
  dir(name: string): string;
  /** A fresh registry over the same JSON file (the server-restart path). */
  reload(): WorkspaceRegistry;
  cleanup(): void;
}

function fixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-ws-order-"));
  const file = path.join(root, "sessions", "workspaces.json");
  return {
    root,
    file,
    registry: new WorkspaceRegistry(file),
    dir(name: string): string {
      const full = path.join(root, "dirs", name);
      fs.mkdirSync(full, { recursive: true });
      return full;
    },
    reload(): WorkspaceRegistry {
      return new WorkspaceRegistry(file);
    },
    cleanup(): void {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function ids(list: RegisteredWorkspace[]): string[] {
  return list.map((ws) => ws.id);
}

/** Predicate for `assert.throws`: a WorkspaceError with the exact message. */
function workspaceError(message: string): (exc: unknown) => boolean {
  return (exc: unknown): boolean => exc instanceof WorkspaceError && exc.message === message;
}

const THREE = (fx: Fixture): [RegisteredWorkspace, RegisteredWorkspace, RegisteredWorkspace] => [
  fx.registry.add(fx.dir("alpha"), "Alpha"),
  fx.registry.add(fx.dir("beta"), "Beta"),
  fx.registry.add(fx.dir("gamma"), "Gamma"),
];

// ---------------------------------------------------------------------------
// rename
// ---------------------------------------------------------------------------

test("rename: trims the name, keeps id/path/order, returns a persisted copy", () => {
  const fx = fixture();
  try {
    const [a, b, c] = THREE(fx);
    const renamed = fx.registry.rename(a.id, "  Alpha Renamed  ");

    assert.deepEqual(renamed, { id: a.id, name: "Alpha Renamed", path: a.path });
    assert.equal(fx.registry.get(a.id)?.name, "Alpha Renamed");
    assert.equal(fx.registry.get(b.id)?.name, "Beta");
    assert.deepEqual(ids(fx.registry.list()), [a.id, b.id, c.id]);

    // The returned object is a copy: mutating it cannot corrupt the registry.
    renamed.name = "mutated";
    assert.equal(fx.registry.get(a.id)?.name, "Alpha Renamed");

    // Registration order is unchanged and survives a reload.
    const reloaded = fx.reload();
    assert.deepEqual(ids(reloaded.list()), [a.id, b.id, c.id]);
    assert.deepEqual(reloaded.get(a.id), { id: a.id, name: "Alpha Renamed", path: a.path });
  } finally {
    fx.cleanup();
  }
});

test("rename: unknown id and blank names throw WorkspaceError and persist nothing", () => {
  const fx = fixture();
  try {
    const [a] = THREE(fx);
    const before = JSON.stringify(fx.registry.list());

    assert.throws(
      () => fx.registry.rename("nope", "Renamed"),
      workspaceError("unknown workspace: nope"),
    );
    assert.throws(() => fx.registry.rename(a.id, ""), workspaceError("name must not be empty"));
    assert.throws(() => fx.registry.rename(a.id, "   "), workspaceError("name must not be empty"));
    assert.throws(
      () => fx.registry.rename(a.id, "\t\n "),
      workspaceError("name must not be empty"),
    );

    assert.equal(fx.registry.get(a.id)?.name, "Alpha");
    assert.equal(JSON.stringify(fx.registry.list()), before);
    assert.equal(fx.reload().get(a.id)?.name, "Alpha");
    assert.equal(fx.registry.rename(a.id, "Renamed").name, "Renamed");
  } finally {
    fx.cleanup();
  }
});

test("rename: long names are capped, not rejected, and the capped value persists", () => {
  const fx = fixture();
  try {
    const [a] = THREE(fx);
    const exact = "x".repeat(WORKSPACE_NAME_MAX_CHARS);
    assert.equal(fx.registry.rename(a.id, exact).name, exact, "exactly at the cap is kept");

    const over = "  " + "y".repeat(WORKSPACE_NAME_MAX_CHARS + 80) + "  ";
    const renamed = fx.registry.rename(a.id, over);
    assert.equal(renamed.name.length, WORKSPACE_NAME_MAX_CHARS);
    assert.equal(renamed.name, "y".repeat(WORKSPACE_NAME_MAX_CHARS));
    assert.equal(fx.reload().get(a.id)?.name, renamed.name);
  } finally {
    fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// reorder
// ---------------------------------------------------------------------------

test("reorder: an exact permutation returns and persists the new order", () => {
  const fx = fixture();
  try {
    const [a, b, c] = THREE(fx);
    const ordered = fx.registry.reorder([c.id, a.id, b.id]);

    assert.deepEqual(ordered, [c, a, b]);
    assert.deepEqual(ids(fx.registry.list()), [c.id, a.id, b.id]);

    // The JSON on disk is in the new order too.
    const raw = JSON.parse(fs.readFileSync(fx.file, "utf-8")) as {
      workspaces: Array<{ id: string }>;
    };
    assert.deepEqual(
      raw.workspaces.map((ws) => ws.id),
      [c.id, a.id, b.id],
    );

    // A fresh registry (server restart) loads the persisted order.
    assert.deepEqual(ids(fx.reload().list()), [c.id, a.id, b.id]);

    // An identity permutation is valid (and keeps the objects intact).
    assert.deepEqual(fx.registry.reorder([c.id, a.id, b.id]), [c, a, b]);
    assert.deepEqual(fx.registry.reorder([a.id, b.id, c.id]), [a, b, c]);
    assert.deepEqual(ids(fx.reload().list()), [a.id, b.id, c.id]);
  } finally {
    fx.cleanup();
  }
});

test("reorder: duplicate ids are rejected without mutating registry or file", () => {
  const fx = fixture();
  try {
    const [a, b, c] = THREE(fx);
    const beforeOrder = ids(fx.registry.list());
    const beforeFile = fs.readFileSync(fx.file, "utf-8");

    assert.throws(
      () => fx.registry.reorder([a.id, b.id, a.id, c.id]),
      workspaceError(`duplicate workspace id: ${a.id}`),
    );
    assert.throws(
      () => fx.registry.reorder([a.id, a.id, a.id]),
      workspaceError(`duplicate workspace id: ${a.id}`),
    );

    assert.deepEqual(ids(fx.registry.list()), beforeOrder);
    assert.equal(fs.readFileSync(fx.file, "utf-8"), beforeFile, "the file is untouched");
    assert.deepEqual(ids(fx.reload().list()), beforeOrder);
  } finally {
    fx.cleanup();
  }
});

test("reorder: unknown and missing ids are rejected without mutating anything", () => {
  const fx = fixture();
  try {
    const [a, b, c] = THREE(fx);
    const before = ids(fx.registry.list());

    assert.throws(
      () => fx.registry.reorder([a.id, b.id, "nope"]),
      workspaceError("unknown workspace: nope"),
    );
    assert.throws(
      () => fx.registry.reorder(["nope", a.id, b.id, c.id]),
      workspaceError("unknown workspace: nope"),
    );
    assert.throws(
      () => fx.registry.reorder([a.id, b.id]),
      workspaceError(`missing workspace: ${c.id}`),
    );
    assert.throws(() => fx.registry.reorder([]), workspaceError(`missing workspace: ${a.id}`));

    assert.deepEqual(ids(fx.registry.list()), before);
    assert.deepEqual(ids(fx.reload().list()), before);
  } finally {
    fx.cleanup();
  }
});

test("reorder: an empty registry accepts only the empty permutation", () => {
  const fx = fixture();
  try {
    assert.deepEqual(fx.registry.reorder([]), []);
    assert.deepEqual(ids(fx.registry.list()), []);
    assert.deepEqual(ids(fx.reload().list()), [], "the empty order persists");

    assert.throws(
      () => fx.registry.reorder(["anything"]),
      workspaceError("unknown workspace: anything"),
    );
    assert.deepEqual(fx.registry.list(), []);
  } finally {
    fx.cleanup();
  }
});

test("reorder: a later add appends after the operator order (and persists)", () => {
  const fx = fixture();
  try {
    const [a, b, c] = THREE(fx);
    fx.registry.reorder([b.id, c.id, a.id]);
    const d = fx.registry.add(fx.dir("delta"), "Delta");

    assert.deepEqual(ids(fx.registry.list()), [b.id, c.id, a.id, d.id]);
    assert.deepEqual(ids(fx.reload().list()), [b.id, c.id, a.id, d.id]);

    // A later remove keeps the relative order of the survivors.
    assert.equal(fx.registry.remove(c.id), true);
    assert.deepEqual(ids(fx.reload().list()), [b.id, a.id, d.id]);
  } finally {
    fx.cleanup();
  }
});
