<script setup lang="ts">
import { computed } from 'vue'
import { NCheckbox } from 'naive-ui'

import {
  COMPACTION_FIELDS,
  COMPACTION_UNSUPPORTED_REASON,
  COMPACTION_ZERO_HELP,
  compactionInputsDirty,
  effectiveCompactionText,
} from '../../compactionSettings'
import type {
  CompactionFieldKey,
  CompactionInputs,
  CompactionState,
} from '../../compactionSettings'

/**
 * Advanced settings. The conversation preference here is device-local (a
 * persisted web pref, not a server setting): prompt audits are developer
 * annotations, so they are off by default and the transcript stays clean.
 *
 * The Auto-compaction card edits the server's persisted run-level context
 * budgets (the `compaction` section of `sessions/settings.json`). The inputs
 * are plain labelled number fields; each shows the value a run would actually
 * use and where it comes from, so a serve CLI flag/env pin is never hidden.
 * Saving rides the dialog's one Save action with the other server settings;
 * invalid values are inline `role="alert"` errors and block the save.
 */
const props = withDefaults(
  defineProps<{
    showPromptAudits?: boolean
    /** Server compaction state; null while the settings request is in flight. */
    compaction?: CompactionState | null
    /** Editable input text, one per budget; null while loading. */
    compactionInputs?: CompactionInputs | null
    /** Inline validation errors, one per budget. */
    compactionErrors?: Partial<Record<CompactionFieldKey, string>>
  }>(),
  {
    showPromptAudits: false,
    compaction: null,
    compactionInputs: null,
    compactionErrors: () => ({}),
  },
)

const emit = defineEmits<{
  'update:show-prompt-audits': [boolean]
  'update:compaction-input': [CompactionFieldKey, string]
}>()

const dirty = computed(
  () =>
    props.compaction !== null &&
    props.compactionInputs !== null &&
    props.compaction.supported &&
    compactionInputsDirty(props.compactionInputs, props.compaction),
)

function inputValue(key: CompactionFieldKey): string {
  if (props.compactionInputs !== null) return props.compactionInputs[key] ?? ''
  return props.compaction !== null ? String(props.compaction.values[key]) : '0'
}

function onInput(key: CompactionFieldKey, event: Event) {
  const target = event.target as HTMLInputElement | null
  emit('update:compaction-input', key, target?.value ?? '')
}
</script>

<template>
  <div class="advanced-section">
    <section class="advanced-card">
      <h3>Conversation</h3>
      <n-checkbox
        :checked="props.showPromptAudits"
        @update:checked="emit('update:show-prompt-audits', $event)"
      >
        Show prompt audits in the conversation
      </n-checkbox>
      <p class="advanced-helper">
        Adds one annotation per model call to the transcript; off by default.
      </p>
    </section>

    <section class="advanced-card" aria-labelledby="advanced-compaction-heading">
      <h3 id="advanced-compaction-heading">Auto-compaction</h3>
      <p class="advanced-helper">
        Context budgets for server runs, stored in <code>sessions/settings.json</code> under the
        sessions directory. They shape proactive compaction of long conversations; leaving every
        budget at 0 keeps compaction off.
      </p>
      <p v-if="props.compaction === null" class="compaction-note" role="status">
        Loading saved context budgets…
      </p>
      <p
        v-else-if="!props.compaction.supported"
        class="compaction-note"
        role="status"
      >
        {{ COMPACTION_UNSUPPORTED_REASON }}
      </p>
      <template v-else>
        <div class="compaction-grid">
          <div v-for="field in COMPACTION_FIELDS" :key="field.key" class="compaction-field">
            <label :for="`compaction-${field.key}`">{{ field.label }}</label>
            <input
              :id="`compaction-${field.key}`"
              type="number"
              min="0"
              step="1"
              inputmode="numeric"
              :value="inputValue(field.key)"
              :aria-invalid="props.compactionErrors[field.key] ? 'true' : undefined"
              :aria-describedby="`compaction-${field.key}-effective`"
              @input="onInput(field.key, $event)"
            />
            <p
              :id="`compaction-${field.key}-effective`"
              class="compaction-effective"
              :class="{ pinned: props.compaction.fields[field.key].source === 'flag' }"
            >
              {{ effectiveCompactionText(props.compaction.fields[field.key]) }}
            </p>
            <p class="compaction-help">{{ field.help }}</p>
            <p
              v-if="props.compactionErrors[field.key]"
              class="compaction-error"
              role="alert"
            >
              {{ props.compactionErrors[field.key] }}
            </p>
          </div>
        </div>
        <p class="advanced-helper">{{ COMPACTION_ZERO_HELP }}</p>
        <p v-if="dirty" class="compaction-dirty" role="status">
          Unsaved auto-compaction changes — Save applies them.
        </p>
        <p v-if="props.compaction.force" class="advanced-helper">
          The server runs with <code>--compact</code>: every run compacts once before it starts.
        </p>
      </template>
    </section>

    <section class="advanced-card">
      <h3>Development transport</h3>
      <p>
        Runs normally use the providers saved on the Models &amp; roles and Providers sections.
        The backend also accepts a <code>mock</code> provider override for offline and hermetic
        tests. It is chosen per run in the composer's development path, is never stored as a
        setting, and is deliberately not offered here as a normal configuration choice.
      </p>
    </section>

    <section class="advanced-card">
      <h3>Environment pins</h3>
      <p>
        A <code>TWO_BROTHERS_*</code> environment variable <strong>pins</strong> its field: the
        environment value wins, and a value saved here for a pinned field is ignored. Pinned values
        are never written to disk. Recognized settings variables include:
      </p>
      <ul class="advanced-env-list">
        <li><code>TWO_BROTHERS_PROVIDER</code></li>
        <li><code>TWO_BROTHERS_BASE_URL</code>, <code>TWO_BROTHERS_API_KEY</code></li>
        <li><code>TWO_BROTHERS_SENIOR_MODEL</code>, <code>TWO_BROTHERS_JUNIOR_MODEL</code></li>
        <li>
          <code>TWO_BROTHERS_SENIOR_BASE_URL</code>, <code>TWO_BROTHERS_SENIOR_API_KEY</code>,
          <code>TWO_BROTHERS_JUNIOR_BASE_URL</code>, <code>TWO_BROTHERS_JUNIOR_API_KEY</code>
        </li>
        <li>
          <code>TWO_BROTHERS_COMPACT_THRESHOLD</code>,
          <code>TWO_BROTHERS_COMPACT_THRESHOLD_TOKENS</code>,
          <code>TWO_BROTHERS_COMPACT_KEEP_RECENT</code>,
          <code>TWO_BROTHERS_CONTEXT_WINDOW</code>
        </li>
      </ul>
      <p>
        The backend reports the effective auto-compaction values above; other pinned fields are
        not marked individually. Unset the variable and restart the server to edit that field
        again.
      </p>
    </section>

    <section class="advanced-card">
      <h3>Stored settings</h3>
      <p>
        Role settings, provider presets, the shared plugin selection, the approval mode and the
        context budgets are stored in <code>sessions/settings.json</code> under the server's
        sessions directory. API keys are encrypted at rest and are never sent back to this app;
        typing a new key replaces the stored one only when settings are saved.
      </p>
    </section>
  </div>
</template>

<style scoped>
.advanced-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.advanced-card {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: 12px 14px;
}

.advanced-card h3 {
  margin: 0 0 6px;
  font-size: 0.85rem;
  font-weight: 600;
}

.advanced-card p {
  margin: 0;
  font-size: 0.78rem;
  line-height: 1.55;
  color: var(--text-secondary);
}

/* Helper copy directly under the conversation toggle. */
.advanced-card .advanced-helper {
  margin-top: 6px;
}

.advanced-card p + p {
  margin-top: 8px;
}

.advanced-card strong {
  color: var(--text-primary);
  font-weight: 600;
}

/* Auto-compaction: one labelled number field per budget. */
.compaction-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px;
  margin-top: 10px;
}

.compaction-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.compaction-field label {
  font-size: 0.76rem;
  font-weight: 600;
  color: var(--text-primary);
}

.compaction-field input {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  padding: 5px 8px;
  background: var(--surface-canvas);
  color: var(--text-primary);
  font: inherit;
  font-size: 0.78rem;
}

.compaction-field input:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.compaction-field input[aria-invalid='true'] {
  border-color: var(--danger);
}

.compaction-effective,
.compaction-help {
  font-size: 0.7rem;
  line-height: 1.4;
  color: var(--text-secondary);
}

.compaction-effective.pinned {
  color: var(--text-primary);
  font-weight: 600;
}

.compaction-error {
  font-size: 0.72rem;
  line-height: 1.4;
  color: var(--danger);
}

.compaction-note {
  margin-top: 8px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: 8px 10px;
  color: var(--text-primary);
}

.compaction-dirty {
  margin-top: 8px;
  font-size: 0.72rem;
  color: var(--text-primary);
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

.advanced-env-list {
  margin: 8px 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: var(--text-secondary);
  font-size: 0.76rem;
}

.advanced-env-list li {
  line-height: 1.5;
}
</style>
