<script setup lang="ts">
/**
 * Welcome / empty hero.
 *
 * Two placements, one presentational component:
 * - `start`: no session is selected (the shell's landing state);
 * - `empty`: a selected session has no transcript yet.
 *
 * The shell owns sessions/workspaces/dialogs and receives the starter + action
 * events; nothing here invents workspace, model or session state. Starter text
 * is only *drafted* into the composer (editable, never auto-sent).
 *
 * Provenance: the welcome-panel shape is adapted from kimi-code's MIT empty
 * welcome chrome (research/vendor/kimi-code); this implementation is original
 * to Two Brothers.
 */
import { computed } from 'vue'

/** One editable task suggestion; the label stays short, the text does the work. */
export interface HeroStarter {
  id: string
  label: string
  description: string
  /** Text put into the composer; the operator edits and sends it. */
  text: string
}

const props = defineProps<{
  variant: 'start' | 'empty'
  /** Workspace context: the sidebar filter first, else the session's link. */
  workspaceName?: string | null
  /** Registered workspace count, used for the "All workspaces (N)" chip. */
  workspaceCount?: number
  /** Selected session title, shown as a quiet meta line in the empty variant. */
  sessionTitle?: string | null
  /** Role routes are usable; false shows the "Set up models" action. */
  modelsReady?: boolean
  starters?: readonly HeroStarter[]
}>()

const emit = defineEmits<{
  /** Prefill the composer with this text (the shell focuses the task box). */
  starter: [text: string]
  newSession: []
  addWorkspace: []
  openHelp: []
  openSettings: []
}>()

const heading = computed(() =>
  props.variant === 'empty' ? 'This session is empty' : 'Two Brothers workspace',
)

const copy = computed(() =>
  props.variant === 'empty'
    ? 'Send the first task below — the Senior and the Junior will take it from there.'
    : 'A group chat between you, the Senior and the Junior. Pick a session on the left, or send a task below to begin.',
)

const contextLabel = computed(() => {
  if (props.workspaceName) return `Workspace: ${props.workspaceName}`
  const count = props.workspaceCount ?? 0
  return count > 0 ? `All workspaces (${count})` : 'No workspace linked yet'
})
</script>

<template>
  <!-- aria-live="off": the hero replaces a quiet placeholder inside the chat
       log region; its static copy must not be read as a new conversation row. -->
  <section class="welcome-hero" aria-labelledby="welcome-hero-title" aria-live="off">
    <p class="welcome-hero-eyebrow">Local group chat · Senior + Junior</p>
    <h2 id="welcome-hero-title" class="welcome-hero-title">{{ heading }}</h2>
    <p class="welcome-hero-copy">{{ copy }}</p>

    <p class="welcome-hero-context">
      <span class="welcome-hero-chip">{{ contextLabel }}</span>
      <span v-if="variant === 'empty' && sessionTitle" class="welcome-hero-meta">
        {{ sessionTitle }}
      </span>
    </p>

    <div class="welcome-hero-actions">
      <button
        type="button"
        class="welcome-hero-button is-primary"
        @click="emit('newSession')"
      >
        New session
      </button>
      <button
        type="button"
        class="welcome-hero-button"
        @click="emit('addWorkspace')"
      >
        Add a workspace
      </button>
      <button
        v-if="!modelsReady"
        type="button"
        class="welcome-hero-button is-warn"
        @click="emit('openSettings')"
      >
        Set up models
      </button>
      <button
        type="button"
        class="welcome-hero-link"
        @click="emit('openHelp')"
      >
        Keyboard shortcuts
      </button>
    </div>

    <div v-if="starters && starters.length" class="welcome-hero-starters">
      <p class="welcome-hero-starters-label">Try a starter</p>
      <div class="welcome-hero-starter-list">
        <button
          v-for="starter in starters"
          :key="starter.id"
          type="button"
          class="welcome-hero-starter"
          :aria-label="`${starter.label}: put this task in the composer`"
          @click="emit('starter', starter.text)"
        >
          <span class="starter-label">{{ starter.label }}</span>
          <span class="starter-description">{{ starter.description }}</span>
        </button>
      </div>
    </div>

    <p class="welcome-hero-hint">
      Send with Enter · Shift+Enter for a new line · Ctrl+K searches
    </p>
  </section>
</template>

<style scoped>
.welcome-hero {
  /* auto margins center the panel in the flex chat column, and it still scrolls
     inside it on short viewports */
  margin: auto;
  width: 100%;
  max-width: 34rem;
  padding: 1.4rem 1.5rem;
  text-align: center;
  background: var(--surface-panel);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-raised);
}

.welcome-hero-eyebrow {
  margin: 0 0 0.45rem;
  font-size: 0.7rem;
  font-weight: 650;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-secondary);
}

.welcome-hero-title {
  margin: 0 0 0.45rem;
  font-size: 1.3rem;
  line-height: 1.25;
  color: var(--text-primary);
}

.welcome-hero-copy {
  margin: 0 0 0.8rem;
  font-size: 0.86rem;
  line-height: 1.55;
  color: var(--text-secondary);
}

.welcome-hero-context {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 0.4rem 0.6rem;
  margin: 0 0 0.9rem;
  min-width: 0;
}

.welcome-hero-chip {
  max-width: 100%;
  overflow: hidden;
  padding: 0.14rem 0.55rem;
  font-size: 0.74rem;
  color: var(--text-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
  border: 1px solid var(--border-strong);
  border-radius: 999px;
}

.welcome-hero-meta {
  min-width: 0;
  overflow: hidden;
  font-size: 0.74rem;
  color: var(--text-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.welcome-hero-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 0.45rem;
}

.welcome-hero-button {
  flex: none;
  height: 1.9rem;
  padding: 0 0.7rem;
  font: inherit;
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--text-primary);
  background: var(--surface-canvas, var(--surface-panel));
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.welcome-hero-button:hover {
  background: var(--surface-hover);
}

.welcome-hero-button.is-primary {
  color: var(--text-on-accent);
  background: var(--accent);
  border-color: var(--accent);
}

.welcome-hero-button.is-primary:hover {
  background: var(--accent-hover);
}

.welcome-hero-button.is-warn {
  color: var(--warning);
  background: var(--warning-soft);
  border-color: var(--warning);
}

.welcome-hero-link {
  flex: none;
  padding: 0.2rem 0.3rem;
  font: inherit;
  font-size: 0.75rem;
  color: var(--text-secondary);
  text-decoration: underline;
  background: transparent;
  border: none;
  cursor: pointer;
}

.welcome-hero-link:hover {
  color: var(--text-primary);
}

.welcome-hero-button:focus-visible,
.welcome-hero-link:focus-visible,
.welcome-hero-starter:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 1px;
}

.welcome-hero-starters {
  margin-top: 1.1rem;
  text-align: left;
}

.welcome-hero-starters-label {
  margin: 0 0 0.4rem;
  font-size: 0.7rem;
  font-weight: 650;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--text-secondary);
}

.welcome-hero-starter-list {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.welcome-hero-starter {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  width: 100%;
  padding: 0.4rem 0.6rem;
  font: inherit;
  text-align: left;
  color: var(--text-primary);
  background: transparent;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.welcome-hero-starter:hover {
  background: var(--surface-hover);
  border-color: var(--border-strong);
}

.starter-label {
  font-size: 0.8rem;
  font-weight: 600;
}

.starter-description {
  min-width: 0;
  font-size: 0.73rem;
  color: var(--text-secondary);
}

.welcome-hero-hint {
  margin: 0.9rem 0 0;
  font-size: 0.7rem;
  color: var(--text-secondary);
}

@media (max-width: 640px) {
  .welcome-hero {
    padding: 1.1rem 1rem;
    border-radius: var(--radius-md);
  }

  .welcome-hero-title {
    font-size: 1.15rem;
  }
}
</style>
