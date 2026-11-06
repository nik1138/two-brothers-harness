<script setup lang="ts">
import type { Density } from '../../density'
import type { ThemeMode } from '../../themeMode'

defineProps<{ mode: ThemeMode; density: Density }>()

const emit = defineEmits<{
  change: [ThemeMode]
  densityChange: [Density]
}>()

const options: { value: ThemeMode; label: string; description: string }[] = [
  { value: 'light', label: 'Light', description: 'Bright surfaces for daylight.' },
  { value: 'dark', label: 'Dark', description: 'Dim surfaces for low light.' },
  {
    value: 'system',
    label: 'System',
    description: "Follow this device's appearance.",
  },
]

const densityOptions: { value: Density; label: string; description: string }[] = [
  {
    value: 'comfortable',
    label: 'Comfortable',
    description: 'Default spacing, easier on the eyes.',
  },
  { value: 'compact', label: 'Compact', description: 'Tighter rows, more visible at once.' },
]

function select(mode: ThemeMode) {
  emit('change', mode)
}

function selectDensity(density: Density) {
  emit('densityChange', density)
}
</script>

<template>
  <div class="appearance-section">
    <p class="settings-lead">
      Choose how the workspace looks on this device. Theme changes apply immediately and are
      remembered for the next visit.
    </p>

    <div class="theme-grid" role="radiogroup" aria-label="Theme">
      <label
        v-for="option in options"
        :key="option.value"
        class="theme-option"
        :class="{ selected: mode === option.value }"
      >
        <input
          class="theme-input"
          type="radio"
          name="theme-mode"
          :value="option.value"
          :checked="mode === option.value"
          @change="select(option.value)"
        />
        <span class="theme-preview" :class="`theme-preview--${option.value}`" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor">
            <template v-if="option.value === 'light'">
              <circle cx="8" cy="8" r="2.6" />
              <path d="M8 1.5v1.4M8 13.1v1.4M1.5 8h1.4M13.1 8h1.4M3.4 3.4l1 1M11.6 11.6l1 1M12.6 3.4l-1 1M4.4 11.6l-1 1" />
            </template>
            <path v-else-if="option.value === 'dark'" d="M12.9 10.3A5.7 5.7 0 0 1 5.7 3.1a5.7 5.7 0 1 0 7.2 7.2Z" />
            <template v-else>
              <circle cx="8" cy="8" r="5.5" />
              <path d="M8 2.5a5.5 5.5 0 0 0 0 11Z" fill="currentColor" stroke="none" />
            </template>
          </svg>
        </span>
        <span class="theme-copy">
          <span class="theme-name">{{ option.label }}</span>
          <span class="theme-description">{{ option.description }}</span>
        </span>
      </label>
    </div>

    <p class="settings-note">
      System follows the operating system's light or dark preference and updates when it changes.
    </p>

    <h4 class="settings-subhead">Density</h4>
    <div class="theme-grid" role="radiogroup" aria-label="Density">
      <label
        v-for="option in densityOptions"
        :key="option.value"
        class="theme-option"
        :class="{ selected: density === option.value }"
      >
        <input
          class="theme-input"
          type="radio"
          name="density-mode"
          :value="option.value"
          :checked="density === option.value"
          @change="selectDensity(option.value)"
        />
        <span class="theme-copy">
          <span class="theme-name">{{ option.label }}</span>
          <span class="theme-description">{{ option.description }}</span>
        </span>
      </label>
    </div>

    <p class="settings-note">
      Density changes row spacing only; it never hides information and is remembered for the next
      visit.
    </p>
  </div>
</template>

<style scoped>
.appearance-section {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.settings-lead,
.settings-note {
  margin: 0;
  font-size: 0.8rem;
  line-height: 1.5;
  color: var(--text-secondary);
}

.settings-note {
  font-size: 0.75rem;
}

.settings-subhead {
  margin: 4px 0 -6px;
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--text-primary);
}

.theme-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 10px;
}

.theme-option {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: 10px;
  cursor: pointer;
  background: var(--surface-panel);
}

.theme-option:hover {
  background: var(--surface-hover);
}

.theme-option.selected {
  border-color: var(--accent);
  background: var(--surface-highlight);
  box-shadow: inset 0 0 0 1px var(--accent);
}

.theme-option:focus-within {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.theme-input {
  position: absolute;
  inset: 0;
  z-index: 1;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}

.theme-preview {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  font-size: 1rem;
  overflow: hidden;
}

.theme-preview--light {
  background: linear-gradient(135deg, #ffffff 0 55%, #eef0f3 55% 100%);
  color: #b07d10;
}

.theme-preview--dark {
  background: linear-gradient(135deg, #1f2026 0 55%, #33353c 55% 100%);
  color: #c9cdd4;
}

.theme-preview--system {
  background: linear-gradient(90deg, #ffffff 0 50%, #1f2026 50% 100%);
  color: #747b88;
}

.theme-copy {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.theme-name {
  font-size: 0.82rem;
  font-weight: 600;
}

.theme-description {
  font-size: 0.7rem;
  line-height: 1.35;
  color: var(--text-secondary);
}
</style>