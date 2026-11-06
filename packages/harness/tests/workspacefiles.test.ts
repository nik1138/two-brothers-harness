/**
 * Bounded workspace file index + picker ranking (`src/workspacefiles.ts`).
 *
 * Hermetic: temp dirs under `os.tmpdir()`, cleaned up in `finally`; the search
 * cases are pure. No network, no sleeps.
 * Run with: node --test tests/workspacefiles.test.ts
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  WORKSPACE_FILE_INDEX_LIMIT,
  WORKSPACE_FILE_MAX_DEPTH,
  indexWorkspaceFiles,
  searchWorkspaceFiles,
  type WorkspaceFileEntry,
} from "../src/workspacefiles.ts";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "two-brothers-workspacefiles-"));
}

function writeFile(root: string, relPath: string, content = "x"): string {
  const file = path.join(root, ...relPath.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf-8");
  return file;
}

function cleanup(root: string): void {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // best-effort temp cleanup
  }
}

/** A small tree with hidden, excluded and sensitive entries mixed in. */
function makeTree(): string {
  const root = tmpdir();
  writeFile(root, "a.txt", "aaa");
  writeFile(root, "b.md", "b");
  writeFile(root, "sub/c.ts", "ccc");
  writeFile(root, "sub/nested/d.ts", "d");
  writeFile(root, "src/app.ts", "app");
  writeFile(root, "src/lib/util.ts", "util");
  writeFile(root, ".hidden/secret.ts", "no");
  writeFile(root, ".gitignore", "no");
  writeFile(root, "node_modules/pkg/index.js", "no");
  writeFile(root, "credentials/keys.txt", "no");
  writeFile(root, "secrets.pem", "no");
  writeFile(root, "id_rsa", "no");
  return root;
}

const TREE_PATHS = [
  "a.txt",
  "b.md",
  "src/app.ts",
  "src/lib/util.ts",
  "sub/c.ts",
  "sub/nested/d.ts",
];

function entry(filePath: string, size = 1, mtime = 1_700_000_000): WorkspaceFileEntry {
  return { path: filePath, size, mtime };
}

test("workspace file constants match the published contract", () => {
  assert.equal(WORKSPACE_FILE_INDEX_LIMIT, 5000);
  assert.equal(WORKSPACE_FILE_MAX_DEPTH, 10);
});

test("index: nested regular files, forward-slash sorted paths, size and mtime", () => {
  const root = makeTree();
  try {
    const index = indexWorkspaceFiles(root);
    assert.equal(index.root, path.resolve(root));
    assert.equal(index.truncated, false);
    assert.equal(index.skipped, 0);
    assert.deepEqual(index.files.map((file) => file.path), TREE_PATHS);
    for (const file of index.files) {
      assert.ok(!file.path.includes("\\"), file.path);
      assert.ok(Number.isInteger(file.size) && file.size > 0, file.path);
      assert.ok(Number.isInteger(file.mtime) && file.mtime > 1_600_000_000, file.path);
    }
    const aTxt = index.files.find((file) => file.path === "a.txt");
    assert.equal(aTxt?.size, 3);
  } finally {
    cleanup(root);
  }
});

test("index: hidden names, node_modules, credentials and sensitive files are skipped", () => {
  const root = makeTree();
  try {
    const paths = indexWorkspaceFiles(root).files.map((file) => file.path);
    for (const skipped of [
      ".gitignore",
      ".hidden/secret.ts",
      "node_modules/pkg/index.js",
      "credentials/keys.txt",
      "secrets.pem",
      "id_rsa",
    ]) {
      assert.ok(!paths.includes(skipped), `should not index ${skipped}`);
    }
    for (const filePath of paths) {
      assert.ok(!filePath.split("/").some((part) => part.startsWith(".")), filePath);
    }
  } finally {
    cleanup(root);
  }
});

test("index: depth cap clips the walk and reports truncation", () => {
  const root = makeTree();
  try {
    const shallow = indexWorkspaceFiles(root, { maxDepth: 0 });
    assert.deepEqual(shallow.files.map((file) => file.path), ["a.txt", "b.md"]);
    assert.equal(shallow.truncated, true);

    const oneLevel = indexWorkspaceFiles(root, { maxDepth: 1 });
    assert.deepEqual(oneLevel.files.map((file) => file.path), [
      "a.txt",
      "b.md",
      "src/app.ts",
      "sub/c.ts",
    ]);
    assert.equal(oneLevel.truncated, true);

    const allLevels = indexWorkspaceFiles(root, { maxDepth: 2 });
    assert.deepEqual(allLevels.files.map((file) => file.path), TREE_PATHS);
    assert.equal(allLevels.truncated, false);
  } finally {
    cleanup(root);
  }
});

test("index: file-count cap is deterministic; an exact-cap walk is not truncated", () => {
  const root = makeTree();
  try {
    const capped = indexWorkspaceFiles(root, { maxFiles: 2 });
    assert.deepEqual(capped.files.map((file) => file.path), ["a.txt", "b.md"]);
    assert.equal(capped.truncated, true);
    assert.deepEqual(indexWorkspaceFiles(root, { maxFiles: 2 }), capped);

    const exact = indexWorkspaceFiles(root, { maxFiles: TREE_PATHS.length });
    assert.deepEqual(exact.files.map((file) => file.path), TREE_PATHS);
    assert.equal(exact.truncated, false);

    const zero = indexWorkspaceFiles(root, { maxFiles: 0 });
    assert.deepEqual(zero.files, []);
    assert.equal(zero.truncated, true);
  } finally {
    cleanup(root);
  }
});

test("index: missing, empty and non-directory roots are fail-soft", () => {
  const missing = path.join(os.tmpdir(), `two-brothers-missing-${process.pid}-${Date.now()}`);
  assert.deepEqual(indexWorkspaceFiles(missing), {
    root: path.resolve(missing),
    files: [],
    truncated: false,
    skipped: 0,
  });
  // empty string must not index the process cwd
  assert.deepEqual(indexWorkspaceFiles(""), { root: "", files: [], truncated: false, skipped: 0 });
  assert.deepEqual(indexWorkspaceFiles("   "), { root: "", files: [], truncated: false, skipped: 0 });

  const root = tmpdir();
  try {
    const emptyIndex = indexWorkspaceFiles(root);
    assert.deepEqual(emptyIndex.files, []);
    assert.equal(emptyIndex.truncated, false);
    assert.equal(emptyIndex.skipped, 0);
    // a null options bag degrades to the defaults instead of throwing
    assert.deepEqual(indexWorkspaceFiles(root, null as unknown as { maxFiles?: number }), emptyIndex);

    const fileRoot = writeFile(root, "just-a-file.txt", "x");
    const fileIndex = indexWorkspaceFiles(fileRoot);
    assert.deepEqual(fileIndex.files, []);
    assert.equal(fileIndex.truncated, false);
  } finally {
    cleanup(root);
  }
});

test("index: symlinked files and directories are skipped, never followed", () => {
  const root = tmpdir();
  try {
    writeFile(root, "real.txt", "x");
    writeFile(root, "target/inside.txt", "y");
    let linked = false;
    try {
      fs.symlinkSync(path.join(root, "target"), path.join(root, "linkdir"), "junction");
      linked = true;
    } catch {
      // symlink creation can be privilege-gated on Windows; nothing to assert
    }
    if (!linked) return;
    try {
      fs.symlinkSync(path.join(root, "real.txt"), path.join(root, "linkfile"), "file");
    } catch {
      // file symlinks additionally need developer mode; the dir junction suffices
    }

    const paths = indexWorkspaceFiles(root).files.map((file) => file.path);
    assert.ok(paths.includes("real.txt"), paths.join(","));
    assert.ok(paths.includes("target/inside.txt"), paths.join(","));
    assert.ok(!paths.includes("linkdir/inside.txt"), paths.join(","));
    assert.ok(!paths.includes("linkfile"), paths.join(","));
  } finally {
    cleanup(root);
  }
});

test("search: ranks exact basename, basename prefix, basename substring, path substring", () => {
  const files = [
    entry("src/myapp.ts"),
    entry("docs/readme-app.md"),
    entry("app"),
    entry("app.ts"),
    entry("src/app.ts"),
    entry("src/appstore.ts"),
    entry("misc/foo-app/bar.txt"),
  ];
  assert.deepEqual(searchWorkspaceFiles(files, "app").map((file) => file.path), [
    "app",
    "app.ts",
    "src/app.ts",
    "src/appstore.ts",
    "docs/readme-app.md",
    "src/myapp.ts",
    "misc/foo-app/bar.txt",
  ]);
});

test("search: case-insensitive matching", () => {
  const files = [entry("src/APp.ts"), entry("docs/README-app.md"), entry("src/myapp.ts")];
  assert.deepEqual(
    searchWorkspaceFiles(files, "APP").map((file) => file.path),
    ["src/APp.ts", "docs/README-app.md", "src/myapp.ts"],
  );
  assert.deepEqual(searchWorkspaceFiles(files, "ReadMe").map((file) => file.path), [
    "docs/README-app.md",
  ]);
  assert.deepEqual(searchWorkspaceFiles(files, "AppStore"), []);
});

test("search: full-path-only matches come last, ordered by path", () => {
  const files = [entry("src/myapp.ts"), entry("src/app.ts"), entry("src/appstore.ts")];
  assert.deepEqual(searchWorkspaceFiles(files, "src/").map((file) => file.path), [
    "src/app.ts",
    "src/appstore.ts",
    "src/myapp.ts",
  ]);
  assert.deepEqual(searchWorkspaceFiles(files, "lib/"), []);
});

test("search: blank query returns the first limit entries in path order without mutating input", () => {
  const files = [entry("b.ts"), entry("a.ts"), entry("c.ts")];
  const snapshot = JSON.stringify(files);
  const firstTwo = searchWorkspaceFiles(files, "  ", { limit: 2 });
  assert.deepEqual(firstTwo.map((file) => file.path), ["a.ts", "b.ts"]);
  assert.deepEqual(searchWorkspaceFiles(files, "").map((file) => file.path), [
    "a.ts",
    "b.ts",
    "c.ts",
  ]);
  assert.equal(JSON.stringify(files), snapshot);
  assert.deepEqual(files.map((file) => file.path), ["b.ts", "a.ts", "c.ts"]);
});

test("search: non-matching queries return an empty list", () => {
  const files = [entry("src/a.ts"), entry("docs/b.md")];
  assert.deepEqual(searchWorkspaceFiles(files, "zzz"), []);
  assert.deepEqual(searchWorkspaceFiles(files, "*.ts"), []);
});

test("search: limit defaults to 50, clamps to 1..200 and accepts junk as the default", () => {
  const many = Array.from({ length: 260 }, (_, index) =>
    entry(`f${String(index).padStart(3, "0")}.ts`),
  );
  assert.equal(searchWorkspaceFiles(many, "").length, 50);
  assert.equal(searchWorkspaceFiles(many, "", { limit: 0 }).length, 1);
  assert.equal(searchWorkspaceFiles(many, "", { limit: -5 }).length, 1);
  assert.equal(searchWorkspaceFiles(many, "", { limit: 999 }).length, 200);
  assert.equal(searchWorkspaceFiles(many, "", { limit: Number.NaN }).length, 50);
  assert.deepEqual(
    searchWorkspaceFiles(many, "", { limit: 2 }).map((file) => file.path),
    ["f000.ts", "f001.ts"],
  );
});

test("search: tolerates malformed entries and keeps entry objects untouched", () => {
  const good = entry("src/a.ts");
  const hostile = [good, null, { nope: 1 }, { path: 42 }] as unknown as WorkspaceFileEntry[];
  assert.deepEqual(searchWorkspaceFiles(hostile, "a"), [good]);
  assert.deepEqual(searchWorkspaceFiles(hostile, ""), [good]);
  assert.equal(good.path, "src/a.ts");
  assert.equal(good.size, 1);
});

test("index + search integration: picker ranking over an indexed tree", () => {
  const root = makeTree();
  try {
    const index = indexWorkspaceFiles(root);
    assert.deepEqual(
      searchWorkspaceFiles(index.files, "d.ts").map((file) => file.path),
      ["sub/nested/d.ts"],
    );
    assert.deepEqual(
      searchWorkspaceFiles(index.files, "src/").map((file) => file.path),
      ["src/app.ts", "src/lib/util.ts"],
    );
    assert.deepEqual(searchWorkspaceFiles(index.files, "app", { limit: 1 }).map((file) => file.path), [
      "src/app.ts",
    ]);
  } finally {
    cleanup(root);
  }
});
