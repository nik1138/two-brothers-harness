#!/usr/bin/env node
/**
 * CLI for the Two Brothers harness. Mirrors the original prototype's CLI
 * (removed 2026-11-04; see git history).
 *
 *   node src/cli.ts run "<task>" [flags]
 *   node src/cli.ts chat [flags]
 *   node src/cli.ts selftest
 */
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

import { resolveConfig, type Config } from "./config.ts";
import { SharedContext } from "./context.ts";
import { TwoBrothersHarness } from "./harness.ts";
import { selftest } from "./selftest.ts";
import { restoreContext, SessionError, SessionStore } from "./session.ts";

const OPTIONS = {
  provider: { type: "string" as const },
  "base-url": { type: "string" as const },
  "api-key": { type: "string" as const },
  "senior-model": { type: "string" as const },
  "junior-model": { type: "string" as const },
  "senior-system": { type: "string" as const },
  "junior-system": { type: "string" as const },
  "max-rounds": { type: "string" as const },
  temperature: { type: "string" as const },
  timeout: { type: "string" as const },
  mode: { type: "string" as const },
  verbose: { type: "boolean" as const, default: false },
  json: { type: "boolean" as const, default: false },
  "session-file": { type: "string" as const },
  resume: { type: "boolean" as const, default: false },
};

const FLAG_TO_CONFIG: Record<string, string> = {
  provider: "provider",
  "base-url": "baseUrl",
  "api-key": "apiKey",
  "senior-model": "seniorModel",
  "junior-model": "juniorModel",
  "senior-system": "seniorSystem",
  "junior-system": "juniorSystem",
  "max-rounds": "maxRounds",
  temperature: "temperature",
  timeout: "timeout",
  mode: "mode",
  verbose: "verbose",
  json: "jsonOut",
  "session-file": "sessionFile",
  resume: "resume",
};

function renderMessages(messages: Array<Record<string, any>>, verbose: boolean): string {
  const out: string[] = [];
  for (const msg of messages) {
    const frm = msg.from;
    const to = msg.to;
    const kind = msg.kind;
    const payload = msg.payload ?? {};

    if (kind === "message" && frm === "user") {
      out.push(`[user]      ${payload.text ?? ""}`);
      continue;
    }

    out.push(`[${frm} -> ${to}] ${kind}`);
    if (verbose) out.push("    " + JSON.stringify(payload));

    if (kind === "consult") {
      out.push(`    ask: ${payload.ask ?? ""}`);
      out.push(`    expect: ${payload.expect ?? "proposal"}`);
    } else if (kind === "proposal") {
      out.push(`    title: ${payload.title ?? ""}`);
      out.push(`    answer: ${payload.answer ?? ""}`);
      if (payload.rationale) out.push(`    rationale: ${payload.rationale}`);
      if (payload.risks) {
        out.push("    risks:");
        for (const risk of payload.risks) out.push(`      - ${risk}`);
      }
      out.push(`    confidence: ${payload.confidence ?? ""}`);
      if (payload.asks) {
        out.push("    asks:");
        for (const ask of payload.asks) out.push(`      - ${ask}`);
      }
    } else if (kind === "delegation") {
      out.push(`    work: ${payload.work ?? ""}`);
      out.push("    acceptance:");
      for (const acceptance of payload.acceptance ?? []) out.push(`      - ${acceptance}`);
    } else if (kind === "deliverable") {
      out.push(`    result: ${payload.result ?? ""}`);
      if (payload.artifacts) {
        out.push("    artifacts:");
        for (const artifact of payload.artifacts) out.push(`      - ${artifact}`);
      }
      out.push(`    confidence: ${payload.confidence ?? ""}`);
    } else if (kind === "review") {
      out.push(`    verdict: ${payload.verdict ?? ""}`);
      out.push(`    notes: ${payload.notes ?? ""}`);
    } else if (kind === "decision") {
      out.push(`    decision: ${payload.decision ?? ""}`);
      out.push(`    rationale: ${payload.rationale ?? ""}`);
      out.push(`    confidence: ${payload.confidence ?? ""}`);
      out.push(`    dissent: ${payload.dissent ?? "(none)"}`);
      if (payload.accepted_proposals) {
        out.push("    accepted_proposals:");
        for (const proposal of payload.accepted_proposals) out.push(`      - ${proposal}`);
      }
    }
  }
  return out.join("\n");
}

function argsToConfigArgs(values: Record<string, any>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [flag, configKey] of Object.entries(FLAG_TO_CONFIG)) {
    if (values[flag] !== undefined) result[configKey] = values[flag];
  }
  return result;
}

function openSession(cfg: Config): SharedContext {
  if (!cfg.sessionFile) return new SharedContext();
  const store = new SessionStore(cfg.sessionFile);
  if (store.exists() && !cfg.resume) {
    throw new SessionError(
      `session file already exists: ${cfg.sessionFile} ` +
        "(use --resume to continue it, or delete it to start a new session)",
    );
  }
  if (cfg.resume) {
    if (store.exists()) return restoreContext(store);
    console.error(`[warn] no session to resume at ${cfg.sessionFile}; starting a new session`);
    return new SharedContext(store);
  }
  return new SharedContext(store);
}

async function runOnce(cfg: Config, task: string, context?: SharedContext): Promise<number> {
  const harness = new TwoBrothersHarness(cfg);
  const result = await harness.run(task, context);
  console.log(
    renderMessages(
      result.messages as unknown as Array<Record<string, any>>,
      cfg.verbose,
    ),
  );
  for (const err of result.errors) console.error(`[warn] ${err}`);
  if (cfg.jsonOut) console.log(JSON.stringify(result.decision));
  return 0;
}

async function doRun(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: OPTIONS,
  });
  const cfg = resolveConfig(argsToConfigArgs(values));
  const task = positionals.join(" ").trim();
  if (!task) {
    console.error("Error: no task given. Usage: run \"<task>\"");
    return 2;
  }
  try {
    const context = openSession(cfg);
    return await runOnce(cfg, task, context);
  } catch (exc) {
    if (exc instanceof SessionError) {
      console.error(`[error] ${exc.message}`);
      return 1;
    }
    throw exc;
  }
}

async function doChat(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: OPTIONS });
  const cfg = resolveConfig(argsToConfigArgs(values));
  let context: SharedContext;
  try {
    context = openSession(cfg);
  } catch (exc) {
    if (exc instanceof SessionError) {
      console.error(`[error] ${exc.message}`);
      return 1;
    }
    throw exc;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log("Two Brothers REPL. Enter a task (empty line or exit to quit).");
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const line = await rl.question("task> ");
    const trimmed = line.trim();
    if (!trimmed || ["exit", "quit", "q"].includes(trimmed.toLowerCase())) {
      rl.close();
      return 0;
    }
    await runOnce(cfg, trimmed, context);
    console.log();
  }
}

function printHelp(): void {
  console.log(`Two Brothers: a senior (arbiter) and a junior (advisor/executor).

Usage:
  two-brothers run "<task>" [flags]   one call: task -> cooperation -> decision
  two-brothers chat [flags]           REPL: many tasks in one session
  two-brothers selftest               offline check of the protocol and providers

Flags:
  --provider openai|mock
  --base-url <url>            --api-key <key>
  --senior-model <m>          --junior-model <m>
  --senior-system <text>      --junior-system <text>
  --max-rounds <n>            --temperature <f>   --timeout <s>
  --mode consult|work|auto
  --session-file <path>       --resume
  --verbose                   --json
`);
}

async function main(argv: string[]): Promise<number> {
  if (argv.length === 0) {
    printHelp();
    return 0;
  }
  const command = argv[0];
  if (command === "selftest") return selftest();
  if (command === "run") return doRun(argv.slice(1));
  if (command === "chat") return doChat(argv.slice(1));
  console.error(`Unknown command: ${command}`);
  printHelp();
  return 2;
}

main(process.argv.slice(2))
  .then((code) => {
    // Set exit code without force-killing the loop (keeps libuv handles clean).
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
