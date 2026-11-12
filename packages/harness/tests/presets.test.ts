/**
 * Seeded provider presets (`src/presets.ts`): shape, key hygiene, lookup and
 * the seed-over-stored merge the server lane will consume. Hermetic — the
 * only environment interaction is an explicit `env` argument.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isSeedPresetName,
  mergeSeedPresets,
  presetApiKey,
  presetById,
  presetIds,
  seedPresets,
} from "../src/presets.ts";
import { PROVIDER_KINDS } from "../src/provider.ts";
import type { ProviderPreset } from "../src/settings_store.ts";

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

test("seeds: every preset has the persisted shape and a usable endpoint", () => {
  const seeds = seedPresets();
  assert.ok(seeds.length >= 6, "at least the curated providers");
  assert.deepEqual(
    seeds.map((preset) => preset.name),
    presetIds(),
    "table order is display order",
  );
  for (const preset of seeds) {
    assert.ok(preset.name.length > 0, "name (the preset id)");
    assert.match(preset.base_url, /^https?:\/\//, `${preset.name}: base url`);
    assert.equal(preset.api_key, "", `${preset.name}: seeds never carry a literal key`);
    assert.ok((PROVIDER_KINDS as readonly string[]).includes(preset.kind), preset.kind);
    assert.ok(Array.isArray(preset.models), `${preset.name}: models list`);
    if (preset.api_key_env !== undefined) {
      assert.match(preset.api_key_env, ENV_NAME, `${preset.name}: env-var name only`);
    }
  }
});

test("seeds: include the expected well-known providers and a custom skeleton", () => {
  const ids = new Set(presetIds());
  for (const id of [
    "openai",
    "deepseek",
    "anthropic",
    "gemini",
    "openrouter",
    "lmstudio",
    "custom",
  ]) {
    assert.ok(ids.has(id), `missing seed: ${id}`);
  }
  assert.equal(presetById("openai")?.base_url, "https://api.openai.com/v1");
  assert.deepEqual(presetById("deepseek")?.models, ["deepseek-chat", "deepseek-reasoner"]);
  // native families carry their wire flavor
  assert.equal(presetById("anthropic")?.kind, "anthropic");
  assert.equal(presetById("gemini")?.kind, "google");
  // local-first default
  assert.equal(presetById("lmstudio")?.base_url, "http://localhost:1234/v1");
  assert.equal(presetById("lmstudio")?.api_key_env, undefined);
  assert.deepEqual(presetById("custom")?.models, []);
});

test("seeds: subscription plans from the dsh provider table and models.dev", () => {
  const subscriptions = [
    "opencode",
    "opencode-go",
    "kimi-coding",
    "zai-coding",
    "zai-coding-cn",
    "qwen-token-plan",
    "xiaomi-token-plan-sgp",
    "moonshotai",
    "minimax",
  ];
  const ids = new Set(presetIds());
  for (const id of subscriptions) {
    const preset = presetById(id);
    assert.ok(preset, `missing subscription seed: ${id}`);
    assert.ok(ids.has(id));
    assert.match(preset.base_url, /^https:\/\//, `${id}: hosted endpoint`);
    assert.match(preset.api_key_env ?? "", ENV_NAME, `${id}: env-var name`);
    assert.ok(preset.models.length > 0, `${id}: a curated model list`);
    assert.ok(!preset.models.includes(""), `${id}: no empty model ids`);
  }

  assert.equal(presetById("opencode-go")?.base_url, "https://opencode.ai/inference/go/openai/v1");
  assert.equal(presetById("opencode-go")?.api_key_env, "OPENCODE_API_KEY");
  assert.equal(presetById("opencode")?.base_url, "https://opencode.ai/inference/openai/v1");
  assert.equal(presetById("kimi-coding")?.base_url, "https://api.kimi.com/coding/v1");
  assert.equal(presetById("kimi-coding")?.api_key_env, "KIMI_API_KEY");
  assert.equal(presetById("zai-coding")?.base_url, "https://api.z.ai/api/coding/paas/v4");
  assert.equal(presetById("zai-coding-cn")?.api_key_env, "ZAI_CODING_CN_API_KEY");
  // MiniMax speaks the Anthropic Messages protocol, not Chat Completions.
  assert.equal(presetById("minimax")?.kind, "anthropic");
  assert.equal(presetById("minimax")?.base_url, "https://api.minimax.io/anthropic");
});

test("presetById: exact, case-insensitive and unknown lookups", () => {
  assert.equal(presetById("openai")?.name, "openai");
  assert.equal(presetById("OpenAI")?.name, "openai");
  assert.equal(presetById("  deepseek  ")?.name, "deepseek");
  assert.equal(presetById("nope"), undefined);
  assert.equal(presetById(""), undefined);
});

test("isSeedPresetName: the same case-insensitive lookup presetById uses", () => {
  for (const id of presetIds()) assert.equal(isSeedPresetName(id), true, id);
  assert.equal(isSeedPresetName("OpenAI"), true);
  assert.equal(isSeedPresetName("  DEEPSEEK  "), true);
  assert.equal(isSeedPresetName("lmstudio"), true);
  assert.equal(isSeedPresetName("mine"), false);
  assert.equal(isSeedPresetName("openai-proxy"), false);
  assert.equal(isSeedPresetName(""), false);
  assert.equal(isSeedPresetName("   "), false);
});

test("seedPresets: fresh copies (callers cannot corrupt the table)", () => {
  const first = seedPresets();
  first[0].models.push("mutated");
  first[0].base_url = "http://mutated";
  const second = seedPresets();
  assert.ok(!second[0].models.includes("mutated"));
  assert.equal(second[0].base_url, "https://api.openai.com/v1");
  // presetById is fresh too
  const viaId = presetById("openai")!;
  viaId.models.push("mutated");
  assert.ok(!seedPresets()[0].models.includes("mutated"));
});

function stored(overrides: Partial<ProviderPreset> & { name: string }): ProviderPreset {
  return {
    base_url: "https://example.test/v1",
    api_key: "",
    kind: "openai-compatible",
    models: [],
    ...overrides,
  };
}

test("mergeSeedPresets: stored same-name presets override seeds in place", () => {
  const merged = mergeSeedPresets([
    stored({ name: "OpenAI", base_url: "https://proxy.example/v1", models: ["gpt-4o"] }),
    stored({ name: "mine", base_url: "http://localhost:9000/v1", models: ["local"] }),
  ]);
  const openai = merged.find((preset) => preset.name === "OpenAI");
  assert.ok(openai, "the stored spelling wins");
  assert.equal(openai.base_url, "https://proxy.example/v1");
  assert.deepEqual(openai.models, ["gpt-4o"]);
  assert.equal(merged.filter((preset) => preset.name.toLowerCase() === "openai").length, 1);
  // seed position preserved: openai stays first, extras append last
  assert.equal(merged[0].name, "OpenAI");
  assert.equal(merged[merged.length - 1].name, "mine");
});

test("mergeSeedPresets: no stored presets yields the seeds; stored arrays are copied", () => {
  assert.equal(mergeSeedPresets().length, seedPresets().length);
  const preset = stored({ name: "mine", models: ["a"] });
  const merged = mergeSeedPresets([preset]);
  merged[merged.length - 1].models.push("b");
  assert.deepEqual(preset.models, ["a"], "merge does not alias stored models");
});

test("mergeSeedPresets: a stored context window survives; seeds never invent one", () => {
  // Seeds omit the field: absence means unknown, not a fabricated window.
  for (const seed of seedPresets()) {
    assert.equal(seed.context_window, undefined, `${seed.name}: no invented window`);
  }
  const merged = mergeSeedPresets([
    stored({ name: "mine", context_window: 8192 }),
    stored({ name: "openai", base_url: "https://proxy.example/v1", context_window: 16384 }),
    stored({ name: "plain" }),
  ]);
  assert.equal(merged.find((preset) => preset.name === "mine")?.context_window, 8192);
  assert.equal(merged.find((preset) => preset.name.toLowerCase() === "openai")?.context_window, 16384);
  assert.equal(merged.find((preset) => preset.name === "plain")?.context_window, undefined);
  // 0 and invalid values read as unknown (never carried through the merge)
  const zero = mergeSeedPresets([stored({ name: "zero", context_window: 0 })]);
  assert.equal(zero[zero.length - 1]?.context_window, undefined);
});

test("presetApiKey: env-var name wins, literal key falls back, value never stored", () => {
  const seed = presetById("openai")!;
  assert.equal(presetApiKey(seed, { OPENAI_API_KEY: "sk-from-env" }), "sk-from-env");
  assert.equal(presetApiKey(seed, { OPENAI_API_KEY: "" }), "");
  assert.equal(presetApiKey(seed, {}), "");
  const literal: ProviderPreset = stored({ name: "stored", api_key: "sk-stored" });
  assert.equal(presetApiKey(literal, {}), "sk-stored");
  // an env name on the preset still beats the literal key
  assert.equal(presetApiKey({ ...literal, api_key_env: "MY_KEY" }, { MY_KEY: "sk-env" }), "sk-env");
});