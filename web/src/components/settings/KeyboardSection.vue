<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import type { ComponentPublicInstance } from 'vue'
import {
  KEYBINDING_ACTIONS,
  KEYBINDING_ACTION_INFO,
  bindingErrorCopy,
  bindingFromEvent,
  bindingKeyCaps,
  bindingLabel,
  defaultKeybindings,
  detectBindingPlatform,
  readKeybindings,
  resetBinding,
  saveKeybindings,
  withBinding,
} from '../../keybindings'
import type { KeybindingAction, Keybindings } from '../../keybindings'

/**
 * Settings → Keyboard: rebind the three modifier-based global chords.
 *
 * Each row shows the current chord, a native "Change" button that enters a
 * one-key capture mode, and a per-row reset; a global "Reset all to defaults"
 * lives below. The pure `keybindings.ts` module owns validation, conflict
 * detection, labels, matching and the persisted store — this component only
 * drives the capture flow and renders honest inline errors.
 *
 * Capture precedence: while a row is capturing, a window-capture keydown
 * handler claims every keystroke (stopPropagation), so the Settings dialog's
 * focus trap and the shell's global chords never see it — most importantly
 * Escape cancels the capture and must NOT close the dialog. The announcement
 * (role="status", aria-live="polite") and the inline error (role="alert") keep
 * the flow screen-reader honest.
 */

const props = defineProps<{
  /** Current bindings from the host; omitted = read the device store directly. */
  bindings?: Keybindings
}>()

const emit = defineEmits<{
  'keybindings-change': [Keybindings]
}>()

const platform = detectBindingPlatform()
/** Mirror used only while no `bindings` prop is bound (standalone mount). */
const fallback = ref<Keybindings>(readKeybindings())
const current = computed<Keybindings>(() => props.bindings ?? fallback.value)

const capturing = ref<KeybindingAction | null>(null)
const status = ref('')
const error = ref<string | null>(null)
const rowButtons = ref<Partial<Record<KeybindingAction, HTMLButtonElement | null>>>({})

const rows = KEYBINDING_ACTIONS.map((action) => KEYBINDING_ACTION_INFO[action])

function capsFor(action: KeybindingAction): string[] {
  return bindingKeyCaps(current.value[action], platform)
}

function labelFor(action: KeybindingAction): string {
  return bindingLabel(current.value[action], platform)
}

function setRowRef(action: KeybindingAction, el: Element | ComponentPublicInstance | null): void {
  if (el instanceof HTMLButtonElement) rowButtons.value[action] = el
}

function announce(message: string): void {
  status.value = message
}

/** Publish one already-validated set (persist outside, emit to the host). */
function publish(bindings: Keybindings, message: string): void {
  const saved = saveKeybindings(bindings)
  if (props.bindings === undefined) fallback.value = saved
  error.value = null
  emit('keybindings-change', saved)
  announce(message)
}

function startCapture(action: KeybindingAction): void {
  capturing.value = action
  error.value = null
  announce(
    `Press the new key combination for ${KEYBINDING_ACTION_INFO[action].label}. ` +
      'Press Escape to cancel.',
  )
}

function stopCapture(message: string): void {
  const action = capturing.value
  capturing.value = null
  error.value = null
  announce(message)
  if (action !== null) {
    void nextTick(() => rowButtons.value[action]?.focus())
  }
}

function cancelCapture(): void {
  if (capturing.value === null) return
  stopCapture('Shortcut change cancelled.')
}

/**
 * One keydown while capturing. Claims every keystroke (including Escape, which
 * cancels instead of closing the Settings dialog) and keeps waiting on
 * modifier-only presses / IME composition; the first complete chord is
 * validated and either persisted with a status announcement or rejected with
 * an inline error while capture stays active for another attempt.
 */
function onCaptureKeydown(event: KeyboardEvent): void {
  const action = capturing.value
  if (action === null) return
  event.preventDefault()
  event.stopPropagation()
  event.stopImmediatePropagation()
  if (event.key === 'Escape') {
    cancelCapture()
    return
  }
  if (event.isComposing || event.keyCode === 229 || event.repeat) return
  const candidate = bindingFromEvent(event)
  if (candidate === null) return // a bare modifier press: keep waiting
  const result = withBinding(current.value, action, candidate)
  if (!result.ok) {
    error.value = bindingErrorCopy(result.reason, result.conflict)
    announce(`The shortcut was not changed. ${error.value}`)
    return
  }
  const label = bindingLabel(result.bindings[action], platform)
  publish(result.bindings, `${KEYBINDING_ACTION_INFO[action].label} is now ${label}.`)
  stopCapture(`${KEYBINDING_ACTION_INFO[action].label} is now ${label}.`)
}

function resetRow(action: KeybindingAction): void {
  const result = resetBinding(current.value, action)
  if (!result.ok) {
    error.value = bindingErrorCopy(result.reason, result.conflict)
    announce(`The shortcut was not reset. ${error.value}`)
    return
  }
  capturing.value = null
  publish(result.bindings, `${KEYBINDING_ACTION_INFO[action].label} reset to its default.`)
}

function resetAll(): void {
  capturing.value = null
  publish(defaultKeybindings(), 'All rebindable shortcuts reset to their defaults.')
}

watch(
  capturing,
  (action) => {
    if (action !== null) window.addEventListener('keydown', onCaptureKeydown, true)
    else window.removeEventListener('keydown', onCaptureKeydown, true)
  },
  { immediate: true },
)

onUnmounted(() => {
  window.removeEventListener('keydown', onCaptureKeydown, true)
})
</script>

<template>
  <section class="keyboard-section" aria-label="Keyboard shortcuts">
    <section class="keyboard-card">
      <h3>Global shortcuts</h3>
      <p class="keyboard-copy">
        These three modifier chords can be rebound on this device and are stored in this browser,
        never on the server. Ctrl and ⌘ are treated as the same modifier; labels show this
        platform's key. All other shortcuts are fixed.
      </p>

      <ul class="keyboard-rows">
        <li
          v-for="row in rows"
          :key="row.action"
          class="keyboard-row"
          :class="{ 'is-capturing': capturing === row.action }"
          :data-action="row.action"
        >
          <div class="keyboard-row-heading">
            <span class="keyboard-row-label">{{ row.label }}</span>
            <span class="keyboard-row-desc">{{ row.description }}</span>
          </div>
          <span
            class="keyboard-keys"
            :aria-label="`Current shortcut: ${labelFor(row.action)}`"
          >
            <kbd v-for="cap in capsFor(row.action)" :key="cap" class="keyboard-key">{{ cap }}</kbd>
          </span>
          <div class="keyboard-row-actions">
            <button
              :ref="(el) => setRowRef(row.action, el)"
              type="button"
              class="keyboard-change"
              :class="{ 'is-capturing': capturing === row.action }"
              :aria-label="
                capturing === row.action
                  ? `Waiting for the new ${row.label} shortcut; press Escape to cancel`
                  : `Change the ${row.label} shortcut (currently ${labelFor(row.action)})`
              "
              @click="startCapture(row.action)"
            >
              {{ capturing === row.action ? 'Press keys…' : 'Change' }}
            </button>
            <button
              type="button"
              class="keyboard-reset"
              :aria-label="`Reset the ${row.label} shortcut to its default`"
              @click="resetRow(row.action)"
            >
              Reset
            </button>
          </div>
        </li>
      </ul>

      <p v-if="error" class="keyboard-error" role="alert">{{ error }}</p>
      <p class="keyboard-status" role="status" aria-live="polite">{{ status }}</p>

      <div class="keyboard-footer">
        <button type="button" class="keyboard-reset-all" @click="resetAll">
          Reset all to defaults
        </button>
        <p class="keyboard-fixed">
          Fixed: the composer's Enter / Shift+Enter / Ctrl/⌘+Enter, the picker keys, the Escape
          layering, and the plain <kbd>?</kbd> alias for this reference.
        </p>
      </div>
    </section>
  </section>
</template>

<style scoped>
.keyboard-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.keyboard-card {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: 12px 14px;
}

.keyboard-card h3 {
  margin: 0 0 6px;
  font-size: 0.85rem;
  font-weight: 600;
}

.keyboard-copy {
  margin: 0;
  font-size: 0.78rem;
  line-height: 1.55;
  color: var(--text-secondary);
}

.keyboard-rows {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
}

.keyboard-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  padding: 9px 10px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--surface-canvas);
}

.keyboard-row.is-capturing {
  border-color: var(--border-focus);
  background: var(--accent-soft);
}

.keyboard-row-heading {
  flex: 1 1 12rem;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.keyboard-row-label {
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--text-primary);
}

.keyboard-row-desc {
  font-size: 0.74rem;
  color: var(--text-secondary);
}

.keyboard-keys {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px;
}

.keyboard-key,
.keyboard-fixed kbd {
  padding: 0.05rem 0.35rem;
  font-family: var(--font-mono);
  font-size: 0.7rem;
  color: var(--text-primary);
  background: var(--surface-panel);
  border: 1px solid var(--border-strong);
  border-radius: 5px;
}

.keyboard-row-actions {
  display: inline-flex;
  gap: 6px;
}

.keyboard-change,
.keyboard-reset,
.keyboard-reset-all {
  font: inherit;
  font-size: 0.76rem;
  padding: 4px 10px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--surface-panel);
  color: var(--text-primary);
  cursor: pointer;
}

.keyboard-change:hover,
.keyboard-reset:hover,
.keyboard-reset-all:hover {
  background: var(--surface-hover);
}

.keyboard-change.is-capturing {
  border-color: var(--border-focus);
  background: var(--surface-panel);
  color: var(--accent-text);
}

.keyboard-change:focus-visible,
.keyboard-reset:focus-visible,
.keyboard-reset-all:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 1px;
}

.keyboard-error {
  margin: 10px 0 0;
  padding: 6px 9px;
  font-size: 0.76rem;
  border-radius: var(--radius-sm);
  color: var(--danger);
  background: var(--danger-soft);
}

.keyboard-status {
  margin: 8px 0 0;
  min-height: 1.1em;
  font-size: 0.74rem;
  color: var(--text-secondary);
}

.keyboard-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 14px;
  margin-top: 10px;
}

.keyboard-fixed {
  flex: 1 1 12rem;
  margin: 0;
  font-size: 0.72rem;
  color: var(--text-tertiary);
}
</style>
