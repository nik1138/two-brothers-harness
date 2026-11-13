/**
 * TUI helper observation (slice O1): the pure row model, event/detail folding,
 * the bounded list and child-transcript views, the overlay key routing, and the
 * status-bar/side-panel/approval surfaces. No terminal, no network, no timers.
 *
 * Run with: node --test tests/tuihelpers.test.ts
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { resolveConfig } from "../src/config.ts";
import { emptyUsage, type UsageTotals } from "../src/provider.ts";
import type { RuntimeEvent } from "../src/runevents.ts";
import { resolveKey, TUI_COMMANDS } from "../src/tui/keymap.ts";
import {
  emptyRuntimeSnapshot,
  resolveTuiProviderState,
} from "../src/tui/providers.ts";
import { displayWidth } from "../src/tui/text.ts";
import {
  approvalPanelHints,
  approvalPanelView,
  createApprovalPanelState,
  type ApprovalPanelItem,
} from "../src/tui/view/approval.ts";
import {
  HELPERS_DETAIL_MAX_ROWS,
  HELPERS_EMPTY_COPY,
  HELPERS_LIST_MAX_ROWS,
  HELPERS_MEMORY_COPY,
  HELPER_SCROLL_PAGE,
  HELPER_UNKNOWN_COPY,
  createHelperOverlayState,
  foldHelperDetail,
  foldHelperEvent,
  helperActivityLabel,
  helperCounts,
  helperDetailHeader,
  helperDetailRows,
  helperDetailView,
  helperElapsed,
  helperOverlayKey,
  helperRowsFromSummaries,
  helperSelectionIndex,
  helperStatusGlyph,
  helperTokenLabel,
  helpersListView,
  helpersListTitle,
  selectedHelperRow,
  type HelperOverlayState,
  type HelperRow,
} from "../src/tui/view/helpers.ts";
import {
  sidePanelEntries,
  type SidePanelState,
} from "../src/tui/view/sidepanel.ts";
import { statusBarSegments, type StatusBarState } from "../src/tui/view/statusbar.ts";
import {
  HELPER_UNKNOWN_COPY as UNKNOWN_COPY,
} from "../src/tui/view/helpers.ts";
import {
  SubagentStore,
  type SubagentDetail,
  type SubagentSummary,
} from "../src/subagent.ts";

function tmpdir(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tuihelpers-"));
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function usage(partial: Partial<UsageTotals> = {}): UsageTotals {
  return { ...emptyUsage(), ...partial };
}

function summary(overrides: Partial<SubagentSummary> = {}): SubagentSummary {
  return {
    id: "sub-aaaaaaaaaaaaaaaa",
    parent_session: "parent.jsonl",
    label: "read the auth module",
    role: "junior",
    model: "child-model",
    task: "Read the auth module.",
    status: "running",
    started_at: 1_000,
    last_activity: null,
    usage: null,
    result: null,
    error: null,
    ...overrides,
  };
}

function startedEvent(overrides: Record<string, unknown> = {}): RuntimeEvent {
  return {
    type: "subagent_started",
    subagent_id: "sub-aaaaaaaaaaaaaaaa",
    label: "read the auth module",
    role: "junior",
    model: "child-model",
    task: "Read the auth module.",
    started_at: 1_000,
    at: 1,
    ...overrides,
  } as RuntimeEvent;
}

function activityEvent(overrides: Record<string, unknown> = {}): RuntimeEvent {
  return {
    type: "subagent_activity",
    subagent_id: "sub-aaaaaaaaaaaaaaaa",
    label: "read the auth module",
    activity: "tool",
    tool: "workspace_read_file",
    status: "started",
    at: 2,
    ...overrides,
  } as RuntimeEvent;
}

function completedEvent(overrides: Record<string, unknown> = {}): RuntimeEvent {
  return {
    type: "subagent_completed",
    subagent_id: "sub-aaaaaaaaaaaaaaaa",
    label: "read the auth module",
    status: "completed",
    result: "the module is fine",
    usage: { input_tokens: 1_200, output_tokens: 300, model_calls: 2 },
    duration_ms: 41_000,
    ended_at: 42_000,
    at: 42,
    ...overrides,
  } as RuntimeEvent;
}

function detailWith(transcript: SubagentDetail["transcript"], overrides: Partial<SubagentDetail> = {}): SubagentDetail {
  return {
    ...summary(),
    status: "completed",
    ended_at: 42_000,
    duration_ms: 41_000,
    usage: usage({ input_tokens: 1_000, output_tokens: 200, model_calls: 2 }),
    transcript: [...transcript],
    ...overrides,
  };
}

function viewFamily(rows: readonly HelperRow[]): string[][] {
  const out: string[][] = [];
  for (const width of [40, 80, 120]) {
    for (let height = 10; height <= 22; height += 1) {
      out.push(helpersListView(rows, createHelperOverlayState(rows[0]?.id ?? null), {
        width,
        height,
        now: 10_000,
      }).lines);
    }
  }
  return out;
}

// --------------------------------------------------------------------------- //
// row model + event folding
// --------------------------------------------------------------------------- //

test("started creates a newest-first row with no invented usage", () => {
  const rows = foldHelperEvent([], startedEvent());
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.id, "sub-aaaaaaaaaaaaaaaa");
  assert.equal(rows[0]?.label, "read the auth module");
  assert.equal(rows[0]?.role, "junior");
  assert.equal(rows[0]?.model, "child-model");
  assert.equal(rows[0]?.status, "running");
  assert.equal(rows[0]?.background, false);
  assert.equal(rows[0]?.startedAt, 1_000);
  assert.equal(rows[0]?.usage, null);
  assert.equal(helperCounts(rows).running, 1);

  const second = foldHelperEvent(rows, startedEvent({
    subagent_id: "sub-bbbbbbbbbbbbbbbb",
    label: "summarise the schema",
    started_at: 2_000,
    background: true,
  }));
  assert.deepEqual(second.map((row) => row.id), [
    "sub-bbbbbbbbbbbbbbbb",
    "sub-aaaaaaaaaaaaaaaa",
  ]);
  assert.equal(second[0]?.background, true);
});

test("activity sets the live label; an unknown id is a no-op", () => {
  const rows = foldHelperEvent([], startedEvent());
  const active = foldHelperEvent(rows, activityEvent());
  assert.equal(active[0]?.activity?.kind, "tool");
  assert.equal(active[0]?.activity?.tool, "workspace_read_file");
  assert.equal(helperActivityLabel(active[0]!), "using workspace_read_file");

  const done = foldHelperEvent(active, activityEvent({ status: "completed" }));
  assert.equal(helperActivityLabel(done[0]!), "workspace_read_file done");

  const unknown = foldHelperEvent(rows, activityEvent({ subagent_id: "sub-cccccccccccccccc" }));
  assert.deepEqual(unknown, rows, "an event for an unknown id invents no row");
  assert.equal(unknown, rows, "and keeps the array identity");
});

test("completed flips status, usage and elapsed; it is idempotent and final", () => {
  const rows = foldHelperEvent(foldHelperEvent([], startedEvent()), completedEvent());
  assert.equal(rows[0]?.status, "completed");
  assert.equal(rows[0]?.endedAt, 42_000);
  assert.equal(rows[0]?.usage?.input_tokens, 1_200);
  assert.equal(helperActivityLabel(rows[0]!), "reported");
  assert.equal(helperTokenLabel(rows[0]?.usage), "1.5k tok");

  const twice = foldHelperEvent(rows, completedEvent());
  assert.deepEqual(twice, rows, "a duplicate terminal event changes nothing");

  const lateApproval = foldHelperEvent(rows, {
    type: "approval_requested",
    approval_id: "ap-1",
    action: "write",
    subagent_id: "sub-aaaaaaaaaaaaaaaa",
    at: 50,
  } as RuntimeEvent);
  assert.deepEqual(lateApproval, rows, "a settled row is never reopened");
});

test("a cancelled completion keeps the cancelled label and cause", () => {
  const rows = foldHelperEvent(foldHelperEvent([], startedEvent()), completedEvent({
    status: "cancelled",
    result: undefined,
    error: "interrupted by the operator",
    cancelled_by: "operator",
  }));
  assert.equal(rows[0]?.status, "cancelled");
  assert.equal(helperStatusGlyph(rows[0]!.status), "⊘");
  assert.equal(helperActivityLabel(rows[0]!), "cancelled");
});

test("child-tagged approvals flip awaiting_approval and back while running", () => {
  const running = foldHelperEvent([], startedEvent());
  const parked = foldHelperEvent(running, {
    type: "approval_requested",
    approval_id: "ap-1",
    action: "write",
    target: "src/a.ts",
    subagent_id: "sub-aaaaaaaaaaaaaaaa",
    subagent_label: "read the auth module",
    at: 5,
  } as RuntimeEvent);
  assert.equal(parked[0]?.activity?.status, "awaiting_approval");
  assert.equal(helperActivityLabel(parked[0]!), "waiting for approval");

  const resumed = foldHelperEvent(parked, {
    type: "approval_resolved",
    approval_id: "ap-1",
    decision: "allow",
    subagent_id: "sub-aaaaaaaaaaaaaaaa",
    at: 6,
  } as RuntimeEvent);
  assert.equal(resumed[0]?.activity?.status, "running");
  assert.equal(helperActivityLabel(resumed[0]!), "working…");

  const brother = foldHelperEvent(running, {
    type: "approval_requested",
    approval_id: "ap-2",
    action: "write",
    at: 7,
  } as RuntimeEvent);
  assert.deepEqual(brother, running, "a brother's approval never names a helper");
});

test("store summaries map to rows newest-first with the background and token labels", () => {
  const rows = helperRowsFromSummaries([
    summary({ id: "sub-aaaaaaaaaaaaaaaa", started_at: 100, status: "completed", ended_at: 41_000, usage: usage({ input_tokens: 3_000, output_tokens: 200 }) }),
    summary({ id: "sub-bbbbbbbbbbbbbbbb", started_at: 200, background: true }),
  ]);
  assert.deepEqual(rows.map((row) => row.id), ["sub-bbbbbbbbbbbbbbbb", "sub-aaaaaaaaaaaaaaaa"]);
  assert.equal(rows[0]?.background, true);
  assert.equal(rows[1]?.endedAt, 41_000);
  assert.equal(helperTokenLabel(rows[1]?.usage), "3.2k tok");
  assert.equal(helperTokenLabel(null), "", "unknown usage invents no number");
  assert.equal(helperTokenLabel(usage()), "", "zero usage is not a token claim");
});

test("selection is anchored by id across an insertion", () => {
  const first = foldHelperEvent([], startedEvent());
  const both = foldHelperEvent(first, startedEvent({
    subagent_id: "sub-bbbbbbbbbbbbbbbb",
    label: "summarise the schema",
    started_at: 2_000,
  }));
  const selected = "sub-aaaaaaaaaaaaaaaa";
  assert.equal(helperSelectionIndex(both, selected), 1);
  assert.equal(selectedHelperRow(both, selected)?.id, selected);

  const inserted = foldHelperEvent(both, startedEvent({
    subagent_id: "sub-cccccccccccccccc",
    label: "a brand new helper",
    started_at: 3_000,
  }));
  assert.equal(
    helperSelectionIndex(inserted, selected),
    2,
    "the selected child keeps its identity even though its index moved",
  );
  assert.equal(selectedHelperRow(inserted, selected)?.id, selected);
  assert.equal(helperSelectionIndex(inserted, null), 0);
  assert.equal(selectedHelperRow([], selected), null);
});

// --------------------------------------------------------------------------- //
// labels
// --------------------------------------------------------------------------- //

test("status glyphs, elapsed and activity labels are the shared vocabulary", () => {
  assert.equal(helperStatusGlyph("running"), "●");
  assert.equal(helperStatusGlyph("completed"), "✓");
  assert.equal(helperStatusGlyph("failed"), "✕");
  assert.equal(helperStatusGlyph("cancelled"), "⊘");
  assert.equal(helperElapsed(1_000, 42_000), "0:41");
  assert.equal(helperElapsed(1_000, 3_723_000), "1:02:02");
  assert.equal(helperElapsed(0, undefined), "", "an unset start stays unknown");
  assert.equal(helperElapsed(1_000, undefined, 31_000), "0:30");
  const running: HelperRow = { ...helperRowsFromSummaries([summary()])[0]! };
  assert.equal(helperActivityLabel(running), "starting…");
  running.activity = { kind: "message", text: "reading…", at: 1 };
  assert.equal(helperActivityLabel(running), "reading…");
  running.activity = { kind: "message", at: 1 };
  assert.equal(helperActivityLabel(running), "writing report…");
  running.activity = { kind: "status", status: "failed", at: 1 };
  assert.equal(helperActivityLabel(running), "failed");
  running.status = "failed";
  running.activity = null;
  assert.equal(helperActivityLabel(running), "");
  assert.match(helpersListTitle(foldHelperEvent([], startedEvent())), /2 total|1 total/);
});

// --------------------------------------------------------------------------- //
// list view
// --------------------------------------------------------------------------- //

test("list view is exact geometry at 40/80/120 columns and every height", () => {
  const rows = foldHelperEvent(foldHelperEvent([], startedEvent()), completedEvent());
  for (const lines of viewFamily(rows)) {
    for (const row of lines) assert.ok(!row.includes("\u001b"), "plain theme emits no escapes");
  }
  for (const width of [40, 80, 120]) {
    for (let height = 10; height <= 22; height += 1) {
      const view = helpersListView(rows, createHelperOverlayState(rows[0]?.id ?? null), {
        width,
        height,
        now: 10_000,
      });
      assert.equal(view.lines.length, height, `height ${height}`);
      for (const row of view.lines) {
        assert.equal(displayWidth(row), width, `width ${width} @ ${height}`);
      }
      assert.equal(view.lines[0]?.includes("HELPERS ·"), true, "the title carries the counts");
      const joined = view.lines.join("\n");
      assert.ok(joined.includes("read the auth module") || width === 40, "the label is visible when it fits");
      assert.ok(joined.includes("0:41"), "the settled elapsed time is visible");
    }
  }
});

test("list selection row and the honest tail are bounded", () => {
  const rows: HelperRow[] = [];
  for (let index = 0; index < 25; index += 1) {
    rows.push(...helperRowsFromSummaries([summary({
      id: `sub-${index.toString(16).padStart(16, "0")}`,
      label: `helper ${index}`,
      started_at: 1_000 + index,
    })]));
  }
  rows.sort((left, right) => right.startedAt - left.startedAt);
  const selectedId = rows[3]?.id ?? null;
  const view = helpersListView(rows, createHelperOverlayState(selectedId), {
    width: 80,
    height: 22,
    now: 10_000,
  });
  assert.equal(view.lines.length, 22);
  assert.ok(view.hidden > 0);
  assert.ok(view.lines.join("\n").includes(`+${view.hidden} older (not shown)`));
  assert.ok(view.visible.length <= HELPERS_LIST_MAX_ROWS);
  const selectedLine = view.lines[view.selectedRow];
  assert.ok(selectedLine?.includes("› "), "the selected row is marked");
  assert.ok(selectedLine?.includes("helper"), "the selected row is the id-anchored one");

  // The hard cap holds even in a tall box: at most HELPERS_LIST_MAX_ROWS rows
  // are rendered before the tail.
  const tall = helpersListView(rows, createHelperOverlayState(selectedId), {
    width: 84,
    height: 26,
    now: 10_000,
  });
  assert.ok(tall.visible.length < HELPERS_LIST_MAX_ROWS + 1);
  assert.ok(tall.lines.join("\n").includes("older (not shown)"));
});

test("list empty states are honest: no delegation yet vs an in-memory session", () => {
  const empty = helpersListView([], createHelperOverlayState(), { width: 80, height: 12 });
  assert.equal(empty.empty, true);
  assert.ok(empty.lines.join("\n").includes(HELPERS_EMPTY_COPY));
  assert.equal(empty.selectedRow, -1);

  const memory = helpersListView([], createHelperOverlayState(), {
    width: 80,
    height: 12,
    inMemory: true,
  });
  assert.ok(memory.lines.join("\n").includes(HELPERS_MEMORY_COPY));
  assert.notEqual(HELPERS_MEMORY_COPY, HELPERS_EMPTY_COPY);

  const one = helpersListView(helperRowsFromSummaries([summary()]), createHelperOverlayState(), {
    width: 80,
    height: 12,
    now: 10_000,
  });
  assert.equal(one.empty, false);
  assert.equal(one.selectedRow, 1, "the first content row sits under the title");
  const hints = one.lines.join("\n");
  assert.ok(hints.includes("Up / Down move · Enter open · Esc close"), "the footer derives its chords");
});

test("model text is sanitized before it reaches a row", () => {
  const rows = helperRowsFromSummaries([summary({
    label: "\u001b[31mowned\u0007 row",
    last_activity: { kind: "message", text: "\u001b]0;title\u0007paint", at: 1 },
  })]);
  const view = helpersListView(rows, createHelperOverlayState(rows[0]!.id), {
    width: 80,
    height: 12,
    now: 10_000,
  });
  const text = view.lines.join("\n");
  assert.ok(!text.includes("\u001b"));
  assert.ok(!text.includes("\u0007"));
  assert.ok(text.includes("owned"));
});

// --------------------------------------------------------------------------- //
// detail rows + view
// --------------------------------------------------------------------------- //

test("detail rows label task, helper, tool, approval and follow-up rows", () => {
  const detail = detailWith([
    { type: "message", role: "user", text: "Read the auth module.", at: 1 },
    { type: "message", role: "assistant", text: "Reading it now.", at: 2 },
    { type: "tool", tool: "workspace_read_file", status: "started", args: { path: "src/auth.ts" }, at: 3 },
    { type: "tool", tool: "workspace_read_file", status: "completed", result: "export const x = 1;", at: 4 },
    { type: "approval", status: "allowed", action: "write", target: "src/auth.ts", at: 5 },
    { type: "message", role: "user", origin: "operator", text: "Also check the tests.", at: 6 },
    { type: "message", role: "assistant", text: "All good.", at: 7 },
  ]);
  const rows = helperDetailRows(detail);
  assert.deepEqual(rows.map((row) => row.label), [
    "Task",
    "Helper",
    "Tool · workspace_read_file · started",
    "Tool · workspace_read_file · completed",
    "Approval · write",
    "Follow-up · operator",
    "Helper",
  ]);
  assert.equal(rows[2]?.kind, "tool");
  assert.match(rows[2]?.text ?? "", /src\/auth\.ts/);
  assert.match(rows[3]?.text ?? "", /export const x = 1;/);
  assert.match(rows[4]?.text ?? "", /src\/auth\.ts — allowed/);
  assert.equal(rows[5]?.kind, "followup");
  assert.equal(rows.some((row) => row.kind === "report"), false, "the final report is an Assistant row");

  const seniorFollowUp = helperDetailRows(detailWith([
    { type: "message", role: "user", origin: "senior", text: "Check one more thing.", at: 1 },
  ]));
  assert.equal(seniorFollowUp[0]?.label, "Follow-up · Senior");
});

test("detail rows report a failure and an unduplicated report honestly", () => {
  const failed = helperDetailRows(detailWith([], {
    status: "failed",
    error: "upstream exploded",
    result: null,
  }));
  assert.ok(failed.some((row) => row.kind === "error" && row.text.includes("upstream exploded")));

  const reported = helperDetailRows(detailWith([
    { type: "message", role: "assistant", text: "the final report", at: 1 },
  ], { result: "the final report" }));
  assert.equal(reported.filter((row) => row.kind === "report").length, 0);

  const onlyResult = helperDetailRows(detailWith([], { result: "a seeded report" }));
  assert.equal(onlyResult.filter((row) => row.kind === "report").length, 1);

  const empty = helperDetailRows(detailWith([], { status: "running", result: null, error: null }));
  assert.equal(empty[0]?.kind, "empty");
});

test("the detail transcript is capped at 400 rows from the tail", () => {
  const transcript: SubagentDetail["transcript"] = [];
  for (let index = 0; index < HELPERS_DETAIL_MAX_ROWS + 50; index += 1) {
    transcript.push({ type: "message", role: "assistant", text: `row ${index}`, at: index });
  }
  const rows = helperDetailRows(detailWith(transcript, { result: null }));
  assert.equal(rows.length, HELPERS_DETAIL_MAX_ROWS);
  assert.equal(rows[0]?.text, "row 50", "the oldest rows drop first");
  assert.equal(rows.at(-1)?.text, `row ${HELPERS_DETAIL_MAX_ROWS + 49}`);
});

test("detail view is exact geometry and the header states model, status and tokens", () => {
  const detail = detailWith([
    { type: "message", role: "user", text: "Read the auth module.", at: 1 },
    { type: "message", role: "assistant", text: "Done.", at: 2 },
  ]);
  const state = createHelperOverlayState(detail.id);
  for (const width of [40, 80, 120]) {
    for (const height of [10, 14, 22]) {
      const view = helperDetailView(detail, state, { width, height, now: 10_000 });
      assert.equal(view.lines.length, height);
      for (const row of view.lines) assert.equal(displayWidth(row), width);
    }
  }
  const view = helperDetailView(detail, state, { width: 84, height: 22, now: 10_000 });
  const text = view.lines.join("\n");
  assert.ok(text.includes("read the auth module"));
  assert.ok(text.includes("child-model · junior"));
  assert.ok(text.includes("completed · 0:41"));
  assert.ok(text.includes("tokens 1.2k tok"));
  assert.ok(text.includes("Task · Read the auth module."));
  assert.ok(text.includes("PgUp / PgDn scroll · Esc back"), "the footer derives its chords");
  assert.deepEqual(helperDetailHeader(detail, { now: 10_000 }), [
    "read the auth module",
    "child-model · junior",
    "completed · 0:41",
    "tokens 1.2k tok",
  ]);
});

test("detail scrolling follows the tail and pages backwards", () => {
  const transcript: SubagentDetail["transcript"] = [];
  for (let index = 0; index < 50; index += 1) {
    transcript.push({ type: "message", role: "assistant", text: `row ${index}`, at: index });
  }
  const detail = detailWith(transcript, { result: null });
  const following = helperDetailView(detail, createHelperOverlayState(detail.id), {
    width: 84,
    height: 20,
    now: 10_000,
  });
  assert.equal(following.rows.length, 50);
  assert.equal(following.visible.at(-1)?.text, "row 49", "offset 0 keeps the newest row visible");
  assert.equal(following.start, 50 - following.visible.length);

  const scrolled = helperDetailView(
    detail,
    { ...createHelperOverlayState(detail.id), scroll: 10 },
    { width: 84, height: 20, now: 10_000 },
  );
  assert.equal(scrolled.visible.at(-1)?.text, "row 39");
  assert.equal(scrolled.start, following.start - 10);
  assert.ok(scrolled.lines.join("\n").includes("scrolled 10 from the tail"));
});

test("PgUp/PgDn scroll the open transcript; the offset clamps", () => {
  const detail = detailWith(
    Array.from({ length: 50 }, (_, index) => ({
      type: "message" as const,
      role: "assistant" as const,
      text: `row ${index}`,
      at: index,
    })),
  );
  const state: HelperOverlayState = { ...createHelperOverlayState(detail.id), detail };
  const up = helperOverlayKey(
    TUI_COMMANDS,
    [],
    state,
    { name: "pageup", raw: "\u001b[5~" },
  );
  assert.equal(up.action, "scroll");
  assert.equal(up.state.scroll, HELPER_SCROLL_PAGE);
  const down = helperOverlayKey(
    TUI_COMMANDS,
    [],
    up.state,
    { name: "pagedown", raw: "\u001b[6~" },
  );
  assert.equal(down.state.scroll, 0);
  const clamped = helperOverlayKey(
    TUI_COMMANDS,
    [],
    { ...state, scroll: 49 },
    { name: "pageup", raw: "\u001b[5~" },
  );
  assert.equal(clamped.state.scroll, 50, "the offset never exceeds the row count");
});

// --------------------------------------------------------------------------- //
// overlay key routing (Esc layering)
// --------------------------------------------------------------------------- //

test("Esc layering: detail → list → closed, Enter opens the anchored selection", () => {
  const rows = helperRowsFromSummaries([
    summary({ id: "sub-aaaaaaaaaaaaaaaa", started_at: 2_000 }),
    summary({ id: "sub-bbbbbbbbbbbbbbbb", label: "older", started_at: 1_000 }),
  ]);
  const detail = detailWith([{ type: "message", role: "user", text: "Task.", at: 1 }]);
  const open: HelperOverlayState = { selectedId: "sub-bbbbbbbbbbbbbbbb", detail, scroll: 3 };

  const back = helperOverlayKey(TUI_COMMANDS, rows, open, { name: "escape", raw: "\u001b" });
  assert.equal(back.action, "back");
  assert.equal(back.state.detail, null);
  assert.equal(back.state.scroll, 0);
  assert.equal(back.state.selectedId, "sub-bbbbbbbbbbbbbbbb", "the list keeps its selection");

  const enterBack = helperOverlayKey(TUI_COMMANDS, rows, open, { name: "return", raw: "\r" });
  assert.equal(enterBack.action, "back", "Enter in the detail returns to the list");

  const fromList = helperOverlayKey(TUI_COMMANDS, rows, back.state, { name: "escape", raw: "\u001b" });
  assert.equal(fromList.action, "close");

  const accepted = helperOverlayKey(TUI_COMMANDS, rows, back.state, { name: "return", raw: "\r" });
  assert.equal(accepted.action, "open");
  assert.equal(accepted.state.selectedId, "sub-bbbbbbbbbbbbbbbb", "Enter opens the anchored child");

  const moved = helperOverlayKey(TUI_COMMANDS, rows, back.state, { name: "up", raw: "\u001b[A" });
  assert.equal(moved.action, "move");
  assert.equal(moved.state.selectedId, "sub-aaaaaaaaaaaaaaaa", "moving wraps to the newest row");

  const toggled = helperOverlayKey(TUI_COMMANDS, rows, back.state, { name: "y", ctrl: true, raw: "\u0019" });
  assert.equal(toggled.action, "close", "Ctrl+Y toggles the overlay closed");

  const empty = helperOverlayKey(TUI_COMMANDS, [], createHelperOverlayState(), {
    name: "return",
    raw: "\r",
  });
  assert.equal(empty.action, "none");
});

test("Ctrl+Y (agents) resolves in the app scope and never while an overlay owns keys", () => {
  const key = { name: "y", ctrl: true, raw: "\u0019" };
  assert.equal(resolveKey(TUI_COMMANDS, key, "app")?.command.id, "agents");
  assert.equal(resolveKey(TUI_COMMANDS, key, "overlay"), null, "overlay scope does not claim it");
});

test("unknown-id copy is the honest state the app reports", () => {
  assert.equal(HELPER_UNKNOWN_COPY, "That helper is not in this session's log.");
  assert.equal(UNKNOWN_COPY, HELPER_UNKNOWN_COPY);
});

// --------------------------------------------------------------------------- //
// store-shaped detail
// --------------------------------------------------------------------------- //

test("a real store.get detail renders the same rows the log recorded", () => {
  const { root, cleanup } = tmpdir();
  try {
    const store = new SubagentStore(path.join(root, "subagents"));
    const id = "sub-0123456789abcdef";
    store.begin({
      id,
      parent_session: "parent.jsonl",
      label: "read the auth module",
      role: "junior",
      model: "child-model",
      task: "Read the auth module.",
      started_at: 1_000,
    });
    store.append(id, { type: "message", role: "user", text: "Read the auth module.", at: 1_000 });
    store.append(id, {
      type: "tool",
      tool: "workspace_read_file",
      status: "started",
      args: { path: "src/auth.ts" },
      at: 1_100,
    });
    store.append(id, {
      type: "tool",
      tool: "workspace_read_file",
      status: "completed",
      result: "export const x = 1;",
      at: 1_200,
    });
    store.append(id, { type: "message", role: "assistant", text: "Looks fine.", at: 1_300 });
    store.finish(id, {
      status: "completed",
      ended_at: 1_400,
      result: "Looks fine.",
      usage: usage({ input_tokens: 900, output_tokens: 100 }),
    });
    const detail = store.get(id);
    assert.ok(detail);
    const rows = helperDetailRows(detail);
    assert.deepEqual(rows.map((row) => row.label), [
      "Task",
      "Tool · workspace_read_file · started",
      "Tool · workspace_read_file · completed",
      "Helper",
    ]);
    assert.equal(rows.some((row) => row.kind === "report"), false);
    const view = helperDetailView(detail, createHelperOverlayState(id), {
      width: 84,
      height: 22,
      now: 10_000,
    });
    assert.ok(view.lines.join("\n").includes("Task · Read the auth module."));
    assert.equal(helperTokenLabel(detail.usage), "1.0k tok");
  } finally {
    cleanup();
  }
});

test("a child detail folds live events without inventing transcript rows", () => {
  const detail = detailWith([
    { type: "message", role: "user", text: "Read the auth module.", at: 1 },
  ], { status: "running", result: null });
  const withMessage = foldHelperDetail(detail, activityEvent({
    activity: "message",
    text: "Reading it now.",
    tool: undefined,
    status: undefined,
  }));
  assert.equal(withMessage.transcript.length, 2);
  assert.equal(withMessage.transcript[1]?.type, "message");
  const duplicate = foldHelperDetail(withMessage, activityEvent({
    activity: "message",
    text: "Reading it now.",
    tool: undefined,
    status: undefined,
  }));
  assert.equal(duplicate.transcript.length, 2, "the store's own final text is not duplicated");

  const toolStart = foldHelperDetail(detail, activityEvent({ tool: "workspace_read_file", status: "started" }));
  assert.equal(toolStart.transcript.length, 2);
  const toolDone = foldHelperDetail(toolStart, activityEvent({
    tool: "workspace_read_file",
    status: "completed",
    result: "export const x = 1;",
  }));
  assert.equal(toolDone.transcript.length, 2, "a completion pairs with the open tool row");
  const paired = toolDone.transcript[1];
  assert.ok(paired?.type === "tool");
  assert.equal(paired.status, "completed");
  assert.match(paired.result ?? "", /export const x/);

  const approval = foldHelperDetail(detail, {
    type: "approval_requested",
    approval_id: "ap-1",
    action: "write",
    target: "src/auth.ts",
    subagent_id: detail.id,
    at: 5,
  } as RuntimeEvent);
  assert.ok(approval.transcript.some((entry) => entry.type === "approval" && entry.status === "pending"));
  const resolved = foldHelperDetail(approval, {
    type: "approval_resolved",
    approval_id: "ap-1",
    decision: "allow",
    subagent_id: detail.id,
    at: 6,
  } as RuntimeEvent);
  const row = resolved.transcript.find((entry) => entry.type === "approval");
  assert.ok(row?.type === "approval");
  assert.equal(row.status, "allowed");

  const otherChild = foldHelperDetail(detail, activityEvent({ subagent_id: "sub-ffffffffffffffff" }));
  assert.equal(otherChild, detail, "an event for another child is a no-op");
});

// --------------------------------------------------------------------------- //
// status bar / side panel / approval panel
// --------------------------------------------------------------------------- //

test("status bar gains one helpers segment after cost and is byte-identical without helpers", () => {
  const base: StatusBarState = {
    mode: "work",
    seniorModel: "senior-model",
    juniorModel: "junior-model",
    sessionName: "s.jsonl",
    cwd: "/tmp",
    running: true,
    activity: "running (work)…",
    cost: 0.01,
    elapsedMs: 5_000,
  };
  const [firstBase, secondBase] = statusBarSegments(base);
  const [firstNoHelpers, secondNoHelpers] = statusBarSegments({
    ...base,
    helpersRunning: undefined,
    helpersTotal: undefined,
  });
  assert.deepEqual(firstNoHelpers, firstBase);
  assert.deepEqual(secondNoHelpers, secondBase, "absent helper fields add nothing");
  assert.equal(secondBase.some((segment) => segment.text.startsWith("helpers")), false);

  const [first, second] = statusBarSegments({
    ...base,
    helpersRunning: 1,
    helpersTotal: 3,
  });
  assert.deepEqual(first, firstBase, "row one never moves");
  const costIndex = second.findIndex((segment) => segment.text.startsWith("cost "));
  const helperIndex = second.findIndex((segment) => segment.text.startsWith("helpers "));
  assert.equal(helperIndex, costIndex + 1, "the helper segment follows cost");
  assert.equal(second[helperIndex]?.text, "helpers 1 running · 2 done");
  assert.equal(second[helperIndex]?.tone, "warning");

  const done = statusBarSegments({ ...base, helpersRunning: 0, helpersTotal: 2 })[1];
  assert.equal(done.find((segment) => segment.text.startsWith("helpers "))?.text, "helpers 2 done");
  assert.equal(done.find((segment) => segment.text.startsWith("helpers "))?.tone, "muted");
});

test("side panel shows a HELPERS row only when the session has helpers", () => {
  const base: SidePanelState = { mode: "consult", seniorModel: "s", juniorModel: "j" };
  const withoutHelpers = sidePanelEntries(base);
  assert.equal(withoutHelpers.some((entry) => entry.label === "HELPERS"), false);
  const labels = withoutHelpers.map((entry) => entry.label);
  assert.ok(labels.includes("CONTEXT") && labels.includes("TOKENS") && labels.includes("COST"));

  const withHelpers = sidePanelEntries({ ...base, helpers: { total: 3, running: 1 } });
  const row = withHelpers.find((entry) => entry.label === "HELPERS");
  assert.equal(row?.value, "1 running · 3 total");
  assert.equal(row?.tone, "warning");
  const mcpIndex = withHelpers.findIndex((entry) => entry.label === "MCP");
  const helpersIndex = withHelpers.findIndex((entry) => entry.label === "HELPERS");
  assert.equal(helpersIndex, mcpIndex + 1, "the helper row follows MCP");
  // The brothers' numbers keep their own rows; nothing is merged into them.
  assert.equal(withHelpers.filter((entry) => entry.label === "HELPERS").length, 1);
  assert.deepEqual(
    withHelpers.filter((entry) => ["CONTEXT", "TOKENS", "COST"].includes(entry.label)),
    withoutHelpers.filter((entry) => ["CONTEXT", "TOKENS", "COST"].includes(entry.label)),
  );
  assert.equal(sidePanelEntries({ ...base, helpers: { total: 0, running: 0 } }).some((entry) => entry.label === "HELPERS"), false);
});

test("approval panel names the helper and keeps a brother's approval byte-identical", () => {
  const brother: ApprovalPanelItem = {
    approvalId: "ap-1",
    action: "write",
    target: "src/a.ts",
  };
  const brotherView = approvalPanelView(createApprovalPanelState(brother), { width: 80 });
  assert.equal(brotherView.lines.some((row) => row.includes("helper:")), false);
  const hints = approvalPanelHints(undefined, brother);

  const helper: ApprovalPanelItem = {
    ...brother,
    subagentId: "sub-aaaaaaaaaaaaaaaa",
    subagentLabel: "read the auth module",
  };
  const helperView = approvalPanelView(createApprovalPanelState(helper), { width: 80 });
  assert.ok(helperView.lines.some((row) => row.includes("helper: read the auth module")));
  assert.equal(
    approvalPanelHints(undefined, helper),
    hints,
    "the decision keys and hints are unchanged",
  );
  assert.equal(
    helperView.lines.filter((row) => row.includes("helper:")).length,
    1,
  );
  // A missing label falls back to the id so the operator still knows who asked.
  const idOnly = approvalPanelView(
    createApprovalPanelState({ ...brother, subagentId: "sub-aaaaaaaaaaaaaaaa" }),
    { width: 80 },
  );
  assert.ok(idOnly.lines.some((row) => row.includes("helper: sub-aaaaaaaaaaaaaaaa")));
});

// --------------------------------------------------------------------------- //
// provider route resolution (R15)
// --------------------------------------------------------------------------- //

test("the TUI resolves the configured helper route like serve does", () => {
  const cfg = resolveConfig({ provider: "mock" });
  const without = resolveTuiProviderState({
    snapshot: emptyRuntimeSnapshot(),
    storedPresets: [],
    cfg,
    env: {},
  });
  assert.equal(without.subagentEndpoint, null, "no route keeps the role fallback");

  const state = resolveTuiProviderState({
    snapshot: emptyRuntimeSnapshot(),
    storedPresets: [],
    cfg,
    env: {},
    subagentSnapshot: {
      provider: "openai",
      model: "helper-model",
      base_url: "http://helper.test/v1",
      api_key: "k",
      provider_ref: "",
    },
  });
  assert.equal(state.subagentEndpoint?.provider, "openai");
  assert.equal(state.subagentEndpoint?.model, "helper-model");
  assert.equal(state.subagentEndpoint?.baseUrl, "http://helper.test/v1");
  assert.equal(state.subagentEndpoint?.apiKey, "k");
});

test("a dangling helper provider_ref warns through the merged warning channel", () => {
  const cfg = resolveConfig({ provider: "mock" });
  const state = resolveTuiProviderState({
    snapshot: emptyRuntimeSnapshot(),
    storedPresets: [],
    cfg,
    env: {},
    subagentSnapshot: {
      provider: "",
      model: "m",
      base_url: "",
      api_key: "",
      provider_ref: "does-not-exist",
    },
  });
  assert.ok(state.subagentEndpoint !== null, "the route still resolves its manual fields");
  assert.ok(
    state.warnings.some((warning) => /subagent route/i.test(warning)),
    `expected a subagent route warning, got ${JSON.stringify(state.warnings)}`,
  );
});
