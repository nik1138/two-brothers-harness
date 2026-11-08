<script setup lang="ts">
import AppIcon from './AppIcon.vue'
import type { ThemeMode } from '../themeMode'

const props = defineProps<{
  /** Selected theme preference; the footer marks exactly this option active. */
  themeMode: ThemeMode
}>()

const emit = defineEmits<{
  openSettings: []
  themeChange: [mode: ThemeMode]
}>()

interface ThemeOption {
  value: ThemeMode
  label: string
  icon: 'sun' | 'moon' | 'monitor'
  /** Accessible name; it contains the visible label (WCAG label-in-name). */
  name: string
}

const themeOptions: readonly ThemeOption[] = [
  { value: 'light', label: 'Light', icon: 'sun', name: 'Use light theme' },
  { value: 'dark', label: 'Dark', icon: 'moon', name: 'Use dark theme' },
  { value: 'system', label: 'System', icon: 'monitor', name: 'Use system theme' },
]

/** Clicking the already-selected option is a no-op (it does not re-emit). */
function select(mode: ThemeMode) {
  if (mode === props.themeMode) return
  emit('themeChange', mode)
}
</script>

<template>
  <footer class="sidebar-footer">
    <button
      type="button"
      class="footer-action"
      title="Settings"
      @click="emit('openSettings')"
    >
      <AppIcon name="settings" class="icon" />
      <span>Settings</span>
    </button>

    <div class="theme-switch" role="radiogroup" aria-label="Theme">
      <button
        v-for="option in themeOptions"
        :key="option.value"
        type="button"
        role="radio"
        class="theme-option"
        :class="{ active: themeMode === option.value }"
        :aria-checked="themeMode === option.value"
        :aria-label="option.name"
        :title="option.name"
        @click="select(option.value)"
      >
        <AppIcon :name="option.icon" class="icon" />
        <span class="theme-option-label">{{ option.label }}</span>
      </button>
    </div>
  </footer>
</template>

<style scoped>
.icon {
  width: 16px;
  height: 16px;
  display: block;
  flex: none;
}

/* Pinned to the bottom of the sidebar column: Settings row, then the
   always-visible three-way theme selector. */
.sidebar-footer {
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 0.3rem;
  min-width: 0;
  padding: 0.35rem var(--sidebar-inline, 0.55rem) 0.4rem;
  background: var(--surface-panel);
  border-top: 1px solid var(--border-subtle);
}

.footer-action {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  width: 100%;
  min-width: 0;
  height: 34px;
  padding: 0 0.4rem;
  font: inherit;
  font-size: 0.78rem;
  font-weight: 500;
  color: var(--text-secondary);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 7px;
  cursor: pointer;
}

.footer-action:hover {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.footer-action:focus-visible,
.theme-option:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: -2px;
}

/* Segmented control: one segment per preference. The active segment keeps the
   accent border + highlight background even when 'system' resolves to the
   appearance that is already on screen. */
.theme-switch {
  display: flex;
  align-items: stretch;
  gap: 2px;
  width: 100%;
  min-width: 0;
  padding: 2px;
  background: var(--surface-canvas);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
}

.theme-option {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  height: 28px;
  padding: 0 0.3rem;
  font: inherit;
  font-size: 0.72rem;
  font-weight: 550;
  line-height: 1;
  color: var(--text-secondary);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
}

.theme-option .icon {
  width: 14px;
  height: 14px;
}

.theme-option:hover {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.theme-option.active {
  color: var(--text-primary);
  background: var(--surface-highlight);
  border-color: var(--accent);
  box-shadow: inset 0 0 0 1px var(--accent);
}

.theme-option-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

@media (hover: none) {
  .footer-action {
    height: 38px;
  }

  .theme-option {
    height: 32px;
  }
}
</style>
