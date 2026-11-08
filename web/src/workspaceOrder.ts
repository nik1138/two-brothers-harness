/**
 * Workspace list helpers (pure, DOM-free): ordering, safe moves, name bounds.
 *
 * `Sidebar.vue` renders group headers in the workspace list order and offers
 * Move up/down per registered workspace; `App.vue` applies the optimistic move
 * and sends the id permutation to `PUT /api/workspaces/order`. `WorkspaceRenameDialog.vue`
 * shares the name normalization/bounds. Everything here is deterministic and
 * never mutates its inputs, so the shell logic is unit-testable in isolation.
 */

/** Maximum workspace display name length (the rename input's `maxlength`). */
export const WORKSPACE_NAME_MAX = 120

/** Minimal workspace shape the ordering helpers need. */
export interface WorkspaceLike {
  id: string
}

/**
 * Collapse whitespace and trim a workspace name. Returns '' for non-strings
 * (callers validate first with `workspaceNameProblem` and never send '').
 */
export function normalizeWorkspaceName(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim()
}

/** Validation problem for a proposed workspace name, or null when acceptable. */
export function workspaceNameProblem(value: unknown): string | null {
  if (typeof value !== 'string') return 'Enter a workspace name.'
  const name = normalizeWorkspaceName(value)
  if (!name) return 'Enter a workspace name.'
  if (name.length > WORKSPACE_NAME_MAX) {
    return `Keep the name under ${WORKSPACE_NAME_MAX} characters.`
  }
  return null
}

/** Copy of an id list; non-arrays are treated as empty, never thrown. */
function copyIds(ids: readonly string[] | null | undefined): string[] {
  return Array.isArray(ids) ? ids.slice() : []
}

/**
 * Move `id` by `delta` positions (negative = up): the result is a new array,
 * unknown ids and zero/non-finite deltas are a no-op, and the target index is
 * clamped into the list (so a large delta stops at the first/last slot).
 */
export function moveWorkspaceId(
  ids: readonly string[] | null | undefined,
  id: string,
  delta: number,
): string[] {
  const current = copyIds(ids)
  const index = typeof id === 'string' ? current.indexOf(id) : -1
  if (index < 0) return current
  const step = typeof delta === 'number' && Number.isFinite(delta) ? Math.trunc(delta) : 0
  if (!step) return current
  const target = Math.min(current.length - 1, Math.max(0, index + step))
  if (target === index) return current
  current.splice(index, 1)
  current.splice(target, 0, id)
  return current
}

/**
 * Move `id` to `index` (clamped into the list). Unknown ids and non-finite
 * targets are a no-op; the input array is never mutated.
 */
export function moveWorkspaceTo(
  ids: readonly string[] | null | undefined,
  id: string,
  index: number,
): string[] {
  const current = copyIds(ids)
  const from = typeof id === 'string' ? current.indexOf(id) : -1
  if (from < 0) return current
  if (typeof index !== 'number' || !Number.isFinite(index)) return current
  const target = Math.min(current.length - 1, Math.max(0, Math.trunc(index)))
  if (target === from) return current
  current.splice(from, 1)
  current.splice(target, 0, id)
  return current
}

/** True when both lists hold the same ids in the same order. */
export function isSameOrder(
  a: readonly string[] | null | undefined,
  b: readonly string[] | null | undefined,
): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

// -- drag-and-drop reordering --------------------------------------------------
// The sidebar's drag handle (an HTML5 drag source) drops a workspace group
// before or after another group header. Both helpers are pure and share the
// same boundary rules as the menu moves: identity drops and unknown ids are a
// no-op, and a drop on the other side of an adjacent neighbour is already the
// requested order. `App.vue` still owns the optimistic update + API call: the
// sidebar only translates a drop into the delta its existing `moveWorkspace`
// event carries.

/** Where a dragged workspace group is dropped relative to another group. */
export type WorkspaceDropPosition = 'before' | 'after'

/**
 * The `delta` a drop represents for {@link moveWorkspaceId}: drop `fromId`
 * before/after `toId` and the target index (after removing the dragged id)
 * minus its current index is exactly the menu-move delta. Returns 0 for a
 * no-op — same item, unknown ids, an adjacent drop that is already the
 * current order, or a non-array input.
 */
export function dropReorderDelta(
  ids: readonly string[] | null | undefined,
  fromId: string,
  toId: string,
  position: WorkspaceDropPosition = 'before',
): number {
  const current = copyIds(ids)
  const from = typeof fromId === 'string' ? current.indexOf(fromId) : -1
  const to = typeof toId === 'string' ? current.indexOf(toId) : -1
  if (from < 0 || to < 0 || from === to) return 0
  // Index the dragged id lands on in the list with it removed: a drop before
  // an id below the source has to shift by one, an `after` drop does not.
  const insertAt =
    position === 'after' ? (to > from ? to : to + 1) : to > from ? to - 1 : to
  return insertAt - from
}

/**
 * The full id order after a drop, with the same boundary rules as
 * {@link dropReorderDelta}. Always returns a fresh array; the input is never
 * mutated.
 */
export function dropReorderIds(
  ids: readonly string[] | null | undefined,
  fromId: string,
  toId: string,
  position: WorkspaceDropPosition = 'before',
): string[] {
  return moveWorkspaceId(ids, fromId, dropReorderDelta(ids, fromId, toId, position))
}

/**
 * Defensive copy of a workspace list for rendering: drops malformed entries and
 * duplicate ids (first occurrence wins) while preserving the server's order.
 * The returned objects are the same references, so caller-side edits are not
 * cloned silently.
 */
export function orderedWorkspaces<T extends WorkspaceLike>(
  workspaces: readonly T[] | null | undefined,
): T[] {
  const out: T[] = []
  const seen = new Set<string>()
  if (!Array.isArray(workspaces)) return out
  for (const workspace of workspaces) {
    if (!workspace || typeof workspace !== 'object') continue
    const id = workspace.id
    if (typeof id !== 'string' || !id.trim() || seen.has(id)) continue
    seen.add(id)
    out.push(workspace)
  }
  return out
}
