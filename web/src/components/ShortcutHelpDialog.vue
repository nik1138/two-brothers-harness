<script setup lang="ts">
import { computed } from 'vue'
import { NButton } from 'naive-ui'
import { BASE_COMMAND_GROUP_LABEL, commandUsageLine } from '../basecommands'
import { SHORTCUT_GROUPS, shortcutGroupViews } from '../shortcuts'
import type { BaseCommand, CommandInfo } from '../types'
import AppDialog from './AppDialog.vue'

/**
 * `/help` (and `?` / Ctrl+⌘+/) reference overlay: the built-in slash commands
 * plus the keyboard shortcut table from the single-source `shortcuts.ts`.
 */

const props = defineProps<{
  baseCommands: BaseCommand[]
  commands: CommandInfo[]
  catalogState: 'idle' | 'loading' | 'ready' | 'error'
}>()

const emit = defineEmits<{
  close: []
}>()

const groups = computed(() => shortcutGroupViews())
const hasCommands = computed(
  () => props.baseCommands.length > 0 || props.commands.length > 0,
)
</script>

<template>
  <AppDialog
    :show="true"
    size="lg"
    title="Commands &amp; shortcuts"
    description="Built-in commands run locally in the workspace; discovered templates expand into a task."
    @close="emit('close')"
  >
    <section class="help-section" aria-labelledby="help-commands-heading">
      <h3 id="help-commands-heading" class="help-section-title">Slash commands</h3>

      <p v-if="catalogState === 'loading'" class="help-empty">Loading commands…</p>
      <p v-else-if="catalogState === 'error'" class="help-empty">
        The command list is unavailable right now — keyboard shortcuts are below.
      </p>
      <p v-else-if="!hasCommands" class="help-empty">No commands available.</p>

      <template v-else>
        <h4 v-if="baseCommands.length" class="help-group-title">{{ BASE_COMMAND_GROUP_LABEL }}</h4>
        <ul v-if="baseCommands.length" class="help-list">
          <li v-for="command in baseCommands" :key="command.name" class="help-row">
            <code class="help-usage">{{ commandUsageLine(command) }}</code>
            <span
              class="help-badge"
              :class="{ 'is-action': command.kind === 'action' }"
            >{{ command.kind }}</span>
            <span class="help-desc">{{ command.description }}</span>
            <span v-if="command.aliases.length" class="help-aliases">
              also: {{ command.aliases.join(', ') }}
            </span>
          </li>
        </ul>

        <h4 v-if="commands.length" class="help-group-title">Commands</h4>
        <ul v-if="commands.length" class="help-list">
          <li v-for="command in commands" :key="command.name" class="help-row">
            <code class="help-usage">
              /{{ command.name }}<template v-if="command.argumentHint"> {{ command.argumentHint }}</template>
            </code>
            <span class="help-desc">{{ command.description }}</span>
          </li>
        </ul>
      </template>
    </section>

    <section class="help-section" aria-labelledby="help-shortcuts-heading">
      <h3 id="help-shortcuts-heading" class="help-section-title">Keyboard shortcuts</h3>
      <div v-for="group in groups" :key="group.group" class="help-shortcut-group">
        <h4 class="help-group-title">{{ group.group }}</h4>
        <ul class="help-list">
          <li v-for="entry in group.entries" :key="entry.id" class="help-row help-shortcut-row">
            <span class="help-keys">
              <kbd v-for="key in entry.keys" :key="key" class="help-key">{{ key }}</kbd>
            </span>
            <span class="help-shortcut-label">
              {{ entry.label }}
              <span v-if="entry.description" class="help-shortcut-desc">{{ entry.description }}</span>
            </span>
          </li>
        </ul>
      </div>
      <p class="help-hint">Open this reference anytime with ? or Ctrl/⌘+/. No shortcuts are rebound from this dialog.</p>
      <p class="visually-hidden">{{ SHORTCUT_GROUPS.length }} shortcut groups listed.</p>
    </section>

    <template #footer>
      <n-button attr-type="button" type="primary" @click="emit('close')">Close</n-button>
    </template>
  </AppDialog>
</template>

<style scoped>
.help-section + .help-section {
  margin-top: 1.1rem;
  padding-top: 0.9rem;
  border-top: 1px solid var(--border-subtle);
}

.help-section-title {
  margin: 0 0 0.5rem;
  font-size: 0.95rem;
  font-weight: 650;
  color: var(--text-primary);
}

.help-group-title {
  margin: 0.6rem 0 0.25rem;
  font-size: 0.7rem;
  font-weight: 650;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--text-secondary);
}

.help-list {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.help-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.15rem 0.5rem;
  padding: 0.3rem 0.45rem;
  border-radius: var(--radius-sm);
  line-height: 1.4;
}

.help-row:nth-child(odd) {
  background: var(--surface-canvas);
}

.help-usage {
  flex: none;
  min-width: 9.5rem;
  font-family: var(--font-mono);
  font-size: 0.78rem;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.help-badge {
  flex: none;
  padding: 0.02rem 0.35rem;
  font-size: 0.62rem;
  font-weight: 650;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-secondary);
  background: var(--surface-hover);
  border-radius: 999px;
}

.help-badge.is-action {
  color: var(--accent-text);
  background: var(--accent-soft);
}

.help-desc {
  flex: 1 1 12rem;
  min-width: 0;
  font-size: 0.8rem;
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}

.help-aliases {
  flex-basis: 100%;
  font-size: 0.72rem;
  color: var(--text-tertiary);
}

.help-keys {
  display: inline-flex;
  flex: none;
  flex-wrap: wrap;
  gap: 0.25rem;
  min-width: 8rem;
}

.help-key {
  padding: 0.05rem 0.35rem;
  font-family: var(--font-mono);
  font-size: 0.7rem;
  color: var(--text-primary);
  background: var(--surface-panel);
  border: 1px solid var(--border-strong);
  border-radius: 5px;
}

.help-shortcut-label {
  flex: 1 1 12rem;
  min-width: 0;
  font-size: 0.82rem;
}

.help-shortcut-desc {
  display: block;
  font-size: 0.74rem;
  color: var(--text-secondary);
}

.help-empty {
  margin: 0;
  padding: 0.45rem 0.4rem;
  font-size: 0.82rem;
  color: var(--text-secondary);
}

.help-hint {
  margin: 0.7rem 0 0;
  font-size: 0.74rem;
  color: var(--text-tertiary);
}

@media (max-width: 620px) {
  .help-usage {
    min-width: 0;
  }
}
</style>
