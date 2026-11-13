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
import { wrapDisplay } from "../src/tui/screen.ts";
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
  createHelperFollowUpDraft,
  helperFollowUpToastText,
  helperInterruptToastText,
  foldHelperDetail,
  foldHelperEvent,
  helperActivityLabel,
  helperCost,
  helperCounts,
  helperDetailHeader,
  helperDetailRows,
  helperDetailView,
  helperElapsed,
  helperOverlayKey,
  helperRowFamily,
  helperRowsFromSummaries,
  helperSelectionIndex,
  helperStatusGlyph,
  helperTokenLabel,
  helperTokenTotal,
  helperUsageLine,
  helpersListView,
  helpersListTitle,
  selectedHelperRow,
  type HelperOverlayState,
  type HelperRoleKinds,
  type HelperRow,
} from "../src/tui/view/helpers.ts";
import {
  sidePanelEntries,
  type SidePanelState,
} from "../src/tui/view/sidepanel.ts";
import { renderStatusBar, statusBarSegments, type StatusBarState } from "../src/tui/view/statusbar.ts";
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
  assert.ok(
    text.includes("PgUp / PgDn scroll · i stop · m message · Esc back"),
    "the footer derives its chords (O2 appends the child controls)",
  );
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
  const open: HelperOverlayState = { selectedId: "sub-bbbbbbbbbbbbbbbb", detail, scroll: 3, draft: null, notice: null };

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

// --------------------------------------------------------------------------- //
// slice C: the helper usage/cache/cost roll-up (a separate helpers aggregate)
// --------------------------------------------------------------------------- //

/** One settled summary row; the store is the authority for these fields. */
function settledSummary(overrides: Partial<SubagentSummary> = {}): SubagentSummary {
  return summary({ status: "completed", started_at: 1, ...overrides });
}

test("helperUsageLine aggregates settled tokens with the status counts; running rows contribute none", () => {
  const kinds: HelperRoleKinds = { senior: "openai-compatible", junior: "openai-compatible" };
  const settled = settledSummary({
    usage: usage({ input_tokens: 1_200, output_tokens: 300 }),
  });
  const live = summary({ usage: usage({ input_tokens: 9_999, output_tokens: 9_999 }) });
  const rows = helperRowsFromSummaries([settled, live]);
  assert.equal(helperTokenTotal(rows, kinds), 1_500);
  assert.equal(
    helperUsageLine(rows, kinds),
    "1 running · 1 done · 1.5k tok · cost unknown",
    "the mock child model is unpriced, so the cost reads unknown — never a partial sum",
  );

  const doneOnly = helperRowsFromSummaries([settled]);
  assert.equal(helperUsageLine(doneOnly, kinds), "1 done · 1.5k tok · cost unknown");
  assert.equal(helperUsageLine([], kinds), null, "no helpers compose no line");
  assert.equal(helperTokenTotal([], kinds), null);
  assert.equal(helperCost([], kinds), null);
});

test("helper tokens are family-normalized: the recorded kind wins, else the role's kind", () => {
  const anthropicUsage = usage({
    input_tokens: 1_000,
    cached_tokens: 500,
    cache_write_tokens: 200,
    output_tokens: 100,
  });
  // Anthropic reports uncached-only input: the prompt total is 1 000 + 500 +
  // 200 = 1 700, plus 100 completion = 1 800.
  const recorded = helperRowsFromSummaries([
    settledSummary({ provider_kind: "anthropic", usage: anthropicUsage }),
  ]);
  assert.equal(helperRowFamily(recorded[0]!, { junior: "openai-compatible" }), "anthropic");
  assert.equal(helperTokenTotal(recorded, {}), 1_800);

  // Same row without the durable kind falls back to the role's resolved kind.
  const fallback = helperRowsFromSummaries([settledSummary({ usage: anthropicUsage })]);
  assert.equal(helperRowFamily(fallback[0]!, { junior: "anthropic" }), "anthropic");
  assert.equal(helperTokenTotal(fallback, { junior: "anthropic" }), 1_800);
  // With no known family anywhere the openai-compatible gauge applies
  // (prompt = input_tokens): 1 000 + 100 = 1 100.
  assert.equal(helperTokenTotal(fallback, {}), 1_100);
  assert.equal(helperTokenTotal(fallback, { junior: "not-a-kind" }), 1_100);

  // A live row never contributes tokens, whatever its family.
  const liveAnthropic = helperRowsFromSummaries([
    summary({ provider_kind: "anthropic", usage: anthropicUsage }),
  ]);
  assert.equal(helperTokenTotal(liveAnthropic, {}), null);
});

test("helperCost sums mixed families and is all-or-nothing on an unpriced child", () => {
  const kinds: HelperRoleKinds = { senior: "openai-compatible", junior: "openai-compatible" };
  const priced = helperRowsFromSummaries([
    settledSummary({
      provider_kind: "anthropic",
      model: "claude-sonnet-4",
      usage: usage({ input_tokens: 100_000 }),
    }),
    settledSummary({
      model: "gpt-4o-mini",
      usage: usage({ input_tokens: 100_000, output_tokens: 50_000 }),
    }),
  ]);
  const cost = helperCost(priced, kinds);
  assert.ok(cost !== null && Math.abs(cost - 0.345) < 1e-9, "0.30 + 0.045 USD");
  assert.equal(
    helperUsageLine(priced, kinds),
    "2 done · 250k tok · $0.3450",
  );

  // One settled token-bearing child with a model the table does not know
  // turns the WHOLE helper cost into `unknown` — the priced child never leaks
  // a partial sum.
  const mixed = helperRowsFromSummaries([
    settledSummary({ model: "gpt-4o-mini", usage: usage({ input_tokens: 100_000 }) }),
    settledSummary({ model: "child-model", usage: usage({ input_tokens: 10 }) }),
  ]);
  assert.equal(helperCost(mixed, kinds), null);
  assert.equal(helperTokenTotal(mixed, kinds), 100_010);
  assert.match(helperUsageLine(mixed, kinds) ?? "", /cost unknown$/);

  // Settled children that reported no tokens price as nothing, not as unknown.
  const silent = helperRowsFromSummaries([
    settledSummary({ model: "child-model", usage: usage() }),
  ]);
  assert.equal(helperCost(silent, kinds), null);
  assert.equal(helperUsageLine(silent, kinds), "1 done");
});

test("status bar renders the composed helpers aggregate after cost", () => {
  const base: StatusBarState = {
    mode: "work",
    seniorModel: "senior-model",
    juniorModel: "junior-model",
  };
  const state: StatusBarState = {
    ...base,
    cost: 0.01,
    helpersRunning: 0,
    helpersTotal: 2,
    helpersUsage: "2 done · 3.3k tok · $0.3450",
  };
  const [first, second] = statusBarSegments(state);
  const costIndex = second.findIndex((segment) => segment.text.startsWith("cost "));
  const helperIndex = second.findIndex((segment) => segment.text.startsWith("helpers "));
  assert.equal(helperIndex, costIndex + 1, "the aggregate still follows cost (drops first)");
  assert.equal(second[helperIndex]?.text, "helpers 2 done · 3.3k tok · $0.3450");
  assert.equal(second[helperIndex]?.tone, "muted");

  // Byte behavior at real widths: the whole segment fits at 120, drops whole
  // at 40 (never a torn half-segment), and row one never moves.
  const wide = renderStatusBar(state, { width: 120 });
  assert.match(wide[1] ?? "", /helpers 2 done · 3\.3k tok · \$0\.3450/);
  const narrow = renderStatusBar(state, { width: 40 });
  const noHelpers = renderStatusBar(base, { width: 40 });
  assert.deepEqual(narrow[0], noHelpers[0], "row one never moves for helpers");
  assert.equal((narrow[1] ?? "").includes("helpers"), false);
  assert.equal((narrow[0] ?? "").includes("helpers"), false);

  // Absent helpersUsage keeps the counts-only segment (pre-slice-C callers).
  const countsOnly = statusBarSegments({ ...state, helpersUsage: undefined })[1];
  assert.equal(
    countsOnly.find((segment) => segment.text.startsWith("helpers "))?.text,
    "helpers 2 done",
  );
});

test("side panel shows HELPER TOK and HELPER COST rows only when there is something settled", () => {
  const base: SidePanelState = { mode: "consult", seniorModel: "s", juniorModel: "j" };
  const without = sidePanelEntries({ ...base, helpers: { total: 1, running: 1 } });
  assert.equal(without.some((entry) => entry.label === "HELPER TOK"), false);
  assert.equal(without.some((entry) => entry.label === "HELPER COST"), false);

  const withRollup = sidePanelEntries({
    ...base,
    helpers: { total: 2, running: 0, tokens: 1_500, cost: 0.345 },
  });
  const tokRow = withRollup.find((entry) => entry.label === "HELPER TOK");
  assert.equal(tokRow?.value, "1.5k tok");
  assert.equal(tokRow?.tone, "muted");
  const costRow = withRollup.find((entry) => entry.label === "HELPER COST");
  assert.equal(costRow?.value, "$0.3450");
  const helpersIndex = withRollup.findIndex((entry) => entry.label === "HELPERS");
  assert.equal(withRollup.findIndex((entry) => entry.label === "HELPER TOK"), helpersIndex + 1);
  assert.equal(withRollup.findIndex((entry) => entry.label === "HELPER COST"), helpersIndex + 2);
  // The brothers' rows are untouched; the roll-up never merges into them.
  const brothers = (entries: ReturnType<typeof sidePanelEntries>) =>
    entries.filter((entry) => ["CONTEXT", "TOKENS", "COST"].includes(entry.label));
  assert.deepEqual(brothers(withRollup), brothers(sidePanelEntries(base)));

  // An unknown helper cost is the honest `cost unknown`, never $0 or a
  // partial sum; a missing token total renders no HELPER COST row at all.
  const unknown = sidePanelEntries({
    ...base,
    helpers: { total: 1, running: 0, tokens: 1_500, cost: null },
  });
  const unknownRow = unknown.find((entry) => entry.label === "HELPER COST");
  assert.equal(unknownRow?.value, "cost unknown");
  assert.equal(unknownRow?.tone, "warning");
  const noTokens = sidePanelEntries({ ...base, helpers: { total: 1, running: 0 } });
  assert.equal(noTokens.some((entry) => entry.label === "HELPER COST"), false);
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

// --------------------------------------------------------------------------- //
// O2 operator controls: interrupt, follow-up draft, refusal copy, pending badge
// --------------------------------------------------------------------------- //

test("O2: interrupt toast copy names the request, never an outcome", () => {
  assert.equal(
    helperInterruptToastText(true),
    "interrupting — the helper's terminal event is the truth",
  );
  assert.equal(helperInterruptToastText(false), "helper already finished");
});

test("O2: follow-up toast copy is the honest bounded-queue answer", () => {
  assert.equal(helperFollowUpToastText({ ok: true, pending: 1 }), "queued · 1 pending");
  assert.equal(helperFollowUpToastText({ ok: true, pending: 3 }), "queued · 3 pending");
  assert.equal(
    helperFollowUpToastText({ ok: false, reason: "not_running" }),
    "helper already finished",
  );
  assert.equal(
    helperFollowUpToastText({ ok: false, reason: "queue_full" }),
    "queue is full (8 pending)",
  );
  assert.equal(
    helperFollowUpToastText({ ok: false, reason: "context_full", chars: 80_123 }),
    "context is full (80123 chars)",
  );
});

test("O2: i/m resolve only in the detail; the list ignores them", () => {
  const rows = helperRowsFromSummaries([summary({ id: "sub-aaaaaaaaaaaaaaaa" })]);
  const detail = detailWith([{ type: "message", role: "user", text: "Task.", at: 1 }]);
  const inDetail: HelperOverlayState = {
    selectedId: "sub-aaaaaaaaaaaaaaaa",
    detail,
    scroll: 0,
    draft: null,
    notice: null,
  };
  const interrupt = helperOverlayKey(TUI_COMMANDS, rows, inDetail, { name: "i", raw: "i" });
  assert.equal(interrupt.action, "interrupt");
  assert.equal(interrupt.state, inDetail, "interrupt never mutates overlay state");
  const followUp = helperOverlayKey(TUI_COMMANDS, rows, inDetail, { name: "m", raw: "m" });
  assert.equal(followUp.action, "followup");
  assert.notEqual(followUp.state.draft, null, "m opens the one-line draft");
  // List mode: the overlay-scope commands exist but act on the open child, so
  // the list leaves them untouched (and they can never reach the composer).
  const inList = createHelperOverlayState("sub-aaaaaaaaaaaaaaaa");
  assert.equal(helperOverlayKey(TUI_COMMANDS, rows, inList, { name: "i", raw: "i" }).action, "none");
  assert.equal(helperOverlayKey(TUI_COMMANDS, rows, inList, { name: "m", raw: "m" }).action, "none");
});

test("O2: the follow-up draft edits printable keys and caps at 4000 chars", () => {
  const rows: HelperRow[] = [];
  const detail = detailWith([]);
  let state: HelperOverlayState = { selectedId: detail.id, detail, scroll: 0, draft: null, notice: null };
  state = helperOverlayKey(TUI_COMMANDS, rows, state, { name: "m", raw: "m" }).state;
  for (const ch of "also check the config") {
    state = helperOverlayKey(TUI_COMMANDS, rows, state, { name: ch, raw: ch }).state;
  }
  assert.equal(state.draft?.text, "also check the config");
  // Cursor movement and deletion reuse the editor primitives unchanged.
  state = helperOverlayKey(TUI_COMMANDS, rows, state, { name: "backspace", raw: "\u007f" }).state;
  assert.equal(state.draft?.text, "also check the confi");
  // The cap is the backend's SUBAGENT_FOLLOWUP_TEXT_MAX_CHARS (4000).
  let capped: HelperOverlayState = { selectedId: detail.id, detail, scroll: 0, draft: null, notice: null };
  capped = helperOverlayKey(TUI_COMMANDS, rows, capped, { name: "m", raw: "m" }).state;
  for (let index = 0; index < 4_100; index += 1) {
    capped = helperOverlayKey(TUI_COMMANDS, rows, capped, { name: "x", raw: "x" }).state;
  }
  assert.equal(capped.draft?.text.length, 4_000, "the draft is capped at 4000 chars");
  // A newline can never enter the one-line draft.
  capped = helperOverlayKey(TUI_COMMANDS, rows, capped, { name: "j", ctrl: true, raw: "\u000a" }).state;
  assert.equal(capped.draft?.text.includes("\n"), false);
});

test("O2: Enter asks to submit the draft; Esc cancels only the draft, never the overlay", () => {
  const detail = detailWith([{ type: "message", role: "user", text: "Task.", at: 1 }]);
  const rows = helperRowsFromSummaries([summary({ id: detail.id })]);
  let state: HelperOverlayState = { selectedId: detail.id, detail, scroll: 0, draft: null, notice: null };
  state = helperOverlayKey(TUI_COMMANDS, rows, state, { name: "m", raw: "m" }).state;
  state = helperOverlayKey(TUI_COMMANDS, rows, state, { name: "p", raw: "p" }).state;
  const submitted = helperOverlayKey(TUI_COMMANDS, rows, state, { name: "return", raw: "\r" });
  assert.equal(submitted.action, "draft-submit");
  assert.equal(submitted.state.draft?.text, "p", "the submit carries the exact draft text");
  // Esc precedence: with the draft open it cancels the draft and keeps the
  // detail; the next Esc backs to the list; the next closes the overlay.
  let esc = helperOverlayKey(TUI_COMMANDS, rows, state, { name: "escape", raw: "\u001b" });
  assert.equal(esc.action, "draft-cancel");
  assert.notEqual(esc.state.detail, null, "the detail stays open after the draft is cancelled");
  esc = helperOverlayKey(TUI_COMMANDS, rows, esc.state, { name: "escape", raw: "\u001b" });
  assert.equal(esc.action, "back");
  esc = helperOverlayKey(TUI_COMMANDS, rows, esc.state, { name: "escape", raw: "\u001b" });
  assert.equal(esc.action, "close");
});

test("O2: drafting and submitting never append a transcript row", () => {
  const detail = detailWith([{ type: "message", role: "user", text: "Task.", at: 1 }]);
  const rowsBefore = helperDetailRows(detail).length;
  let state: HelperOverlayState = { selectedId: detail.id, detail, scroll: 0, draft: null, notice: null };
  state = helperOverlayKey(TUI_COMMANDS, [], state, { name: "m", raw: "m" }).state;
  for (const ch of "queued words") {
    state = helperOverlayKey(TUI_COMMANDS, [], state, { name: ch, raw: ch }).state;
  }
  const submitted = helperOverlayKey(TUI_COMMANDS, [], state, { name: "return", raw: "\r" });
  assert.equal(submitted.action, "draft-submit");
  assert.equal(
    helperDetailRows(submitted.state.detail ?? detail).length,
    rowsBefore,
    "no local row appears before the backend delivers the follow-up",
  );
  // The draft line renders in the frame; the transcript rows are untouched.
  const view = helperDetailView(detail, state, { width: 60, height: 14, now: 10_000 });
  assert.ok(view.lines.some((line) => line.includes("message: queued words")));
  assert.equal(view.rows.length, rowsBefore);
});

test("O2: the detail header carries the live pending badge from pendingFollowUps()", () => {
  const detail = detailWith([], { status: "running", ended_at: undefined });
  assert.deepEqual(helperDetailHeader(detail, { now: 5_000, pending: 0 })[2], "running · 0:04");
  assert.equal(
    helperDetailHeader(detail, { now: 5_000, pending: 2 })[2],
    "running · 0:04 · 2 pending",
  );
  const view = helperDetailView(detail, createHelperOverlayState(detail.id), {
    width: 60,
    height: 14,
    now: 5_000,
    pending: 1,
  });
  assert.ok(view.lines.some((line) => line.includes("running · 0:04 · 1 pending")));
});

test("O2: with the draft open the footer derives Enter send · Esc cancel", () => {
  const detail = detailWith([]);
  const state: HelperOverlayState = {
    selectedId: detail.id,
    detail,
    scroll: 0,
    draft: createHelperFollowUpDraft(),
    notice: null,
  };
  const view = helperDetailView(detail, state, { width: 60, height: 12, now: 10_000 });
  assert.ok(view.lines.some((line) => line.includes("Enter send · Esc cancel")));
  // Without a draft the O2 controls join the O1 footer.
  const plain = helperDetailView(detail, createHelperOverlayState(detail.id), {
    width: 60,
    height: 12,
    now: 10_000,
  });
  assert.ok(plain.lines.some((line) => /i stop · m message/.test(line)));
});

test("O2: the overlay-scope i/m chords collide with nothing and reach no other handler", () => {
  const seen = new Map<string, string>();
  for (const command of TUI_COMMANDS) {
    if (command.when !== "overlay") continue;
    for (const chord of command.keys ?? []) {
      const label = chord.name
        + (chord.ctrl === true ? "+ctrl" : "")
        + (chord.shift === true ? "+shift" : "")
        + (chord.alt === true ? "+alt" : "");
      assert.equal(seen.has(label), false, `overlay chord ${label} is bound twice`);
      seen.set(label, command.id);
    }
  }
  assert.equal(seen.get("i"), "helper-interrupt");
  assert.equal(seen.get("m"), "helper-followup");
  // Overlay keys are resolved in overlay scope only: app scope must not see
  // them (no key stealing from the composer while no overlay is up).
  assert.equal(resolveKey(TUI_COMMANDS, { name: "i", raw: "i" }, "app"), null);
  assert.equal(resolveKey(TUI_COMMANDS, { name: "m", raw: "m" }, "app"), null);
  assert.equal(
    resolveKey(TUI_COMMANDS, { name: "i", raw: "i" }, "overlay")?.command.id,
    "helper-interrupt",
  );
});

// --------------------------------------------------------------------------- //
// helper-overlay correctness: one-line frames (D1/D4), physical tail windowing
// (D2), one-line capped paste into the draft (D5)
// --------------------------------------------------------------------------- //

test("D1: multiline helper activity collapses to one line and every list frame stays exact-height", () => {
  const rows = helperRowsFromSummaries([
    summary({
      label: "line one\nline two",
      last_activity: { kind: "message", text: "first line\nsecond line\nthird line", at: 1 },
    }),
  ]);
  assert.equal(helperActivityLabel(rows[0]!), "first line second line third line");
  for (const width of [40, 80, 120]) {
    for (let height = 10; height <= 22; height += 1) {
      const view = helpersListView(rows, createHelperOverlayState(rows[0]!.id), {
        width,
        height,
        now: 10_000,
      });
      assert.equal(view.lines.length, height, `height ${height}`);
      for (const line of view.lines) {
        assert.ok(!line.includes("\n"), "no frame line carries a raw newline");
        assert.equal(displayWidth(line), width, `width ${width} @ ${height}`);
      }
    }
  }
  // A live started event with a multiline label is normalized at the fold.
  const folded = foldHelperEvent([], startedEvent({ label: "a\nb" }));
  assert.equal(folded[0]?.label, "a b");
});

test("D4: the detail header normalizes a multiline label to one exact-height frame", () => {
  const detail = detailWith([], { label: "task one\ntask two" });
  assert.equal(helperDetailHeader(detail)[0], "task one task two");
  for (const height of [10, 14, 22]) {
    const view = helperDetailView(detail, createHelperOverlayState(detail.id), {
      width: 60,
      height,
      now: 10_000,
    });
    assert.equal(view.lines.length, height);
    for (const line of view.lines) assert.ok(!line.includes("\n"));
  }
});

test("D2: a long wrapped detail shows the newest physical tail; the O2 notice and draft are never sliced away", () => {
  const longText =
    "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima ".repeat(4).trim();
  const detail = detailWith(
    [
      { type: "message", role: "user", text: "row zero", at: 1 },
      { type: "message", role: "assistant", text: longText, at: 2 },
    ],
    { result: null },
  );
  const state: HelperOverlayState = {
    ...createHelperOverlayState(detail.id),
    notice: { text: "queued · 1 pending", level: "success" },
    draft: createHelperFollowUpDraft(),
  };
  const width = 40;
  const height = 14;
  const capacity = height - 8 - 2; // notice and draft reserve one row each
  const wrapped = wrapDisplay(`Helper · ${longText}`, width - 2);
  assert.ok(wrapped.length > capacity * 2, "the last row really wraps across many lines");

  const view = helperDetailView(detail, state, { width, height, now: 10_000 });
  assert.equal(view.lines.length, height);
  for (const line of view.lines) {
    assert.equal(displayWidth(line), width);
    assert.ok(!line.includes("\n"));
  }
  const text = view.lines.join("\n");
  // scroll = 0 shows the NEWEST PHYSICAL lines: the last wrapped segments are
  // in the frame and the oldest wrapped segment of the long row is not.
  for (const segment of wrapped.slice(-capacity)) {
    assert.ok(text.includes(segment.trim()), `tail segment visible: ${segment.trim()}`);
  }
  assert.ok(
    !text.includes(wrapped[0]!.slice(0, 20)),
    "the oldest physical line of the wrapped row never crowds the tail",
  );
  // The O2 answer and the open draft survive the wrapping.
  assert.ok(text.includes("queued · 1 pending"), "the notice row is reserved, not sliced");
  assert.ok(text.includes("message:"), "the draft row is reserved, not sliced");
  assert.equal(view.visible.at(-1)?.text, longText, "the newest logical row stays visible");

  // Scrolling by one logical row steps over the whole wrapped row: the window
  // then ends at the short row above it.
  const scrolled = helperDetailView(
    detail,
    { ...state, scroll: 1 },
    { width, height, now: 10_000 },
  );
  const scrolledText = scrolled.lines.join("\n");
  assert.ok(scrolledText.includes("Task · row zero"), "the previous row is now the tail");
  assert.ok(!scrolledText.includes(wrapped.at(-1)!.trim()), "the wrapped row stepped over");
});

test("D5: a paste into the open draft becomes one sanitized line capped at 4000 chars", () => {
  const detail = detailWith([]);
  let state: HelperOverlayState = {
    selectedId: detail.id,
    detail,
    scroll: 0,
    draft: null,
    notice: null,
  };
  state = helperOverlayKey(TUI_COMMANDS, [], state, { name: "m", raw: "m" }).state;
  const pasted = helperOverlayKey(TUI_COMMANDS, [], state, {
    name: "paste",
    raw: "line one\nline two\r\nline three",
  });
  assert.equal(pasted.action, "draft-edit");
  assert.equal(pasted.state.draft?.text, "line one line two line three");
  assert.ok(!pasted.state.draft?.text.includes("\n"), "the paste can never add a newline");
  // The rendered draft row is a single frame line.
  const frame = helperDetailView(detail, pasted.state, { width: 60, height: 12, now: 10_000 });
  const draftRow = frame.lines.find((line) => line.includes("message:"));
  assert.ok(draftRow !== undefined);
  assert.ok(!draftRow.includes("\n"));

  // The 4000-char cap holds across a paste (newline becomes one space first).
  let capped: HelperOverlayState = {
    selectedId: detail.id,
    detail,
    scroll: 0,
    draft: null,
    notice: null,
  };
  capped = helperOverlayKey(TUI_COMMANDS, [], capped, { name: "m", raw: "m" }).state;
  capped = helperOverlayKey(TUI_COMMANDS, [], capped, {
    name: "paste",
    raw: `${"x".repeat(3_900)}\n${"y".repeat(3_900)}`,
  }).state;
  assert.equal(capped.draft?.text.length, 4_000, "the paste is capped at 4000 chars");
  assert.ok(!capped.draft?.text.includes("\n"));

  // With no draft open a paste is a no-op (the app only routes it to the draft).
  const closed = helperOverlayKey(
    TUI_COMMANDS,
    [],
    { ...state, draft: null },
    { name: "paste", raw: "nope\nnope" },
  );
  assert.equal(closed.action, "none");
  assert.equal(closed.state.draft, null);
});
