<script setup lang="ts">
import { computed } from 'vue'

import {
  APPROVAL_MODES,
  approvalModeCopy,
  approvalModeDanger,
  approvalPolicyDisabledReason,
} from '../../approvalPolicy'
import type { ApprovalMode } from '../../types'

/**
 * Settings → Approvals: the operator approval mode for workspace-bound runs.
 * The cards are plain radio inputs (like Appearance) so keyboard and screen
 * reader behavior comes from the platform; the copy is the honest decision
 * table from `src/approvalPolicy.ts` and `allow-all` renders its destructive
 * warning inline.
 *
 * The mode is a server-side setting saved with the rest of the settings form.
 * An older backend omits the `approval_policy` field (unsupported) and a
 * serve flag/env pin overrides the persisted value (pinned); both states make
 * the selector read-only and explain why.
 */
const props = defineProps<{
  mode: ApprovalMode
  supported: boolean
  pinned: boolean
}>()

const emit = defineEmits<{
  'update:mode': [ApprovalMode]
}>()

const disabledReason = computed(() =>
  approvalPolicyDisabledReason({ supported: props.supported, pinned: props.pinned }),
)
const readonly = computed(() => disabledReason.value !== null)
const selectedDanger = computed(() => approvalModeDanger(props.mode))

function select(mode: ApprovalMode) {
  if (readonly.value) return
  emit('update:mode', mode)
}
</script>

<template>
  <div class="approval-section">
    <p class="approval-lead">
      How much a model may do in a workspace without asking you. The mode applies to every new
      workspace-bound run; it never overrides workspace confinement, and workspace paths that
      are refused for safety (sensitive files, paths outside the workspace) are refused in every
      mode.
    </p>

    <p v-if="disabledReason" class="approval-note approval-note--readonly" role="status">
      {{ disabledReason }}
    </p>

    <div
      class="approval-grid"
      role="radiogroup"
      aria-label="Approval mode"
      :aria-disabled="readonly"
    >
      <label
        v-for="mode in APPROVAL_MODES"
        :key="mode"
        class="approval-card"
        :class="{ selected: mode === props.mode, disabled: readonly }"
      >
        <input
          class="approval-input"
          type="radio"
          name="approval-mode"
          :value="mode"
          :checked="mode === props.mode"
          :disabled="readonly"
          @change="select(mode)"
        />
        <span class="approval-copy">
          <span class="approval-name">{{ approvalModeCopy(mode).label }}</span>
          <span class="approval-description">{{ approvalModeCopy(mode).description }}</span>
        </span>
      </label>
    </div>

    <p v-if="selectedDanger" class="approval-danger" role="alert">
      <strong>{{ approvalModeCopy(props.mode).label }}:</strong> {{ selectedDanger }}
    </p>

    <p class="approval-note">
      Ask is the default and the mode used when a stored value is missing or unreadable. The saved
      mode is stored in <code>sessions/settings.json</code> next to the role settings; it is
      never set by a model or a tool call.
    </p>
  </div>
</template>

<style scoped>
.approval-section {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.approval-lead,
.approval-note {
  margin: 0;
  font-size: 0.8rem;
  line-height: 1.5;
  color: var(--text-secondary);
}

.approval-note {
  font-size: 0.75rem;
}

.approval-note--readonly {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: 8px 10px;
  color: var(--text-primary);
}

.approval-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 10px;
}

.approval-card {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  min-width: 0;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: 10px;
  cursor: pointer;
  background: var(--surface-panel);
}

.approval-card:hover {
  background: var(--surface-hover);
}

.approval-card.selected {
  border-color: var(--accent);
  background: var(--surface-highlight);
  box-shadow: inset 0 0 0 1px var(--accent);
}

.approval-card:focus-within {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.approval-card.disabled {
  cursor: default;
  opacity: 0.75;
}

.approval-input {
  position: absolute;
  inset: 0;
  z-index: 1;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}

.approval-card.disabled .approval-input {
  cursor: default;
}

.approval-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.approval-name {
  font-size: 0.82rem;
  font-weight: 600;
}

.approval-description {
  font-size: 0.72rem;
  line-height: 1.4;
  color: var(--text-secondary);
}

.approval-danger {
  margin: 0;
  border: 1px solid var(--danger);
  border-radius: var(--radius-md);
  padding: 9px 11px;
  font-size: 0.76rem;
  line-height: 1.45;
  color: var(--text-primary);
}

.approval-danger strong {
  color: var(--danger);
  font-weight: 600;
}

code {
  border: 1px solid var(--border-subtle);
  border-radius: 5px;
  padding: 0 4px;
  background: var(--surface-canvas);
  color: var(--text-primary);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 0.72rem;
  overflow-wrap: anywhere;
}
</style>
