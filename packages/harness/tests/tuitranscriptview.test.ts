/**
 * Transcript-view lane: the parked ("n more" below) gutter marker and the
 * positioned-rows memoization. Both are view-local behaviors of
 * `src/tui/view/transcript.ts`; the renderer in `src/tui/transcript.ts` is only
 * read here.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Message } from "../src/protocol.ts";
import {
  addNotice,
  addToolCall,
  addToolResult,
  addUserBlock,
  commitEnvelope,
  createTuiModel,
  type TuiModel,
} from "../src/tui/model.ts";
import { styledWidth, stripAnsi } from "../src/tui/screen.ts";
import { createTheme, plainTheme } from "../src/tui/theme.ts";
import {
  TOP_SLICE_MARKER,
  TRANSCRIPT_LABEL_WIDTH,
  toolExpansionKey,
  withToolExpansion,
} from "../src/tui/transcript.ts";
import {
  homeTranscriptScroll,
  latestTranscriptScroll,
  scrollToBlock,
  scrollTranscript,
  transcriptView,
  type TranscriptView,
} from "../src/tui/view/transcript.ts";

function message(id: string, from: string, text: string, seq: number): Message {
  return {
    v: 1,
    id,
    seq,
    ts: "2026-11-04T00:00:00Z",
    from,
    to: from === "user" ? "senior" : "user",
    kind: "message",
    payload: { text },
  };
}

/** A one-reply transcript with enough wrapped rows to scroll. */
function seniorReply(text: string, id = "m0"): TuiModel {
  return commitEnvelope(createTuiModel(), message(id, "senior", text, 1));
}

/** A multi-block transcript: operator turn, senior reply, tool round-trip. */
function mixedModel(blocks = 6): TuiModel {
  let model = createTuiModel();
  for (let index = 0; index < blocks; index += 1) {
    model = addUserBlock(model, `Operator turn ${index}: review step ${index}.`, {
      messageId: `u${index}`,
    });
    model = commitEnvelope(
      model,
      message(
        `m${index}`,
        index % 2 === 0 ? "senior" : "junior",
        `proposal: step ${index}\n\n${"- a short finding\n".repeat(2)}`,
        index + 1,
      ),
    );
    model = addToolCall(model, {
      role: "junior",
      tool: "workspace_read_file",
      callId: `c${index}`,
      args: `src/file${index}.ts`,
    });
    model = addToolResult(model, {
      role: "junior",
      tool: "workspace_read_file",
      status: "ok",
      callId: `c${index}`,
      result: Array.from({ length: 20 }, (_, line) => `result ${index}.${line} of the tool output`).join("\n"),
    });
    model = addNotice(model, "info", `checked step ${index}`);
  }
  return model;
}

/** The marker label the view is expected to write for `more` hidden rows. */
function expectedMoreLabel(more: number): string {
  for (const variant of [
    `${TOP_SLICE_MARKER} ${more} more`,
    `${TOP_SLICE_MARKER}${more} more`,
    `${TOP_SLICE_MARKER}${more}more`,
    `${TOP_SLICE_MARKER} ${more}`,
  ]) {
    if (styledWidth(variant) <= TRANSCRIPT_LABEL_WIDTH - 1) return variant;
  }
  return "";
}

function bottomMarkerRow(view: TranscriptView): number {
  // The top-slice marker sits at the end of the gutter (seven spaces first);
  // the parked marker starts the gutter, so only it begins with the glyph.
  return view.lines.findIndex((line) => stripAnsi(line).startsWith(TOP_SLICE_MARKER));
}

function bottomMarkerCount(view: TranscriptView): number {
  return view.lines.filter((line) => stripAnsi(line).startsWith(TOP_SLICE_MARKER)).length;
}

/** Parked `rows` visual rows above the newest content. */
function parked(model: TuiModel, rows: number, width: number, height: number): TranscriptView {
  const scroll = scrollTranscript(model, latestTranscriptScroll(), -rows, { width, height });
  return transcriptView(model, { width, height, scroll });
}

/**
 * The same window rendered at the newest content by growing the height, so the
 * window start matches the parked one: it is the pre-indicator frame for those
 * rows (nothing is below it, so no parked marker).
 */
function unmarkedRows(
  model: TuiModel,
  view: TranscriptView,
  width: number,
  height: number,
): string[] {
  const hidden = view.totalRows - view.startRow - height;
  assert.ok(hidden > 0, "the parked frame must have content below it");
  const taller = transcriptView(model, {
    width,
    height: height + hidden,
    scroll: latestTranscriptScroll(),
  });
  assert.equal(taller.startRow, view.startRow, "the taller follow window starts on the same row");
  return taller.lines.slice(0, height);
}

/** A blocks array that counts every element read (a render pass touches all). */
function countingBlocks(blocks: TuiModel["blocks"]): {
  blocks: TuiModel["blocks"];
  reads: () => number;
} {
  let reads = 0;
  const proxy = new Proxy(blocks as unknown[], {
    get(target, property, receiver) {
      if (typeof property === "string" && /^(0|[1-9]\d*)$/.test(property)) reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  return { blocks: proxy as unknown as TuiModel["blocks"], reads: () => reads };
}

/** A model that counts `blocks` property reads (one per positioned-rows pass). */
function countingModel(model: TuiModel): {
  model: TuiModel;
  blockAccesses: () => number;
} {
  let accesses = 0;
  const proxy = new Proxy(model, {
    get(target, property, receiver) {
      if (property === "blocks") accesses += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  return { model: proxy, blockAccesses: () => accesses };
}

/**
 * An uncached reference to the same document: a fresh blocks array (and live
 * reasoning copy) means the memo has no entry for it, so it renders from
 * scratch while the block objects themselves stay immutable and shared.
 */
function cloneModel(model: TuiModel): TuiModel {
  return {
    blocks: model.blocks.slice(),
    nextId: model.nextId,
    ...(model.liveThinking !== undefined
      ? { liveThinking: { ...model.liveThinking } }
      : {}),
  };
}

// --------------------------------------------------------------------------- //
// parked indicator
// --------------------------------------------------------------------------- //

test("followed frame: the newest-row frame is byte-identical to the pre-marker frame", () => {
  // Golden captured from the tree before the parked indicator was added: a
  // followed window must keep rendering exactly these bytes.
  let model = createTuiModel();
  model = addUserBlock(model, "Check the deploy plan.", { messageId: "u1" });
  model = commitEnvelope(
    model,
    message("m1", "senior", "proposal: ship it\n\n- the plan is green\n- rollback is rehearsed", 1),
  );
  const view = transcriptView(model, { width: 40, height: 8, scroll: latestTranscriptScroll() });
  assert.equal(view.atLatest, true);
  assert.deepEqual(view.lines, [
    "YOU     Check the deploy plan.          ",
    "                                        ",
    "SENIOR  proposal: ship it               ",
    "                                        ",
    "        - the plan is green             ",
    "        - rollback is rehearsed         ",
    "                                        ",
    "                                        ",
  ]);
});

test("followed frame: only the top-slice marker exists, never a parked marker", () => {
  // One long reply: the followed window starts mid-block, so the top marker is
  // present and the bottom of the window has nothing below it.
  const model = seniorReply("proposal: migration\n\n" + "step detail ".repeat(120));
  const view = transcriptView(model, { width: 60, height: 6, scroll: latestTranscriptScroll() });
  assert.equal(view.atLatest, true);
  assert.ok(stripAnsi(view.lines[0] ?? "").includes(TOP_SLICE_MARKER));
  assert.ok(
    !stripAnsi(view.lines.slice(1).join("\n")).includes(TOP_SLICE_MARKER),
    "a followed frame grows no bottom marker",
  );
});

test("parked marker: the last visible row counts the rows below, cell for cell", () => {
  const model = seniorReply("proposal: migration\n\n" + "step detail ".repeat(160));
  const width = 60;
  const height = 6;
  const latest = transcriptView(model, { width, height, scroll: latestTranscriptScroll() });
  assert.equal(latest.atLatest, true);
  assert.ok(latest.totalRows >= height + 5, "the document must scroll far enough to park");

  const view = parked(model, 5, width, height);
  assert.equal(view.atLatest, false);
  const index = bottomMarkerRow(view);
  assert.equal(index, height - 1, "the marker sits on the last visible row");
  const hidden = view.totalRows - (view.startRow + height);
  assert.equal(hidden, 5);
  assert.equal(
    stripAnsi(view.lines[index] ?? "").slice(0, TRANSCRIPT_LABEL_WIDTH),
    expectedMoreLabel(hidden).padEnd(TRANSCRIPT_LABEL_WIDTH, " "),
    "the gutter names the exact number of rows below",
  );
  assert.ok((view.lines[index] ?? "").includes("more"), "small counts keep the word");
  assert.equal(
    bottomMarkerCount(view),
    1,
    "exactly one parked marker per frame",
  );
  assert.ok(!view.lines.some((line) => line.includes("\u001b")), "plain output is escape-free");
  for (const line of view.lines) assert.equal(styledWidth(line), width);

  // The marker is a gutter swap: every row body is the unmarked frame's body,
  // and only the marked row differs at all (and then only in its first 8 cells).
  const unmarked = unmarkedRows(model, view, width, height);
  for (let row = 0; row < height; row += 1) {
    if (row === index) {
      assert.equal(
        stripAnsi(view.lines[row] ?? "").slice(TRANSCRIPT_LABEL_WIDTH),
        stripAnsi(unmarked[row] ?? "").slice(TRANSCRIPT_LABEL_WIDTH),
        "the marked row keeps its body",
      );
    } else {
      assert.equal(view.lines[row], unmarked[row], `row ${row} is unchanged`);
    }
  }

  // A followed frame (nothing below) carries no parked marker anywhere.
  for (const line of latest.lines.slice(1)) {
    assert.ok(!stripAnsi(line).includes(TOP_SLICE_MARKER), "a followed frame has no marker");
  }
});

test("parked marker: the marker survives width changes and never changes a row width", () => {
  const model = seniorReply("proposal: migration\n\n" + "step detail ".repeat(200));
  for (const width of [20, 24, 40, 60, 80, 120]) {
    const height = 6;
    const view = parked(model, 5, width, height);
    assert.equal(view.atLatest, false, `${width}: the window is parked`);
    const index = bottomMarkerRow(view);
    assert.equal(index, height - 1, `${width}: the marker sits on the last visible row`);
    const hidden = view.totalRows - (view.startRow + height);
    assert.equal(
      stripAnsi(view.lines[index] ?? "").slice(0, TRANSCRIPT_LABEL_WIDTH),
      expectedMoreLabel(hidden).padEnd(TRANSCRIPT_LABEL_WIDTH, " "),
      `${width}: exact count`,
    );
    for (const line of view.lines) {
      assert.equal(styledWidth(line), width, `${width}: rows keep their exact width`);
    }
    const unmarked = unmarkedRows(model, view, width, height);
    for (let row = 0; row < height; row += 1) {
      if (row !== index) assert.equal(view.lines[row], unmarked[row], `${width}: row ${row}`);
    }
    assert.equal(
      stripAnsi(view.lines[index] ?? "").slice(TRANSCRIPT_LABEL_WIDTH),
      stripAnsi(unmarked[index] ?? "").slice(TRANSCRIPT_LABEL_WIDTH),
      `${width}: the body survives the swap`,
    );
  }
});

test("parked marker: compact rows have no gutter, so they carry no marker", () => {
  const model = seniorReply("proposal: migration\n\n" + "step detail ".repeat(60));
  const view = parked(model, 5, 12, 6);
  assert.equal(view.atLatest, false);
  assert.ok(
    !view.lines.some((line) => stripAnsi(line).includes(TOP_SLICE_MARKER)),
    "width <= TRANSCRIPT_LABEL_WIDTH + 8 has no label gutter to mark",
  );
  for (const line of view.lines) assert.equal(styledWidth(line), 12);
});

test("parked marker: a block label row on the bottom is preserved, the marker moves up", () => {
  const model = mixedModel();
  const width = 60;
  const height = 6;
  let checked = 0;
  for (let delta = 1; delta < 60; delta += 1) {
    const view = parked(model, delta, width, height);
    if (view.atLatest) break;
    const last = stripAnsi(view.lines[height - 1] ?? "");
    if (!/^(SENIOR|JUNIOR|YOU|TOOL|INFO|WARN|ERR|SUMMARY)\b/.test(last)) continue;
    const index = bottomMarkerRow(view);
    assert.ok(index >= 0, "a parked window still reports that content follows");
    assert.ok(index < height - 1, "the marker does not overwrite the label row");
    assert.equal(view.lines[height - 1], unmarkedRows(model, view, width, height)[height - 1]);
    const belowMarker = view.totalRows - (view.startRow + index + 1);
    assert.equal(
      stripAnsi(view.lines[index] ?? "").slice(0, TRANSCRIPT_LABEL_WIDTH),
      expectedMoreLabel(belowMarker).padEnd(TRANSCRIPT_LABEL_WIDTH, " "),
      "the count is the rows below the marked row",
    );
    for (const line of view.lines) assert.equal(styledWidth(line), width);
    checked += 1;
  }
  assert.ok(checked > 0, "the sweep must find a window whose last row is a block label");
});

test("parked marker: theme paints only the marker; NO_COLOR output is the plain frame", () => {
  const model = seniorReply("proposal: migration\n\n" + "step detail ".repeat(160));
  const width = 60;
  const height = 6;
  const theme = createTheme("dark");
  const scroll = scrollTranscript(model, latestTranscriptScroll(), -5, { width, height });
  const plainView = transcriptView(model, { width, height, theme: plainTheme, scroll });
  const themedView = transcriptView(model, { width, height, theme, scroll });
  const index = bottomMarkerRow(plainView);
  assert.ok(index >= 0);
  assert.ok(themedView.lines[index]?.includes(theme.tokens.dim), "the marker is dim-painted");
  for (let row = 0; row < plainView.lines.length; row += 1) {
    assert.equal(
      stripAnsi(themedView.lines[row] ?? ""),
      plainView.lines[row] ?? "",
      `row ${row}: the theme only paints`,
    );
  }
  assert.ok(!plainView.lines.some((line) => line.includes("\u001b")));
});

test("parked marker: large counts stay exact inside the gutter budget", () => {
  let model = createTuiModel();
  for (let index = 0; index < 140; index += 1) {
    model = commitEnvelope(
      model,
      message(
        `m${index}`,
        "senior",
        `proposal: block ${index}\n\n${"- detail row\n".repeat(4)}`,
        index + 1,
      ),
    );
  }
  const width = 60;
  const height = 6;
  for (const delta of [12, 250]) {
    const view = parked(model, delta, width, height);
    assert.equal(view.atLatest, false);
    const index = bottomMarkerRow(view);
    assert.ok(index >= 0);
    const belowMarker = view.totalRows - (view.startRow + index + 1);
    assert.ok(belowMarker >= delta - height, "the count is at least the parked distance");
    const gutter = stripAnsi(view.lines[index] ?? "").slice(0, TRANSCRIPT_LABEL_WIDTH).trimEnd();
    assert.ok(gutter.includes(String(belowMarker)), `${gutter} names the exact count`);
    assert.equal(gutter, expectedMoreLabel(belowMarker));
    for (const line of view.lines) assert.equal(styledWidth(line), width);
  }
});

// --------------------------------------------------------------------------- //
// positioned-rows memo
// --------------------------------------------------------------------------- //

test("memo: a repeated frame reuses the positioned rows", () => {
  const model = mixedModel(4);
  const counted = countingBlocks(model.blocks);
  const cachedModel: TuiModel = { blocks: counted.blocks, nextId: model.nextId };
  const options = { width: 60, height: 8 };
  const first = transcriptView(cachedModel, { ...options, scroll: latestTranscriptScroll() });
  const afterFirst = counted.reads();
  assert.ok(afterFirst > 0, "the first frame renders every block");

  const second = transcriptView(cachedModel, { ...options, scroll: latestTranscriptScroll() });
  assert.equal(counted.reads(), afterFirst, "a repeated frame does not re-read the blocks");
  assert.deepEqual(second.lines, first.lines);

  // Height and scroll only window the rows, so they reuse the same render too.
  const taller = transcriptView(cachedModel, {
    width: 60,
    height: 12,
    scroll: latestTranscriptScroll(),
  });
  assert.equal(counted.reads(), afterFirst, "windowing does not re-render the document");
  assert.equal(taller.lines.length, 12);
  // Both windows are bottom-anchored, so the last 7 rows of the taller frame
  // are the smaller frame's rows 1-7; its row 4 is the smaller frame's first
  // row, whose only difference is the top-slice marker (a window-row effect).
  assert.deepEqual(taller.lines.slice(5), first.lines.slice(1));
  assert.equal(
    stripAnsi(taller.lines[4] ?? "").slice(TRANSCRIPT_LABEL_WIDTH),
    stripAnsi(first.lines[0] ?? "").slice(TRANSCRIPT_LABEL_WIDTH),
  );
});

test("memo: replacing the blocks array invalidates the render", () => {
  const options = { width: 60, height: 6 };
  const atLatest = { ...options, scroll: latestTranscriptScroll() };
  const alpha = seniorReply("proposal: alpha\n\n" + "alpha detail ".repeat(40));
  const first = transcriptView(alpha, atLatest);
  assert.ok(first.lines.join("\n").includes("alpha"));

  // Same block ids, different content: a new blocks array must not reuse rows.
  const beta = seniorReply("proposal: beta\n\n" + "beta detail ".repeat(40));
  const second = transcriptView(beta, atLatest);
  assert.ok(second.lines.join("\n").includes("beta"));
  assert.ok(!second.lines.join("\n").includes("alpha detail"));
  assert.deepEqual(second.lines, transcriptView(cloneModel(beta), atLatest).lines);

  // A copied array with equal content renders the same bytes from scratch.
  assert.deepEqual(transcriptView(cloneModel(alpha), atLatest).lines, first.lines);

  // Appending a block derives a new document (the model is immutable).
  const grown = commitEnvelope(
    alpha,
    message("m1", "senior", "proposal: more\n\n" + "tail ".repeat(20), 2),
  );
  assert.notDeepEqual(transcriptView(grown, atLatest).lines, first.lines);
});

test("memo: a live reasoning change invalidates rows that share the blocks array", () => {
  const base = seniorReply("proposal: migration\n\n" + "step detail ".repeat(60));
  const options = { width: 60, height: 12, scroll: latestTranscriptScroll() };
  const one: TuiModel = {
    blocks: base.blocks,
    nextId: base.nextId,
    liveThinking: { role: "senior", text: "first thought", streaming: true },
  };
  const first = transcriptView(one, options);
  assert.ok(first.lines.join("\n").includes("first thought"));

  const two: TuiModel = {
    blocks: base.blocks,
    nextId: base.nextId,
    liveThinking: { role: "senior", text: "a longer thought with a second clause", streaming: true },
  };
  const second = transcriptView(two, options);
  assert.ok(second.lines.join("\n").includes("second clause"));
  assert.notDeepEqual(second.lines, first.lines, "the reasoning rows changed with the buffer");

  // The first model's own entry is still correct and unchanged.
  assert.deepEqual(transcriptView(one, options).lines, first.lines);
});

test("memo: identical output across widths, themes, find highlight and replay options", () => {
  const model = mixedModel(4);
  const dark = createTheme("dark");
  const findId = model.blocks[1]?.id ?? "";
  assert.notEqual(findId, "");
  for (const width of [20, 24, 40, 60, 80]) {
    for (const theme of [undefined, dark]) {
      const options = {
        width,
        height: 8,
        ...(theme !== undefined ? { theme } : {}),
        scroll: latestTranscriptScroll(),
      };
      const cold = transcriptView(model, options);
      // A differently keyed frame must not poison this width/theme entry.
      transcriptView(model, { ...options, width: width + 1 });
      const reused = transcriptView(model, options);
      assert.deepEqual(reused.lines, cold.lines, `${width}: cached frame is stable`);
      assert.deepEqual(
        transcriptView(cloneModel(model), options).lines,
        cold.lines,
        `${width}: the uncached reference renders the same bytes`,
      );
    }
  }

  // The find highlight is a row-text input (the `▸` label cell). The window is
  // anchored on the highlighted block so its label row is on screen.
  const findOptions = { width: 60, height: 8, scroll: scrollToBlock(findId) };
  const plainFrame = transcriptView(model, findOptions);
  const highlighted = transcriptView(model, { ...findOptions, activeBlockId: findId });
  assert.notDeepEqual(highlighted.lines, plainFrame.lines);
  assert.deepEqual(
    transcriptView(cloneModel(model), { ...findOptions, activeBlockId: findId }).lines,
    highlighted.lines,
  );

  // The replayed-reasoning section and its hidden-record bound are row inputs;
  // a fresh array with the same content is an uncached reference. The section
  // is the document prefix, so the frame is anchored at its top row.
  const replayed = [
    { role: "senior" as const, kind: "consult", text: "replayed reasoning record", truncated: false },
  ];
  const plainTen = transcriptView(model, {
    width: 60,
    height: 10,
    scroll: homeTranscriptScroll(model),
  });
  const withReplay = transcriptView(model, {
    width: 60,
    height: 10,
    replayedReasoning: replayed,
    scroll: homeTranscriptScroll(model, replayed),
  });
  assert.notDeepEqual(withReplay.lines, plainTen.lines);
  assert.deepEqual(
    transcriptView(cloneModel(model), {
      width: 60,
      height: 10,
      replayedReasoning: replayed.map((record) => ({ ...record })),
      scroll: homeTranscriptScroll(model, replayed),
    }).lines,
    withReplay.lines,
  );
  const hiddenBound = transcriptView(model, {
    width: 60,
    height: 10,
    replayedReasoning: replayed,
    hiddenReplayedReasoning: 3,
    scroll: homeTranscriptScroll(model, replayed),
  });
  assert.ok(hiddenBound.lines.join("\n").includes("3 earlier reasoning records"));
  assert.notDeepEqual(hiddenBound.lines, withReplay.lines);
  assert.deepEqual(
    transcriptView(cloneModel(model), {
      width: 60,
      height: 10,
      replayedReasoning: replayed.map((record) => ({ ...record })),
      hiddenReplayedReasoning: 3,
      scroll: homeTranscriptScroll(model, replayed),
    }).lines,
    hiddenBound.lines,
  );
});

test("memo: per-row tool expansion is keyed by the derived blocks identity", () => {
  const model = mixedModel(3);
  const tools = model.blocks.filter((block) => block.kind === "tool");
  const tool = tools[tools.length - 1];
  assert.ok(tool !== undefined);
  const keys = new Set([toolExpansionKey(tool)]);
  const options = { width: 60, height: 12, scroll: scrollToBlock(tool.id) };
  const collapsed = transcriptView(model, options);
  // `withToolExpansion` derives a new blocks array with a cloned tool row, so
  // the expansion state is part of the memo identity.
  const expandedA = transcriptView(withToolExpansion(model, keys), options);
  const expandedB = transcriptView(withToolExpansion(model, keys), options);
  assert.notDeepEqual(expandedA.lines, collapsed.lines, "expansion shows more tool rows");
  assert.deepEqual(expandedB.lines, expandedA.lines, "two identical expansions render identically");
  assert.deepEqual(
    transcriptView(withToolExpansion(model, new Set()), options).lines,
    collapsed.lines,
    "an empty key set returns the input model and the collapsed frame",
  );
});

test("scrollTranscript: one positioned-rows pass per call", () => {
  const model = seniorReply("proposal: migration\n\n" + "step detail ".repeat(120));
  const options = { width: 60, height: 6 };

  const rendered = countingModel(cloneModel(model));
  transcriptView(rendered.model, { ...options, scroll: latestTranscriptScroll() });
  assert.equal(rendered.blockAccesses(), 1, "one frame is one positioned-rows pass");

  // A fresh blocks array: the scroll must render once, not twice.
  const scrolled = countingModel(cloneModel(model));
  const scroll = scrollTranscript(scrolled.model, latestTranscriptScroll(), -5, options);
  assert.equal(
    scrolled.blockAccesses(),
    1,
    "scrollTranscript reuses the rows it rendered (no duplicate pass)",
  );
  assert.equal(scroll.followLatest, false);
  const view = transcriptView(model, { ...options, scroll });
  assert.equal(view.atLatest, false);
  assert.ok(bottomMarkerRow(view) >= 0);
});
