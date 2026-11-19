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
import { TOP_SLICE_MARKER, TRANSCRIPT_LABEL_WIDTH } from "../src/tui/transcript.ts";
import {
  latestTranscriptScroll,
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
      result: `line ${index}\n`.repeat(2),
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
