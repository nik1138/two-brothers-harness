/**
 * Workspace context for a web session/run.
 *
 * A session created under a workspace keeps that link (the `*.meta.json`
 * sidecar). It is the workspace the composer's `@` file picker searches, the
 * status seats describe and the run itself must use — otherwise the model is
 * offered no workspace tools while the UI claims a linked folder. The sidebar
 * filter is only a fallback for a session without a link (it is the workspace
 * a session started from that filter will belong to).
 *
 * Pure and defensive: unexpected values read as "not set", and `'all'` is the
 * sidebar's no-filter sentinel, never a workspace id.
 */

/** The workspace id a run should carry for the selected session/context. */
export function runWorkspaceId(
  sessionWorkspaceId: string | null | undefined,
  filterWorkspaceId: string | null | undefined,
): string | null {
  const linked =
    typeof sessionWorkspaceId === 'string' ? sessionWorkspaceId.trim() : ''
  if (linked) return linked
  const filter =
    typeof filterWorkspaceId === 'string' ? filterWorkspaceId.trim() : ''
  return filter && filter !== 'all' ? filter : null
}
