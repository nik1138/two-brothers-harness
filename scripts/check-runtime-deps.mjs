#!/usr/bin/env node

// Supply-chain check (pi-style): every bare specifier imported by the built
// dist/*.js of packages/harness must be declared in its package.json runtime
// dependencies. Catches phantom imports (works locally via hoisting, breaks
// for consumers) before publish. AST-free: regex scan of the emitted JS.

import { readdirSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageDir = join(repoRoot, "packages", "harness");
const distDir = join(packageDir, "dist");
const manifestPath = join(packageDir, "package.json");

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const declared = new Set([
	manifest.name,
	...Object.keys(manifest.dependencies ?? {}),
	...Object.keys(manifest.optionalDependencies ?? {}),
]);

let distFiles;
try {
	distFiles = readdirSync(distDir).filter((name) => name.endsWith(".js"));
} catch {
	console.error(`No dist/ at ${distDir} — run "npm run build" in packages/harness first.`);
	process.exit(1);
}

if (distFiles.length === 0) {
	console.error(`dist/ at ${distDir} is empty — run "npm run build" in packages/harness first.`);
	process.exit(1);
}

// require("x"), require.resolve("x"), import("x"), ... from "x" / export ... from "x"
const specifierPatterns = [
	/\brequire(?:\.resolve)?\s*\(\s*["']([^"']+)["']\s*\)/g,
	/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
	/(?<![\w"'])from\s*["']([^"']+)["']/g,
];

function packageNameOf(specifier) {
	return specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
}

const failures = [];
const scanned = [];

for (const file of distFiles.sort()) {
	const path = join(distDir, file);
	const lines = readFileSync(path, "utf8").split("\n");
	scanned.push(path);

	for (let i = 0; i < lines.length; i++) {
		for (const pattern of specifierPatterns) {
			pattern.lastIndex = 0;
			let match;
			while ((match = pattern.exec(lines[i])) !== null) {
				const specifier = match[1];
				// A real module specifier never contains whitespace; without this,
				// stray prose ("escaped from \"x\"") or array data can false-positive.
				if (/\s/.test(specifier)) continue;
				if (
					specifier.startsWith(".") ||
					specifier.startsWith("/") ||
					specifier.startsWith("node:") ||
					isBuiltin(specifier)
				) {
					continue;
				}
				const name = packageNameOf(specifier);
				if (declared.has(name)) continue;
				failures.push(`${path}:${i + 1}: "${specifier}" is not declared in ${manifest.name}'s runtime dependencies`);
			}
		}
	}
}

if (failures.length > 0) {
	console.error("Undeclared bare imports in the built package:");
	for (const failure of failures) console.error(`  ${failure}`);
	process.exit(1);
}

console.log(`Runtime-deps check passed (${scanned.length} dist files scanned against ${manifestPath}).`);
