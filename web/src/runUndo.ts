/**
 * Run-scoped workspace undo (wave 23): the pure client model for a preview /
 * apply panel over a run's recorded file mutations.
 *
 * A run that used the workspace tools leaves a local undo record (metadata +
 * content-addressed pre-images). The server classifies every recorded file
 * against the live workspace before touching anything; the operator sees
 * per-file statuses and an honest summary, and a refused file is never
 * reported as undone. This module mirrors the backend vocabulary
 * (`packages/harness/src/workspacehistory.ts`) and owns every operator-facing
 * string, so the panel has no presentation logic of its own.
 *
 * The HTTP surface is session-scoped (approved wave-23 contract):
 * `GET /api/sessions/{name}/undo/{run_id}` preview,
 * `POST /api/sessions/{name}/undo/{run_id}` apply,
 * `DELETE /api/sessions/{name}/undo/{run_id}` discard. When the GET route is
 * absent (an older backend answers 404 for every run) the app hides the action
 * with an honest reason rather than showing a disabled control that implies
 * support.
 *
 * No DOM and no backend import; unit tests pin the vocabulary and the response
 * mapping.
 */

/** How one file would fare if the run were undone now. */
export type UndoPreviewStatus =
  | 'applicable'
  | 'created'
  | 'deleted'
  | 'changed-since'
  | 'skipped'
  | 'missing'

/** Every preview status, in display order (reversible first). */
export const UNDO_PREVIEW_STATUSES: readonly UndoPreviewStatus[] = [
  'applicable',
  'created',
  'deleted',
  'changed-since',
  'skipped',
  'missing',
]

/** The action a run took on one file (backend record vocabulary). */
export type UndoAction = 'write' | 'edit' | 'delete'

/** True for the three statuses applyUndo can actually act on. */
export function isReversibleStatus(status: string | null | undefined): boolean {
  return status === 'applicable' || status === 'created' || status === 'deleted'
}

/** Short human label for one preview status (never a raw backend token). */
export function undoStatusLabel(status: string | null | undefined): string {
  switch (status) {
    case 'applicable':
      return 'will be restored'
    case 'created':
      return 'will be deleted (created by the run)'
    case 'deleted':
      return 'will be restored (deleted by the run)'
    case 'changed-since':
      return 'refused — changed since the run'
    case 'skipped':
      return 'not captured'
    case 'missing':
      return 'refused — the saved copy is missing'
    default:
      return 'unknown state'
  }
}

/** One-line honest explanation per status (`reason` from the server wins). */
export function undoStatusReason(
  entry: { status?: string; reason?: string | null } | null | undefined,
): string {
  const serverReason = typeof entry?.reason === 'string' ? entry.reason.trim() : ''
  if (serverReason) return serverReason
  switch (entry?.status) {
    case 'changed-since':
      return 'The file no longer matches what the run left behind; it was not touched.'
    case 'skipped':
      return 'The change was not fully captured (size or count bound), so it cannot be undone.'
    case 'missing':
      return 'The saved pre-image is absent or corrupt; the file was not touched.'
    default:
      return ''
  }
}

/** The undo action that will be performed for one reversible file. */
export function undoEntryAction(status: string | null | undefined, action: string | null | undefined): string {
  if (status === 'created') return 'Delete the file the run created'
  if (status === 'deleted') return 'Restore the file the run deleted'
  if (status === 'applicable') return 'Restore the earlier file content'
  if (action === 'delete') return 'Restore the deleted file'
  return 'Restore the earlier file content'
}

/** One preview row as the API returns it (mirrors the backend shape). */
export interface RunUndoPreviewEntry {
  path: string
  action: UndoAction | string
  status: UndoPreviewStatus | string
  reason?: string
  reversible: boolean
}

/** Per-status counts returned with a preview or apply response. */
export interface RunUndoCounts {
  applicable?: number
  created?: number
  deleted?: number
  changed_since?: number
  skipped?: number
  missing?: number
  total?: number
}

/**
 * Preview document (`GET /api/sessions/{name}/undo/{run_id}`): `statuses` is
 * the approved field name; `entries` is accepted as a tolerant alias so a
 * slightly older shape still renders.
 */
export interface RunUndoPreview {
  session?: string
  run_id?: string
  workspace_root?: string
  created_at?: string
  statuses?: RunUndoPreviewEntry[]
  entries?: RunUndoPreviewEntry[]
  counts?: RunUndoCounts
  omitted?: { entries: number; reason: string }
}

/** Per-file apply outcome (mirrors the backend apply entry). */
export interface RunUndoApplyEntry {
  path: string
  action: UndoAction | string
  status: 'applied' | 'refused' | 'failed' | string
  preview_status: UndoPreviewStatus | string
  reason?: string
}

/** Apply summary (`POST /api/sessions/{name}/undo/{run_id}`). */
export interface RunUndoApplyResult {
  session?: string
  run_id?: string
  workspace_root?: string
  applied: number
  refused: number
  failed: number
  /** Approved field name for the per-file rows; `entries` is a tolerant alias. */
  files?: RunUndoApplyEntry[]
  entries?: RunUndoApplyEntry[]
  counts?: RunUndoCounts
  omitted?: { entries: number; reason: string }
}

/** Discard result (`DELETE /api/sessions/{name}/undo/{run_id}`). */
export interface RunUndoDiscardResult {
  discarded: boolean
  session?: string
  run_id?: string
}

/** The preview rows, accepting the approved `statuses` field or its alias. */
export function undoPreviewEntries(
  preview: Pick<RunUndoPreview, 'statuses' | 'entries'> | null | undefined,
): RunUndoPreviewEntry[] {
  const rows = preview?.statuses ?? preview?.entries
  if (!Array.isArray(rows)) return []
  return rows.filter((row): row is RunUndoPreviewEntry => row !== null && typeof row === 'object')
}

/** The apply rows, accepting the approved `files` field or its alias. */
export function undoApplyEntries(
  result: Pick<RunUndoApplyResult, 'files' | 'entries'> | null | undefined,
): RunUndoApplyEntry[] {
  const rows = result?.files ?? result?.entries
  if (!Array.isArray(rows)) return []
  return rows.filter((row): row is RunUndoApplyEntry => row !== null && typeof row === 'object')
}

function normalizePreviewEntry(raw: unknown): RunUndoPreviewEntry | null {
  if (raw === null || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  const path = typeof row.path === 'string' ? row.path : ''
  if (!path) return null
  const status = typeof row.status === 'string' ? row.status : 'unknown'
  return {
    path,
    action: typeof row.action === 'string' ? row.action : 'edit',
    status,
    ...(typeof row.reason === 'string' ? { reason: row.reason } : {}),
    reversible: row.reversible === true || isReversibleStatus(status),
  }
}

function normalizeApplyEntry(raw: unknown): RunUndoApplyEntry | null {
  if (raw === null || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  const path = typeof row.path === 'string' ? row.path : ''
  if (!path) return null
  return {
    path,
    action: typeof row.action === 'string' ? row.action : 'edit',
    status: typeof row.status === 'string' ? row.status : 'failed',
    preview_status: typeof row.preview_status === 'string' ? row.preview_status : 'unknown',
    ...(typeof row.reason === 'string' ? { reason: row.reason } : {}),
  }
}

function normalizeCounts(raw: unknown): RunUndoCounts | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const source = raw as Record<string, unknown>
  const counts: RunUndoCounts = {}
  for (const key of ['applicable', 'created', 'deleted', 'changed_since', 'skipped', 'missing', 'total'] as const) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value)) counts[key] = Math.max(0, Math.floor(value))
  }
  return counts
}

/**
 * Tolerantly normalize a preview response: unknown/missing fields are dropped
 * rather than crashing the dialog, the approved `statuses` array wins, and a
 * document without any recognized row is still a valid empty preview.
 */
export function normalizeUndoPreview(raw: unknown): RunUndoPreview | null {
  if (raw === null || typeof raw !== 'object') return null
  const source = raw as Record<string, unknown>
  const rowsRaw = Array.isArray(source.statuses)
    ? source.statuses
    : Array.isArray(source.entries)
      ? source.entries
      : []
  const statuses = rowsRaw
    .map(normalizePreviewEntry)
    .filter((row): row is RunUndoPreviewEntry => row !== null)
  const preview: RunUndoPreview = { statuses }
  if (typeof source.session === 'string') preview.session = source.session
  if (typeof source.run_id === 'string') preview.run_id = source.run_id
  if (typeof source.workspace_root === 'string') preview.workspace_root = source.workspace_root
  if (typeof source.created_at === 'string') preview.created_at = source.created_at
  const counts = normalizeCounts(source.counts)
  if (counts !== undefined) preview.counts = counts
  if (source.omitted !== null && typeof source.omitted === 'object') {
    const omitted = source.omitted as Record<string, unknown>
    const entries = typeof omitted.entries === 'number' ? Math.max(0, Math.floor(omitted.entries)) : 0
    if (entries > 0) {
      preview.omitted = {
        entries,
        reason: typeof omitted.reason === 'string' ? omitted.reason : 'capture bound',
      }
    }
  }
  return preview
}

/** Tolerantly normalize an apply response (missing counts read as zero). */
export function normalizeUndoApplyResult(raw: unknown): RunUndoApplyResult | null {
  if (raw === null || typeof raw !== 'object') return null
  const source = raw as Record<string, unknown>
  const rowsRaw = Array.isArray(source.files)
    ? source.files
    : Array.isArray(source.entries)
      ? source.entries
      : []
  const files = rowsRaw
    .map(normalizeApplyEntry)
    .filter((row): row is RunUndoApplyEntry => row !== null)
  const result: RunUndoApplyResult = {
    applied: boundedCount(source.applied),
    refused: boundedCount(source.refused),
    failed: boundedCount(source.failed),
    files,
  }
  if (typeof source.session === 'string') result.session = source.session
  if (typeof source.run_id === 'string') result.run_id = source.run_id
  if (typeof source.workspace_root === 'string') result.workspace_root = source.workspace_root
  const counts = normalizeCounts(source.counts)
  if (counts !== undefined) result.counts = counts
  return result
}

/** What a preview would do, counted honestly from its rows. */
export interface RunUndoPreviewSummary {
  /** Files applyUndo would act on. */
  reversible: number
  /** Files that will be refused (changed-since / skipped / missing). */
  refused: number
  total: number
  /** Coarse counts per display status. */
  byStatus: Record<UndoPreviewStatus, number>
}

/** Count a preview's rows by status (defensive against unknown statuses). */
export function summarizeUndoPreview(
  preview: RunUndoPreview | null | undefined,
): RunUndoPreviewSummary {
  const byStatus: Record<UndoPreviewStatus, number> = {
    applicable: 0,
    created: 0,
    deleted: 0,
    'changed-since': 0,
    skipped: 0,
    missing: 0,
  }
  const entries = undoPreviewEntries(preview)
  let reversible = 0
  for (const entry of entries) {
    const status = typeof entry.status === 'string' ? entry.status : ''
    if ((UNDO_PREVIEW_STATUSES as readonly string[]).includes(status)) {
      byStatus[status as UndoPreviewStatus] += 1
    }
    if (entry.reversible === true || isReversibleStatus(entry.status)) reversible += 1
  }
  const total = entries.length
  return { reversible, refused: Math.max(0, total - reversible), total, byStatus }
}

/** True when there is at least one file the run can honestly undo. */
export function canApplyUndo(preview: RunUndoPreview | null | undefined): boolean {
  return summarizeUndoPreview(preview).reversible > 0
}

/** Preview head-line: what the operator is about to review. */
export function undoPreviewNotice(preview: RunUndoPreview | null | undefined): string {
  const summary = summarizeUndoPreview(preview)
  if (summary.total === 0) return 'This run recorded no file changes to undo.'
  const omitted = omittedNote(preview?.omitted)
  return (
    `${summary.reversible} of ${summary.total} recorded file${summary.total === 1 ? '' : 's'} can be undone now` +
    `${summary.refused > 0 ? `; ${summary.refused} will be refused` : ''}.${omitted}`
  )
}

/** Preview confirmation body: names the consequences without overclaiming. */
export function undoConfirmation(preview: RunUndoPreview | null | undefined): string {
  const summary = summarizeUndoPreview(preview)
  if (summary.total === 0) return 'This run recorded no file changes, so there is nothing to undo.'
  const reversible = `${summary.reversible} file${summary.reversible === 1 ? '' : 's'} will be restored or deleted`
  const refused =
    summary.refused > 0
      ? ` ${summary.refused} will be left untouched (refused or not captured — each row says why).`
      : ''
  return `Undo the file changes this run made: ${reversible}.${refused} Nothing outside the run's recorded files is touched.`
}

/** Bounded non-negative display count from a backend number. */
function boundedCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/** Grammatically correct "N further change(s) ... not captured" note. */
function omittedNote(omitted: { entries?: unknown; reason?: unknown } | null | undefined): string {
  const entries = boundedCount(omitted?.entries)
  if (entries === 0) return ''
  const reason = typeof omitted?.reason === 'string' && omitted.reason.trim() ? omitted.reason.trim() : 'capture bound'
  return ` ${entries} further ${entries === 1 ? 'change' : 'changes'} ${entries === 1 ? 'was' : 'were'} not captured (${reason}).`
}

/**
 * Apply summary: every file is counted as applied / refused / failed — a
 * refused file is never folded into the success count. The `omitted` note is
 * repeated because those files were never candidates at all.
 */
export function undoApplyNotice(result: RunUndoApplyResult | null | undefined): string {
  if (!result) return 'Undo finished.'
  const applied = boundedCount(result.applied)
  const refused = boundedCount(result.refused)
  const failed = boundedCount(result.failed)
  const total = applied + refused + failed
  const omitted = omittedNote(result.omitted)
  if (total === 0) return `Undo finished; no files were changed.${omitted}`
  const parts = [`${applied} ${applied === 1 ? 'file' : 'files'} restored`]
  if (refused > 0) parts.push(`${refused} refused`)
  if (failed > 0) parts.push(`${failed} failed`)
  const lead = applied === 0 ? 'Undo finished without applying any file' : 'Undo applied'
  return `${lead}: ${parts.join(', ')}.${omitted}`
}

/** Per-file apply row label (the driving preview status is shown verbatim). */
export function undoAppliedLabel(entry: RunUndoApplyEntry | null | undefined): string {
  if (!entry) return 'unknown'
  if (entry.status === 'applied') {
    return entry.action === 'delete' || entry.preview_status === 'created'
      ? 'deleted'
      : 'restored'
  }
  if (entry.status === 'refused') return 'refused'
  if (entry.status === 'failed') return 'failed'
  return 'unknown'
}

/**
 * Honest failure copy for a preview/apply/discard request. 404 means no undo
 * record for that run (or the routes/feature are unsupported by this backend
 * — the caller hides the feature, it never fakes a disabled control); 409 is
 * a workspace-root mismatch or a corrupt record; the detail wins when present.
 */
export function undoFailureNotice(input: {
  status?: number
  detail?: string
} | null | undefined): string {
  const status = typeof input?.status === 'number' ? input.status : 0
  const detail = typeof input?.detail === 'string' ? input.detail.trim() : ''
  if (status === 0) return 'The backend is unreachable — nothing was changed.'
  if (status === 404) return detail || 'This run recorded no file changes to undo.'
  if (status === 409) {
    return detail || 'The saved undo record does not match this workspace; nothing was changed.'
  }
  if (status === 400) return detail || 'That undo request was rejected.'
  return detail || `Undo failed (HTTP ${status}).`
}

/** The undo action's menu/button label (stable copy for docs and tests). */
export const UNDO_ACTION_LABEL = 'Undo file changes…'

/**
 * The action's honest hint. A run whose workspace link is unknown (started
 * outside this browser tab / before a reload) still gets the action, but the
 * hint does not pretend to know it changed files — the preview reports that.
 */
export function undoActionHint(workspaceKnown: boolean): string {
  return workspaceKnown
    ? 'Restores the files this run changed; files changed since the run are refused.'
    : 'Preview the files this run changed (if any) and restore them; files changed since the run are refused.'
}

/**
 * Honest reason shown when the undo action is hidden because the backend
 * answered 404 for the preview (older backend without the route, or no undo
 * record for that run). Used once as a notice; the action then stays hidden
 * for that run — no fake success, no permanently dead control.
 */
export function undoUnavailableNotice(): string {
  return 'No file undo is available for this run — this backend has no undo record for it (or does not support file undo).'
}

/** Sort preview rows for display: actionable first, then by path. */
export function sortUndoEntries(
  entries: readonly RunUndoPreviewEntry[] | null | undefined,
): RunUndoPreviewEntry[] {
  const weight = (entry: RunUndoPreviewEntry): number => {
    const index = (UNDO_PREVIEW_STATUSES as readonly string[]).indexOf(String(entry.status))
    return index === -1 ? UNDO_PREVIEW_STATUSES.length : index
  }
  return [...(entries ?? [])]
    .filter((entry): entry is RunUndoPreviewEntry => entry !== null && typeof entry === 'object')
    .sort((a, b) => {
      const delta = weight(a) - weight(b)
      if (delta !== 0) return delta
      return String(a.path).localeCompare(String(b.path))
    })
}
