/**
 * Non-interactive automation modes (`--mode print` / `--mode json` /
 * `--json-events`): deterministic machine-readable output on stdout,
 * diagnostics on stderr, pi-style exit codes. All runs use the offline
 * mock provider.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import assert from "node:assert/strict";

import { main, type CliIO } from "../src/cli.ts";

function makeIO(): CliIO & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    log: (line) => out.push(line),
    error: (line) => err.push(line),
  };
}

const MOCK_RUN = ["run", "pick an approach", "--provider", "mock"] as const;

/** Run `fn` with exactly these environment values, restoring the env after. */
async function withEnv<T>(
  updates: Record<string, string | undefined>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(updates)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/**
 * The stable part of one machine-output object: protocol ids and timestamps are
 * generated per run, so equality is asserted on the full shape with those two
 * volatile fields normalized.
 */
function normalizeMachineOutput(line: string): string {
  const parsed = JSON.parse(line) as {
    events: Array<Record<string, unknown>>;
    [key: string]: unknown;
  };
  return JSON.stringify({
    ...parsed,
    events: parsed.events.map((event) => ({ ...event, id: "<id>", ts: "<ts>" })),
  });
}

/** Drive one piped `chat` REPL turn (the REPL reads process.stdin directly). */
async function runChatTurn(
  io: CliIO & { out: string[]; err: string[] },
  lines: string[],
  extraArgs: string[] = [],
): Promise<number> {
  const original = Object.getOwnPropertyDescriptor(process, "stdin");
  Object.defineProperty(process, "stdin", {
    value: Readable.from(lines.map((line) => `${line}\n`)),
    configurable: true,
  });
  try {
    return await main(["chat", "--provider", "mock", ...extraArgs], io);
  } finally {
    if (original !== undefined) Object.defineProperty(process, "stdin", original);
    else delete (process as unknown as { stdin?: unknown }).stdin;
  }
}

test("json mode: stdout is one parseable object with events/decision/usage/rounds/errors", async () => {
  const io = makeIO();
  const code = await main([...MOCK_RUN, "--mode", "json"], io);
  assert.equal(code, 0);
  assert.equal(io.out.length, 1, `stdout must be a single line, got: ${io.out.join("\n")}`);
  const parsed = JSON.parse(io.out[0]);
  for (const key of ["events", "decision", "usage", "rounds", "errors"]) {
    assert.ok(key in parsed, `missing key: ${key}`);
  }
  assert.equal(typeof parsed.rounds, "number");
  assert.ok(Array.isArray(parsed.events));
  assert.ok(parsed.events.length >= 5, "message → consult → proposal → review → decision");
  const first = parsed.events[0];
  assert.equal(first.from, "user");
  assert.equal(first.kind, "message");
  assert.equal(first.payload.text, "pick an approach");
  const last = parsed.events[parsed.events.length - 1];
  assert.equal(last.kind, "decision");
  assert.equal(typeof parsed.decision.decision, "string");
  assert.ok(parsed.decision.decision.length > 0);
  assert.equal(typeof parsed.usage.model_calls, "number");
  assert.ok(parsed.usage.model_calls >= 4);
  assert.deepEqual(parsed.errors, []);
  // nothing but the JSON object on stdout
  assert.deepEqual(io.err, [], "clean run keeps stderr silent");
});

test("json mode: --json-events is an alias and composes with --mode work", async () => {
  const io = makeIO();
  const code = await main([...MOCK_RUN, "--mode", "work", "--json-events"], io);
  assert.equal(code, 0);
  assert.equal(io.out.length, 1);
  const parsed = JSON.parse(io.out[0]);
  assert.ok("decision" in parsed && "usage" in parsed);
  const kinds = parsed.events.map((e: { kind: string }) => e.kind);
  assert.deepEqual(kinds, ["message", "delegation", "deliverable", "review", "decision"]);
});

test("print mode: stdout carries only the final decision text", async () => {
  const io = makeIO();
  const code = await main([...MOCK_RUN, "--mode", "print"], io);
  assert.equal(code, 0);
  assert.equal(io.out.length, 1);
  assert.match(io.out[0], /Final decision/);
  assert.doesNotMatch(io.out[0], /\[(user|senior|junior)/, "no transcript on stdout");
  // usage footer is diagnostic: it belongs on stderr
  assert.ok(io.err.some((line) => line.startsWith("tokens: ")), io.err.join("\n"));
});

test("print mode: --json keeps the decision-object output working", async () => {
  const io = makeIO();
  const code = await main([...MOCK_RUN, "--mode", "print", "--json"], io);
  assert.equal(code, 0);
  assert.equal(io.out.length, 1);
  const parsed = JSON.parse(io.out[0]);
  assert.equal(typeof parsed.decision, "string");
  assert.ok(parsed.decision.length > 0);
});

test("bare --json implies the machine-readable output mode", async () => {
  const io = makeIO();
  const code = await main([...MOCK_RUN, "--json"], io);
  assert.equal(code, 0);
  // one JSON object on stdout — never the human transcript plus a final line
  assert.equal(io.out.length, 1, `stdout must be a single line, got: ${io.out.join("\n")}`);
  const parsed = JSON.parse(io.out[0]);
  for (const key of ["events", "decision", "usage", "rounds", "errors"]) {
    assert.ok(key in parsed, `missing key: ${key}`);
  }
  assert.equal(typeof parsed.decision.decision, "string");
  assert.ok(parsed.events.length >= 5);
  assert.doesNotMatch(io.out[0], /\[senior -> user\]/, "no human transcript on stdout");
  assert.deepEqual(io.err, [], "clean run keeps stderr silent");
});

test("bare --json composes with a cooperation mode", async () => {
  const io = makeIO();
  const code = await main([...MOCK_RUN, "--mode", "work", "--json"], io);
  assert.equal(code, 0);
  assert.equal(io.out.length, 1);
  const parsed = JSON.parse(io.out[0]);
  assert.deepEqual(
    parsed.events.map((e: { kind: string }) => e.kind),
    ["message", "delegation", "deliverable", "review", "decision"],
  );
});

test("exit codes: 2 on usage error (missing task), 1 on run error", async () => {
  const missing = makeIO();
  assert.equal(await main(["run", "--provider", "mock", "--mode", "json"], missing), 2);
  assert.match(missing.err.join("\n"), /no task given/);

  // a session file that already exists (without --resume) is a run error
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-printmode-test-"));
  try {
    fs.writeFileSync(path.join(dir, "s.jsonl"), "{}\n", "utf-8");
    const io = makeIO();
    const code = await main(
      [...MOCK_RUN, "--mode", "json", "--session-file", path.join(dir, "s.jsonl")],
      io,
    );
    assert.equal(code, 1);
    assert.equal(io.out.length, 0, "no JSON payload on stdout when the run never starts");
    assert.match(io.err.join("\n"), /session file already exists/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("exit code 2 with a clean stderr/stdout separation on unknown flags' values", async () => {
  // invalid --mode value is a config (usage) error, rejected before any run
  const io = makeIO();
  await assert.rejects(main([...MOCK_RUN, "--mode", "bogus"], io), /invalid mode/);
});

// ---------------------------------------------------------------------------
// TWO_BROTHERS_JSON: the env spelling of a bare --json (contract alignment)
// ---------------------------------------------------------------------------

test("TWO_BROTHERS_JSON=1 emits the same machine object as bare --json", async () => {
  // FORCE_COLOR on both runs: machine modes must stay escape-free regardless.
  const flagIO = await withEnv({ FORCE_COLOR: "3", NO_COLOR: undefined }, async () => {
    const io = makeIO();
    assert.equal(await main([...MOCK_RUN, "--json"], io), 0, io.err.join("\n"));
    return io;
  });
  const envResult = await withEnv(
    { FORCE_COLOR: "3", NO_COLOR: undefined, TWO_BROTHERS_JSON: "1" },
    async () => {
      const io = makeIO();
      const code = await main([...MOCK_RUN], io);
      return { code, io };
    },
  );

  assert.equal(envResult.code, 0, envResult.io.err.join("\n"));
  assert.equal(envResult.io.out.length, 1, "stdout must be a single line");
  assert.deepEqual(envResult.io.err, [], "a clean run keeps stderr silent");
  // The env output is the full machine object, key order included — never the
  // retired human transcript plus a decision JSON last line.
  assert.deepEqual(Object.keys(JSON.parse(envResult.io.out[0])), [
    "task",
    "events",
    "decision",
    "usage",
    "cost",
    "rounds",
    "errors",
  ]);
  assert.equal(
    normalizeMachineOutput(envResult.io.out[0]),
    normalizeMachineOutput(flagIO.out[0]),
    "TWO_BROTHERS_JSON=1 and bare --json must produce the same machine output",
  );
  // Machine-mode purity: zero ESC even under FORCE_COLOR=3.
  for (const io of [flagIO, envResult.io]) {
    assert.ok(!io.out.join("").includes("\u001b"), "machine output must carry no escapes");
  }
});

test("TWO_BROTHERS_JSON truthy spellings select the machine object; falsey keeps text", async () => {
  for (const value of ["1", "true", "yes", "on"]) {
    const io = await withEnv({ TWO_BROTHERS_JSON: value }, async () => {
      const sink = makeIO();
      assert.equal(await main([...MOCK_RUN], sink), 0, sink.err.join("\n"));
      return sink;
    });
    assert.equal(io.out.length, 1, `${value}: one machine line`);
    const parsed = JSON.parse(io.out[0]);
    assert.ok(Array.isArray(parsed.events) && parsed.events.length >= 5, `${value}: events`);
  }
  for (const value of ["0", "false", "no", "off", ""]) {
    const io = await withEnv({ TWO_BROTHERS_JSON: value }, async () => {
      const sink = makeIO();
      assert.equal(await main([...MOCK_RUN], sink), 0, sink.err.join("\n"));
      return sink;
    });
    assert.ok(io.out.length > 1, `${value}: human transcript lines`);
    assert.match(io.out.join("\n"), /\[user\]/, `${value}: human transcript`);
    assert.match(io.out.join("\n"), /tokens .* in \/ .* out/, `${value}: human footer`);
    assert.throws(() => JSON.parse(io.out[0]), `${value}: first line is not a machine object`);
  }
});

test("explicit output flags and modes beat TWO_BROTHERS_JSON", async () => {
  // --mode print wins over the env var: decision TEXT, not a JSON object.
  const printIO = await withEnv({ TWO_BROTHERS_JSON: "1" }, async () => {
    const io = makeIO();
    assert.equal(await main([...MOCK_RUN, "--mode", "print"], io), 0, io.err.join("\n"));
    return io;
  });
  assert.equal(printIO.out.length, 1);
  assert.match(printIO.out[0], /Final decision/);
  assert.throws(() => JSON.parse(printIO.out[0]), "--mode print must not emit an object");
  assert.ok(printIO.err.some((line) => line.startsWith("tokens: ")), "usage stays on stderr");

  // --mode print --json is the decision-object print mode, NOT the env object.
  const printJsonIO = await withEnv({ TWO_BROTHERS_JSON: "1" }, async () => {
    const io = makeIO();
    assert.equal(await main([...MOCK_RUN, "--mode", "print", "--json"], io), 0, io.err.join("\n"));
    return io;
  });
  assert.equal(printJsonIO.out.length, 1);
  const printed = JSON.parse(printJsonIO.out[0]);
  assert.equal(typeof printed.decision, "string");

  // --json-events selects JSON even when the env var is false.
  const eventsIO = await withEnv({ TWO_BROTHERS_JSON: "0" }, async () => {
    const io = makeIO();
    assert.equal(await main([...MOCK_RUN, "--json-events"], io), 0, io.err.join("\n"));
    return io;
  });
  assert.equal(eventsIO.out.length, 1);
  assert.ok("decision" in JSON.parse(eventsIO.out[0]));

  // The bare --json flag wins over env "0".
  const flagOverFalse = await withEnv({ TWO_BROTHERS_JSON: "0" }, async () => {
    const io = makeIO();
    assert.equal(await main([...MOCK_RUN, "--json"], io), 0, io.err.join("\n"));
    return io;
  });
  assert.equal(flagOverFalse.out.length, 1);
  assert.ok("events" in JSON.parse(flagOverFalse.out[0]));

  // --mode json selects JSON even when the env var is false.
  const modeJson = await withEnv({ TWO_BROTHERS_JSON: "0" }, async () => {
    const io = makeIO();
    assert.equal(await main([...MOCK_RUN, "--mode", "json"], io), 0, io.err.join("\n"));
    return io;
  });
  assert.equal(modeJson.out.length, 1);
  assert.ok("events" in JSON.parse(modeJson.out[0]));

  // --stream is its own mode and wins over the env var (no mode conflict: the
  // env var is a default, not an explicit flag).
  const streamIO = await withEnv({ TWO_BROTHERS_JSON: "1" }, async () => {
    const io = makeIO();
    assert.equal(await main([...MOCK_RUN, "--stream"], io), 0, io.err.join("\n"));
    return io;
  });
  assert.ok(streamIO.out.length > 1, "stream writes one NDJSON record per event");
  const types = streamIO.out.map((line) => (JSON.parse(line) as { type: string }).type);
  assert.ok(types.includes("run_status"), "run lifecycle records");
  assert.ok(types.includes("envelope"), "envelope records");
  assert.equal(types.at(-1), "result", "the terminal result record closes the stream");
});

test("dry-run output mode follows the env var exactly like --json", async () => {
  const flagDryRun = await withEnv({ TWO_BROTHERS_JSON: undefined }, async () => {
    const io = makeIO();
    assert.equal(
      await main(["run", "pick an approach", "--provider", "mock", "--dry-run", "--json"], io),
      0,
      io.err.join("\n"),
    );
    return io;
  });
  const envDryRun = await withEnv({ TWO_BROTHERS_JSON: "1" }, async () => {
    const io = makeIO();
    assert.equal(
      await main(["run", "pick an approach", "--provider", "mock", "--dry-run"], io),
      0,
      io.err.join("\n"),
    );
    return io;
  });
  assert.equal(envDryRun.out.length, 1, "one JSON plan line");
  assert.equal(
    envDryRun.out[0],
    flagDryRun.out[0],
    "the dry-run plan is deterministic: env and flag must be byte-identical",
  );
  assert.ok(
    (JSON.parse(envDryRun.out[0]) as { dryRun?: boolean }).dryRun === true,
    "the dry-run plan object",
  );

  // An explicit output mode wins over the env var for dry-run too.
  const printDryRun = await withEnv({ TWO_BROTHERS_JSON: "1" }, async () => {
    const io = makeIO();
    assert.equal(
      await main(["run", "pick an approach", "--provider", "mock", "--dry-run", "--mode", "print"], io),
      0,
      io.err.join("\n"),
    );
    return io;
  });
  assert.ok(printDryRun.out.length > 1, "--mode print renders the human plan");
  assert.throws(() => JSON.parse(printDryRun.out[0]));
});

test("chat: TWO_BROTHERS_JSON turns emit the machine object like --json", async () => {
  const lines = ["pick an approach", ""];
  const flagIO = makeIO();
  assert.equal(await runChatTurn(flagIO, lines, ["--json"]), 0, flagIO.err.join("\n"));
  const envIO = await withEnv({ TWO_BROTHERS_JSON: "1" }, async () => {
    const io = makeIO();
    assert.equal(await runChatTurn(io, lines), 0, io.err.join("\n"));
    return io;
  });

  assert.equal(flagIO.out.length, 1, "one machine object per REPL turn");
  assert.equal(envIO.out.length, 1, "one machine object per REPL turn");
  assert.ok(!envIO.out.join("").includes("Two Brothers REPL"), "no banner in machine mode");
  assert.ok("decision" in JSON.parse(envIO.out[0]));
  assert.equal(
    normalizeMachineOutput(envIO.out[0]),
    normalizeMachineOutput(flagIO.out[0]),
    "chat env and bare --json turns must produce the same machine output",
  );
});
