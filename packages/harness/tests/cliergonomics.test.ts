/**
 * CLI ergonomics lane: `models` discovery, `onboard` settings writing,
 * `--max-tokens` / `--retries` / cost reporting, and the help/sessions
 * surface (`--help` per command, grouped/full help, did-you-mean diagnostics,
 * `sessions --json` and `sessions show`). Hermetic — discovery and the
 * end-to-end run talk to a local `node:http` stub on 127.0.0.1, onboarding
 * writes into a temp directory and the session fixtures live under temp.
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import { costLine, estimateRunCost, main, mcpConfigFromValues, OPTIONS, type CliIO } from "../src/cli.ts";
import { commandHelp, COMMAND_ORDER, FLAGS } from "../src/clihelp.ts";
import { maxTokensForRole, resolveConfig, type Config } from "../src/config.ts";
import {
  buildConfigView,
  renderConfigView,
  type ConfigView,
} from "../src/configview.ts";
import {
  AnthropicProvider,
  GoogleProvider,
  OpenAICompatibleProvider,
  type FetchLike,
  type ModelProviderConfig,
} from "../src/provider.ts";
import { seedPresets } from "../src/presets.ts";
import {
  SettingsStore,
  type SettingsSnapshot,
} from "../src/settings_store.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeIO(): CliIO & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (line) => out.push(line), error: (line) => err.push(line) };
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-cli-ergonomics-"));
  try {
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

interface RecordedRequest {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

interface StubServer {
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

/** A local HTTP stub: records every request, answers with `handler`'s JSON. */
async function startServer(
  handler: (request: RecordedRequest) => { status?: number; body: unknown },
): Promise<StubServer> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      let body: any = undefined;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      const request: RecordedRequest = { path: req.url ?? "", headers: req.headers, body };
      requests.push(request);
      const result = handler(request);
      res.writeHead(result.status ?? 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ---------------------------------------------------------------------------
// `models` discovery
// ---------------------------------------------------------------------------

test("models: compact id/owned_by table, Bearer auth, no key echoed", async () => {
  const server = await startServer(() => ({
    body: {
      data: [
        { id: "gpt-4o", owned_by: "openai" },
        { id: "gpt-4o-mini", owned_by: "openai" },
      ],
    },
  }));
  const io = makeIO();
  try {
    const code = await main(
      ["models", "--base-url", `${server.url}/v1`, "--api-key", "sk-models-secret"],
      io,
    );
    assert.equal(code, 0, io.err.join("\n"));
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0].path, "/v1/models");
    assert.equal(server.requests[0].headers.authorization, "Bearer sk-models-secret");
    assert.match(io.out[0], /^id\s+owned_by$/);
    assert.ok(io.out.some((line) => /^gpt-4o\s+openai$/.test(line)), io.out.join("\n"));
    assert.ok(io.out.some((line) => /^gpt-4o-mini\s+openai$/.test(line)), io.out.join("\n"));
    const printed = [...io.out, ...io.err].join("\n");
    assert.ok(!printed.includes("sk-models-secret"), "the key never appears in output");
  } finally {
    await server.close();
  }
});

test("models --json: one array of {id, owned_by}", async () => {
  const server = await startServer(() => ({
    body: { data: [{ id: "deepseek-chat", owned_by: "deepseek" }] },
  }));
  const io = makeIO();
  try {
    const code = await main(["models", "--base-url", server.url, "--json"], io);
    assert.equal(code, 0, io.err.join("\n"));
    assert.equal(io.out.length, 1);
    assert.deepEqual(JSON.parse(io.out[0]), [{ id: "deepseek-chat", owned_by: "deepseek" }]);
  } finally {
    await server.close();
  }
});

test("models: no owner labels -> a plain id list", async () => {
  const server = await startServer(() => ({ body: [{ id: "local-model" }] }));
  const io = makeIO();
  try {
    const code = await main(["models", "--base-url", server.url], io);
    assert.equal(code, 0, io.err.join("\n"));
    assert.deepEqual(io.out, ["local-model"]);
  } finally {
    await server.close();
  }
});

test("models: an empty endpoint result is a friendly line, exit 0", async () => {
  const server = await startServer(() => ({ body: { data: [] } }));
  const io = makeIO();
  try {
    const code = await main(["models", "--base-url", server.url], io);
    assert.equal(code, 0);
    assert.deepEqual(io.out, [`no models reported by ${server.url}`]);
  } finally {
    await server.close();
  }
});

test("models: HTTP errors exit 1 with a clean message", async () => {
  const server = await startServer(() => ({ status: 401, body: { error: { message: "bad key" } } }));
  const io = makeIO();
  try {
    const code = await main(["models", "--base-url", server.url], io);
    assert.equal(code, 1);
    assert.match(io.err.join("\n"), /\[error\] HTTP 401/);
    assert.deepEqual(io.out, []);
  } finally {
    await server.close();
  }
});

test("models: connection refused exits 1 with `cannot reach`", async () => {
  const io = makeIO();
  const code = await main(["models", "--base-url", "http://127.0.0.1:9/v1"], io);
  assert.equal(code, 1);
  assert.equal(io.out.length, 0);
  assert.match(io.err[0], /^\[error\] cannot reach http:\/\/127\.0\.0\.1:9\/v1\/models/);
});

test("models: missing --base-url and a missing key env var are usage errors (exit 2)", async () => {
  const io = makeIO();
  assert.equal(await main(["models"], io), 2);
  assert.match(io.err.join("\n"), /Usage: models --base-url/);

  const io2 = makeIO();
  const code = await main(
    ["models", "--base-url", "http://127.0.0.1:9/v1", "--api-key-env", "TB_TEST_UNSET_KEY_ENV"],
    io2,
  );
  assert.equal(code, 2);
  assert.match(io2.err.join("\n"), /TB_TEST_UNSET_KEY_ENV is not set/);
});

// ---------------------------------------------------------------------------
// `onboard` settings writing
// ---------------------------------------------------------------------------

test("onboard --non-interactive: writes role settings, masks the key", async () => {
  await withTempDir(async (dir) => {
    const io = makeIO();
    const secret = "sk-onboard-secret-42";
    const code = await main(
      [
        "onboard",
        "--sessions-dir",
        dir,
        "--base-url",
        "http://example.test/v1",
        "--senior-model",
        "gpt-4o",
        "--junior-model",
        "gpt-4o-mini",
        "--api-key",
        secret,
        "--non-interactive",
      ],
      io,
    );
    assert.equal(code, 0, io.err.join("\n"));
    const file = path.join(dir, "settings.json");
    assert.ok(fs.existsSync(file), "settings.json written");
    assert.ok(
      io.out.some((line) => line.startsWith("wrote ") && line.includes("settings.json")),
      io.out.join("\n"),
    );

    const store = new SettingsStore(file);
    const settings = store.read();
    assert.equal(settings.senior?.provider, "openai");
    assert.equal(settings.senior?.base_url, "http://example.test/v1");
    assert.equal(settings.senior?.model, "gpt-4o");
    assert.equal(settings.senior?.api_key, secret, "key round-trips through the store");
    assert.equal(settings.junior?.model, "gpt-4o-mini");
    assert.equal(store.public().senior.api_key_set, true);

    const printed = [...io.out, ...io.err].join("\n");
    assert.ok(!printed.includes(secret), "the key is never printed back");
    assert.match(printed, /api-key=\(set\)/);
    assert.ok(!fs.readFileSync(file, "utf-8").includes(secret), "key is encrypted at rest");
  });
});

test("onboard: --preset supplies the base url and default models", async () => {
  await withTempDir(async (dir) => {
    const io = makeIO();
    const code = await main(
      ["onboard", "--sessions-dir", dir, "--preset", "lmstudio", "--non-interactive"],
      io,
    );
    assert.equal(code, 0, io.err.join("\n"));
    const settings = new SettingsStore(path.join(dir, "settings.json")).read();
    assert.equal(settings.senior?.base_url, "http://localhost:1234/v1");
    assert.equal(settings.senior?.model, "spark-x2.6-4b@q4_k_m");
    assert.equal(settings.junior?.model, "lfm3-1.7b");
    assert.equal(settings.senior?.api_key, undefined, "no key stored without --api-key");
  });
});

test("onboard: a native-family preset notes the wire family it needs", async () => {
  await withTempDir(async (dir) => {
    const io = makeIO();
    const code = await main(
      ["onboard", "--sessions-dir", dir, "--preset", "anthropic", "--non-interactive"],
      io,
    );
    assert.equal(code, 0, io.err.join("\n"));
    assert.match(io.out.join("\n"), /--provider-kind anthropic/);
  });
});

test("onboard: interactive prompts work from piped input (scripted onboarding)", async () => {
  await withTempDir(async (dir) => {
    const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const result = spawnSync(process.execPath, [cli, "onboard", "--sessions-dir", dir], {
      // preset (blank) → base url (default) → senior model → junior model
      input: "\n\nmodel-a\nmodel-b\n",
      encoding: "utf-8",
      timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /base url \[http:\/\/localhost:1234\/v1\]/);
    assert.match(result.stdout, /wrote /);
    const settings = new SettingsStore(path.join(dir, "settings.json")).read();
    assert.equal(settings.senior?.base_url, "http://localhost:1234/v1");
    assert.equal(settings.senior?.model, "model-a");
    assert.equal(settings.junior?.model, "model-b");
  });
});

test("onboard: missing base url / unknown preset / missing models exit 2", async () => {
  await withTempDir(async (dir) => {
    const io = makeIO();
    const code = await main(
      ["onboard", "--sessions-dir", dir, "--non-interactive", "--senior-model", "a", "--junior-model", "b"],
      io,
    );
    assert.equal(code, 2);
    assert.match(io.err.join("\n"), /no base url/);

    const io2 = makeIO();
    assert.equal(
      await main(["onboard", "--sessions-dir", dir, "--preset", "nope", "--non-interactive"], io2),
      2,
    );
    assert.match(io2.err.join("\n"), /unknown preset: nope/);

    const io3 = makeIO();
    const code3 = await main(
      ["onboard", "--sessions-dir", dir, "--base-url", "http://localhost:1234/v1", "--non-interactive"],
      io3,
    );
    assert.equal(code3, 2);
    assert.match(io3.err.join("\n"), /no model ids/);
    assert.ok(!fs.existsSync(path.join(dir, "settings.json")), "a failed onboard writes nothing");
  });
});

// ---------------------------------------------------------------------------
// `--max-tokens` config and provider wiring
// ---------------------------------------------------------------------------

function withCleanMaxTokenEnv(fn: () => void): void {
  const keys = [
    "TWO_BROTHERS_MAX_TOKENS",
    "TWO_BROTHERS_SENIOR_MAX_TOKENS",
    "TWO_BROTHERS_JUNIOR_MAX_TOKENS",
  ];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  try {
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("--max-tokens: flag parsing, validation and per-role env overrides", () => {
  withCleanMaxTokenEnv(() => {
    assert.equal(resolveConfig({ maxTokens: "321" }).maxTokens, 321);
    assert.equal(maxTokensForRole(resolveConfig({ maxTokens: "321" }), "senior"), 321);
    assert.equal(maxTokensForRole(resolveConfig({ maxTokens: "321" }), "junior"), 321);
    assert.throws(() => resolveConfig({ maxTokens: "abc" }), /invalid max tokens/);
    assert.throws(() => resolveConfig({ maxTokens: "0" }), /invalid max tokens/);

    process.env.TWO_BROTHERS_MAX_TOKENS = "200";
    process.env.TWO_BROTHERS_SENIOR_MAX_TOKENS = "50";
    const cfg = resolveConfig({});
    assert.equal(cfg.maxTokens, 200);
    assert.equal(maxTokensForRole(cfg, "senior"), 50, "role env override wins");
    assert.equal(maxTokensForRole(cfg, "junior"), 200, "other role keeps the run-level cap");
  });
});

function baseProviderConfig(overrides: Partial<ModelProviderConfig> = {}): ModelProviderConfig {
  return {
    provider: "openai",
    baseUrl: "http://stub.test/v1",
    apiKey: "k",
    seniorModel: "",
    juniorModel: "",
    model: "gpt-4o",
    temperature: 0.4,
    timeout: 5,
    retries: 0,
    ...overrides,
  };
}

/** Answers each family's wire shape and records request bodies. */
function shapeAwareFetch(): { fetchImpl: FetchLike; urls: string[]; bodies: any[] } {
  const urls: string[] = [];
  const bodies: any[] = [];
  return {
    urls,
    bodies,
    fetchImpl: async (url, init) => {
      urls.push(url);
      bodies.push(JSON.parse(String(init.body)));
      let payload: unknown;
      if (url.includes("/messages")) {
        payload = { content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } };
      } else if (url.includes(":generateContent")) {
        payload = {
          candidates: [{ content: { parts: [{ text: "ok" }] } }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        };
      } else {
        payload = {
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        };
      }
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  };
}

test("provider bodies: all three adapters send the configured output cap", async () => {
  const messages = [{ role: "user" as const, content: "hi" }];

  const openai = shapeAwareFetch();
  await new OpenAICompatibleProvider(
    baseProviderConfig({ fetchImpl: openai.fetchImpl, maxTokens: 321 }),
  ).chat(messages);
  assert.equal(openai.bodies[0].max_tokens, 321);
  assert.equal(openai.bodies[0].model, "gpt-4o");

  const openaiDefault = shapeAwareFetch();
  await new OpenAICompatibleProvider(baseProviderConfig({ fetchImpl: openaiDefault.fetchImpl })).chat(
    messages,
  );
  assert.ok(!("max_tokens" in openaiDefault.bodies[0]), "unset cap leaves the field off the wire");

  const anthropic = shapeAwareFetch();
  await new AnthropicProvider(
    baseProviderConfig({ fetchImpl: anthropic.fetchImpl, maxTokens: 77 }),
  ).chat(messages);
  assert.equal(anthropic.bodies[0].max_tokens, 77);

  const google = shapeAwareFetch();
  await new GoogleProvider(
    baseProviderConfig({ fetchImpl: google.fetchImpl, maxTokens: 99 }),
  ).chat(messages);
  assert.equal(google.bodies[0].generationConfig.maxOutputTokens, 99);

  const googleDefault = shapeAwareFetch();
  await new GoogleProvider(baseProviderConfig({ fetchImpl: googleDefault.fetchImpl })).chat(messages);
  assert.ok(!("maxOutputTokens" in googleDefault.bodies[0].generationConfig));
});

// ---------------------------------------------------------------------------
// usage splits + cost line / JSON
// ---------------------------------------------------------------------------

test("costLine: format, and no estimate for mixed or unknown models", () => {
  const same = resolveConfig({ provider: "mock", seniorModel: "gpt-4o", juniorModel: "gpt-4o" });
  assert.equal(
    costLine(same, { input_tokens: 4000, output_tokens: 2000 }),
    "cost: $0.0300 (in 4000 / out 2000 tokens)",
  );
  assert.equal(
    estimateRunCost(same, { input_tokens: 1000, output_tokens: 500 })?.totalCost,
    0.0075,
  );

  const mixed = resolveConfig({
    provider: "mock",
    seniorModel: "gpt-4o",
    juniorModel: "gpt-4o-mini",
  });
  assert.equal(costLine(mixed, { input_tokens: 1, output_tokens: 1 }), null);

  const unknown = resolveConfig({ provider: "mock", seniorModel: "mystery", juniorModel: "mystery" });
  assert.equal(costLine(unknown, { input_tokens: 5, output_tokens: 5 }), null);
});

test("run --mode json: usage splits and cost survive the mocked run (cost null without a model)", async () => {
  const io = makeIO();
  const code = await main(["run", "pick an approach", "--provider", "mock", "--mode", "json"], io);
  assert.equal(code, 0, io.err.join("\n"));
  const parsed = JSON.parse(io.out[0]);
  assert.ok(parsed.usage.input_tokens > 0, "prompt-token split present");
  assert.ok(parsed.usage.output_tokens > 0, "completion-token split present");
  assert.equal(parsed.cost, null, "mock runs name no model");
});

test("run: --max-tokens rides every request; cost estimates from the usage splits", async () => {
  // One union payload satisfies every node's schema (sanitize drops the
  // extra keys), so the stub run needs no repair round-trips: 4 calls.
  const payload = {
    text: "ok",
    task: "pick an approach",
    ask: "what is best?",
    expect: "proposal",
    title: "Plan",
    answer: "Do it",
    rationale: "because",
    risks: [],
    asks: [],
    confidence: 0.7,
    work: "do part",
    acceptance: ["done"],
    return: "deliverable",
    result: "done",
    artifacts: [],
    notes: "ok",
    verdict: "accept",
    points: [],
    decision: "ok",
    dissent: null,
    accepted_proposals: ["Plan"],
  };
  const server = await startServer(() => ({
    body: {
      choices: [{ message: { content: JSON.stringify(payload) } }],
      usage: { prompt_tokens: 1000, completion_tokens: 500 },
    },
  }));
  const io = makeIO();
  try {
    const code = await main(
      [
        "run",
        "pick an approach",
        "--provider",
        "openai",
        "--base-url",
        `${server.url}/v1`,
        "--api-key",
        "sk-run-secret",
        "--senior-model",
        "gpt-4o",
        "--junior-model",
        "gpt-4o",
        "--max-tokens",
        "321",
        "--mode",
        "json",
      ],
      io,
    );
    assert.equal(code, 0, io.err.join("\n"));
    assert.equal(io.out.length, 1, io.out.join("\n"));
    const parsed = JSON.parse(io.out[0]);
    assert.equal(parsed.usage.model_calls, 4);
    assert.equal(parsed.usage.input_tokens, 4000);
    assert.equal(parsed.usage.output_tokens, 2000);
    assert.ok(parsed.cost, "known model yields a cost estimate");
    assert.equal(parsed.cost.model, "gpt-4o");
    assert.equal(parsed.cost.currency, "USD");
    assert.ok(Math.abs(parsed.cost.totalCost - 0.03) < 1e-9, String(parsed.cost.totalCost));

    assert.equal(server.requests.length, 4);
    for (const request of server.requests) {
      assert.equal(request.path, "/v1/chat/completions");
      assert.equal(request.body.max_tokens, 321);
      assert.equal(request.body.model, "gpt-4o");
      assert.equal(request.headers.authorization, "Bearer sk-run-secret");
    }
    assert.ok(!io.out.join("\n").includes("sk-run-secret"));
  } finally {
    await server.close();
  }
});

test("--help lists the new commands and the max-tokens flag", async () => {
  const io = makeIO();
  assert.equal(await main(["--help"], io), 0);
  const text = io.out.join("\n");
  assert.match(text, /two-brothers models/);
  assert.match(text, /two-brothers onboard/);
  assert.match(text, /--max-tokens/);
  assert.match(text, /--retries <n>.*default 6;/s);
  assert.match(text, /TWO_BROTHERS_RETRIES/);
  assert.match(text, /two-brothers --version/);
});

test("--version (and -v) print exactly the package version, exit 0", async () => {
  const pkg = JSON.parse(
    fs.readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf-8"),
  ) as { version: string };
  for (const flag of ["--version", "-v"]) {
    const io = makeIO();
    assert.equal(await main([flag], io), 0);
    assert.deepEqual(io.out, [pkg.version], `${flag} prints exactly the version`);
    assert.deepEqual(io.err, [], `${flag} keeps stderr clean`);
  }
});

// ---------------------------------------------------------------------------
// `--retries` on `run` + run usage-error exit codes
// ---------------------------------------------------------------------------

function failingRunArgs(serverUrl: string, retries: string): string[] {
  return [
    "run",
    "pick an approach",
    "--provider",
    "openai",
    "--base-url",
    `${serverUrl}/v1`,
    "--senior-model",
    "gpt-4o",
    "--junior-model",
    "gpt-4o",
    "--retries",
    retries,
  ];
}

test("run --retries is accepted and maps to the provider attempt budget", async () => {
  // A 500 is classified retryable, so the attempt count proves the flag
  // reached the provider: 0 -> one attempt, 1 -> two (one backoff wait).
  // A persistently failing endpoint is a runtime failure: the script entry
  // maps the rejected run to exit 1.
  const server = await startServer(() => ({
    status: 500,
    body: { error: { message: "boom" } },
  }));
  try {
    const io0 = makeIO();
    await assert.rejects(main(failingRunArgs(server.url, "0"), io0), /HTTP 500/);
    assert.equal(server.requests.length, 1, "--retries 0 = a single attempt");

    const io1 = makeIO();
    await assert.rejects(main(failingRunArgs(server.url, "1"), io1), /HTTP 500/);
    assert.equal(server.requests.length, 3, "--retries 1 = one retry after the first attempt");
  } finally {
    await server.close();
  }
});

test("run --retries accepts mock runs", async () => {
  const io = makeIO();
  const code = await main(["run", "pick an approach", "--provider", "mock", "--retries", "1"], io);
  assert.equal(code, 0, io.err.join("\n"));
  assert.match(io.out.join("\n"), /decision:/);
});

test("run: an unknown option is a usage error (exit 2) with a usage line", async () => {
  const io = makeIO();
  const code = await main(["run", "pick an approach", "--provider", "mock", "--bogus"], io);
  assert.equal(code, 2);
  assert.match(io.err[0], /^\[error\] Unknown option '--bogus'/);
  assert.match(io.err[1], /Usage: two-brothers run "<task>" \[flags\]/);
  assert.deepEqual(io.out, [], "nothing ran — no transcript on stdout");
});

// ---------------------------------------------------------------------------
// help catalog: per-command help, grouped help, full reference
// ---------------------------------------------------------------------------

/** The commands this CLI batch gives first-class help (requirement: all but
 * `help`, which is covered through `help --all` and `--help`). */
const HELP_COMMANDS = [
  "run",
  "chat",
  "tui",
  "serve",
  "sessions",
  "models",
  "onboard",
  "doctor",
  "config",
  "completions",
  "selftest",
] as const;

test("every command: --help and -h print command help on stdout, exit 0", async () => {
  for (const command of HELP_COMMANDS) {
    for (const flag of ["--help", "-h"]) {
      const io = makeIO();
      const code = await main([command, flag], io);
      const label = `${command} ${flag}`;
      assert.equal(code, 0, `${label}: ${io.err.join("\n")}`);
      assert.deepEqual(io.err, [], `${label} keeps stderr clean`);
      const text = io.out.join("\n");
      assert.match(text, new RegExp(`Usage: two-brothers ${command}\\b`), label);
      assert.match(text, /Flags:/, `${label} lists flags`);
      assert.match(
        text,
        /Run 'two-brothers help --all' for the full reference\./,
        `${label} points at the full reference`,
      );
    }
  }
});

test("serve --help documents the compaction budgets web runs honour", async () => {
  const io = makeIO();
  assert.equal(await main(["serve", "--help"], io), 0);
  const text = io.out.join("\n");
  for (const flag of [
    "--compact",
    "--compact-threshold",
    "--compact-threshold-tokens",
    "--compact-keep-recent",
    "--context-window",
  ]) {
    assert.match(text, new RegExp(`${flag}(?![\\w-])`), `serve help lists ${flag}`);
  }
  assert.match(text, /auto-compact/, "serve help says what the budgets drive");
});

test("help <command> prints that command's help, exit 0", async () => {
  for (const command of HELP_COMMANDS) {
    const io = makeIO();
    assert.equal(await main(["help", command], io), 0, command);
    assert.deepEqual(io.err, [], `${command} keeps stderr clean`);
    const text = io.out.join("\n");
    assert.match(text, new RegExp(`Usage: two-brothers ${command}\\b`), command);
    if (command === "tui") {
      // `help tui` and `tui --help` share the generated key guide.
      assert.match(text, /Keys:/, "help tui includes the key guide");
      assert.match(text, /PgUp \/ PgDn/, "help tui includes the keymap registry rows");
    }
  }
});

test("help: concise grouped overview with the documented sections", async () => {
  const io = makeIO();
  assert.equal(await main(["help"], io), 0);
  assert.deepEqual(io.err, []);
  const text = io.out.join("\n");
  for (const heading of [
    "Commands:",
    "Common flows:",
    "Output modes:",
    "Provider & models:",
    "Sessions & context:",
    "Extensions:",
    "Environment:",
  ]) {
    assert.ok(text.includes(heading), `missing section ${heading}:\n${text}`);
  }
  assert.match(text, /two-brothers run "<task>"/);
  assert.match(text, /two-brothers help --all/);
  assert.ok(!text.includes("Return codes:"), "the grouped help is not the full reference");
});

test("help --all: full reference covers every command, flags, env and exit codes", async () => {
  const io = makeIO();
  assert.equal(await main(["help", "--all"], io), 0);
  assert.deepEqual(io.err, []);
  const text = io.out.join("\n");
  assert.match(text, /full reference/i);
  for (const command of [...COMMAND_ORDER]) {
    assert.ok(
      text.includes(`  Usage: two-brothers ${command}`),
      `full reference misses ${command}:\n${text.slice(0, 400)}`,
    );
  }
  assert.match(text, /Environment variables/);
  assert.match(text, /TWO_BROTHERS_RETRIES/);
  assert.match(text, /Return codes:/);
  assert.match(text, /2  usage error/);
});

test("help catalog covers every flag the shared parser accepts", () => {
  for (const flag of Object.keys(OPTIONS)) {
    assert.ok(flag in FLAGS, `clihelp FLAGS is missing --${flag}`);
  }
  for (const command of COMMAND_ORDER) {
    const spec = commandHelp(command);
    assert.ok(spec, `missing help spec for ${command}`);
    for (const flag of [...spec.flags, ...(spec.acceptedFlags ?? [])]) {
      assert.ok(flag in FLAGS, `${command} help references unknown flag --${flag}`);
    }
  }
});

// ---------------------------------------------------------------------------
// unknown command / unknown option diagnostics
// ---------------------------------------------------------------------------

test("unknown command: exit 2, stderr diagnostic + suggestion, no full-help dump", async () => {
  const io = makeIO();
  assert.equal(await main(["rnu"], io), 2);
  assert.equal(io.err[0], "Unknown command: rnu");
  assert.ok(io.err.includes("Did you mean 'run'?"), io.err.join("\n"));
  assert.ok(
    io.err.includes("Run 'two-brothers help' for the command list."),
    io.err.join("\n"),
  );
  const stdout = io.out.join("\n");
  assert.match(stdout, /two-brothers run "<task>"/, "brief usage stays on stdout");
  assert.ok(!stdout.includes("Commands:"), "no full help dump on stdout");
  assert.ok(!stdout.includes("Common flows:"), "no full help dump on stdout");
  assert.ok(stdout.split("\n").length <= 10, "stdout stays brief");

  // A name farther than edit distance 2 gets no did-you-mean line.
  const far = makeIO();
  assert.equal(await main(["frobnicate"], far), 2);
  assert.ok(
    !far.err.some((line) => line.startsWith("Did you mean")),
    far.err.join("\n"),
  );
});

test("unknown option: exit 2 with a nearest-flag suggestion for every command", async () => {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ["run", "--providr", "--provider"],
    ["run", "--dryrun", "--dry-run"],
    ["run", "--task-fil", "--task-file"],
    ["run", "--hlep", "--help"],
    ["chat", "--providr", "--provider"],
    ["tui", "--providr", "--provider"],
    ["serve", "--por", "--port"],
    ["sessions", "--sesions-dir", "--sessions-dir"],
    ["models", "--base-ur", "--base-url"],
    ["onboard", "--presett", "--preset"],
    ["config", "--jsn", "--json"],
    ["config", "--providr", "--provider"],
    ["selftest", "--hlep", "--help"],
    ["help", "--al", "--all"],
  ];
  for (const [command, unknown, nearest] of cases) {
    const io = makeIO();
    const code = await main([command, unknown], io);
    assert.equal(code, 2, `${command} ${unknown}`);
    assert.equal(io.err[0], `[error] Unknown option '${unknown}'`, `${command} ${unknown}`);
    assert.ok(
      io.err.some((line) => line === `Did you mean '${nearest}'?`),
      `${command} ${unknown}: ${io.err.join("\n")}`,
    );
    assert.ok(
      io.err.some((line) => line.startsWith("Usage: ")),
      `${command} ${unknown} prints usage`,
    );
    assert.deepEqual(io.out, [], `${command} ${unknown} prints nothing on stdout`);
  }

  const top = makeIO();
  assert.equal(await main(["--bogus"], top), 2);
  assert.match(top.err[0], /^\[error\] Unknown option '--bogus'/);
  assert.match(top.err.join("\n"), /Run 'two-brothers --help'\./);
});

test("missing option value: exit 2 with usage instead of an uncaught error", async () => {
  const io = makeIO();
  assert.equal(await main(["run", "a task", "--provider"], io), 2);
  assert.match(io.err.join("\n"), /Usage: two-brothers run "<task>" \[flags\]/);
  assert.deepEqual(io.out, []);
});

// ---------------------------------------------------------------------------
// `sessions --json` / `sessions show`
// ---------------------------------------------------------------------------

/** One protocol envelope line for the session fixtures. */
function sessionEnvelope(
  seq: number,
  from: string,
  to: string,
  kind: string,
  payload: Record<string, unknown>,
): string {
  return JSON.stringify({
    v: 1,
    id: `id-${seq}`,
    seq,
    ts: "2026-11-01T00:00:00Z",
    from,
    to,
    kind,
    payload,
  });
}

/** Two session files (3 envelopes, 1 envelope) plus an ignored non-JSONL. */
function writeSessionFixtures(dir: string): void {
  fs.writeFileSync(
    path.join(dir, "alpha.jsonl"),
    [
      sessionEnvelope(1, "user", "senior", "message", { text: "Alpha task" }),
      sessionEnvelope(2, "senior", "junior", "consult", {
        task: "t",
        ask: "a",
        expect: "proposal",
      }),
      sessionEnvelope(3, "junior", "senior", "proposal", {
        title: "Plan",
        answer: "Do it",
      }),
    ].join("\n") + "\n",
    "utf-8",
  );
  fs.writeFileSync(
    path.join(dir, "beta.jsonl"),
    sessionEnvelope(1, "user", "senior", "message", { text: "Beta task" }) + "\n",
    "utf-8",
  );
  fs.writeFileSync(path.join(dir, "notes.txt"), "not a session\n", "utf-8");
}

test("sessions --json: a stable array of session summaries", async () => {
  await withTempDir(async (dir) => {
    writeSessionFixtures(dir);
    const io = makeIO();
    assert.equal(await main(["sessions", "--sessions-dir", dir, "--json"], io), 0);
    assert.deepEqual(io.err, []);
    assert.equal(io.out.length, 1, "one JSON document on stdout");
    const parsed = JSON.parse(io.out[0]) as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(parsed), "list JSON is an array");
    assert.deepEqual(
      parsed.map((item) => item.name),
      ["alpha.jsonl", "beta.jsonl"],
    );
    assert.deepEqual(Object.keys(parsed[0]), [
      "name",
      "title",
      "envelopes",
      "updated",
      "error",
    ]);
    assert.equal(parsed[0].title, "Alpha task");
    assert.equal(parsed[0].envelopes, 3);
    assert.equal(parsed[0].error, null);
    assert.match(String(parsed[0].updated), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

test("sessions --json: an empty/missing directory is an empty array, exit 0", async () => {
  await withTempDir(async (dir) => {
    const io = makeIO();
    assert.equal(await main(["sessions", "--sessions-dir", dir, "--json"], io), 0);
    assert.deepEqual(JSON.parse(io.out[0]), []);
    const missing = makeIO();
    assert.equal(
      await main(["sessions", "--sessions-dir", path.join(dir, "missing"), "--json"], missing),
      0,
    );
    assert.deepEqual(JSON.parse(missing.out[0]), []);
  });
});

test("sessions --limit caps the listed rows (human and JSON)", async () => {
  await withTempDir(async (dir) => {
    writeSessionFixtures(dir);
    const json = makeIO();
    assert.equal(await main(["sessions", "--sessions-dir", dir, "--json", "--limit", "1"], json), 0);
    const parsed = JSON.parse(json.out[0]) as Array<{ name: string }>;
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].name, "alpha.jsonl");

    const human = makeIO();
    assert.equal(await main(["sessions", "--sessions-dir", dir, "--limit", "1"], human), 0);
    assert.equal(human.out.length, 2, "header + one row");
    assert.match(human.out[1], /^alpha\.jsonl/);
  });
});

test("sessions show: human summary + envelopes, name with or without .jsonl", async () => {
  await withTempDir(async (dir) => {
    writeSessionFixtures(dir);
    for (const name of ["alpha", "alpha.jsonl"]) {
      const io = makeIO();
      assert.equal(await main(["sessions", "show", name, "--sessions-dir", dir], io), 0, name);
      assert.deepEqual(io.err, []);
      const text = io.out.join("\n");
      assert.equal(io.out[0], "session: alpha.jsonl");
      assert.match(text, /title: Alpha task/);
      assert.match(text, /envelopes: 3/);
      assert.match(text, /events:/);
      assert.match(text, /user -> senior message — Alpha task/);
      assert.match(text, /junior -> senior proposal — Plan — Do it/);
    }
  });
});

test("sessions show --json: one object with the session summary and events", async () => {
  await withTempDir(async (dir) => {
    writeSessionFixtures(dir);
    const io = makeIO();
    assert.equal(
      await main(["sessions", "show", "alpha", "--sessions-dir", dir, "--json"], io),
      0,
    );
    assert.deepEqual(io.err, []);
    assert.equal(io.out.length, 1, "one JSON document on stdout");
    const parsed = JSON.parse(io.out[0]) as {
      name: string;
      title: string;
      envelopes: number;
      error: string | null;
      events: Array<{ kind: string; seq: number }>;
    };
    assert.equal(typeof parsed, "object");
    assert.equal(parsed.name, "alpha.jsonl");
    assert.equal(parsed.title, "Alpha task");
    assert.equal(parsed.envelopes, 3);
    assert.equal(parsed.error, null);
    assert.ok(Array.isArray(parsed.events));
    assert.deepEqual(
      parsed.events.map((event) => event.kind),
      ["message", "consult", "proposal"],
    );
    assert.deepEqual(
      parsed.events.map((event) => event.seq),
      [1, 2, 3],
    );

    const limited = makeIO();
    assert.equal(
      await main(
        ["sessions", "show", "alpha", "--sessions-dir", dir, "--json", "--limit", "2"],
        limited,
      ),
      0,
    );
    const limitedParsed = JSON.parse(limited.out[0]) as { events: unknown[] };
    assert.equal(limitedParsed.events.length, 2);
  });
});

test("sessions show --limit caps the printed envelopes", async () => {
  await withTempDir(async (dir) => {
    writeSessionFixtures(dir);
    const io = makeIO();
    assert.equal(
      await main(["sessions", "show", "alpha", "--sessions-dir", dir, "--limit", "1"], io),
      0,
    );
    const text = io.out.join("\n");
    assert.equal(
      io.out.filter((line) => line.includes(" -> ")).length,
      1,
      "only one envelope line",
    );
    assert.match(text, /Alpha task/);
    assert.ok(!text.includes("proposal"), text);
    assert.match(text, /… 2 more envelope\(s\); raise --limit to see them/);
  });
});

test("sessions show: unknown session and missing name exit 2 with a clear message", async () => {
  await withTempDir(async (dir) => {
    writeSessionFixtures(dir);

    const unknown = makeIO();
    assert.equal(await main(["sessions", "show", "nope", "--sessions-dir", dir], unknown), 2);
    assert.match(unknown.err.join("\n"), /Unknown session: nope/);
    assert.deepEqual(unknown.out, []);

    const unknownJson = makeIO();
    assert.equal(
      await main(["sessions", "show", "nope", "--sessions-dir", dir, "--json"], unknownJson),
      2,
    );
    assert.match(unknownJson.err.join("\n"), /Unknown session: nope/);
    assert.deepEqual(unknownJson.out, [], "a failed lookup prints no JSON");

    const missing = makeIO();
    assert.equal(await main(["sessions", "show", "--sessions-dir", dir], missing), 2);
    assert.match(missing.err.join("\n"), /no session name/);
    assert.deepEqual(missing.out, []);
  });
});

test("sessions undo is advertised by help/completions and its flags are catalogued", async () => {
  const help = makeIO();
  assert.equal(await main(["sessions", "--help"], help), 0);
  const text = help.out.join("\n");
  assert.match(text, /sessions undo <name> \[--run <id>\] \[--apply\] \[--discard\]/);
  assert.match(text, /undo: run id/i);
  assert.match(text, /--apply/);
  assert.match(text, /--discard/);
  for (const flag of ["run", "apply", "discard"]) {
    assert.ok(flag in FLAGS, `clihelp FLAGS is missing --${flag}`);
  }
  const spec = commandHelp("sessions");
  assert.ok(spec);
  for (const flag of ["run", "apply", "discard"]) {
    assert.ok((spec.flags ?? []).includes(flag), `sessions help spec lacks --${flag}`);
  }

  const completion = makeIO();
  assert.equal(await main(["completions", "bash"], completion), 0);
  const script = completion.out.join("\n");
  assert.match(script, /--run/);
  assert.match(script, /--apply/);
  assert.match(script, /--discard/);
});

// ---------------------------------------------------------------------------
// config: provenance, key masking, `config --json`
// ---------------------------------------------------------------------------

/** Run `fn` with every TWO_BROTHERS_* env var cleared, then restore them. */
async function withCleanCliEnv<T>(fn: () => T | Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(process.env)) {
    if (!key.startsWith("TWO_BROTHERS_")) continue;
    saved.set(key, process.env[key]);
    delete process.env[key];
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

test("configview: provenance flag > role env > shared env > preset > settings > default", async () => {
  await withCleanCliEnv(() => {
    const flagSecret = "sk-provenance-flag-secret";
    const settings: SettingsSnapshot = {
      senior: {
        base_url: "http://settings.test/v1",
        model: "settings-model",
        api_key: "sk-provenance-settings-secret",
      },
    };
    const roleEnv: NodeJS.ProcessEnv = {
      TWO_BROTHERS_SENIOR_BASE_URL: "http://role-env.test/v1",
      TWO_BROTHERS_BASE_URL: "http://shared-env.test/v1",
      TWO_BROTHERS_SENIOR_MODEL: "env-model",
      TWO_BROTHERS_SENIOR_API_KEY: "sk-provenance-env-secret",
      TWO_BROTHERS_API_KEY: "sk-provenance-shared-secret",
    };
    // config carries the CLI-resolved values; the view reports the layers.
    const config = resolveConfig({ provider: "openai", seniorModel: "config-model" });
    const flags = {
      provider: "openai",
      "senior-base-url": "http://flag.test/v1",
      "senior-model": "flag-model",
      "senior-api-key": flagSecret,
    };

    const top = buildConfigView({
      config,
      env: roleEnv,
      settings,
      flags,
      settingsFile: "sessions/settings.json",
      settingsPresent: true,
    });
    assert.equal(top.roles.senior.baseUrl, "http://flag.test/v1");
    assert.equal(top.roles.senior.sources.baseUrl.kind, "flag");
    assert.equal(top.roles.senior.sources.baseUrl.detail, "--senior-base-url");
    assert.equal(top.roles.senior.model, "flag-model");
    assert.equal(top.roles.senior.sources.model.kind, "flag");
    assert.equal(top.roles.senior.apiKey, "set");
    assert.equal(top.roles.senior.sources.apiKey.kind, "flag");
    assert.equal(top.roles.senior.sources.provider.kind, "flag");
    assert.equal(top.providerSource.kind, "flag");

    // No flags: the role env pair wins over the shared env pair and settings.
    const fromRoleEnv = buildConfigView({
      config,
      env: roleEnv,
      settings,
      flags: {},
      settingsFile: "sessions/settings.json",
      settingsPresent: true,
    });
    assert.equal(fromRoleEnv.roles.senior.baseUrl, "http://role-env.test/v1");
    assert.equal(fromRoleEnv.roles.senior.sources.baseUrl.kind, "role-env");
    assert.equal(fromRoleEnv.roles.senior.model, "env-model");
    assert.equal(fromRoleEnv.roles.senior.sources.model.kind, "role-env");
    assert.equal(fromRoleEnv.roles.senior.sources.apiKey.kind, "role-env");

    // Only the shared pair: it beats settings for both roles.
    const sharedEnv: NodeJS.ProcessEnv = {
      TWO_BROTHERS_BASE_URL: "http://shared-env.test/v1",
      TWO_BROTHERS_API_KEY: "sk-provenance-shared-secret",
    };
    const fromSharedEnv = buildConfigView({
      config,
      env: sharedEnv,
      settings,
      flags: {},
      settingsFile: "sessions/settings.json",
      settingsPresent: true,
    });
    assert.equal(fromSharedEnv.roles.senior.baseUrl, "http://shared-env.test/v1");
    assert.equal(fromSharedEnv.roles.senior.sources.baseUrl.kind, "shared-env");
    assert.equal(fromSharedEnv.roles.senior.apiKey, "set");
    assert.equal(fromSharedEnv.roles.senior.sources.apiKey.kind, "shared-env");

    // A settings provider_ref resolves the preset (env-backed key included).
    const presetSettings: SettingsSnapshot = {
      senior: { provider_ref: "deepseek", model: "settings-model" },
    };
    const presetEnv: NodeJS.ProcessEnv = { DEEPSEEK_API_KEY: "sk-provenance-preset-secret" };
    const fromPreset = buildConfigView({
      config,
      env: presetEnv,
      settings: presetSettings,
      flags: {},
      presets: seedPresets(),
      settingsFile: "sessions/settings.json",
      settingsPresent: true,
    });
    assert.equal(fromPreset.roles.senior.baseUrl, "https://api.deepseek.com/v1");
    assert.equal(fromPreset.roles.senior.sources.baseUrl.kind, "preset");
    assert.equal(fromPreset.roles.senior.sources.baseUrl.detail, "deepseek");
    assert.equal(fromPreset.roles.senior.kind, "openai-compatible");
    assert.equal(fromPreset.roles.senior.apiKey, "set");
    assert.equal(fromPreset.roles.senior.sources.apiKey.detail, "deepseek (DEEPSEEK_API_KEY)");
    // model is not part of the preset connection: settings supplies it.
    assert.equal(fromPreset.roles.senior.model, "settings-model");
    assert.equal(fromPreset.roles.senior.sources.model.kind, "settings");

    // Nothing set: built-in defaults.
    const fromDefaults = buildConfigView({
      config: resolveConfig({ provider: "mock" }),
      env: {},
      settings: {},
      flags: {},
      settingsFile: "sessions/settings.json",
      settingsPresent: false,
    });
    assert.equal(fromDefaults.roles.senior.baseUrl, "");
    assert.equal(fromDefaults.roles.senior.sources.baseUrl.kind, "default");
    assert.equal(fromDefaults.roles.senior.model, "");
    assert.equal(fromDefaults.roles.senior.sources.model.kind, "default");
    assert.equal(fromDefaults.roles.senior.apiKey, "not set");
    assert.equal(fromDefaults.roles.senior.sources.apiKey.kind, "default");
    assert.equal(fromDefaults.provider, "mock");

    const serialized = JSON.stringify([
      top,
      fromRoleEnv,
      fromSharedEnv,
      fromPreset,
      fromDefaults,
    ]);
    for (const value of [
      flagSecret,
      "sk-provenance-settings-secret",
      "sk-provenance-env-secret",
      "sk-provenance-shared-secret",
      "sk-provenance-preset-secret",
    ]) {
      assert.ok(!serialized.includes(value), `config view leaked ${value}`);
    }

    const table = renderConfigView(top).join("\n");
    assert.match(table, /^role\s+field\s+value\s+source$/m);
    assert.match(table, /flag --senior-base-url/);
    assert.ok(!table.includes(flagSecret), "the rendered table leaked the key");
  });
});

test("config --json: stable object with per-role sources and masked keys", async () => {
  await withTempDir(async (dir) => {
    await withCleanCliEnv(async () => {
      const secret = "sk-config-command-secret";
      const store = new SettingsStore(path.join(dir, "settings.json"));
      store.write({
        senior: {
          provider: "openai",
          base_url: "http://settings.test/v1",
          model: "settings-senior",
          api_key: secret,
        },
        junior: { model: "settings-junior" },
      });

      const io = makeIO();
      const code = await main(
        [
          "config",
          "--json",
          "--provider",
          "openai",
          "--base-url",
          "http://flag.test/v1",
          "--sessions-dir",
          dir,
        ],
        io,
      );
      assert.equal(code, 0, io.err.join("\n"));
      assert.deepEqual(io.err, []);
      assert.equal(io.out.length, 1, "config --json is one JSON document");
      const view = JSON.parse(io.out[0]) as ConfigView;
      assert.equal(view.schema, "two-brothers.config/1");
      assert.deepEqual(Object.keys(view.roles), ["senior", "junior"]);
      assert.deepEqual(Object.keys(view.roles.senior.sources), [
        "provider",
        "kind",
        "baseUrl",
        "model",
        "apiKey",
      ]);
      assert.equal(view.provider, "openai");
      assert.equal(view.providerSource.detail, "--provider");
      assert.equal(view.roles.senior.baseUrl, "http://flag.test/v1");
      assert.equal(view.roles.senior.sources.baseUrl.kind, "flag");
      assert.equal(view.roles.junior.baseUrl, "http://flag.test/v1");
      assert.equal(view.roles.senior.model, "settings-senior");
      assert.equal(view.roles.senior.sources.model.kind, "settings");
      assert.equal(view.roles.senior.apiKey, "set");
      assert.equal(view.roles.senior.sources.apiKey.kind, "settings");
      assert.equal(view.roles.junior.apiKey, "not set");
      assert.deepEqual(view.settings, {
        file: path.join(dir, "settings.json"),
        present: true,
      });
      assert.equal(view.sessionsDir, dir);
      assert.equal(view.limits.retries, 6);
      assert.equal(view.limits.timeoutSeconds, 120);
      assert.equal(view.compaction.mode, "off");
      assert.ok(view.roots.skills.paths.length >= 2, "default skill roots are listed");
      assert.equal(view.pinning.notes.length, 0);
      assert.ok(!io.out[0].includes(secret), "the key value leaked into --json");

      const human = makeIO();
      assert.equal(
        await main(["config", "--provider", "mock", "--sessions-dir", dir], human),
        0,
        human.err.join("\n"),
      );
      const text = human.out.join("\n");
      assert.match(text, /^role\s+field\s+value\s+source$/m);
      assert.match(text, /senior\s+model\s+settings-senior\s+settings /);
      assert.match(text, /settings: .*settings\.json \(present\)/);
      assert.match(text, /notes:/, "served settings/preset layers are called out");
      assert.ok(!text.includes(secret), "the key value leaked into the table");
    });
  });
});

// ---------------------------------------------------------------------------
// run input: --dry-run, --task-file and `run -`
// ---------------------------------------------------------------------------

test("run --dry-run honours TWO_BROTHERS_COMPACT when the flag is absent", async () => {
  await withTempDir(async (dir) => {
    await withCleanCliEnv(async () => {
      process.env.TWO_BROTHERS_COMPACT = "1";
      try {
        const io = makeIO();
        const code = await main(
          [
            "run",
            "env compact task",
            "--provider",
            "mock",
            "--session-file",
            path.join(dir, "env-compact.jsonl"),
            "--dry-run",
          ],
          io,
        );
        assert.equal(code, 0, io.err.join("\n"));
        // The parser default `compact: false` must not override the env value.
        assert.match(io.out.join("\n"), /\(forced once\)/);
      } finally {
        delete process.env.TWO_BROTHERS_COMPACT;
      }
    });
  });
});

test("run --dry-run: prints the plan, writes no session, calls no provider", async () => {
  await withTempDir(async (dir) => {
    await withCleanCliEnv(async () => {
      const sessionFile = path.join(dir, "dry.jsonl");
      const io = makeIO();
      const code = await main(
        [
          "run",
          "dry task",
          "--provider",
          "mock",
          "--session-file",
          sessionFile,
          "--dry-run",
        ],
        io,
      );
      assert.equal(code, 0, io.err.join("\n"));
      const text = io.out.join("\n");
      assert.match(text, /^dry run — no model calls, no session written$/m);
      assert.match(text, /^task: dry task$/m);
      assert.match(text, /session: .*dry\.jsonl \(new\)/);
      assert.match(text, /problems: none/);
      assert.ok(!fs.existsSync(sessionFile), "the dry run created the session file");
      assert.deepEqual(fs.readdirSync(dir), [], "the dry run wrote nothing");
      assert.ok(!text.includes("tokens:"), "no usage footer on a dry run");

      const jsonIo = makeIO();
      assert.equal(
        await main(
          [
            "run",
            "dry task",
            "--provider",
            "mock",
            "--session-file",
            sessionFile,
            "--dry-run",
            "--json",
          ],
          jsonIo,
        ),
        0,
        jsonIo.err.join("\n"),
      );
      assert.equal(jsonIo.out.length, 1, "dry-run --json is one JSON document");
      const plan = JSON.parse(jsonIo.out[0]) as {
        dryRun: boolean;
        command: string;
        task: string;
        session: { mode: string };
        problems: string[];
        config: ConfigView;
      };
      assert.equal(plan.dryRun, true);
      assert.equal(plan.command, "run");
      assert.equal(plan.task, "dry task");
      assert.equal(plan.session.mode, "new");
      assert.deepEqual(plan.problems, []);
      assert.equal(plan.config.roles.senior.provider, "mock");
      assert.equal(plan.config.roles.senior.apiKey, "not set");
      assert.ok(!fs.existsSync(sessionFile), "the JSON dry run created the session file");

      const bad = makeIO();
      assert.equal(
        await main(["run", "dry task", "--provider", "mock", "--dry-run", "--stream"], bad),
        2,
      );
      assert.match(bad.err.join("\n"), /cannot combine with --stream/);
      assert.deepEqual(bad.out, []);

      const chat = makeIO();
      assert.equal(await main(["chat", "--provider", "mock", "--dry-run"], chat), 0);
      assert.match(chat.out.join("\n"), /^command: chat$/m);
      assert.ok(
        !chat.out.join("\n").includes("Two Brothers REPL."),
        "a dry-run chat must not start the REPL",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// MCP config: `--mcp-config` > TWO_BROTHERS_MCP_CONFIG
// (clihelp.ts + docs/cli-reference.md map the two to each other)
// ---------------------------------------------------------------------------

test("mcpConfigFromValues: flag wins over env, blank layers mean unconfigured", () => {
  const env = (value: string | undefined): NodeJS.ProcessEnv =>
    value === undefined ? {} : { TWO_BROTHERS_MCP_CONFIG: value };

  assert.equal(
    mcpConfigFromValues({ "mcp-config": "flag.json" }, env("env.json")),
    "flag.json",
    "the flag wins over the env",
  );
  assert.equal(mcpConfigFromValues({}, env("env.json")), "env.json", "env-only");
  assert.equal(
    mcpConfigFromValues({ "mcp-config": "   " }, env("env.json")),
    "env.json",
    "a blank flag falls back to the env",
  );
  assert.equal(
    mcpConfigFromValues({ "mcp-config": "" }, env("env.json")),
    "env.json",
    "an empty flag falls back to the env",
  );
  assert.equal(
    mcpConfigFromValues({ "mcp-config": "  flag.json  " }, env("env.json")),
    "flag.json",
    "both layers are trimmed",
  );
  assert.equal(mcpConfigFromValues({}, env("  env.json  ")), "env.json");
  assert.equal(mcpConfigFromValues({}, env("   ")), undefined, "blank env is unconfigured");
  assert.equal(mcpConfigFromValues({ "mcp-config": "  " }, {}), undefined);
  assert.equal(mcpConfigFromValues({}, {}), undefined, "nothing configured");
  assert.equal(
    mcpConfigFromValues({ "mcp-config": true }, env("  ")),
    undefined,
    "a non-string flag value is ignored",
  );
  assert.equal(
    mcpConfigFromValues({ "mcp-config": "tests/fixtures/mcp-config.stdio.json" }, {}),
    "tests/fixtures/mcp-config.stdio.json",
    "the path is kept as given (the MCP loader resolves relative paths)",
  );
});

test("run --dry-run honours TWO_BROTHERS_MCP_CONFIG; --mcp-config wins", async () => {
  await withTempDir(async (dir) => {
    await withCleanCliEnv(async () => {
      const fixture = fileURLToPath(
        new URL("./fixtures/mcp-config.stdio.json", import.meta.url),
      );
      const envConfig = path.join(dir, "env-mcp.json");
      const flagConfig = path.join(dir, "flag-mcp.json");
      fs.copyFileSync(fixture, envConfig);
      fs.copyFileSync(fixture, flagConfig);

      interface McpPlan {
        configured: boolean;
        file: string | null;
        present: boolean;
        servers: number;
        error: string | null;
      }
      const dryRunPlan = async (extra: string[]): Promise<McpPlan> => {
        const io = makeIO();
        assert.equal(
          await main(
            ["run", "mcp task", "--provider", "mock", "--dry-run", "--json", ...extra],
            io,
          ),
          0,
          io.err.join("\n"),
        );
        assert.equal(io.out.length, 1, "dry-run --json is one JSON document");
        return (JSON.parse(io.out[0]) as { tools: { mcp: McpPlan } }).tools.mcp;
      };

      // Nothing configured: the env must not conjure a config out of nowhere.
      const bare = await dryRunPlan([]);
      assert.equal(bare.configured, false);
      assert.equal(bare.file, null);

      process.env.TWO_BROTHERS_MCP_CONFIG = envConfig;
      try {
        // The env is honored exactly like the flag (no MCP server is started).
        const fromEnv = await dryRunPlan([]);
        assert.equal(fromEnv.configured, true);
        assert.equal(fromEnv.file, envConfig, "the env path is used as given");
        assert.equal(fromEnv.present, true);
        assert.equal(fromEnv.servers, 1);
        assert.equal(fromEnv.error, null);

        // An explicit flag wins over the env.
        const flagged = await dryRunPlan(["--mcp-config", flagConfig]);
        assert.equal(flagged.file, flagConfig);

        // A blank flag falls back to the env instead of meaning "none".
        const blankFlag = await dryRunPlan(["--mcp-config", "   "]);
        assert.equal(blankFlag.file, envConfig);
      } finally {
        delete process.env.TWO_BROTHERS_MCP_CONFIG;
      }
    });
  });
});

test("cli source: values[\"mcp-config\"] is read only by mcpConfigFromValues", () => {
  // run/chat/serve/tui/dry-run each forward the resolved path through the
  // helper; this guards against a new call site reading the raw flag and
  // silently ignoring TWO_BROTHERS_MCP_CONFIG (the dry-run test above only
  // exercises the plan path; serve/chat/tui are not spawned here).
  const source = fs.readFileSync(
    fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
    "utf-8",
  );
  const rawReads = source
    .split("\n")
    .filter((line) => line.includes('values["mcp-config"]'));
  assert.equal(
    rawReads.length,
    1,
    `only the helper may read values["mcp-config"]:\n${rawReads.join("\n")}`,
  );
  const helperCalls = source.match(/mcpConfigFromValues\(/g) ?? [];
  assert.ok(
    helperCalls.length >= 6,
    `expected the helper to be wired through run/chat/serve/tui/dry-run, found ${helperCalls.length} uses`,
  );
});

test("run --task-file: reads the task; missing/blank/ambiguous files exit 2", async () => {
  await withTempDir(async (dir) => {
    await withCleanCliEnv(async () => {
      const file = path.join(dir, "task.txt");
      fs.writeFileSync(file, "task from a file\n", "utf-8");

      const io = makeIO();
      assert.equal(
        await main(["run", "--task-file", file, "--provider", "mock"], io),
        0,
        io.err.join("\n"),
      );
      assert.match(io.out.join("\n"), /\[user\]\s+task from a file/);
      assert.match(io.out.join("\n"), /\[senior -> user\] decision/);

      const missing = makeIO();
      assert.equal(
        await main(
          ["run", "--task-file", path.join(dir, "missing.txt"), "--provider", "mock"],
          missing,
        ),
        2,
      );
      assert.match(missing.err.join("\n"), /cannot read --task-file .*missing\.txt/);
      assert.match(missing.err.join("\n"), /Usage: two-brothers run/);
      assert.deepEqual(missing.out, []);

      const blankFile = path.join(dir, "blank.txt");
      fs.writeFileSync(blankFile, "  \r\n\n ", "utf-8");
      const blank = makeIO();
      assert.equal(await main(["run", "--task-file", blankFile, "--provider", "mock"], blank), 2);
      assert.match(blank.err.join("\n"), /--task-file .*blank\.txt is empty/);

      const both = makeIO();
      assert.equal(
        await main(["run", "positional", "--task-file", file, "--provider", "mock"], both),
        2,
      );
      assert.match(both.err.join("\n"), /mutually exclusive/);
    });
  });
});

test("run -: reads the task from piped stdin; blank and oversized input exit 2", async () => {
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const ok = spawnSync(process.execPath, [cli, "run", "-", "--provider", "mock"], {
    input: "task from stdin\n",
    encoding: "utf-8",
    timeout: 60_000,
  });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /\[user\]\s+task from stdin/);
  assert.match(ok.stdout, /\[senior -> user\] decision/);

  const blank = spawnSync(process.execPath, [cli, "run", "-", "--provider", "mock"], {
    input: "\n \n",
    encoding: "utf-8",
    timeout: 60_000,
  });
  assert.equal(blank.status, 2, blank.stderr);
  assert.match(blank.stderr, /no task given on stdin/);

  const oversized = spawnSync(process.execPath, [cli, "run", "-", "--provider", "mock"], {
    input: "x".repeat(1024 * 1024 + 1),
    encoding: "utf-8",
    timeout: 60_000,
  });
  assert.equal(oversized.status, 2, oversized.stderr);
  assert.match(oversized.stderr, /1 MiB limit/);
});
