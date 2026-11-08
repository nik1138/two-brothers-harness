/**
 * Transcript pagination model (pure).
 *
 * The shell owns the complete timeline (chat projection, runtime merge, context
 * meter, run anchors and find all need it); only the *render* is bounded. A
 * window keeps at most {@link TRANSCRIPT_PAGE_SIZE} newest rows in the DOM plus
 * every earlier chunk the operator explicitly asked for, and lets the operator
 * prepend the previous {@link TRANSCRIPT_CHUNK_SIZE} rows per activation. A
 * session that fits in the default window is unaffected: it has no hidden rows,
 * no control and no announcement.
 *
 * One "block" is one timeline row as `ChatView` renders it — a chat group,
 * revision divider, system note, tool/approval/prompt-audit card or replayed
 * reasoning row. A chat group of several messages is one block, because it is
 * one row in the transcript projection and one unit of render cost; the UI copy
 * still says "messages" in the chat-standard sense. The window slices rows, it
 * never re-groups or re-projects them, so `ChatView` keeps passing the absolute
 * window start to `buildFoldRows` as its key offset and run/fold identities do
 * not change when an earlier chunk is revealed.
 *
 * State is the number of earlier rows the operator has asked to load
 * (`loaded`), not an absolute index. That difference matters for a live
 * session: an absolute start would either pin the window and let every appended
 * row grow the DOM without bound, or re-anchor on growth and silently undo the
 * chunks the operator had just revealed. With `loaded`, the rendered count is
 * `min(total, page + loaded)` forever: growth keeps the newest rows and the
 * loaded chunks, shrink (a rewind) shows everything that remains, and the
 * "show earlier" control always makes progress.
 *
 * No DOM or Vue dependency: the model is unit-tested directly.
 */

/** Rows rendered by default, newest first. */
export const TRANSCRIPT_PAGE_SIZE = 200

/** Rows the "show earlier" control prepends per activation. */
export const TRANSCRIPT_CHUNK_SIZE = 100

export interface TranscriptWindowOptions {
  /** Defaults to {@link TRANSCRIPT_PAGE_SIZE}; invalid values use the default. */
  readonly pageSize?: number
  /** Defaults to {@link TRANSCRIPT_CHUNK_SIZE}; invalid values use the default. */
  readonly chunkSize?: number
}

/** Immutable pagination state: how many earlier rows the operator loaded. */
export interface TranscriptWindowState {
  /** Earlier rows the operator asked to keep visible; 0 = newest page only. */
  readonly loaded: number
}

/** One rendered window's bounds and truthful control copy. */
export interface TranscriptWindow {
  /** Rows in the timeline. */
  readonly total: number
  /** Absolute index of the first rendered row (= `hidden`). */
  readonly start: number
  /** Rows currently rendered. */
  readonly visible: number
  /** Older rows the window hides above it. */
  readonly hidden: number
  /** Rows one activation would prepend (clamped to what is hidden). */
  readonly chunk: number
  /** True while at least one older row is hidden. */
  readonly hasEarlier: boolean
  /** Accessible control label; empty when everything is loaded. */
  readonly controlLabel: string
}

/** Result of one "show earlier" activation. */
export interface TranscriptWindowStep {
  /** State after prepending the previous chunk. */
  readonly state: TranscriptWindowState
  /** Window after the activation. */
  readonly window: TranscriptWindow
  /** Rows this activation prepended (0 for a no-op). */
  readonly loaded: number
  /** Rows still hidden after this activation. */
  readonly remaining: number
  /** Polite live-region sentence; empty when the activation did nothing. */
  readonly announcement: string
}

/** A non-negative integer count; anything else reads as 0 (empty transcript). */
function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0
}

/** A positive integer option; invalid values fall back to `fallback`. */
function sizeOf(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : fallback
}

function pageSizeOf(options: TranscriptWindowOptions): number {
  return sizeOf(options.pageSize, TRANSCRIPT_PAGE_SIZE)
}

function chunkSizeOf(options: TranscriptWindowOptions): number {
  return sizeOf(options.chunkSize, TRANSCRIPT_CHUNK_SIZE)
}

/** Absolute start for the rendered window: rows beyond page + loaded are hidden. */
function startFor(rows: number, loaded: number, page: number): number {
  return Math.max(0, rows - page - loaded)
}

/**
 * Initial state for a transcript: the newest page, or everything when the
 * timeline already fits. Used on mount and when resetting for a session switch.
 * The `total` argument documents intent and keeps callers honest; the initial
 * window is always "nothing extra loaded".
 */
export function initialTranscriptWindow(
  _total?: unknown,
  _options: TranscriptWindowOptions = {},
): TranscriptWindowState {
  return { loaded: 0 }
}

/**
 * The rendered window for `total` rows and `state`.
 *
 * Growth and shrink both stay truthful: raising `total` keeps the rendered
 * count at `page + loaded` (the DOM never grows without bound), and lowering
 * it (a rewind or a reloaded session) shows what remains instead of an empty
 * transcript.
 */
export function transcriptWindow(
  total: unknown,
  state: TranscriptWindowState,
  options: TranscriptWindowOptions = {},
): TranscriptWindow {
  const rows = countOf(total)
  const page = pageSizeOf(options)
  const loaded = countOf(state?.loaded)
  const start = startFor(rows, loaded, page)
  const hidden = start
  const visible = rows - hidden
  const chunk = Math.min(chunkSizeOf(options), hidden)
  return {
    total: rows,
    start,
    visible,
    hidden,
    chunk,
    hasEarlier: hidden > 0,
    controlLabel: hidden > 0 ? `Show earlier messages (${hidden} more)` : '',
  }
}

function earlierCount(count: number): string {
  return count === 1 ? '1 earlier message' : `${count} earlier messages`
}

function remainingSentence(count: number): string {
  return count === 1 ? '1 older message remains hidden.' : `${count} older messages remain hidden.`
}

/** Polite sentence for one successful activation. */
function announcementFor(loaded: number, remaining: number): string {
  const head = `Loaded ${earlierCount(loaded)}.`
  if (remaining === 0) return `${head} All messages are now loaded.`
  return `${head} ${remainingSentence(remaining)}`
}

/**
 * Prepend the previous bounded chunk. A no-op (nothing hidden) returns the same
 * state, `loaded: 0` and an empty announcement, so the view can call this from
 * the control handler without pre-checking.
 */
export function showEarlierTranscriptWindow(
  total: unknown,
  state: TranscriptWindowState,
  options: TranscriptWindowOptions = {},
): TranscriptWindowStep {
  const current = transcriptWindow(total, state, options)
  if (!current.hasEarlier) {
    return {
      state: { loaded: countOf(state?.loaded) },
      window: current,
      loaded: 0,
      remaining: 0,
      announcement: '',
    }
  }
  const nextState: TranscriptWindowState = {
    loaded: countOf(state?.loaded) + current.chunk,
  }
  const next = transcriptWindow(total, nextState, options)
  const loaded = current.hidden - next.hidden
  return {
    state: nextState,
    window: next,
    loaded,
    remaining: next.hidden,
    announcement: announcementFor(loaded, next.hidden),
  }
}

/**
 * Memoized newest-rows slice. `ChatView` owns one instance per mount, so a
 * re-render that did not move the window (or did not replace the timeline)
 * reuses the previous array instead of allocating a fresh one — downstream
 * watchers such as find invalidation only fire on real changes. A start of 0
 * returns the input array itself, which keeps a short session's render path
 * identical to the unpaginated one.
 */
export function createTranscriptSliceMemo<T>(): (
  blocks: readonly T[],
  start: number,
) => readonly T[] {
  let lastBlocks: readonly T[] | undefined
  let lastStart = -1
  let lastSlice: readonly T[] = []
  return (blocks, start) => {
    const requested = countOf(start)
    const safeStart = Math.min(requested, blocks.length)
    if (blocks === lastBlocks && safeStart === lastStart) return lastSlice
    lastBlocks = blocks
    lastStart = safeStart
    lastSlice = safeStart === 0 ? blocks : blocks.slice(safeStart)
    return lastSlice
  }
}
