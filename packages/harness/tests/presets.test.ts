/**
 * Seeded provider presets (`src/presets.ts`): shape, key hygiene, lookup and
 * the seed-over-stored merge the server lane will consume. Hermetic — the
 * only environment interaction is an explicit `env` argument.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
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
  for (const id of ["openai", "deepseek", "anthropic", "gemini", "openrouter", "lmstudio", "custom"]) {
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

test("presetById: exact, case-insensitive and unknown lookups", () => {
  assert.equal(presetById("openai")?.name, "openai");
  assert.equal(presetById("OpenAI")?.name, "openai");
  assert.equal(presetById("  deepseek  ")?.name, "deepseek");
  assert.equal(presetById("nope"), undefined);
  assert.equal(presetById(""), undefined);
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