<script setup lang="ts">
import AppIcon from './AppIcon.vue'

defineProps<{
  /** Current theme description for the theme control's accessible name. */
  themeLabel?: string
}>()

const emit = defineEmits<{
  openSettings: []
  toggleTheme: []
}>()
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
    <button
      type="button"
      class="footer-action"
      :title="themeLabel ?? 'Switch theme'"
      :aria-label="themeLabel ?? 'Switch theme'"
      @click="emit('toggleTheme')"
    >
      <AppIcon name="monitor" class="icon" />
      <span aria-hidden="true">Theme</span>
    </button>
  </footer>
</template>

<style scoped>
.icon {
  width: 16px;
  height: 16px;
  display: block;
  flex: none;
}

/* Pinned to the bottom of the sidebar column; the session list scrolls above it. */
.sidebar-footer {
  flex: none;
  display: flex;
  align-items: stretch;
  gap: 0.25rem;
  min-height: 48px;
  padding: 0.35rem var(--sidebar-inline, 0.55rem);
  background: var(--surface-panel);
  border-top: 1px solid var(--border-subtle);
}

.footer-action {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
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

.footer-action:focus-visible {
  outline-offset: -2px;
}

@media (hover: none) {
  .footer-action {
    height: 38px;
  }
}
</style>