/**
 * Live streaming draft for the followed run (ephemeral SSE `token` frames).
 *
 * The server emits NAMED `token` frames while a run generates: reasoning deltas
 * (`kind: "thinking"`, observational, never part of the reply) and reply deltas
 * (`kind: "text"`). Tokens are ephemeral — they are not persisted and are not
 * replayed on `?after` reconnects — so this module keeps a bounded, disposable
 * draft per run/role. The completed reply always arrives as a normal
 * `envelope` runtime event, which clears the draft again.
 *
 * Pure and DOM-free: `App.vue` feeds tokens/events in, `ChatView.vue` renders
 * `streamingBlocks()`; everything is deterministic and unit-testable.
 */

import type { TokenEvent } from './types'

/** Per-buffer cap; a runaway stream keeps only its tail and is marked clipped. */
export const STREAMING_MAX_CHARS = 200_000

/** Roles that can produce live tokens (matches the runtime event contract). */
export type TokenRole = 'senior' | 'junior' | 'user'

/** Which buffer the latest token wrote; drives the "streaming" render flag. */
export type StreamingPhase = 'thinking' | 'text' | null

/** Mutable-by-replacement accumulators for one followed run. */
export interface StreamingState {
  /** Run whose live draft this is (null = no live draft). */
  runId: string | null
  /** Role currently generating (only one at a time). */
  role: TokenRole | null
  thinking: string
  text: string
  /** Kind of the most recent accepted token. */
  phase: StreamingPhase
  /** True once a buffer was clipped by `STREAMING_MAX_CHARS`. */
  thinkingTruncated: boolean
  textTruncated: boolean
}

/** One renderable live block. */
export interface StreamingBlock {
  text: string
  /** The block is still receiving tokens of its kind. */
  streaming: boolean
  /** Older text was clipped by the buffer bound. */
  truncated: boolean
}

/** Render-ready live draft (null sections are not shown). */
export interface StreamingBlocks {
  role: TokenRole | null
  thinking: StreamingBlock | null
  text: StreamingBlock | null
}

const TOKEN_ROLES: ReadonlySet<string> = new Set(['senior', 'junior', 'user'])

function emptyState(): StreamingState {
  return {
    runId: null,
    role: null,
    thinking: '',
    text: '',
    phase: null,
    thinkingTruncated: false,
    textTruncated: false,
  }
}

/** A fresh, empty accumulator. */
export function createStreamingState(): StreamingState {
  return emptyState()
}

/** Clear the live draft (run/session switch, stop, terminal event). */
export function resetStreaming(_state?: StreamingState | null): StreamingState {
  return emptyState()
}

/** True when any live draft content exists (avoids needless re-renders). */
export function hasStreamingDraft(state: StreamingState | null | undefined): boolean {
  if (!state) return false
  return state.runId !== null || state.thinking !== '' || state.text !== ''
}

/**
 * Narrow an unknown SSE payload to a token event. Role/kind stay tolerant in
 * `applyToken`; here only the structural minimum is required.
 */
export function isTokenEvent(value: unknown): value is TokenEvent {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    record.type === 'token' &&
    typeof record.run_id === 'string' &&
    record.run_id !== '' &&
    typeof record.delta === 'string'
  )
}

function normalizeRole(value: unknown): TokenRole | null {
  return typeof value === 'string' && TOKEN_ROLES.has(value) ? (value as TokenRole) : null
}

/** Missing/unknown kinds are reply text (documented client contract). */
function normalizeKind(value: unknown): 'thinking' | 'text' {
  return value === 'thinking' ? 'thinking' : 'text'
}

/**
 * Append `delta`, keeping at most `STREAMING_MAX_CHARS` characters (the tail).
 * Never splits a surrogate pair at the cut point.
 */
function appendBounded(previous: string, delta: string): { value: string; truncated: boolean } {
  const combined = previous + delta
  if (combined.length <= STREAMING_MAX_CHARS) return { value: combined, truncated: false }
  let start = combined.length - STREAMING_MAX_CHARS
  const code = combined.charCodeAt(start)
  if (code >= 0xdc00 && code <= 0xdfff) start += 1 // don't start on a low surrogate
  return { value: combined.slice(start), truncated: true }
}

/**
 * Fold one live token into the draft. A token for a different run or role
 * resets the draft to that role (the harness only streams one call at a time).
 * Malformed tokens are ignored; unknown kinds count as `text`.
 */
export function applyToken(state: StreamingState, token: unknown): StreamingState {
  if (!state || !isTokenEvent(token)) return state ?? emptyState()
  const event = token as TokenEvent
  const role = normalizeRole(event.role)
  if (!role) return state

  const sameDraft = state.runId === event.run_id && state.role === role
  const base: StreamingState = sameDraft
    ? state
    : { ...emptyState(), runId: event.run_id, role }

  const kind = normalizeKind(event.kind)
  if (event.delta === '') return base === state ? state : base

  const next: StreamingState = { ...base }
  if (kind === 'thinking') {
    const appended = appendBounded(base.thinking, event.delta)
    next.thinking = appended.value
    next.thinkingTruncated = base.thinkingTruncated || appended.truncated
  } else {
    const appended = appendBounded(base.text, event.delta)
    next.text = appended.value
    next.textTruncated = base.textTruncated || appended.truncated
  }
  next.phase = kind
  return next
}

/**
 * Fold a runtime event into the draft: a completed `envelope` for the streaming
 * role replaces its draft (both buffers clear); `run_end`/`run_error` clear
 * everything; token events are delegated; everything else is a no-op.
 */
export function applyRuntimeEvent(state: StreamingState, event: unknown): StreamingState {
  if (!state || !event || typeof event !== 'object') return state ?? emptyState()
  const record = event as Record<string, unknown>

  if (record.type === 'token') {
    return isTokenEvent(event) ? applyToken(state, event) : state
  }
  if (typeof record.type !== 'string' || typeof record.run_id !== 'string') return state
  if (!state.runId || record.run_id !== state.runId) return state

  if (record.type === 'envelope') {
    const envelope = record.envelope
    const from =
      envelope && typeof envelope === 'object'
        ? (envelope as Record<string, unknown>).from
        : undefined
    // the completed reply for the streaming role takes over from the draft
    if (state.role !== null && from === state.role) return resetStreaming(state)
    return state
  }

  if (record.type === 'run_end' || record.type === 'run_error') {
    return resetStreaming(state)
  }

  return state
}

/** Render-ready view of the draft (thinking first, response second). */
export function streamingBlocks(
  state: StreamingState | null | undefined,
): StreamingBlocks {
  const safe = state ?? emptyState()
  return {
    role: safe.role,
    thinking: safe.thinking
      ? {
          text: safe.thinking,
          streaming: safe.phase === 'thinking',
          truncated: safe.thinkingTruncated,
        }
      : null,
    text: safe.text
      ? { text: safe.text, streaming: safe.phase === 'text', truncated: safe.textTruncated }
      : null,
  }
}
