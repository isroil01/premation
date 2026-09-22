/**
 * Where a floating layer — a popover, a dropdown menu, a submenu — portals to.
 *
 * `document.body`, unless the element that opened it sits inside a dialog; then
 * the dialog itself.
 *
 * WHY. A modal Radix dialog (`components/Modal`) locks the page behind it: it
 * sets `pointer-events: none` on <body>, traps focus inside its content, and
 * closes on any pointerdown outside that content. A layer portalled to <body>
 * is "outside" on all three counts — it inherits the dead pointer events, so a
 * click on a menu item falls straight through to whatever is underneath (in
 * Settings ▸ Appearance that was the accent swatch below the Language menu),
 * and were the clicks let through, the dialog would treat them as outside and
 * close. Mounted INSIDE the dialog, the layer is part of it on all three.
 *
 * Positioning is unaffected: the layers are `position: fixed`, and a dialog has
 * no transform, filter or containment once its entry animation has finished —
 * any of those would make the dialog the containing block and shift the layer.
 * Keep `.dialog` in `Modal.module.css` free of them at rest.
 */
export function floatingLayerContainer(anchor: Element | null | undefined): HTMLElement {
  return anchor?.closest<HTMLElement>('[role="dialog"]') ?? document.body;
}
