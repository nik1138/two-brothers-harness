<script lang="ts">
export type AppDialogSize = 'sm' | 'md' | 'lg' | 'xl'
</script>

<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import { NModal } from 'naive-ui'
import AppIcon from './AppIcon.vue'

const props = withDefaults(
  defineProps<{
    /** Controls visibility; pair with `@update:show` for v-model. */
    show: boolean
    /** Width preset: 420 / 560 / 680 / 800px. */
    size?: AppDialogSize
    /** Rendered as the dialog heading and used as its accessible name. */
    title?: string
    /** Supporting sentence under the title. */
    description?: string
    /** Accessible name when no visible title is rendered. */
    ariaLabel?: string
    closeOnEsc?: boolean
    closeOnMaskClick?: boolean
    showClose?: boolean
    /** Suppress Escape/mask/close while a request is in flight. */
    persistent?: boolean
    /** Body is the scroll container (header/footer stay pinned). */
    scrollBody?: boolean
    /** Remove body padding, for lists and full-bleed finders. */
    flush?: boolean
    /** Selector for the element focused after the dialog opens. */
    initialFocus?: string
    /** Optional exact width, e.g. `min(680px, 100vw - 32px)`. */
    width?: string
    /** Optional exact height; the viewport max-height still clamps it. */
    height?: string
    maxHeight?: string
    zIndex?: number
    autoFocus?: boolean
    trapFocus?: boolean
  }>(),
  {
    size: 'md',
    closeOnEsc: true,
    closeOnMaskClick: true,
    showClose: true,
    persistent: false,
    scrollBody: true,
    flush: false,
    autoFocus: true,
    trapFocus: true,
  },
)

const emit = defineEmits<{
  'update:show': [value: boolean]
  close: []
  'after-enter': []
  'after-leave': []
}>()

defineOptions({ inheritAttrs: false })

const uid = `app-dialog-${useId()}`
const titleId = `${uid}-title`
const descriptionId = `${uid}-description`

const dialogEl = ref<HTMLElement | null>(null)
let previouslyFocused: HTMLElement | null = null

const dialogStyle = computed<Record<string, string>>(() => {
  const style: Record<string, string> = {}
  if (props.width) style.width = props.width
  if (props.height) style.height = props.height
  if (props.maxHeight) style.maxHeight = props.maxHeight
  return style
})

const ariaLabel = computed(() => {
  if (props.ariaLabel) return props.ariaLabel
  return props.title ? undefined : 'Dialog'
})

watch(
  () => props.show,
  (open) => {
    if (!open) return
    const active = document.activeElement
    previouslyFocused = active instanceof HTMLElement ? active : null
  },
  { immediate: true },
)

/** Only the topmost dialog answers Escape/mask dismissals. */
function isTopmostDialog(): boolean {
  const own = dialogEl.value
  if (!own) return true
  const ownModal = own.classList.contains('n-modal') ? own : own.closest('.n-modal')
  if (!ownModal) return true
  const dialogs = Array.from(document.querySelectorAll<HTMLElement>('.n-modal'))
  return dialogs[dialogs.length - 1] === ownModal
}

function requestClose() {
  if (props.persistent) return
  emit('update:show', false)
  emit('close')
}

function handleEsc() {
  if (!props.closeOnEsc || !isTopmostDialog()) return
  requestClose()
}

/**
 * Naive UI fires `mask-click` for clicks inside a stacked dialog too. A real
 * mask click has no `.n-modal` ancestor; a click in a child dialog has one
 * that is not ours. Clicks inside our own surface never close either.
 */
function handleMaskClick(event: MouseEvent) {
  if (!props.closeOnMaskClick || !isTopmostDialog()) return
  const target = event.target
  if (!(target instanceof Element)) return

  const own = dialogEl.value
  if (own?.contains(target)) return

  const clickedModal = target.closest('.n-modal')
  const ownModal = own?.classList.contains('n-modal')
    ? own
    : own?.closest('.n-modal') ?? null
  if (clickedModal && clickedModal !== ownModal) return

  requestClose()
}

function focusInitialTarget() {
  const root = dialogEl.value
  if (!root) return
  let target: HTMLElement | null = null
  if (props.initialFocus) {
    try {
      target = root.querySelector<HTMLElement>(props.initialFocus)
    } catch {
      // An invalid selector must not break the dialog; fall back to autofocus.
    }
  }
  if (!target) target = root.querySelector<HTMLElement>('[autofocus], [data-autofocus]')
  if (target && target !== document.activeElement) target.focus()
}

function handleAfterEnter() {
  focusInitialTarget()
  emit('after-enter')
}

/**
 * Restore the trigger when the focus trap did not (e.g. the trigger unmounted
 * or the close transition left focus on <body>).
 */
function handleAfterLeave() {
  const restore = previouslyFocused
  previouslyFocused = null
  const active = document.activeElement
  const focusLost =
    !active || active === document.body || dialogEl.value?.contains(active) === true
  if (restore?.isConnected && focusLost) restore.focus({ preventScroll: true })
  emit('after-leave')
}
</script>

<template>
  <n-modal
    :show="show"
    :mask-closable="false"
    :close-on-esc="false"
    :auto-focus="autoFocus"
    :trap-focus="trapFocus"
    :block-scroll="true"
    :z-index="zIndex"
    @mask-click="handleMaskClick"
    @esc="handleEsc"
    @after-enter="handleAfterEnter"
    @after-leave="handleAfterLeave"
  >
    <div
      ref="dialogEl"
      v-bind="$attrs"
      class="app-dialog"
      :class="[`app-dialog--${size}`, { 'app-dialog--fixed-height': height }]"
      :style="dialogStyle"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      :aria-label="ariaLabel"
      :aria-labelledby="!ariaLabel && title ? titleId : undefined"
      :aria-describedby="description ? descriptionId : undefined"
    >
      <header
        v-if="title || description || $slots.header || showClose"
        class="app-dialog__header"
      >
        <slot name="header">
          <div class="app-dialog__heading">
            <h2 v-if="title" :id="titleId" class="app-dialog__title">{{ title }}</h2>
            <p v-if="description" :id="descriptionId" class="app-dialog__description">
              {{ description }}
            </p>
          </div>
        </slot>
        <slot name="header-extra" />
        <button
          v-if="showClose"
          type="button"
          class="icon-btn app-dialog__close"
          aria-label="Close dialog"
          :disabled="persistent"
          @click="requestClose"
        >
          <AppIcon name="x" :size="18" />
        </button>
      </header>

      <div
        class="app-dialog__body"
        :class="{
          'app-dialog__body--flush': flush,
          'app-dialog__body--static': !scrollBody,
        }"
      >
        <slot />
      </div>

      <footer v-if="$slots.footer || $slots.actions" class="app-dialog__footer">
        <slot name="footer">
          <slot name="actions" />
        </slot>
      </footer>
    </div>
  </n-modal>
</template>