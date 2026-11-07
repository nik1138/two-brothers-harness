<script setup lang="ts">
import { NCheckbox } from 'naive-ui'

/**
 * Advanced settings. The conversation preference here is device-local (a
 * persisted web pref, not a server setting): prompt audits are developer
 * annotations, so they are off by default and the transcript stays clean.
 */
const props = withDefaults(
  defineProps<{
    showPromptAudits?: boolean
  }>(),
  { showPromptAudits: false },
)

const emit = defineEmits<{
  'update:show-prompt-audits': [boolean]
}>()
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
      </ul>
      <p>
        The backend does not report which fields are currently pinned, so this panel cannot mark
        them individually. Unset the variable and restart the server to edit that field again.
      </p>
    </section>

    <section class="advanced-card">
      <h3>Stored settings</h3>
      <p>
        Role settings, provider presets, and the shared plugin selection are stored in
        <code>sessions/settings.json</code> under the server's sessions directory. API keys are
        encrypted at rest and are never sent back to this app; typing a new key replaces the stored
        one only when settings are saved.
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