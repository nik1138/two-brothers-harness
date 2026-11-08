<script setup lang="ts">
/**
 * Run-scoped workspace undo preview/apply (wave 23). The server classifies
 * every file mutation the run recorded against the live workspace; this dialog
 * shows all six statuses with counts, states exactly what applying will do
 * ("restores the files this run changed; files changed since the run are
 * refused"), and only then calls
 * `POST /api/sessions/{name}/undo/{run_id}`.
 *
 * After applying it keeps the dialog open with the honest summary: applied /
 * refused / failed rows are listed separately, and a refused file is never
 * counted as undone. `DELETE` (discard the recorded undo data) is a secondary
 * action with its own in-place confirmation.
 *
 * Dialogs own their API call and report failures inline (`role=alert`) plus to
 * the shell (`error`); the shell only refreshes the affected session/sidebar
 * after `applied`/`discarded`.
 */
import { computed, ref } from 'vue'
import { NButton } from 'naive-ui'
import { ApiError, applyRunUndo, discardRunUndo } from '../api'
import {
  UNDO_ACTION_LABEL,
  UNDO_PREVIEW_STATUSES,
  canApplyUndo,
  sortUndoEntries,
  summarizeUndoPreview,
  undoActionHint,
  undoApplyEntries,
  undoApplyNotice,
  undoAppliedLabel,
  undoConfirmation,
  undoEntryAction,
  undoFailureNotice,
  undoPreviewEntries,
  undoPreviewNotice,
  undoStatusLabel,
  undoStatusReason,
} from '../runUndo'
import type {
  RunUndoApplyResult,
  RunUndoPreview,
  RunUndoPreviewEntry,
} from '../runUndo'
import AppDialog from './AppDialog.vue'

const props = defineProps<{
  /** Canonical session file name the undo record belongs to. */
  session: string
  /** The completed run whose file changes are being reviewed. */
  runId: string
  /** `GET /api/sessions/{name}/undo/{run_id}` preview (normalized). */
  preview: RunUndoPreview
}>()

const emit = defineEmits<{
  close: []
  /** Files were restored/deleted; the shell refreshes session metadata. */
  applied: [result: RunUndoApplyResult]
  /** The undo record was discarded; the shell may refresh the session. */
  discarded: []
  /** Non-blocking shell feedback (the dialog already shows it inline too). */
  error: [message: string]
}>()

const busy = ref<'apply' | 'discard' | null>(null)
const serverError = ref<string | null>(null)
const result = ref<RunUndoApplyResult | null>(null)
const confirmDiscard = ref(false)
const discarded = ref(false)

const entries = computed(() => undoPreviewEntries(props.preview))
const summary = computed(() => summarizeUndoPreview(props.preview))
const canApply = computed(() => canApplyUndo(props.preview))
const body = computed(() => undoConfirmation(props.preview))
const head = computed(() => undoPreviewNotice(props.preview))
const applying = computed(() => busy.value === 'apply')

/** Preview rows grouped in display order (reversible statuses first). */
const groups = computed(() =>
  UNDO_PREVIEW_STATUSES.map((status) => ({
    status,
    label: undoStatusLabel(status),
    rows: sortUndoEntries(entries.value).filter((row) => row.status === status),
  })).filter((group) => group.rows.length > 0),
)

const appliedRows = computed(() =>
  undoApplyEntries(result.value).filter((row) => row.status === 'applied'),
)
const refusedRows = computed(() =>
  undoApplyEntries(result.value).filter((row) => row.status === 'refused'),
)
const failedRows = computed(() =>
  undoApplyEntries(result.value).filter((row) => row.status === 'failed'),
)

function errText(e: unknown): string {
  return e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e)
}

function failure(e: unknown): string {
  return undoFailureNotice({
    status: e instanceof ApiError ? e.status : undefined,
    detail: errText(e),
  })
}

function requestClose(): void {
  if (busy.value !== null) return
  emit('close')
}

function rowAction(row: RunUndoPreviewEntry): string {
  return undoEntryAction(row.status, row.action)
}

function rowReason(row: RunUndoPreviewEntry): string {
  return undoStatusReason(row)
}

async function apply(): Promise<void> {
  if (busy.value !== null || !canApply.value) return
  serverError.value = null
  busy.value = 'apply'
  try {
    const applied = await applyRunUndo(props.session, props.runId)
    result.value = applied
    emit('applied', applied)
  } catch (e) {
    const message = failure(e)
    serverError.value = message
    emit('error', message)
  } finally {
    busy.value = null
  }
}

async function discard(): Promise<void> {
  if (busy.value !== null) return
  if (!confirmDiscard.value) {
    confirmDiscard.value = true
    return
  }
  serverError.value = null
  busy.value = 'discard'
  try {
    await discardRunUndo(props.session, props.runId)
    discarded.value = true
    confirmDiscard.value = false
    emit('discarded')
  } catch (e) {
    const message = failure(e)
    serverError.value = message
    emit('error', message)
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <AppDialog
    :show="true"
    size="md"
    title="Undo this run's file changes"
    :description="`Run ${runId} · session ${session}`"
    :persistent="busy !== null"
    initial-focus=".undo-cancel"
    @close="requestClose"
  >
    <div class="run-undo-body">
      <template v-if="result === null && !discarded">
        <p class="run-undo-head">{{ head }}</p>
        <p class="run-undo-copy">{{ body }}</p>
        <p class="run-undo-hint">{{ undoActionHint(true) }}</p>

        <section
          v-for="group in groups"
          :key="group.status"
          class="run-undo-group"
          :aria-label="`${group.label} (${group.rows.length})`"
        >
          <h3 class="run-undo-group-title">
            {{ group.label }} <span class="run-undo-count">{{ group.rows.length }}</span>
          </h3>
          <ul class="run-undo-list">
            <li v-for="row in group.rows" :key="row.path" class="run-undo-row">
              <span class="run-undo-path">{{ row.path }}</span>
              <span class="run-undo-what">{{ rowAction(row) }}</span>
              <span v-if="rowReason(row)" class="run-undo-reason">{{ rowReason(row) }}</span>
            </li>
          </ul>
        </section>
        <p v-if="entries.length === 0" class="run-undo-empty">
          This run recorded no file changes to undo.
        </p>
      </template>

      <template v-else-if="discarded">
        <p class="run-undo-head" role="status">
          The undo record for this run was discarded. The workspace files are unchanged.
        </p>
      </template>

      <template v-else>
        <p class="run-undo-head" role="status">{{ undoApplyNotice(result) }}</p>
        <section v-if="appliedRows.length" class="run-undo-group" aria-label="Restored or deleted">
          <h3 class="run-undo-group-title">
            Restored / deleted <span class="run-undo-count">{{ appliedRows.length }}</span>
          </h3>
          <ul class="run-undo-list">
            <li v-for="row in appliedRows" :key="row.path" class="run-undo-row">
              <span class="run-undo-path">{{ row.path }}</span>
              <span class="run-undo-what">{{ undoAppliedLabel(row) }}</span>
            </li>
          </ul>
        </section>
        <section v-if="refusedRows.length" class="run-undo-group" aria-label="Refused">
          <h3 class="run-undo-group-title">
            Refused — left untouched <span class="run-undo-count">{{ refusedRows.length }}</span>
          </h3>
          <ul class="run-undo-list">
            <li v-for="row in refusedRows" :key="row.path" class="run-undo-row">
              <span class="run-undo-path">{{ row.path }}</span>
              <span class="run-undo-what">{{ undoStatusLabel(row.preview_status) }}</span>
              <span v-if="row.reason" class="run-undo-reason">{{ row.reason }}</span>
            </li>
          </ul>
        </section>
        <section v-if="failedRows.length" class="run-undo-group" aria-label="Failed">
          <h3 class="run-undo-group-title">
            Failed <span class="run-undo-count">{{ failedRows.length }}</span>
          </h3>
          <ul class="run-undo-list">
            <li v-for="row in failedRows" :key="row.path" class="run-undo-row">
              <span class="run-undo-path">{{ row.path }}</span>
              <span class="run-undo-what">failed</span>
              <span v-if="row.reason" class="run-undo-reason">{{ row.reason }}</span>
            </li>
          </ul>
        </section>
      </template>

      <p v-if="serverError" class="run-undo-error" role="alert">{{ serverError }}</p>
    </div>

    <template #footer>
      <template v-if="result === null && !discarded">
        <n-button
          v-if="!confirmDiscard"
          attr-type="button"
          quaternary
          class="undo-discard"
          :disabled="busy !== null"
          title="Discard the recorded undo data for this run; workspace files stay as they are."
          @click="discard"
        >
          Discard record
        </n-button>
        <n-button
          v-else
          attr-type="button"
          quaternary
          type="warning"
          class="undo-discard"
          :loading="busy === 'discard'"
          @click="discard"
        >
          Confirm discard record
        </n-button>
        <n-button
          attr-type="button"
          class="undo-cancel"
          :disabled="busy !== null"
          @click="requestClose"
        >
          Cancel
        </n-button>
        <n-button
          attr-type="button"
          type="primary"
          class="undo-apply"
          :loading="applying"
          :disabled="busy !== null || !canApply"
          :title="canApply ? UNDO_ACTION_LABEL : 'No recorded file can be undoably restored right now.'"
          @click="apply"
        >
          {{ applying ? 'Undoing…' : `Undo ${summary.reversible} file${summary.reversible === 1 ? '' : 's'}` }}
        </n-button>
      </template>
      <n-button v-else attr-type="button" class="undo-cancel" @click="requestClose">
        Close
      </n-button>
    </template>
  </AppDialog>
</template>

<style scoped>
.run-undo-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  font-size: 0.82rem;
  line-height: 1.5;
}

.run-undo-head,
.run-undo-copy,
.run-undo-hint,
.run-undo-empty {
  margin: 0;
}

.run-undo-head {
  color: var(--text-primary);
  font-weight: 600;
}

.run-undo-hint {
  color: var(--text-secondary);
  font-size: 0.76rem;
}

.run-undo-group {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.run-undo-group-title {
  margin: 0;
  color: var(--text-secondary);
  font-size: 0.74rem;
  font-weight: 600;
  text-transform: none;
}

.run-undo-count {
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.run-undo-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.run-undo-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.15rem 0.5rem;
  padding: 0.15rem 0.35rem;
  border-radius: var(--radius-sm);
  background: var(--surface-panel);
}

.run-undo-path {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.76rem;
  overflow-wrap: anywhere;
}

.run-undo-what {
  color: var(--text-secondary);
  font-size: 0.74rem;
}

.run-undo-reason {
  flex-basis: 100%;
  color: var(--warning);
  font-size: 0.72rem;
}

.run-undo-error {
  margin: 0;
  color: var(--danger);
  font-size: 0.78rem;
  line-height: 1.4;
}
</style>
