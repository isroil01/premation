/**
 * Folding the menu bar when its host cannot fit every group.
 *
 * Pure, so the arithmetic is testable without a layout engine: the component
 * measures, these decide. See the OVERFLOW note in `AppMenuBar.tsx`.
 */

import type { MenuGroupModel } from './menuModel';

/** The id of the synthetic "…" group. */
export const OVERFLOW_GROUP_ID = '__overflow';

/** A stand-in for a group that has never been rendered (so never measured). */
export function estimateGroupWidth(label: string): number {
  return Math.round(label.length * 7 + 24);
}

/**
 * How many LEADING groups fit in `available` px.
 *
 * All of them when they simply fit. Otherwise the most that still leave room
 * for the "…" button — it has to be on the bar for the rest to be reachable, so
 * its width is charged before the last group's is.
 */
export function countFittingGroups(
  widths: ReadonlyArray<number>,
  gap: number,
  available: number,
  moreWidth: number,
): number {
  const total = widths.reduce((a, w) => a + w, 0) + gap * Math.max(0, widths.length - 1);
  if (total <= available) return widths.length;
  let used = 0;
  let n = 0;
  for (const w of widths) {
    // `used` already carries a trailing gap for each group placed, which is
    // exactly the gap the "…" button needs in front of it.
    if (used + w + gap + moreWidth > available) break;
    used += w + gap;
    n += 1;
  }
  return n;
}

/**
 * The groups the bar draws: the first `fitCount` as they are, and the rest as
 * submenus of one trailing "…" group. Order is preserved, so Help is still the
 * last thing in the list a user reads.
 */
export function foldOverflowGroups(
  groups: ReadonlyArray<MenuGroupModel>,
  fitCount: number,
  overflowLabel: string,
): MenuGroupModel[] {
  if (fitCount >= groups.length) return [...groups];
  const keep = Math.max(0, Math.floor(fitCount));
  return [
    ...groups.slice(0, keep),
    {
      id: OVERFLOW_GROUP_ID,
      label: overflowLabel,
      items: groups.slice(keep).map((g) => ({ label: g.label, children: g.items })),
    },
  ];
}
