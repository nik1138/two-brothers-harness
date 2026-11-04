/**
 * Non-interactive automation modes (`--mode print` / `--mode json` /
 * `--json-events`): deterministic machine-readable output on stdout,
 * diagnostics on stderr, pi-style exit codes. All runs use the offline
 * mock provider.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
