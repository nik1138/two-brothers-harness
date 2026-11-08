<script setup lang="ts">
import type { Density } from '../../density'
import type { ThemeMode } from '../../themeMode'
import type { AccentTheme, RoleTheme } from '../../uiPrefs'

defineProps<{
  mode: ThemeMode
  density: Density
  accent: AccentTheme
  roleTheme: RoleTheme
}>()

const emit = defineEmits<{
  change: [ThemeMode]
  densityChange: [Density]
  accentChange: [AccentTheme]
  roleThemeChange: [RoleTheme]
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

/**
 * Accent themes map 1:1 to the `data-accent` token blocks in tokens.css; the
 * default blue is the base `:root` palette (no attribute block). Labels name the
 * colour because the swatch would need raw hex outside the token layer.
 */
const accentOptions: { value: AccentTheme; label: string; description: string }[] = [
  { value: 'blue', label: 'Blue', description: 'The default workspace accent.' },
  { value: 'violet', label: 'Violet', description: 'A deeper, calmer accent.' },
  { value: 'teal', label: 'Teal', description: 'A cool, restrained accent.' },
  { value: 'amber', label: 'Amber', description: 'A warm accent for daylight.' },
]

/**
 * Role-colour palettes map 1:1 to the `data-roles` token blocks in tokens.css;
 * the default palette is the base `:root` role tokens (no attribute block). The
 * labels name the palettes because a per-palette swatch would need raw hex
 * outside the token layer.
 */
const roleThemeOptions: { value: RoleTheme; label: string; description: string }[] = [
  { value: 'default', label: 'Default', description: 'Blue, teal and grey role colours.' },
  {
    value: 'contrast',
    label: 'High contrast',
    description: 'Darker in light, lighter in dark; AA-tuned text.',
  },
  { value: 'neutral', label: 'Neutral', description: 'Muted tones; labels carry identity.' },
]

function select(mode: ThemeMode) {
  emit('change', mode)
}

function selectDensity(density: Density) {
  emit('densityChange', density)
}

function selectAccent(accent: AccentTheme) {
  emit('accentChange', accent)
}

function selectRoleTheme(roleTheme: RoleTheme) {
  emit('roleThemeChange', roleTheme)
}
</script>

<template>
  <div class="appearance-section">
    <p class="settings-lead">
      Choose how the workspace looks on this device. Theme changes apply immediately and are
      remembered for the next visit.
    </p>

    <div class="appearance-grid" role="radiogroup" aria-label="Theme">
      <label
        v-for="option in options"
        :key="option.value"
        class="appearance-card"
        :class="{ selected: mode === option.value }"
      >
        <input
          class="appearance-input"
          type="radio"
          name="theme-mode"
          :value="option.value"
          :checked="mode === option.value"
          @change="select(option.value)"
        />
        <span class="appearance-preview" :class="`appearance-preview--${option.value}`" aria-hidden="true">
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
        <span class="appearance-copy">
          <span class="appearance-name">{{ option.label }}</span>
          <span class="appearance-description">{{ option.description }}</span>
        </span>
      </label>
    </div>

    <p class="settings-note">
      System follows the operating system's light or dark preference and updates when it changes.
    </p>

    <h4 class="settings-subhead">Accent</h4>
    <div class="accent-grid" role="radiogroup" aria-label="Accent">
      <label
        v-for="option in accentOptions"
        :key="option.value"
        class="accent-option"
        :class="{ selected: accent === option.value }"
      >
        <input
          class="accent-input"
          type="radio"
          name="accent-theme"
          :value="option.value"
          :checked="accent === option.value"
          @change="selectAccent(option.value)"
        />
        <span class="accent-copy">
          <span class="accent-name">{{ option.label }}</span>
          <span class="accent-description">{{ option.description }}</span>
        </span>
      </label>
    </div>

    <p class="settings-note">
      The accent applies immediately and is remembered for the next visit. Theme and density stay
      independent of it.
    </p>

    <h4 class="settings-subhead">Role colours</h4>
    <div class="role-theme-grid" role="radiogroup" aria-label="Role colours">
      <label
        v-for="option in roleThemeOptions"
        :key="option.value"
        class="role-theme-option"
        :class="{ selected: roleTheme === option.value }"
      >
        <input
          class="role-theme-input"
          type="radio"
          name="role-theme"
          :value="option.value"
          :checked="roleTheme === option.value"
          @change="selectRoleTheme(option.value)"
        />
        <span class="role-theme-copy">
          <span class="role-theme-name">{{ option.label }}</span>
          <span class="role-theme-description">{{ option.description }}</span>
        </span>
      </label>
    </div>

    <p class="settings-note">
      Role colours apply immediately and are remembered for the next visit. The palette changes
      only the Senior / Junior / Operator identity colours, never the accent.
    </p>

    <h4 class="settings-subhead">Density</h4>
    <div class="appearance-grid" role="radiogroup" aria-label="Density">
      <label
        v-for="option in densityOptions"
        :key="option.value"
        class="appearance-card"
        :class="{ selected: density === option.value }"
      >
        <input
          class="appearance-input"
          type="radio"
          name="density-mode"
          :value="option.value"
          :checked="density === option.value"
          @change="selectDensity(option.value)"
        />
        <span class="appearance-copy">
          <span class="appearance-name">{{ option.label }}</span>
          <span class="appearance-description">{{ option.description }}</span>
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

.appearance-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 10px;
}

.appearance-card {
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

.appearance-card:hover {
  background: var(--surface-hover);
}

.appearance-card.selected {
  border-color: var(--accent);
  background: var(--surface-highlight);
  box-shadow: inset 0 0 0 1px var(--accent);
}

.appearance-card:focus-within {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.appearance-input {
  position: absolute;
  inset: 0;
  z-index: 1;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}

.appearance-preview {
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

.appearance-preview--light {
  background: linear-gradient(135deg, #ffffff 0 55%, #eef0f3 55% 100%);
  color: #b07d10;
}

.appearance-preview--dark {
  background: linear-gradient(135deg, #1f2026 0 55%, #33353c 55% 100%);
  color: #c9cdd4;
}

.appearance-preview--system {
  background: linear-gradient(90deg, #ffffff 0 50%, #1f2026 50% 100%);
  color: #747b88;
}

.appearance-copy {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.appearance-name {
  font-size: 0.82rem;
  font-weight: 600;
}

.appearance-description {
  font-size: 0.7rem;
  line-height: 1.35;
  color: var(--text-secondary);
}

/* Accent chooser: the same card language as the theme/density radios, but its
   own class names so the appearance-density browser scenario (which measures
   `.appearance-card`) keeps measuring exactly theme + density. */
.accent-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: 10px;
}

.accent-option {
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

.accent-option:hover {
  background: var(--surface-hover);
}

.accent-option.selected {
  border-color: var(--accent);
  background: var(--surface-highlight);
  box-shadow: inset 0 0 0 1px var(--accent);
}

.accent-option:focus-within {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.accent-input {
  position: absolute;
  inset: 0;
  z-index: 1;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}

.accent-copy {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.accent-name {
  font-size: 0.82rem;
  font-weight: 600;
}

.accent-description {
  font-size: 0.7rem;
  line-height: 1.35;
  color: var(--text-secondary);
}

/* Role-colour chooser: same card language as the accent group, own class
   names so the appearance-density browser scenario keeps measuring exactly
   theme + density `.appearance-card`s. */
.role-theme-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 10px;
}

.role-theme-option {
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

.role-theme-option:hover {
  background: var(--surface-hover);
}

.role-theme-option.selected {
  border-color: var(--accent);
  background: var(--surface-highlight);
  box-shadow: inset 0 0 0 1px var(--accent);
}

.role-theme-option:focus-within {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.role-theme-input {
  position: absolute;
  inset: 0;
  z-index: 1;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}

.role-theme-copy {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.role-theme-name {
  font-size: 0.82rem;
  font-weight: 600;
}

.role-theme-description {
  font-size: 0.7rem;
  line-height: 1.35;
  color: var(--text-secondary);
}
</style>