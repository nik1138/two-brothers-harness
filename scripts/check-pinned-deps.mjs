#!/usr/bin/env node

// Supply-chain check (pi-style): every runtime dependency of the publishable
// package must be pinned to an exact version. Catches ^/~/*/range specifiers
// before they reach the registry.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(repoRoot, "packages", "harness", "package.json");

const dependencySections = ["dependencies", "optionalDependencies"];
const exactVersionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const nonRegistryPattern = /^(?:workspace:|file:|link:|portal:|git\+|github:|git:|https?:|ssh:|git:\/\/)/;

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const failures = [];

for (const section of dependencySections) {
	const dependencies = manifest[section];
	if (!dependencies) continue;

	for (const [name, specifier] of Object.entries(dependencies)) {
		if (nonRegistryPattern.test(specifier)) continue;
		if (exactVersionPattern.test(specifier)) continue;
		failures.push(`${manifestPath}: ${section}.${name} must be pinned to an exact version, found "${specifier}"`);
	}
}

if (failures.length > 0) {
	console.error("Runtime dependencies of @two-brothers/harness must use exact versions:");
	for (const failure of failures) console.error(`  ${failure}`);
	process.exit(1);
}

console.log(`Pinned-deps check passed (${manifestPath}).`);
