/**
 * compNavigation — After Effects' nested-composition navigation.
 *
 * AE's model, which this reproduces:
 *   - Double-clicking a precomposition layer OPENS the composition it shows:
 *     the viewer switches to it and the Timeline gets a tab for it. Its layers
 *     are then edited on their own, at the nested comp's own size and time.
 *   - The Composition Navigator bar along the top of the viewer shows the flow
 *     path — downstream (containing) comps on the left, upstream on the right —
 *     and clicking a name activates that comp.
 *   - Shift+Esc opens the most recently active comp in the same network.
 *   - "Synchronize Time Of All Related Items" is on by default, so the playhead
 *     follows across the jump: a precomp placed at 2s shows its own 0s at the
 *     parent's 2s, and opening it from there lands on 0s.
 *
 * There are two kinds of nested thing here, and one kind AE does not have:
 *   - a comp INSTANCE (`readCompRef`) opens the composition it references —
 *     that comp's own time axis, so the playhead is mapped through the layer;
 *   - a GROUP (a legacy in-place precomp, or a plain group) opens as a tab of
 *     its own subtree. A group's layers keep their clips on the PARENT's time
 *     axis (precompose transfers them without an offset), so the playhead maps
 *     one-to-one.
 *
 * The trail lives on the tab (`TabInfo.breadcrumbPath` / `breadcrumbVia`) and
 * is saved with the document. Tabs are not in undo history, so an undo that
 * removes a group you are inside would leave its tab pointing at nothing —
 * `installCompNavigation` repairs that by stepping back out to the nearest comp
 * that still exists.
 */

import { useProjectStore } from '@stores/projectStore';

/** What double-clicking a layer opens, when it opens anything. */
export interface NestedTarget {
  /** The composition (or group) the new viewer shows. */
  compId: string;
  title: string;
  /** `instance` = a placed composition; `group` = a group opened as its own tab. */
  kind: 'instance' | 'group';
}

// ── Shift+Esc: the most recently active composition in the network ───

/** The tab navigation last left, for Shift+Esc to return to. */
let previousTabId: string | null = null;

// Any tab switch counts — a click on a Timeline tab is as much "the comp I was
// just in" as a navigator jump.
useProjectStore.subscribe((state, prev) => {
  if (state.activeTabId !== prev.activeTabId && prev.activeTabId && state.tabs[prev.activeTabId]) {
    previousTabId = prev.activeTabId;
  }
  if (previousTabId && !state.tabs[previousTabId]) previousTabId = null;
});
