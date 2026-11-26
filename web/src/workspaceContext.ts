/**
 * Workspace context for a web session/run.
 *
 * A session created under a workspace keeps that link (the `*.meta.json`
 * sidecar). It is the workspace the composer's `@` file picker searches, the
 * status seats describe and the run itself must carry — otherwise the model is
 * offered no workspace tools while the UI claims a linked folder.
 *
 * The run rule is "select a workspace to start": a run never starts with no
 * workspace. The sidebar filter is a *view* filter, so it is only a display and
 * `@`-picker fallback for an unlinked session — never a run choice. An existing
 * session with no link must have one bound explicitly before a run can start.
 *
 * Pure and defensive: unexpected values read as "not set", and `'all'` is the
 * sidebar's no-filter sentinel, never a workspace id.
 */

/**
 * The documented refusal for a run that resolves no workspace
 * (POST /api/runs). Forward-compatible: the client gate is authoritative
 * today, and once an enforcing backend lands it answers this message while
 * the picker and its error handling already recognize it.
 */
export const SELECT_WORKSPACE_MESSAGE = 'select a workspace to start'

/** UI copy naming that same rule (the in-place prompt and the disabled submit note). */
export const SELECT_WORKSPACE_NOTE = 'Select a workspace to start'

/** Normalize a workspace id: trimmed, non-empty, never the `all` sentinel. */
export function normalizeWorkspaceId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const id = value.trim()
  return id && id !== 'all' ? id : null
}

/** True when `workspaceId` names a real workspace a run can carry. */
export function canStartRun(workspaceId: unknown): boolean {
  return normalizeWorkspaceId(workspaceId) !== null
}

/**
 * The workspace a run must carry.
 *
 * An existing session runs only with its own link: a pending pick has to be
 * bound first, so this deliberately ignores it (no silent binding). A
 * not-yet-created session uses the operator's explicit pick. There is no
 * filter parameter: the sidebar filter is a view filter, not a run choice.
 */
export function runWorkspaceForSession(
  hasSession: boolean,
  sessionWorkspaceId: string | null | undefined,
  pickedWorkspaceId: string | null | undefined,
): string | null {
  return hasSession
    ? normalizeWorkspaceId(sessionWorkspaceId)
    : normalizeWorkspaceId(pickedWorkspaceId)
}

/**
 * Workspace whose files the composer's `@` picker searches and whose context
 * the composer displays: the selected session's link, else the operator's
 * explicit pick, else the sidebar filter (the legacy unlinked-session fallback).
 */
export function contextWorkspaceId(
  sessionWorkspaceId: string | null | undefined,
  pickedWorkspaceId: string | null | undefined,
  filterWorkspaceId: string | null | undefined,
): string | null {
  return (
    normalizeWorkspaceId(sessionWorkspaceId) ??
    normalizeWorkspaceId(pickedWorkspaceId) ??
    normalizeWorkspaceId(filterWorkspaceId)
  )
}

/**
 * Initial pick for the New session dialog: an explicit sidebar-filter
 * workspace when it still exists, else the newest recent one that does.
 * Returns `''` when neither exists — never a null/"No workspace" sentinel, so
 * Create stays disabled until the operator picks a real folder.
 */
export function initialSessionWorkspaceId(
  existingIds: readonly unknown[],
  defaultWorkspaceId?: unknown,
  recentWorkspaceIds: readonly unknown[] = [],
): string {
  const existing = new Set<string>()
  for (const candidate of existingIds) {
    const id = normalizeWorkspaceId(candidate)
    if (id !== null) existing.add(id)
  }
  const preferred = normalizeWorkspaceId(defaultWorkspaceId)
  if (preferred !== null && existing.has(preferred)) return preferred
  for (const candidate of recentWorkspaceIds) {
    const id = normalizeWorkspaceId(candidate)
    if (id !== null && existing.has(id)) return id
  }
  return ''
}

/**
 * True when a backend/API message is the documented no-workspace refusal.
 * Matched exactly (case-insensitive, trimmed): any other 400 keeps its own
 * error surface instead of being reported as the workspace prompt.
 */
export function isSelectWorkspaceMessage(message: unknown): boolean {
  return (
    typeof message === 'string' &&
    message.trim().toLowerCase() === SELECT_WORKSPACE_MESSAGE
  )
}
