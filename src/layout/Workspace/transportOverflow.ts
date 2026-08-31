/**
 * What the transport bar has demoted into the View Options menu.
 *
 * The bar used to scroll horizontally when it ran out of room, which is the
 * worst of the options: controls were still THERE, just past an edge, reachable
 * only by a gesture nothing on screen advertised. The container queries that
 * preceded the scroll were no better — they hid controls outright.
 *
 * So the bar sheds groups into a menu instead, one at a time, and the menu is
 * the one that was already in the row: View Options. A published list rather
 * than a prop chain because the two ends are far apart — `TransportBar` owns
 * the controls and their handlers, `ViewControls` (in TopNav) owns the menu —
 * and threading `DropdownItem[]` through `ViewportTools` to get between them
 * would make an unrelated component the courier.
 */

import { create } from 'zustand';
import type { DropdownItem } from '@components/Dropdown';

/**
 * The order groups leave the row, least useful first.
 *
 * Each entry is a group, not a single button: splitting the three clip edits
 * across a row and a menu would be worse than having them in either one.
 */
export const TRANSPORT_DEMOTE_ORDER = ['clipEdits', 'quality', 'loopMarker', 'zoom'] as const;

export type TransportGroup = (typeof TRANSPORT_DEMOTE_ORDER)[number];

/** How many groups are demoted at `level` — level 1 demotes the first, and so on. */
export function isDemoted(group: TransportGroup, level: number): boolean {
  return TRANSPORT_DEMOTE_ORDER.indexOf(group) < level;
}

/** Levels beyond this demote nothing further, so measuring can stop. */
export const MAX_DEMOTE_LEVEL = TRANSPORT_DEMOTE_ORDER.length;

interface TransportOverflowState {
  /** Menu items for the demoted groups, in row order. Empty when nothing is. */
  items: ReadonlyArray<DropdownItem>;
  setItems(items: ReadonlyArray<DropdownItem>): void;
}

export const useTransportOverflow = create<TransportOverflowState>((set) => ({
  items: [],
  setItems: (items) => set({ items }),
}));
