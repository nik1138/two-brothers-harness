/**
 * Read-only helper subagents in the parent view (pure, no DOM/Vue).
 *
 * The parent session's runtime sidecar carries live `subagent_started`,
 * `subagent_activity` and `subagent_completed` events. The same tree can be
 * reloaded from `GET /api/sessions/{name}/subagents`, and one child's bounded
 * transcript from `GET /api/subagents/{id}`. These helpers normalize those
 * payloads and fold live events into the tree/detail without inventing a row.
 */

import type {
  RunEvent,
  RunUsage,
  SubagentActivity,
  SubagentActivityEvent,
  SubagentCompletedEvent,
  SubagentDetail,
  SubagentInfo,
  SubagentRole,
  SubagentStartedEvent,
  SubagentStatus,
  SubagentTranscriptEntry,
} from './types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringOf(value: unknown, limit = 2_000): string {
  return typeof value === 'string' ? value.slice(0, limit) : ''
}

function intOf(value: unknown, fallback = 0): number {
  const num = Number(value)
  return Number.isFinite(num) ? Math.trunc(num) : fallback
}

function statusOf(value: unknown): SubagentStatus {
  return value === 'completed' || value === 'failed' || value === 'cancelled'
    ? value
    : 'running'
}

function roleOf(value: unknown): SubagentRole {
  return value === 'senior' ? 'senior' : 'junior'
}

function usageOf(value: unknown): RunUsage | null {
  if (!isRecord(value)) return null
  return {
    model_calls: Math.max(0, intOf(value.model_calls)),
    input_tokens: Math.max(0, intOf(value.input_tokens)),
    output_tokens: Math.max(0, intOf(value.output_tokens)),
    cached_tokens: Math.max(0, intOf(value.cached_tokens)),
    cache_write_tokens: Math.max(0, intOf(value.cache_write_tokens)),
    ...(value.prompt_tokens !== undefined
      ? { prompt_tokens: Math.max(0, intOf(value.prompt_tokens)) }
      : {}),
  }
}

function activityOf(value: unknown): SubagentActivity | null {
  if (!isRecord(value)) return null
  const kind =
    value.kind === 'tool' || value.kind === 'status' ? value.kind : 'message'
  return {
    kind,
    ...(typeof value.text === 'string' ? { text: value.text.slice(0, 300) } : {}),
    ...(typeof value.tool === 'string' ? { tool: value.tool.slice(0, 120) } : {}),
    ...(typeof value.status === 'string' ? { status: value.status.slice(0, 80) } : {}),
    at: intOf(value.at),
  }
}

function transcriptEntryOf(value: unknown): SubagentTranscriptEntry | null {
  if (!isRecord(value)) return null
  if (value.type === 'message') {
    const text = stringOf(value.text, 12_000)
    if (text === '') return null
    return {
      type: 'message',
      role: value.role === 'user' ? 'user' : 'assistant',
      text,
      at: intOf(value.at),
    }
  }
  if (value.type === 'tool') {
    const tool = stringOf(value.tool, 200)
    if (tool === '') return null
    const status =
      value.status === 'completed' || value.status === 'error' ? value.status : 'started'
    return {
      type: 'tool',
      tool,
      status,
      at: intOf(value.at),
      ...(isRecord(value.args) ? { args: value.args } : {}),
      ...(typeof value.result === 'string'
        ? { result: value.result.slice(0, 4_000) }
        : {}),
    }
  }
  return null
}

export function normalizeSubagentInfo(value: unknown): SubagentInfo | null {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id === '') return null
  const parentSession = stringOf(value.parent_session, 300)
  const label = stringOf(value.label, 120)
  // A row needs a parent or a label; a bare id is a malformed fragment.
  if (parentSession === '' && label === '') return null
  const started = intOf(value.started_at)
  return {
    id: value.id,
    parent_session: parentSession,
    label: label || 'Subagent',
    role: roleOf(value.role),
    model: stringOf(value.model, 200),
    task: stringOf(value.task, 4_000),
    status: statusOf(value.status),
    started_at: started,
    ...(value.ended_at !== undefined ? { ended_at: intOf(value.ended_at) } : {}),
    ...(value.duration_ms !== undefined ? { duration_ms: intOf(value.duration_ms) } : {}),
    last_activity: activityOf(value.last_activity),
    usage: usageOf(value.usage),
    result: typeof value.result === 'string' ? value.result : null,
    error: typeof value.error === 'string' ? value.error : null,
  }
}

export function normalizeSubagentDetail(value: unknown): SubagentDetail | null {
  const info = normalizeSubagentInfo(value)
  if (info === null || !isRecord(value)) return null
  const transcript = Array.isArray(value.transcript)
    ? value.transcript
        .map((entry) => transcriptEntryOf(entry))
        .filter((entry): entry is SubagentTranscriptEntry => entry !== null)
    : []
  return { ...info, transcript }
}

export function normalizeSubagentList(value: unknown): SubagentInfo[] {
  const raw = isRecord(value) && Array.isArray(value.subagents) ? value.subagents : value
  if (!Array.isArray(raw)) return []
  return raw
    .map((entry) => normalizeSubagentInfo(entry))
    .filter((entry): entry is SubagentInfo => entry !== null)
}

/** Fold one live tree event into the newest-first list (no duplicates). */
export function applySubagentEvent(
  list: readonly SubagentInfo[],
  event: RunEvent,
): SubagentInfo[] {
  if (
    event.type !== 'subagent_started' &&
    event.type !== 'subagent_activity' &&
    event.type !== 'subagent_completed'
  ) {
    return list as SubagentInfo[]
  }
  const index = list.findIndex((row) => row.id === event.subagent_id)
  const current = index >= 0 ? list[index]! : null
  if (event.type === 'subagent_started') {
    const started = event as SubagentStartedEvent
    const next: SubagentInfo = {
      id: started.subagent_id,
      parent_session: current?.parent_session ?? '',
      label: started.label,
      role: started.role,
      model: started.model,
      task: started.task,
      status: 'running',
      started_at: started.started_at,
      last_activity: null,
      usage: null,
      result: null,
      error: null,
    }
    if (index >= 0) {
      const copy = [...list]
      copy[index] = { ...current!, ...next }
      return copy
    }
    return [next, ...list]
  }
  if (current === null) return list as SubagentInfo[]
  const copy = [...list]
  if (event.type === 'subagent_activity') {
    const activity = event as SubagentActivityEvent
    copy[index] = {
      ...current,
      label: activity.label || current.label,
      last_activity: {
        kind: activity.activity,
        ...(activity.text !== undefined ? { text: activity.text.slice(0, 300) } : {}),
        ...(activity.tool !== undefined ? { tool: activity.tool.slice(0, 120) } : {}),
        ...(activity.status !== undefined ? { status: activity.status.slice(0, 80) } : {}),
        at: activity.at,
      },
    }
    return copy
  }
  const completed = event as SubagentCompletedEvent
  copy[index] = {
    ...current,
    status: completed.status,
    ...(completed.result !== undefined ? { result: completed.result } : {}),
    ...(completed.error !== undefined ? { error: completed.error } : {}),
    usage: usageOf(completed.usage),
    duration_ms: completed.duration_ms,
    ended_at: completed.ended_at,
    last_activity: {
      kind: 'status',
      status: completed.status,
      at: completed.at,
    },
  }
  return copy
}

/**
 * Fold one live event into the open child drawer. A message event is skipped
 * when the store already returned the same final text (the common case when a
 * child is opened mid-run); a tool start/completion pairs with the newest open
 * row for that tool instead of appending a duplicate.
 */
export function applySubagentDetailEvent(
  detail: SubagentDetail,
  event: RunEvent,
): SubagentDetail {
  if (
    event.type !== 'subagent_started' &&
    event.type !== 'subagent_activity' &&
    event.type !== 'subagent_completed'
  ) {
    return detail
  }
  if (event.subagent_id !== detail.id) return detail
  if (event.type === 'subagent_started') {
    const started = event as SubagentStartedEvent
    return {
      ...detail,
      label: started.label,
      role: started.role,
      model: started.model,
      task: started.task,
      status: 'running',
      started_at: started.started_at,
    }
  }
  if (event.type === 'subagent_activity') {
    const activity = event as SubagentActivityEvent
    if (activity.activity === 'message') {
      const text = (activity.text ?? '').slice(0, 12_000)
      if (text === '') return detail
      const last = detail.transcript[detail.transcript.length - 1]
      if (last?.type === 'message' && last.role === 'assistant' && last.text === text) {
        return {
          ...detail,
          last_activity: { kind: 'message', text: text.slice(0, 300), at: activity.at },
        }
      }
      return {
        ...detail,
        last_activity: { kind: 'message', text: text.slice(0, 300), at: activity.at },
        transcript: [
          ...detail.transcript,
          { type: 'message', role: 'assistant', text, at: activity.at * 1_000 },
        ],
      }
    }
    if (activity.activity === 'tool') {
      const tool = (activity.tool ?? '').slice(0, 200)
      if (tool === '') return detail
      const status =
        activity.status === 'completed' || activity.status === 'error'
          ? activity.status
          : 'started'
      const open = [...detail.transcript]
        .reverse()
        .findIndex(
          (entry) => entry.type === 'tool' && entry.tool === tool && entry.status === 'started',
        )
      const openIndex =
        open >= 0 ? detail.transcript.length - 1 - open : -1
      if (status === 'started') {
        if (openIndex >= 0) return detail
        return {
          ...detail,
          last_activity: { kind: 'tool', tool, status, at: activity.at },
          transcript: [
            ...detail.transcript,
            {
              type: 'tool',
              tool,
              status,
              ...(activity.args !== undefined ? { args: activity.args } : {}),
              at: activity.at * 1_000,
            },
          ],
        }
      }
      if (openIndex >= 0) {
        const transcript = [...detail.transcript]
        transcript[openIndex] = {
          ...transcript[openIndex]!,
          status,
          ...(typeof activity.result === 'string' ? { result: activity.result } : {}),
        }
        return {
          ...detail,
          last_activity: {
            kind: 'tool',
            tool,
            status,
            ...(typeof activity.result === 'string'
              ? { text: activity.result.slice(0, 200) }
              : {}),
            at: activity.at,
          },
          transcript,
        }
      }
      return {
        ...detail,
        last_activity: { kind: 'tool', tool, status, at: activity.at },
        transcript: [
          ...detail.transcript,
          {
            type: 'tool',
            tool,
            status,
            ...(activity.args !== undefined ? { args: activity.args } : {}),
            ...(typeof activity.result === 'string' ? { result: activity.result } : {}),
            at: activity.at * 1_000,
          },
        ],
      }
    }
    return {
      ...detail,
      last_activity: {
        kind: 'status',
        ...(activity.status !== undefined ? { status: activity.status } : {}),
        at: activity.at,
      },
    }
  }
  if (event.type === 'subagent_completed') {
    const completed = event as SubagentCompletedEvent
    return {
      ...detail,
      status: completed.status,
      ...(completed.result !== undefined ? { result: completed.result } : {}),
      ...(completed.error !== undefined ? { error: completed.error } : {}),
      usage: usageOf(completed.usage),
      duration_ms: completed.duration_ms,
      ended_at: completed.ended_at,
      last_activity: { kind: 'status', status: completed.status, at: completed.at },
    }
  }
  return detail
}

export function runningSubagentCount(list: readonly SubagentInfo[]): number {
  return list.filter((row) => row.status === 'running').length
}

export function subagentStatusLabel(status: SubagentStatus): string {
  if (status === 'completed') return 'completed'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'cancelled'
  return 'running'
}

export function subagentRoleLabel(role: SubagentRole): string {
  return role === 'senior' ? 'Senior model' : 'Junior model'
}

/** Compact duration label (`0:42`, `12:03`, `1:02:03`) for elapsed/total ms. */
export function subagentDuration(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1_000))
  const h = Math.floor(total / 3_600)
  const m = Math.floor((total % 3_600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** Compact elapsed clock for a tree row (`0:42`, `12:03`, `1:02:03`). */
export function subagentElapsed(startedAt: number, endedAt?: number | null): string {
  if (!Number.isFinite(startedAt) || startedAt <= 0) return ''
  const end = Number.isFinite(endedAt) && (endedAt ?? 0) > 0 ? Number(endedAt) : Date.now()
  return subagentDuration(end - startedAt)
}

/** `1.2k`/`12k` token shorthand for a narrow row; `''` when unknown. */
export function subagentTokenLabel(usage: RunUsage | null | undefined): string {
  if (!usage) return ''
  const total = Number(usage.input_tokens) + Number(usage.output_tokens)
  if (!Number.isFinite(total) || total <= 0) return ''
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}m tok`
  if (total >= 100_000) return `${Math.round(total / 1_000)}k tok`
  if (total >= 1_000) return `${(total / 1_000).toFixed(1)}k tok`
  return `${Math.round(total)} tok`
}

/** One-line activity for the tree (`reading a file`, `reported`, …). */
export function subagentActivityText(
  activity: SubagentActivity | null | undefined,
  status?: SubagentStatus,
): string {
  if (!activity) return status === 'running' ? 'starting…' : ''
  if (activity.kind === 'tool' && activity.tool) {
    return activity.status === 'completed'
      ? `${activity.tool} done`
      : activity.status === 'error'
        ? `${activity.tool} failed`
        : `using ${activity.tool}`
  }
  if (activity.kind === 'message') return activity.text || 'writing report…'
  if (activity.kind === 'status') {
    return activity.status === 'completed'
      ? 'reported'
      : activity.status === 'failed'
        ? 'failed'
        : activity.status === 'cancelled'
          ? 'cancelled'
          : 'working…'
  }
  return ''
}

/** The child task's first line, bounded for a drawer header. */
export function subagentTaskPreview(task: string, max = 160): string {
  const oneLine = task.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= max) return oneLine
  return oneLine.slice(0, Math.max(0, max - 1)) + '…'
}
