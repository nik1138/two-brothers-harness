<script setup lang="ts">
import { computed, ref } from 'vue'

import {
  PERMISSION_PRESETS,
  PERMISSION_PRESET_COPY,
  approvalPolicyDisabledReason,
  permissionPresetDanger,
  permissionPresetId,
  permissionPresetOf,
} from '../../approvalPolicy'
import type { PermissionPreset } from '../../approvalPolicy'
import type { ApprovalMode } from '../../types'

/**
 * Settings → Permissions: the named permission preset for workspace-bound
 * runs. The presets mirror deepseek-harness's one-selector idea while the
 * persisted value stays our `approval_policy.mode`; each card names the exact
 * mode it applies, so the UI never hides the enforcement contract.
 *
 * The cards are plain radio inputs (like Appearance) so keyboard and screen
 * reader behavior comes from the platform; `danger-full-access` renders its
 * destructive warning inline.
 *
 * The preset is a server-side setting saved with the rest of the settings
 * form. An older backend omits the `approval_policy` field (unsupported) and a
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
const selectedPreset = computed(() => permissionPresetId(props.mode))
const selectedCopy = computed(() => permissionPresetOf(props.mode))
const selectedDanger = computed(() =>
  selectedPreset.value === 'custom' ? null : permissionPresetDanger(selectedPreset.value),
)

// Full access is the deepseek-style risk-gated choice: the card alone does not
// switch the mode. An explicit confirmation with an acknowledgement checkbox
// is required before the setting is emitted (the dialog still saves it only
// with the rest of the form).
const pendingFullAccess = ref(false)
const acknowledged = ref(false)

function select(preset: PermissionPreset) {
  if (readonly.value) return
  if (preset !== 'danger-full-access') {
    pendingFullAccess.value = false
    acknowledged.value = false
    emit('update:mode', PERMISSION_PRESET_COPY[preset].mode)
    return
  }
  if (selectedPreset.value === 'danger-full-access') return
  pendingFullAccess.value = true
  acknowledged.value = false
}

function cancelFullAccess() {
  pendingFullAccess.value = false
  acknowledged.value = false
}

function confirmFullAccess() {
  if (!acknowledged.value) return
  pendingFullAccess.value = false
  emit('update:mode', 'allow-all')
}
</script>

<template>
  <div class="permission-section">
    <p class="permission-lead">
      How much a model may do in a workspace without asking you. A preset is a named bundle for the
      same persisted approval mode every older surface already uses; it applies to every new
      workspace-bound run. It never overrides workspace confinement, and workspace paths that are
      refused for safety (sensitive files, paths outside the workspace) are refused in every
      preset.
    </p>

    <p v-if="disabledReason" class="permission-note permission-note--readonly" role="status">
      {{ disabledReason }}
    </p>

    <div
      class="permission-grid"
      role="radiogroup"
      aria-label="Permission preset"
      :aria-disabled="readonly"
    >
      <label
        v-for="preset in PERMISSION_PRESETS"
        :key="preset"
        class="permission-card"
        :class="{
          selected: preset === selectedPreset,
          danger: preset === 'danger-full-access',
          disabled: readonly,
        }"
      >
        <input
          class="permission-input"
          type="radio"
          name="permission-preset"
          :value="preset"
          :checked="preset === selectedPreset"
          :disabled="readonly"
          @change="select(preset)"
        />
        <span class="permission-copy">
          <span class="permission-name">{{ PERMISSION_PRESET_COPY[preset].label }}</span>
          <span class="permission-description">
            {{ PERMISSION_PRESET_COPY[preset].description }}
          </span>
          <span class="permission-mode">stores mode: {{ PERMISSION_PRESET_COPY[preset].mode }}</span>
        </span>
      </label>
    </div>

    <section
      v-if="pendingFullAccess"
      class="permission-confirm"
      role="alertdialog"
      aria-labelledby="permission-confirm-title"
      aria-describedby="permission-confirm-description"
    >
      <h4 id="permission-confirm-title">Enable Full access?</h4>
      <p id="permission-confirm-description">
        Full access reduces confirmation steps and lets the brothers perform more actions directly,
        including sensitive operations, file changes and external commands. Only use it when you
        trust the workspaces and tasks this setting will cover.
      </p>
      <label class="permission-ack">
        <input v-model="acknowledged" type="checkbox" />
        <span>I understand the risks and want to continue</span>
      </label>
      <div class="permission-confirm-actions">
        <button type="button" class="permission-btn" @click="cancelFullAccess">Cancel</button>
        <button
          type="button"
          class="permission-btn permission-btn--danger"
          :disabled="!acknowledged"
          @click="confirmFullAccess"
        >
          Enable Full access
        </button>
      </div>
    </section>

    <p v-if="selectedDanger" class="permission-danger" role="alert">
      <strong>{{ selectedCopy.label }}:</strong> {{ selectedDanger }}
    </p>

    <p class="permission-note">
      Always ask is the default and the preset used when a stored value is missing or unreadable.
      The saved mode is stored in <code>sessions/settings.json</code> next to the role settings; it
      is never set by a model or a tool call. The legacy mode names remain accepted by
      <code>/permission</code> in the TUI and by the API.
    </p>
  </div>
</template>

<style scoped>
.permission-section {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.permission-lead,
.permission-note {
  margin: 0;
  font-size: 0.8rem;
  line-height: 1.5;
  color: var(--text-secondary);
}

.permission-note {
  font-size: 0.75rem;
}

.permission-note--readonly {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: 8px 10px;
  color: var(--text-primary);
}

.permission-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 10px;
}

.permission-card {
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

.permission-card:hover {
  background: var(--surface-hover);
}

.permission-card.selected {
  border-color: var(--accent);
  background: var(--surface-highlight);
  box-shadow: inset 0 0 0 1px var(--accent);
}

.permission-card.danger.selected {
  border-color: var(--danger);
  box-shadow: inset 0 0 0 1px var(--danger);
}

.permission-card:focus-within {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.permission-card.disabled {
  cursor: default;
  opacity: 0.75;
}

.permission-input {
  position: absolute;
  inset: 0;
  z-index: 1;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}

.permission-card.disabled .permission-input {
  cursor: default;
}

.permission-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.permission-name {
  font-size: 0.82rem;
  font-weight: 600;
}

.permission-description {
  font-size: 0.72rem;
  line-height: 1.4;
  color: var(--text-secondary);
}

.permission-mode {
  font-size: 0.68rem;
  line-height: 1.4;
  color: var(--text-muted, var(--text-secondary));
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}

.permission-confirm {
  display: flex;
  flex-direction: column;
  gap: 9px;
  border: 1px solid var(--danger);
  border-radius: var(--radius-md);
  padding: 11px;
  background: var(--surface-panel);
}

.permission-confirm h4 {
  margin: 0;
  font-size: 0.86rem;
  font-weight: 650;
  color: var(--danger);
}

.permission-confirm p {
  margin: 0;
  font-size: 0.76rem;
  line-height: 1.45;
  color: var(--text-secondary);
}

.permission-ack {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  font-size: 0.76rem;
  line-height: 1.4;
  color: var(--text-primary);
  cursor: pointer;
}

.permission-ack input {
  margin: 2px 0 0;
  accent-color: var(--danger);
}

.permission-confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.permission-btn {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: 5px 10px;
  background: var(--surface-panel);
  color: var(--text-primary);
  font: inherit;
  font-size: 0.76rem;
  cursor: pointer;
}

.permission-btn:hover {
  background: var(--surface-hover);
}

.permission-btn--danger {
  border-color: var(--danger);
  color: var(--danger);
  font-weight: 600;
}

.permission-btn:disabled {
  cursor: default;
  opacity: 0.55;
}

.permission-danger {
  margin: 0;
  border: 1px solid var(--danger);
  border-radius: var(--radius-md);
  padding: 9px 11px;
  font-size: 0.76rem;
  line-height: 1.45;
  color: var(--text-primary);
}

.permission-danger strong {
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
