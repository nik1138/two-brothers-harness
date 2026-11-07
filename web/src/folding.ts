/**
 * Step folding (pure): collapse the tool/activity rows a finished run left in
 * the transcript into one muted disclosure row.
 *
 * The transcript always keeps conversation content (operator/senior/junior
 * message groups, revision dividers, system activities) and the rows of the run
 * this app currently follows. Only rows that are attributable to a run id fold:
 * `tool` and `prompt_audit` runtime entries carry one, while message groups and
 * system activities do not — so chat content can never disappear into a fold.
 *
 * Fold rules:
 * - a fold group is a maximal run of foldable entries between rendered
 *   non-foldable rows (message groups, system notes, history approvals…);
 * - entries hidden by a preference or by the approval dock are not rendered and
 *   do not break a group (the tool rows around a hidden audit stay together);
 * - a group folds only when it has at least {@link FOLD_MIN_ROWS} *rendered*
 *   rows — a single tool row stays visible;
 * - collapsed groups render one summary row; expanded groups render the summary
 *   button followed by their rows in the original order, so expansion restores
 *   the transcript in place;
 * - the summary counts only what expansion will actually show (tool calls,
 *   visible prompt audits, distinct runs) — it never invents activity.
 *
 * Find/copy: a collapsed group's rows are absent from the render rows, which is
 * exactly what "removed from the DOM" means for the view: find-in-transcript
 * (which searches the rendered conversation only) cannot reach them until the
 * group is expanded, and the summary row itself is chrome, not conversation.
 * The view must invalidate its cached find blocks when the fold state changes.
 *
 * Provenance: the collapsed summary shape ("… N tool calls in M runs") follows
 * kimi-code's MIT step-summary idea (research/vendor/kimi-code); the grouping,
 * expand/collapse and find/copy behavior here is original to Two Brothers.
 *
 * No DOM or Vue dependency: the projection is unit-tested directly.
 */

import type { RuntimeItem, TimelineEntry } from './runtime'

type Entry = TimelineEntry['entry']

/** Smallest group size worth folding; a single row keeps its full card. */
export const FOLD_MIN_ROWS = 2

export interface FoldOptions {
  /**
   * Run the app currently follows. Its tool/audit rows stay open; every other
   * known run is finished (or historical) and folds.
   */
  liveRunId?: string | null
  /** Prompt-audit annotations render only when the developer preference is on. */
  showPromptAudits?: boolean
  /** Pending approval docked above the composer is not rendered in the stream. */
  dockedApprovalId?: string | null
  /** Fold-group keys the operator expanded (per session). */
  expanded?: ReadonlySet<string>
  /** Minimum rendered rows in a group before it folds (default 2). */
  minRows?: number
}

/** One folded group's truthful counts and its visible summary label. */
export interface FoldSummary {
  /** Rendered rows the group holds (what expanding would show). */
  rowCount: number
  toolCount: number
  auditCount: number
  /** Distinct run ids among the rendered rows. */
  runCount: number
  /** Visible summary text, e.g. "3 tool calls in 2 runs". */
  label: string
}

/** One render row: a normal transcript entry, or a fold disclosure row. */
export type FoldRenderRow =
  | { type: 'entry'; key: string; entry: Entry; index: number }
  | { type: 'fold'; key: string; expanded: boolean; summary: FoldSummary }

function isRuntimeEntry(entry: Entry): entry is RuntimeItem {
  return (
    entry.type === 'tool' ||
    entry.type === 'approval' ||
    entry.type === 'prompt_audit'
  )
}

/** Stable id for a transcript entry (the fold-state and v-for identity). */
export function foldEntryId(entry: Entry): string {
  if (entry.type === 'group') return entry.group.messages[0]?.id ?? 'group'
  if (entry.type === 'divider') return `divider-${entry.seq}`
  if (entry.type === 'system') return entry.activity.id
  if (entry.type === 'tool' || entry.type === 'prompt_audit') return entry.id
  return `approval-${entry.approvalId}`
}

/** The run a runtime entry belongs to, or null when it carries none. */
function runIdOf(entry: Entry): string | null {
  if (!isRuntimeEntry(entry)) return null
  return entry.runId || null
}

/** True when the entry renders nothing in the current transcript state. */
function isRendered(
  entry: Entry,
  showPromptAudits: boolean,
  dockedApprovalId: string | null,
): boolean {
  if (entry.type === 'prompt_audit') return showPromptAudits
  if (entry.type === 'approval') {
    return !(entry.decision === undefined && entry.approvalId === dockedApprovalId)
  }
  return true
}

/**
 * True when `entry` is a row this module may fold: a tool call or a prompt-audit
 * annotation attributable to a run that is not the followed one.
 */
export function isFoldableEntry(
  entry: Entry,
  liveRunId: string | null = null,
): boolean {
  if (entry.type !== 'tool' && entry.type !== 'prompt_audit') return false
  const runId = runIdOf(entry)
  return runId !== null && runId !== liveRunId
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`
}

/** Summary of the rows an expanded group would show. */
export function summarizeFold(entries: readonly Entry[]): FoldSummary {
  let toolCount = 0
  let auditCount = 0
  const runs = new Set<string>()
  for (const entry of entries) {
    if (entry.type === 'tool') toolCount += 1
    else if (entry.type === 'prompt_audit') auditCount += 1
    else continue
    const runId = runIdOf(entry)
    if (runId !== null) runs.add(runId)
  }
  const parts: string[] = []
  if (toolCount > 0) parts.push(plural(toolCount, 'tool call', 'tool calls'))
  if (auditCount > 0) parts.push(plural(auditCount, 'prompt audit', 'prompt audits'))
  let label = parts.join(' and ')
  if (runs.size > 1) label += ` in ${runs.size} runs`
  return {
    rowCount: toolCount + auditCount,
    toolCount,
    auditCount,
    runCount: runs.size,
    label: label || 'older activity',
  }
}

interface PendingGroup {
  /** Every foldable member, including entries hidden by a preference. */
  members: Entry[]
  /** Members that render (and that expansion would show). */
  rendered: Entry[]
  /** Absolute timeline index of the first member (stable per-row keying). */
  start: number
  /** Stable key derived from the first member. */
  key: string
}

function freshGroup(first: Entry, start: number): PendingGroup {
  return { members: [first], rendered: [], start, key: `fold:${foldEntryId(first)}` }
}

function entryKey(entry: Entry, index: number): string {
  return `${foldEntryId(entry)}#${index}`
}

function pushEntries(
  rows: FoldRenderRow[],
  entries: readonly Entry[],
  start: number,
): void {
  entries.forEach((entry, i) => {
    const index = start + i
    rows.push({ type: 'entry', key: entryKey(entry, index), entry, index })
  })
}

function flushGroup(
  group: PendingGroup,
  rows: FoldRenderRow[],
  expanded: ReadonlySet<string>,
  minRows: number,
): void {
  if (group.rendered.length === 0) return
  if (group.rendered.length < minRows) {
    pushEntries(rows, group.rendered, group.start)
    return
  }
  const isExpanded = expanded.has(group.key)
  rows.push({
    type: 'fold',
    key: group.key,
    expanded: isExpanded,
    summary: summarizeFold(group.rendered),
  })
  if (isExpanded) pushEntries(rows, group.rendered, group.start)
}

/**
 * Project one visible timeline slice into render rows.
 *
 * `offset` is the slice's index in the full timeline; it only feeds the stable
 * per-row `key` (so a windowed render keeps the same identity the unwindowed
 * one would produce).
 */
export function buildFoldRows(
  timeline: readonly TimelineEntry[],
  options: FoldOptions = {},
  offset = 0,
): FoldRenderRow[] {
  const liveRunId = typeof options.liveRunId === 'string' ? options.liveRunId : null
  const showPromptAudits = options.showPromptAudits === true
  const dockedApprovalId =
    typeof options.dockedApprovalId === 'string' ? options.dockedApprovalId : null
  const expanded = options.expanded ?? new Set<string>()
  const rawMin = options.minRows
  const minRows =
    typeof rawMin === 'number' && Number.isFinite(rawMin) && rawMin >= 1
      ? Math.floor(rawMin)
      : FOLD_MIN_ROWS

  const rows: FoldRenderRow[] = []
  let group: PendingGroup | null = null
  let index = offset

  for (const row of timeline) {
    const entry = row.entry
    const foldable = isFoldableEntry(entry, liveRunId)
    const rendered = isRendered(entry, showPromptAudits, dockedApprovalId)

    if (foldable) {
      let current: PendingGroup | null = group
      if (current === null) {
        current = freshGroup(entry, index)
        group = current
      } else {
        current.members.push(entry)
      }
      if (rendered) current.rendered.push(entry)
      index += 1
      continue
    }

    if (!rendered) {
      // hidden rows (docked approval) neither break a group nor render
      index += 1
      continue
    }

    if (group !== null) {
      flushGroup(group, rows, expanded, minRows)
      group = null
    }
    rows.push({ type: 'entry', key: entryKey(entry, index), entry, index })
    index += 1
  }

  if (group !== null) flushGroup(group, rows, expanded, minRows)
  return rows
}
