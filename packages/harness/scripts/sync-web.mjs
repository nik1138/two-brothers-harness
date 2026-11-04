#!/usr/bin/env node

// Copy the built web workspace into the package so the npm tarball ships the
// UI (`web` in package.json `files`). Builds nothing: run `npm run build` in
// web/ first. Cross-platform (pure Node, no shell), no dependencies.

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = resolve(packageDir, "..", "..");
const source = join(repoRoot, "web", "dist");
const target = join(packageDir, "web");

if (!existsSync(join(source, "index.html"))) {
  console.error(`sync-web: built web app not found at ${source}`);
  console.error("sync-web: run `npm run build` in web/ first, then retry.");
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });

console.log(`sync-web: copied ${source} -> ${target}`);