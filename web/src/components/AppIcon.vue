<script lang="ts">
/** Canonical icon names. Keep this list in sync with the template below. */
export const APP_ICON_NAMES = [
  'folder',
  'folder-plus',
  'inbox',
  'chevron-right',
  'chevron-down',
  'chevron-left',
  'chevron-up',
  'plus',
  'search',
  'settings',
  'panel',
  'ellipsis',
  'check',
  'x',
  'trash',
  'pencil',
  'stop',
  'send',
  'sun',
  'moon',
  'monitor',
  'warning',
  'refresh',
] as const

export type AppIconName = (typeof APP_ICON_NAMES)[number]

/** Convenience aliases for names used by common shell vocabulary. */
export const APP_ICON_ALIASES = {
  more: 'ellipsis',
  close: 'x',
  gear: 'settings',
  cog: 'settings',
  'panel-left': 'panel',
  'panel-right': 'panel',
  collapse: 'panel',
} as const

export type AppIconAlias = keyof typeof APP_ICON_ALIASES
</script>

<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    /** Canonical icon name, or one of the small aliases above. */
    name: AppIconName | AppIconAlias
    /** Pixel size or any CSS length. The set is designed on a 24px grid. */
    size?: number | string
    /** Accessible name. When omitted the icon is decorative (aria-hidden). */
    label?: string
    /** Stroke weight in the 24px viewBox. */
    strokeWidth?: number
  }>(),
  {
    size: 16,
    strokeWidth: 1.75,
  },
)

const resolvedName = computed<AppIconName>(() => {
  const alias = APP_ICON_ALIASES[props.name as AppIconAlias]
  return alias ?? (props.name as AppIconName)
})

const pixelSize = computed(() =>
  typeof props.size === 'number' ? `${props.size}px` : props.size,
)

const accessibleLabel = computed(() => props.label?.trim() || undefined)
</script>

<template>
  <svg
    class="app-icon"
    :class="`app-icon--${resolvedName}`"
    :width="pixelSize"
    :height="pixelSize"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    :role="accessibleLabel ? 'img' : undefined"
    :aria-label="accessibleLabel"
    :aria-hidden="accessibleLabel ? undefined : 'true'"
    focusable="false"
  >
    <template v-if="resolvedName === 'folder'">
      <path
        d="M3.5 7.5A2.5 2.5 0 0 1 6 5h3.2c.6 0 1.2.2 1.6.7L12.2 7H18a2.5 2.5 0 0 1 2.5 2.5v7A2.5 2.5 0 0 1 18 19H6a2.5 2.5 0 0 1-2.5-2.5z"
      />
    </template>

    <template v-else-if="resolvedName === 'folder-plus'">
      <path
        d="M3.5 7.5A2.5 2.5 0 0 1 6 5h3.2c.6 0 1.2.2 1.6.7L12.2 7H18a2.5 2.5 0 0 1 2.5 2.5v7A2.5 2.5 0 0 1 18 19H6a2.5 2.5 0 0 1-2.5-2.5z"
      />
      <path d="M12 10.5v5M9.5 13h5" />
    </template>

    <template v-else-if="resolvedName === 'inbox'">
      <path d="M4 13.5 6.2 6h11.6L20 13.5V18a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18z" />
      <path d="M4 13.5h4l1.4 2.3h5.2l1.4-2.3h4" />
    </template>

    <template v-else-if="resolvedName === 'chevron-right'">
      <path d="m9 6 6 6-6 6" />
    </template>

    <template v-else-if="resolvedName === 'chevron-down'">
      <path d="m6 9 6 6 6-6" />
    </template>

    <template v-else-if="resolvedName === 'chevron-left'">
      <path d="m15 6-6 6 6 6" />
    </template>

    <template v-else-if="resolvedName === 'chevron-up'">
      <path d="m6 15 6-6 6 6" />
    </template>

    <template v-else-if="resolvedName === 'plus'">
      <path d="M12 5v14M5 12h14" />
    </template>

    <template v-else-if="resolvedName === 'search'">
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </template>

    <template v-else-if="resolvedName === 'settings'">
      <path d="M4 7h8M16 7h4M4 17h4M12 17h8" />
      <circle cx="14" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
    </template>

    <template v-else-if="resolvedName === 'panel'">
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M9 4.5v15" />
    </template>

    <template v-else-if="resolvedName === 'ellipsis'">
      <circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </template>

    <template v-else-if="resolvedName === 'check'">
      <path d="m5 12.5 4.5 4.5L19 7" />
    </template>

    <template v-else-if="resolvedName === 'x'">
      <path d="M6 6l12 12M18 6 6 18" />
    </template>

    <template v-else-if="resolvedName === 'trash'">
      <path d="M4.5 7h15" />
      <path d="M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7" />
      <path d="m6.5 7 .8 11.1A2 2 0 0 0 9.3 20h5.4a2 2 0 0 0 2-1.9L17.5 7" />
      <path d="M10 11v5M14 11v5" />
    </template>

    <template v-else-if="resolvedName === 'pencil'">
      <path d="m4 20 .9-4.2L16.2 4.5a2.12 2.12 0 0 1 3 3L7.9 18.8 4 20Z" />
      <path d="m13.8 6.9 3 3" />
    </template>

    <template v-else-if="resolvedName === 'stop'">
      <rect
        x="6"
        y="6"
        width="12"
        height="12"
        rx="2"
        fill="currentColor"
        stroke="none"
      />
    </template>

    <template v-else-if="resolvedName === 'send'">
      <path d="M21 3 10.5 13.5" />
      <path d="m21 3-6.3 18-4.2-7.5L3 9.3 21 3Z" />
    </template>

    <template v-else-if="resolvedName === 'sun'">
      <circle cx="12" cy="12" r="3.4" />
      <path
        d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4"
      />
    </template>

    <template v-else-if="resolvedName === 'moon'">
      <path d="M20.5 14.8A8.5 8.5 0 0 1 9.2 3.5a8.5 8.5 0 1 0 11.3 11.3Z" />
    </template>

    <template v-else-if="resolvedName === 'monitor'">
      <rect x="3.5" y="4.5" width="17" height="12" rx="2" />
      <path d="M9 20h6M12 16.5V20" />
    </template>

    <template v-else-if="resolvedName === 'warning'">
      <path d="M12 3.5 21 19.5H3L12 3.5Z" />
      <path d="M12 9.5v4.5" />
      <circle cx="12" cy="17.2" r=".9" fill="currentColor" stroke="none" />
    </template>

    <template v-else-if="resolvedName === 'refresh'">
      <path d="M20 11a8 8 0 0 0-14.6-4.1" />
      <path d="M4 6v5h5" />
      <path d="M4 13a8 8 0 0 0 14.6 4.1" />
      <path d="M20 18v-5h-5" />
    </template>
  </svg>
</template>