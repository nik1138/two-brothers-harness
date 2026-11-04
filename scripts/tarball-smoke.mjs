#!/usr/bin/env node

// Release rehearsal (pi-style): pack the publishable tarball, install it into
// a fresh temp dir, and smoke-run the built artifacts exactly as a consumer
// would. Run manually before each npm publish:
//
//   node scripts/tarball-smoke.mjs

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageDir = join(repoRoot, "packages", "harness");
const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
const packageName = manifest.name; // @two-brothers/harness

const results = [];
function check(name, ok, detail = "") {
	results.push({ name, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function run(command, args, cwd, { timeoutMs = 120_000 } = {}) {
	const outcome = spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		timeout: timeoutMs,
		windowsHide: true,
		// npm is npm.cmd on Windows — spawning it needs a shell.
		shell: process.platform === "win32",
	});
	return {
		stdout: outcome.stdout ?? "",
		stderr: outcome.stderr ?? "",
		failed: outcome.error !== undefined,
		status: outcome.status,
	};
}

const tempDir = mkdtempSync(join(tmpdir(), "harness-tarball-smoke-"));
let tarballPath;

try {
	// 1. Pack the tarball (npm prints the filename on the last stdout line).
	const pack = run("npm", ["pack", "--pack-destination", tempDir, "--no-audit", "--no-fund"], packageDir);
	const packLines = pack.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
	tarballPath = packLines.length > 0 ? join(tempDir, packLines[packLines.length - 1]) : undefined;
	check("npm pack", !pack.failed && pack.status === 0 && !!tarballPath && existsSync(tarballPath), tarballPath ?? pack.stderr.trim());

	// 2. Install the tarball into the fresh temp dir (consumer-style).
	const install = run("npm", ["install", tarballPath, "--no-audit", "--no-fund", "--loglevel=error"], tempDir);
	check(
		"npm install <tarball>",
		!install.failed && install.status === 0,
		(install.stderr || install.stdout).trim().split("\n").slice(-3).join(" ") || "installed",
	);

	// 3. The tarball ships the built web workspace.
	const installedRoot = join(tempDir, "node_modules", ...packageName.split("/"));
	const webIndex = join(installedRoot, "web", "index.html");
	check("packaged web/index.html", existsSync(webIndex), webIndex);

	// 4. Selftest from the installed copy.
	const selftestEntry = join(installedRoot, "dist", "selftest.js");
	if (existsSync(selftestEntry)) {
		const selftest = run("node", [selftestEntry], tempDir);
		check(
			"node dist/selftest.js",
			!selftest.failed && selftest.status === 0 && selftest.stdout.includes("SELFTEST: PASS"),
			(selftest.stdout + selftest.stderr).trim().split("\n").slice(-2).join(" "),
		);
	} else {
		check("node dist/selftest.js", false, `missing ${selftestEntry}`);
	}

	// 5. Mock CLI run from the installed copy (offline; expects the tokens footer).
	const cliEntry = join(installedRoot, "dist", "cli.js");
	if (existsSync(cliEntry)) {
		const cli = run("node", [cliEntry, "run", "smoke", "--provider", "mock"], tempDir, { timeoutMs: 180_000 });
		check(
			"node dist/cli.js run --provider mock",
			!cli.failed && cli.status === 0 && cli.stdout.includes("tokens:"),
			`exit ${cli.status}; ${cli.stdout.trim().split("\n").slice(-1)[0] ?? cli.stderr.trim()}`,
		);
	} else {
		check("node dist/cli.js run --provider mock", false, `missing ${cliEntry}`);
	}
} finally {
	rmSync(tempDir, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
console.log("");
console.log(failed.length === 0 ? `TARBALL SMOKE: PASS (${results.length}/${results.length})` : `TARBALL SMOKE: FAIL (${failed.length}/${results.length} failed)`);
process.exit(failed.length === 0 ? 0 : 1);
