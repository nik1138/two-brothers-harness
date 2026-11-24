/**
 * Equivalence lock for the one head-and-tail notice bound shared by the toast,
 * `/fork` and `/rewind` surfaces (`src/tui/noticebound.ts`).
 *
 * The three helpers used to carry a copy of the same 4-line algorithm; this
 * suite pins that the shared helper keeps the pre-refactor split byte for byte:
 * input of at most 320 UTF-16 code units is returned untouched, a longer input
 * becomes a 160-code-unit head, one `…` and a 159-code-unit tail. The expected
 * long-case strings below were captured from the pre-refactor helpers at base
 * e0230df (`git show e0230df:packages/harness/src/tui/{app,forkcommand,rewindcommand}.ts`)
 * and verified equal to the shared helper's output.
 *
 * Run with: node --test tests/tuiboundnotice.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { boundToastText, TOAST_TEXT_MAX_CHARS } from "../src/tui/app.ts";
import { boundForkNotice, FORK_NOTICE_MAX_CHARS } from "../src/tui/forkcommand.ts";
import { boundRewindNotice, REWIND_NOTICE_MAX_CHARS } from "../src/tui/rewindcommand.ts";

test("the shared notice bound stays byte-identical on every surface", () => {
  assert.deepEqual(
    [TOAST_TEXT_MAX_CHARS, FORK_NOTICE_MAX_CHARS, REWIND_NOTICE_MAX_CHARS],
    [320, 320, 320],
    "the three named ceilings stay 320",
  );
  const helpers = [
    ["toast", boundToastText],
    ["fork", boundForkNotice],
    ["rewind", boundRewindNotice],
  ] as const;

  for (const [name, bound] of helpers) {
    // Pre-refactor outputs captured from base e0230df.
    assert.equal(bound(""), "", `${name}: empty input is untouched`);
    assert.equal(bound("saved"), "saved", `${name}: a short notice is untouched`);
    assert.equal(bound("x".repeat(320)), "x".repeat(320), `${name}: exactly 320 is untouched`);
    assert.equal(
      bound("x".repeat(321)),
      `${"x".repeat(160)}…${"x".repeat(159)}`,
      `${name}: 321 splits at 160 + … + 159`,
    );

    const usage = " — usage: /fork [--at <seq>] [new-name]";
    const longUsage = `fork failed: ${"y".repeat(640)}${usage}`;
    assert.equal(
      bound(longUsage),
      `fork failed: ${"y".repeat(147)}…${"y".repeat(120)}${usage}`,
      `${name}: the actionable usage tail survives the cut`,
    );
    assert.equal(
      bound("中文".repeat(300)),
      `${"中文".repeat(80)}…文${"中文".repeat(79)}`,
      `${name}: slicing stays code-unit based (pre-refactor behavior)`,
    );
    assert.equal(
      bound(`${"a".repeat(319)}😀`),
      `${"a".repeat(160)}…${"a".repeat(157)}😀`,
      `${name}: a trailing astral pair is kept whole by the 159-unit tail`,
    );

    // Every length around the boundary, with a mixed alphabet so the cut can
    // land on ASCII, a wide char or an astral pair's surrogate halves.
    const alphabet = "ab —…😀\n中";
    const mixed = (length: number): string => {
      let out = "";
      for (let i = 0; i < length; i += 1) out += alphabet[i % alphabet.length];
      return out.slice(0, length);
    };
    for (let length = 0; length <= 700; length += 1) {
      const input = mixed(length);
      const expected =
        input.length <= TOAST_TEXT_MAX_CHARS
          ? input
          : `${input.slice(0, 160)}…${input.slice(input.length - 159)}`;
      assert.equal(bound(input), expected, `${name}: length ${length}`);
      if (length >= 300) {
        // The usage clause rides the tail at every boundary length.
        const withUsage = `${input}${usage}`;
        assert.equal(
          bound(withUsage),
          `${withUsage.slice(0, 160)}…${withUsage.slice(withUsage.length - 159)}`,
          `${name}: usage tail at length ${length}`,
        );
      }
    }

    // At the shared 320 ceiling the three helpers agree on every corpus input.
    for (let length = 0; length <= 700; length += 1) {
      const input = mixed(length);
      assert.equal(boundToastText(input), bound(input), `${name}: toast vs ${name} at ${length}`);
      assert.equal(boundForkNotice(input), bound(input), `${name}: fork vs ${name} at ${length}`);
      assert.equal(boundRewindNotice(input), bound(input), `${name}: rewind vs ${name} at ${length}`);
    }
  }
});
