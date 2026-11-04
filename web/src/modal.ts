/** Stacked-modal click helper.
 *
 * naive-ui binds vdirs' `clickoutside` on every modal body and fires
 * `mask-click` for ANY click outside that body — including clicks inside a
 * stacked second dialog. Dialogs must therefore ignore mask-clicks whose
 * target sits inside another `.n-modal` body; only true mask hits (or the
 * page behind everything) should close. Known limitation: one mask click on
 * the TOP stacked dialog still closes the whole stack (both clickoutside
 * handlers fire and neither guard can attribute the mask hit) — accepted as
 * click-through dismiss.
 */
export function clickInModalBody(e: MouseEvent): boolean {
  const target = e.target as Node | null
  if (!target) return false
  return Array.from(document.querySelectorAll('.n-modal')).some((el) =>
    el.contains(target),
  )
}
