/**
 * Where a menu panel goes when you click the control that opens it.
 *
 * Both menu renderers computed this inline and one of them got it wrong in a
 * way that shipped: `AppMenuButton` anchored the panel RIGHT-aligned to its
 * trigger (`left = trigger.right - 220`), which is correct for a kebab at the
 * right edge of a bar and catastrophic for where TopNav actually mounts it —
 * the far LEFT. The result was `left: -186px`: the entire application menu,
 * including every File ▸ New/Open/Save entry, rendered off the left edge of the
 * window. In the web build that menu is the ONLY route to those commands.
 *
 * So: prefer left-aligned under the trigger, flip to right-aligned when that
 * would overflow, and clamp either way. A menu that cannot leave the viewport
 * cannot be positioned into unreachability by a future caller.
 */

/** Matches `.dropdown { min-width }` in AppMenuBar.module.css. */
const MENU_WIDTH = 220;
/** Breathing room from the window edge, and the gap under the trigger. */
const EDGE_GAP = 8;
const DROP = 4;

export interface MenuAnchor {
  left: number;
  top: number;
}

export function anchorMenuTo(trigger: DOMRect, viewportWidth = window.innerWidth): MenuAnchor {
  const flipped = trigger.right - MENU_WIDTH;
  const left = trigger.left + MENU_WIDTH + EDGE_GAP <= viewportWidth ? trigger.left : flipped;
  // Clamp last, so a viewport narrower than the panel still shows its left edge
  // rather than centring it off both sides.
  const maxLeft = Math.max(EDGE_GAP, viewportWidth - MENU_WIDTH - EDGE_GAP);
  return {
    left: Math.max(EDGE_GAP, Math.min(left, maxLeft)),
    top: trigger.bottom + DROP,
  };
}
