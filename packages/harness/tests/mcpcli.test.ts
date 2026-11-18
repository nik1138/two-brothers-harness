/**
 * `mcp list` CLI lane: `two-brothers mcp [list]` — the offline listing of
 * the MCP servers named by the `--mcp-config` /
 * `TWO_BROTHERS_MCP_CONFIG` config file. Hermetic: only temp config files
 * are read; nothing is started or contacted. Run with:
 * node tests/run-all.ts  (or node --test tests/, or node tests/mcpcli.test.ts)
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { main, type CliIO } from "../src/cli.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeIO(): CliIO & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (line) => out.push(line), error: (line) => err.push(line) };
}

async function withTempDir(fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-mcp-cli-"));
  try {
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeConfig(dir: string, document: unknown): string {
  const filePath = path.join(dir, "mcp.json");
  fs.writeFileSync(filePath, JSON.stringify(document));
  return filePath;
}

/** A config exercising all three transports plus role/env/header fields. */
const FULL_CONFIG = {
  mcpServers: {
    zeta: { url: "https://example.test/mcp", headers: { "X-Token": "tok-value" }, role: "senior" },
    alpha: {
      command: "node",
      args: ["server.js", "--verbose"],
      env: { SECRET: "s3cr3t-value", API_KEY: "k-value" },
    },
    broken: { cwd: "/tmp" },
  },
};

/** The three `mcp list` rows of FULL_CONFIG as parsed from `--json`. */
function expectedEntries(): Array<Record<string, unknown>> {
  return [
    {
      name: "alpha",
      transport: "stdio",
      role: "junior",
      target: "node server.js --verbose",
      envKeys: ["API_KEY", "SECRET"],
      headerKeys: [],
    },
    {
      name: "broken",
      transport: "invalid",
      role: "junior",
      target: "",
      envKeys: [],
      headerKeys: [],
    },
    {
      name: "zeta",
      transport: "http",
      role: "senior",
      target: "https://example.test/mcp",
      envKeys: [],
      headerKeys: ["X-Token"],
    },
  ];
}

/** Ensure the pinned env override cannot leak into a case. */
function withoutMcpEnv(fn: () => Promise<void> | void): Promise<void> | void {
  const saved = process.env.TWO_BROTHERS_MCP_CONFIG;
  delete process.env.TWO_BROTHERS_MCP_CONFIG;
  try {
    return fn();
  } finally {
    if (saved !== undefined) process.env.TWO_BROTHERS_MCP_CONFIG = saved;
  }
}

// ---------------------------------------------------------------------------
// config resolution
// ---------------------------------------------------------------------------

test("mcp list: no config set prints a hint and exits 0", async () => {
  await withoutMcpEnv(async () => {
    const io = makeIO();
    const code = await main(["mcp", "list"], io);
    assert.equal(code, 0);
    assert.deepEqual(io.err, []);
    assert.ok(io.out.some((line) => line.includes("No MCP servers configured")), io.out.join("\n"));
    const hint = io.out.join("\n");
    assert.ok(hint.includes("--mcp-config"), hint);
    assert.ok(hint.includes("TWO_BROTHERS_MCP_CONFIG"), hint);
  });
});

test("mcp list: TWO_BROTHERS_MCP_CONFIG env names the config file", async () => {
  await withTempDir(async (dir) => {
    const filePath = writeConfig(dir, FULL_CONFIG);
    const saved = process.env.TWO_BROTHERS_MCP_CONFIG;
    process.env.TWO_BROTHERS_MCP_CONFIG = filePath;
    try {
      const io = makeIO();
      const code = await main(["mcp", "list", "--json"], io);
      assert.equal(code, 0);
      assert.deepEqual(JSON.parse(io.out[0]), { servers: expectedEntries() });
    } finally {
      if (saved === undefined) delete process.env.TWO_BROTHERS_MCP_CONFIG;
      else process.env.TWO_BROTHERS_MCP_CONFIG = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// config errors: exit 2, bounded, no stack
// ---------------------------------------------------------------------------

test("mcp list: missing config file exits 2 with a bounded error", async () => {
  await withTempDir(async (dir) => {
    const io = makeIO();
    const code = await main(["mcp", "list", "--mcp-config", path.join(dir, "nope.json")], io);
    assert.equal(code, 2);
    assert.equal(io.out.length, 0);
    assert.ok(io.err[0].startsWith("[error] "), io.err.join("\n"));
    assert.ok(io.err[0].includes("not found"), io.err[0]);
    assert.ok(io.err.some((line) => line.includes("Usage: two-brothers mcp")), io.err.join("\n"));
    for (const line of io.err) assert.ok(!line.includes(" at "), `stack-like line: ${line}`);
  });
});

test("mcp list: invalid JSON exits 2 and never echoes the file's bytes", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "bad.json");
    fs.writeFileSync(filePath, '{"mcpServers": {"a": SECRET-BYTES-12345');
    const io = makeIO();
    const code = await main(["mcp", "list", "--mcp-config", filePath], io);
    assert.equal(code, 2);
    assert.ok(io.err[0].startsWith("[error] "), io.err.join("\n"));
    assert.ok(io.err[0].includes("not valid JSON"), io.err[0]);
    assert.ok(!io.err.join("\n").includes("SECRET-BYTES-12345"), "file bytes must not leak");
  });
});

test("mcp list: non-object mcpServers exits 2", async () => {
  await withTempDir(async (dir) => {
    const filePath = writeConfig(dir, { mcpServers: ["a"] });
    const io = makeIO();
    const code = await main(["mcp", "list", "--mcp-config", filePath], io);
    assert.equal(code, 2);
    assert.ok(io.err[0].includes("mcpServers"), io.err[0]);
  });
});

test("mcp list: non-object top-level document exits 2", async () => {
  await withTempDir(async (dir) => {
    const filePath = writeConfig(dir, [1, 2, 3]);
    const io = makeIO();
    const code = await main(["mcp", "list", "--mcp-config", filePath], io);
    assert.equal(code, 2);
  });
});

// ---------------------------------------------------------------------------
// happy path
// ---------------------------------------------------------------------------

test("mcp list --json: exact machine-readable shape, sorted by name", async () => {
  await withTempDir(async (dir) => {
    const filePath = writeConfig(dir, FULL_CONFIG);
    const io = makeIO();
    const code = await main(["mcp", "list", "--mcp-config", filePath, "--json"], io);
    assert.equal(code, 0);
    assert.deepEqual(io.err, []);
    assert.equal(io.out.length, 1);
    assert.deepEqual(JSON.parse(io.out[0]), { servers: expectedEntries() });
  });
});

test("mcp list: human table with aligned columns and effective roles", async () => {
  await withTempDir(async (dir) => {
    const filePath = writeConfig(dir, FULL_CONFIG);
    const io = makeIO();
    const code = await main(["mcp", "list", "--mcp-config", filePath], io);
    assert.equal(code, 0);
    assert.deepEqual(io.err, []);
    // Header + three servers, one per line.
    assert.equal(io.out.length, 4, io.out.join("\n"));
    assert.match(io.out[0], /^name\s+transport\s+role\s+target$/);
    const rows = io.out.slice(1).map((line) => line.trim().split(/\s{2,}/));
    assert.deepEqual(
      rows.map((columns) => columns[0]),
      ["alpha", "broken", "zeta"],
    );
    assert.deepEqual(
      rows.map((columns) => columns[1]),
      ["stdio", "invalid", "http"],
    );
    assert.deepEqual(
      rows.map((columns) => columns[2]),
      ["junior", "junior", "senior"],
    );
    assert.deepEqual(
      rows.map((columns) => columns.slice(3).join("  ")),
      ["node server.js --verbose", "", "https://example.test/mcp"],
    );
    // Same-width name column: alpha pads to zeta's width.
    assert.ok(io.out[1].startsWith("alpha  "), io.out[1]);
    assert.ok(io.out[3].startsWith("zeta   "), io.out[3]);
  });
});

test("mcp list: env and header VALUES never print (key names only in --json)", async () => {
  await withTempDir(async (dir) => {
    const filePath = writeConfig(dir, FULL_CONFIG);
    for (const args of [
      ["mcp", "list", "--mcp-config", filePath],
      ["mcp", "list", "--mcp-config", filePath, "--json"],
    ]) {
      const io = makeIO();
      assert.equal(await main(args, io), 0);
      const text = [...io.out, ...io.err].join("\n");
      assert.ok(!text.includes("s3cr3t-value"), `env value leaked: ${text}`);
      assert.ok(!text.includes("k-value"), `env value leaked: ${text}`);
      assert.ok(!text.includes("tok-value"), `header value leaked: ${text}`);
    }
    const io = makeIO();
    await main(["mcp", "list", "--mcp-config", filePath, "--json"], io);
    const parsed = JSON.parse(io.out[0]) as { servers: Array<{ envKeys: string[] }> };
    assert.deepEqual(parsed.servers[0].envKeys, ["API_KEY", "SECRET"]);
  });
});

test("mcp list: a long target is hard-bounded to 80 characters", async () => {
  await withTempDir(async (dir) => {
    const longArg = "a".repeat(200);
    const filePath = writeConfig(dir, {
      mcpServers: { long: { command: "node", args: [longArg] } },
    });
    const io = makeIO();
    assert.equal(await main(["mcp", "list", "--mcp-config", filePath], io), 0);
    const target = io.out[1].trim().split(/\s{2,}/).pop() ?? "";
    assert.ok(target.length <= 80, `target too long (${target.length})`);
    assert.ok(target.endsWith("…"), target);
  });
});

test("mcp list: an empty mcpServers object prints an honest empty note", async () => {
  await withTempDir(async (dir) => {
    const filePath = writeConfig(dir, { mcpServers: {} });
    const io = makeIO();
    assert.equal(await main(["mcp", "list", "--mcp-config", filePath], io), 0);
    assert.ok(io.out[0].includes("No MCP servers configured"), io.out.join("\n"));
  });
});

// ---------------------------------------------------------------------------
// subcommand surface
// ---------------------------------------------------------------------------

test("mcp: bare `mcp` behaves as `mcp list`", async () => {
  await withTempDir(async (dir) => {
    const filePath = writeConfig(dir, FULL_CONFIG);
    const bare = makeIO();
    const listed = makeIO();
    assert.equal(await main(["mcp", "--mcp-config", filePath, "--json"], bare), 0);
    assert.equal(await main(["mcp", "list", "--mcp-config", filePath, "--json"], listed), 0);
    assert.deepEqual(bare.out, listed.out);
    assert.equal(bare.out.length, 1);
  });
});

test("mcp: unknown subcommand is a usage error (exit 2)", async () => {
  const io = makeIO();
  const code = await main(["mcp", "bogus"], io);
  assert.equal(code, 2);
  assert.ok(io.err[0].includes("unexpected argument 'bogus'"), io.err.join("\n"));
  assert.ok(io.err.some((line) => line.includes("Run 'two-brothers mcp --help'.")), io.err.join("\n"));
});

test("mcp: extra positionals after `list` are a usage error (exit 2)", async () => {
  const io = makeIO();
  const code = await main(["mcp", "list", "extra"], io);
  assert.equal(code, 2);
  assert.ok(io.err[0].includes("unexpected argument"), io.err.join("\n"));
});

test("mcp: unknown flag is a usage error naming the flag (exit 2)", async () => {
  const io = makeIO();
  const code = await main(["mcp", "list", "--bogus"], io);
  assert.equal(code, 2);
  assert.ok(io.err.join("\n").includes("--bogus"), io.err.join("\n"));
});

test("mcp --help and `help mcp` render the registered command help", async () => {
  for (const args of [["mcp", "--help"], ["mcp", "list", "--help"], ["help", "mcp"]]) {
    const io = makeIO();
    const code = await main(args, io);
    assert.equal(code, 0, args.join(" "));
    const text = io.out.join("\n");
    assert.ok(text.includes("Usage: two-brothers mcp"), text.slice(0, 300));
    assert.ok(text.includes("--mcp-config"), text);
    assert.ok(text.includes("--json"), text);
  }
});

test("mcp list: `--mcp-config` beats the env var", async () => {
  await withTempDir(async (dir) => {
    const flagFile = writeConfig(dir, { mcpServers: { fromFlag: { command: "x" } } });
    const envFile = path.join(dir, "env.json");
    fs.writeFileSync(envFile, JSON.stringify({ mcpServers: { fromEnv: { command: "y" } } }));
    const saved = process.env.TWO_BROTHERS_MCP_CONFIG;
    process.env.TWO_BROTHERS_MCP_CONFIG = envFile;
    try {
      const io = makeIO();
      assert.equal(await main(["mcp", "list", "--mcp-config", flagFile, "--json"], io), 0);
      const parsed = JSON.parse(io.out[0]) as { servers: Array<{ name: string }> };
      assert.deepEqual(
        parsed.servers.map((entry) => entry.name),
        ["fromFlag"],
      );
    } finally {
      if (saved === undefined) delete process.env.TWO_BROTHERS_MCP_CONFIG;
      else process.env.TWO_BROTHERS_MCP_CONFIG = saved;
    }
  });
});
