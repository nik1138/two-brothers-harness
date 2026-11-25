/**
 * `withToolExpansion` derivation memo (`src/tui/transcript.ts`).
 *
 * The transcript view memoizes its positioned rows on the model's `blocks`
 * array; deriving a fresh expanded array per frame silently defeated that memo
 * for as long as a tool row stayed expanded. These cases pin the derivation
 * cache: a stable key set reuses the derived model/blocks (so the row memo
 * hits), a changed key set or document derives fresh, frames stay
 * byte-identical to an uncached derivation, and the model fields that move
 * without replacing `blocks` (the live reasoning buffer) are never stale.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addNotice,
  addToolCall,
  addToolResult,
  addUserBlock,
  createTuiModel,
  type LiveThinking,
  type ToolBlock,
  type TuiModel,
} from "../src/tui/model.ts";
import {
  newestToolBlock,
  renderBlock,
  toggleNewestToolExpansion,
  toolExpansionKey,
  withToolExpansion,
} from "../src/tui/transcript.ts";
import { transcriptView } from "../src/tui/view/transcript.ts";

function numberedLines(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, line) => `${prefix} line ${line}`).join("\n");
}

/** A transcript with two tool round-trips whose results are long enough to fold. */
function toolModel(): TuiModel {
  let model = addUserBlock(createTuiModel(), "inspect both files", { messageId: "u1" });
  for (const callId of ["old", "new"]) {
    model = addToolCall(model, {
      role: "junior",
      tool: "workspace_read_file",
      callId,
      args: `src/${callId}.ts`,
    });
    model = addToolResult(model, {
      role: "junior",
      tool: "workspace_read_file",
      status: "ok",
      callId,
      result: numberedLines(callId, 20),
    });
  }
  return addNotice(model, "info", "inspected both files");
}

function toolBlocks(model: TuiModel): ToolBlock[] {
  const tools = model.blocks.filter((block): block is ToolBlock => block.kind === "tool");
  assert.ok(tools.length >= 2);
  return tools;
}

/**
 * The same derivation on a fresh `blocks` array: no cache entry exists for it,
 * so the function computes the expansion from scratch.
 */
function uncached(model: TuiModel, keys: ReadonlySet<string>): TuiModel {
  return withToolExpansion({ ...model, blocks: model.blocks.slice() }, keys);
}

const VIEW_OPTIONS = { width: 80, height: 24 };

/**
 * Wrap every block so `text` reads are counted: the positioned-rows memo either
 * recomputes the rows (reading block text) or reuses them (reading nothing).
 */
function countingModel(model: TuiModel): {
  model: TuiModel;
  reads: () => number;
  reset: () => void;
} {
  let reads = 0;
  const blocks = model.blocks.map(
    (block) =>
      new Proxy(block, {
        get(target, property, receiver) {
          if (property === "text") reads += 1;
          return Reflect.get(target, property, receiver);
        },
      }),
  );
  return {
    model: { ...model, blocks },
    reads: () => reads,
    reset: () => {
      reads = 0;
    },
  };
}

test("withToolExpansion: a stable expansion reuses the derived blocks and the row memo", () => {
  const source = toolModel();
  const counting = countingModel(source);
  const newest = newestToolBlock(counting.model);
  assert.ok(newest !== undefined);
  const keys = new Set([toolExpansionKey(newest)]);

  const first = withToolExpansion(counting.model, keys);
  assert.notEqual(first, counting.model, "an expanded row derives a new model");
  assert.notEqual(first.blocks, counting.model.blocks, "with a fresh blocks array");
  const firstFrame = transcriptView(first, VIEW_OPTIONS);
  assert.ok(counting.reads() > 0, "the first frame renders the rows and reads block text");

  // The next frame: the same source model and the same key set (the app keeps
  // one set between toggles) must return the same derived model.
  const second = withToolExpansion(counting.model, keys);
  assert.equal(second, first, "a stable key set reuses the derived model identity");
  assert.equal(second.blocks, first.blocks, "and the derived blocks array identity");

  counting.reset();
  const secondFrame = transcriptView(second, VIEW_OPTIONS);
  assert.equal(counting.reads(), 0, "the second frame reuses the positioned rows");
  assert.deepEqual(secondFrame.lines, firstFrame.lines, "and renders byte-identically");
});

test("withToolExpansion: cached frames match an uncached derivation for every expansion state", () => {
  const model = toolModel();
  const tools = toolBlocks(model);
  const newestKey = toolExpansionKey(tools[tools.length - 1]!);
  const olderKey = toolExpansionKey(tools[0]!);
  const states: Array<[string, ReadonlySet<string>]> = [
    ["empty", new Set<string>()],
    ["newest", new Set([newestKey])],
    ["older", new Set([olderKey])],
    ["both", new Set([olderKey, newestKey])],
    ["unmatched", new Set(["call:missing"])],
    // Back to the first key set: the derivation is recomputed, not resurrected
    // from a superseded entry.
    ["newest again", new Set([newestKey])],
  ];
  for (const [label, keys] of states) {
    const cached = transcriptView(withToolExpansion(model, keys), VIEW_OPTIONS).lines;
    const fresh = transcriptView(uncached(model, keys), VIEW_OPTIONS).lines;
    assert.deepEqual(cached, fresh, `${label} expansion renders byte-identically`);
  }
});

test("withToolExpansion: a changed key set or document invalidates the derivation", () => {
  const model = toolModel();
  const tools = toolBlocks(model);
  const older = tools[0]!;
  const newest = tools[tools.length - 1]!;
  const olderIndex = model.blocks.indexOf(older);
  const newestIndex = model.blocks.indexOf(newest);
  const keysOlder = new Set([toolExpansionKey(older)]);
  const keysNewest = new Set([toolExpansionKey(newest)]);

  const derivedNewest = withToolExpansion(model, keysNewest);
  const derivedOlder = withToolExpansion(model, keysOlder);
  assert.notEqual(derivedOlder, derivedNewest, "a new key set derives a new model");
  assert.notEqual(derivedOlder.blocks, derivedNewest.blocks, "with a fresh blocks array");

  // Only the toggled row is cloned; the other tool row keeps its identity.
  assert.notEqual(derivedOlder.blocks[olderIndex], model.blocks[olderIndex]);
  assert.equal(derivedOlder.blocks[newestIndex], model.blocks[newestIndex]);
  const olderRows = renderBlock(derivedOlder.blocks[olderIndex]!, { width: 80 }).join("\n");
  assert.ok(olderRows.includes("old line 19"), "the toggled row expands in full");
  assert.ok(!olderRows.includes("more lines"), "with no fold marker");
  const newestRows = renderBlock(derivedOlder.blocks[newestIndex]!, { width: 80 }).join("\n");
  assert.ok(newestRows.includes("more lines"), "the untoggled row keeps its fold marker");

  // Toggling back derives the newest row again with the same frame bytes.
  const back = withToolExpansion(model, keysNewest);
  assert.notEqual(back, derivedNewest, "a superseded entry is not resurrected");
  assert.deepEqual(
    transcriptView(back, VIEW_OPTIONS).lines,
    transcriptView(derivedNewest, VIEW_OPTIONS).lines,
    "toggling back renders the same frame",
  );

  // A changed document invalidates too, while the earlier document's
  // derivation stays cached and stable.
  const next = addNotice(model, "info", "one more line");
  const derivedNext = withToolExpansion(next, keysNewest);
  assert.notEqual(derivedNext, back, "a new document derives a new model");
  assert.notEqual(derivedNext.blocks, back.blocks, "with a fresh blocks array");
  assert.equal(withToolExpansion(model, keysNewest), back, "the earlier document keeps its entry");
});

test("withToolExpansion: a live reasoning update keeps the derived blocks but not a stale buffer", () => {
  const model = toolModel();
  const newest = newestToolBlock(model);
  assert.ok(newest !== undefined);
  const keys = new Set([toolExpansionKey(newest)]);
  const expanded = withToolExpansion(model, keys);

  const thinking: LiveThinking = { role: "senior", text: "weighing the two reads", streaming: true };
  const whileThinking = withToolExpansion({ ...model, liveThinking: thinking }, keys);
  assert.equal(whileThinking.liveThinking, thinking, "the derived model carries the current buffer");
  assert.equal(whileThinking.blocks, expanded.blocks, "and the stable expanded blocks");

  const nextThinking: LiveThinking = { ...thinking, text: "weighing the two reads again" };
  const later = withToolExpansion({ ...model, liveThinking: nextThinking }, keys);
  assert.equal(later.liveThinking, nextThinking);
  assert.equal(later.blocks, expanded.blocks);

  // Settling the buffer must not resurrect the buffer captured at derivation.
  const settled = withToolExpansion(model, keys);
  assert.equal(settled.liveThinking, undefined);
  assert.equal(settled.blocks, expanded.blocks);

  assert.ok(
    transcriptView(later, VIEW_OPTIONS).lines.join("\n").includes("weighing the two reads again"),
    "the frame shows the current reasoning",
  );
});

test("withToolExpansion: a key set that matches no row returns the input model", () => {
  const model = toolModel();
  const keys = new Set(["call:missing"]);
  assert.equal(withToolExpansion(model, keys), model, "no matching row derives the input model");
  assert.equal(withToolExpansion(model, keys), model, "a repeated unmatched set does the same");
  assert.deepEqual(
    transcriptView(withToolExpansion(model, keys), VIEW_OPTIONS).lines,
    transcriptView(model, VIEW_OPTIONS).lines,
    "the frame stays the collapsed frame",
  );
});

test("withToolExpansion: toggling the newest row tracks the fold state", () => {
  const model = toolModel();
  const first = toggleNewestToolExpansion(model, new Set());
  assert.equal(first.expanded, true);
  const expanded = withToolExpansion(model, first.keys);
  assert.notEqual(expanded, model);

  const second = toggleNewestToolExpansion(model, first.keys);
  assert.equal(second.expanded, false);
  assert.equal(withToolExpansion(model, second.keys), model, "collapsing returns the input model");
});
