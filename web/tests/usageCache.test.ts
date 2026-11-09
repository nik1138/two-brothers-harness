// Family-normalized cache percentage tests (no DOM):
//   node --import ./tests/register-ts.mjs --test tests/usageCache.test.ts

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { cacheHitPercent, promptTokensOf } from '../src/usageCache.ts'

test('OpenAI-compatible runs fall back to input (already the prompt total)', () => {
  assert.equal(promptTokensOf({ input_tokens: 4_000 }), 4_000)
  assert.equal(cacheHitPercent({ input_tokens: 4_000, cached_tokens: 1_000 }), 25)
})

test('Anthropic/Gemini use the normalized prompt total as the denominator', () => {
  // 3 200 cached of 7 600 prompt = 42%, not 3 200 / 4 000 = 80%.
  assert.equal(
    promptTokensOf({ input_tokens: 4_000, prompt_tokens: 7_600 }),
    7_600,
  )
  assert.equal(
    cacheHitPercent({ input_tokens: 4_000, prompt_tokens: 7_600, cached_tokens: 3_200 }),
    42,
  )
  assert.equal(cacheHitPercent({ input_tokens: 80, prompt_tokens: 120, cached_tokens: 40 }), 33)
})

test('a fully cached uncached-input-zero call is 100%, not hidden', () => {
  assert.equal(cacheHitPercent({ input_tokens: 0, prompt_tokens: 1_000, cached_tokens: 1_000 }), 100)
  assert.equal(cacheHitPercent({ input_tokens: 0, cached_tokens: 50 }), 100)
})

test('absent or malformed counters never fabricate a percentage', () => {
  assert.equal(cacheHitPercent(null), null)
  assert.equal(cacheHitPercent(undefined), null)
  assert.equal(cacheHitPercent({ input_tokens: 0, cached_tokens: 0 }), null)
  assert.equal(cacheHitPercent({ input_tokens: 0, prompt_tokens: 0, cached_tokens: 0 }), null)
  assert.equal(
    cacheHitPercent({ input_tokens: 100, cached_tokens: Number.NaN } as never),
    0,
  )
  // A provider reporting more hits than prompt tokens is clamped, never >100%.
  assert.equal(cacheHitPercent({ input_tokens: 100, cached_tokens: 400 }), 100)
  assert.equal(promptTokensOf({ input_tokens: Number.NaN }), 0)
})
