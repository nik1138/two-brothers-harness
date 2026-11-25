/**
 * Transcript-view lane: the parked ("n more" below) gutter marker and the
 * positioned-rows memoization. Both are view-local behaviors of
 * `src/tui/view/transcript.ts`; the renderer in `src/tui/transcript.ts` is only
 * read here.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { COMPACTION_SUMMARY_PREFIX, COMPACTION_SUMMARY_SUFFIX } from "../src/compaction.ts";
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
import {
  REPLAYED_REASONING_BLOCK_ID,
  renderReplayedReasoning,
} from "../src/tui/view/reasoning.ts";

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

test("window markers: a window inside the replayed reasoning section is never gutted", () => {
  const records = [
    {
      role: "senior" as const,
      kind: "consult",
      text: "a long replayed reasoning record ".repeat(20),
      truncated: false,
    },
    {
      role: "junior" as const,
      kind: "proposal",
      text: "      indented replay continuation",
      truncated: false,
    },
  ];
  const model = mixedModel(1);
  const width = 60;
  const sectionRows = renderReplayedReasoning(records, { width });
  const indented = sectionRows.findIndex((row) => row.includes("indented replay continuation"));
  assert.ok(indented > 1, "the fixture puts the indented row below a header and preview");

  // A window whose top row continues a replayed record: the record's header row
  // is above the window, but the replay section has no transcript gutter, so the
  // top-slice marker must not replace the row's first cells.
  const midRecord = transcriptView(model, {
    width,
    height: 2,
    replayedReasoning: records,
    scroll: { followLatest: false, anchorId: REPLAYED_REASONING_BLOCK_ID, offset: 1 },
  });
  assert.equal(midRecord.startRow, 1);
  assert.ok(midRecord.totalRows > midRecord.startRow + 2, "content follows the window");
  assert.ok(
    !stripAnsi(midRecord.lines[0] ?? "").includes(TOP_SLICE_MARKER),
    "a replayed record row is not turned into a guarded continuation row",
  );
  assert.ok(
    stripAnsi(midRecord.lines[0] ?? "").startsWith("  "),
    "the replay preview keeps its two-cell indent",
  );

  // A window whose bottom row is a replay row that happens to begin with a full
  // continuation gutter: the parked indicator skips it instead of overwriting
  // the record's own first cells with the hidden-row count.
  const parkedInside = transcriptView(model, {
    width,
    height: 3,
    replayedReasoning: records,
    scroll: {
      followLatest: false,
      anchorId: REPLAYED_REASONING_BLOCK_ID,
      offset: indented - 2,
    },
  });
  assert.equal(parkedInside.lines.length, 3);
  const bottom = stripAnsi(parkedInside.lines[2] ?? "");
  assert.ok(bottom.includes("indented replay continuation"), "the record text survives");
  assert.ok(
    !bottom.includes(TOP_SLICE_MARKER),
    "no parked marker overwrote the replayed record",
  );
  assert.ok(
    bottom.startsWith(" ".repeat(TRANSCRIPT_LABEL_WIDTH)),
    "the fixture row really uses the continuation gutter, so the skip is the guard",
  );
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

test("memo: a ninth distinct key evicts the oldest entry and keeps the newest eight", () => {
  const model = mixedModel(2);
  const counted = countingBlocks(model.blocks);
  const cached: TuiModel = { blocks: counted.blocks, nextId: model.nextId };
  const frame = (width: number): TranscriptView =>
    transcriptView(cached, { width, height: 6, scroll: latestTranscriptScroll() });

  const widths = [40, 41, 42, 43, 44, 45, 46, 47];
  for (const width of widths) frame(width);
  const afterEight = counted.reads();
  assert.ok(afterEight > 0, "the first frame renders every block");

  // All eight entries are live: re-requesting the oldest is a pure cache hit.
  frame(40);
  assert.equal(counted.reads(), afterEight, "the oldest of eight entries is still cached");

  // A ninth distinct key pushes the cache past its per-document entry budget.
  const ninth = frame(48);
  assert.ok(counted.reads() > afterEight, "the ninth key renders from scratch");
  const afterNine = counted.reads();

  // The oldest entry was evicted, so it renders again instead of being reused...
  frame(40);
  assert.ok(counted.reads() > afterNine, "the evicted oldest entry re-renders");
  const afterEvicted = counted.reads();
  // ...while the newest entry is still cached.
  const newest = frame(48);
  assert.equal(counted.reads(), afterEvicted, "the newest entry stays cached");
  assert.deepEqual(newest.lines, ninth.lines);
});

test("memo: the width key is floored, so a sub-cell resize reuses the same entry", () => {
  const base = seniorReply("proposal: migration\n\n" + "step detail ".repeat(40));
  const model = cloneModel(base);
  const counted = countingBlocks(model.blocks);
  const cached: TuiModel = { blocks: counted.blocks, nextId: model.nextId };
  const options = { width: 60.9, height: 6, scroll: latestTranscriptScroll() };
  const first = transcriptView(cached, options);
  const afterFirst = counted.reads();
  assert.ok(afterFirst > 0, "the first frame renders every block");

  const second = transcriptView(cached, { ...options, width: 60.1 });
  assert.equal(counted.reads(), afterFirst, "60.9 and 60.1 share the floored width entry");
  assert.deepEqual(second.lines, first.lines);

  const wider = transcriptView(cached, { ...options, width: 61 });
  assert.ok(counted.reads() > afterFirst, "the next whole column is a distinct entry");
  assert.notDeepEqual(wider.lines, first.lines);
});

test("memo: the tool row bound and the legacy expansion mode are invalidation inputs", () => {
  const model = mixedModel(1);
  const tool = model.blocks.find((block) => block.kind === "tool");
  assert.ok(tool !== undefined);
  const counted = countingBlocks(model.blocks);
  const cached: TuiModel = { blocks: counted.blocks, nextId: model.nextId };
  const scroll = scrollToBlock(tool.id);
  const render = (extra: { maxToolRows?: number; expandedTools?: boolean }): TranscriptView =>
    transcriptView(cached, { width: 60, height: 10, scroll, ...extra });

  const two = render({ maxToolRows: 2 });
  assert.ok(two.lines.join("\n").includes("… +"), "two rows show the hidden-line marker");
  const afterTwo = counted.reads();
  assert.ok(afterTwo > 0);
  render({ maxToolRows: 2 });
  assert.equal(counted.reads(), afterTwo, "the same bound is a cache hit");

  const five = render({ maxToolRows: 5 });
  assert.ok(counted.reads() > afterTwo, "a different bound re-renders");
  assert.notDeepEqual(five.lines, two.lines, "a different bound changes the tool rows");

  // The legacy expandedTools view is a different row mode, not just a bound.
  const detail = render({ maxToolRows: 2, expandedTools: true });
  assert.ok(counted.reads() > afterTwo, "the expanded mode re-renders");
  assert.notDeepEqual(detail.lines, two.lines, "the expanded view renders different detail rows");
  assert.notDeepEqual(detail.lines, five.lines);
  assert.ok(detail.lines.join("\n").includes("call: c0"), "the expanded rows carry the call id");

  // Earlier entries stay correct: a new key never poisons them.
  assert.deepEqual(render({ maxToolRows: 2 }).lines, two.lines);
  assert.deepEqual(render({ maxToolRows: 5 }).lines, five.lines);
});

test("memo: the summary preview bound is an invalidation input", () => {
  const body = "## Goal\n" + "summarize the migration plan ".repeat(12);
  let model = createTuiModel();
  model = commitEnvelope(
    model,
    message(
      "sum1",
      "user",
      `${COMPACTION_SUMMARY_PREFIX}${body}${COMPACTION_SUMMARY_SUFFIX}`,
      1,
    ),
  );
  const counted = countingBlocks(model.blocks);
  const cached: TuiModel = { blocks: counted.blocks, nextId: model.nextId };
  const render = (maxSummaryRows: number): TranscriptView =>
    transcriptView(cached, {
      width: 48,
      height: 10,
      maxSummaryRows,
      scroll: latestTranscriptScroll(),
    });

  const one = render(1);
  const afterOne = counted.reads();
  assert.ok(afterOne > 0);
  assert.ok(one.lines.join("\n").includes("context compacted"));
  render(1);
  assert.equal(counted.reads(), afterOne, "the same summary bound is a cache hit");

  const six = render(6);
  assert.ok(counted.reads() > afterOne, "a different summary bound re-renders");
  assert.notDeepEqual(six.lines, one.lines, "the bound changes the preview rows");
  assert.ok(six.lines.join("\n").includes("… +"), "the bound still collapses the hidden rows");

  // The bounded entry was kept correct across the differently keyed render.
  assert.deepEqual(render(1).lines, one.lines);
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
