/**
 * The order the transport bar sheds its groups when it runs short.
 *
 * The bar used to scroll horizontally when it ran out of room, which is the
 * worst of the options: controls were still THERE, just past an edge, reachable
 * only by a gesture nothing on screen advertised. The container queries that
 * preceded the scroll were no better — they hid controls outright.
 *
 * So the bar sheds groups into a menu instead, one at a time. That menu was
 * View Options, which lived in the same row; View Options is gone, so the
 * shed groups now appear under the bar's own overflow trigger, rendered by
 * `TransportBar` itself — the component that owns the handlers.
 *
 * ## One ladder, two kinds of rung
 *
 * The viewport's DISPLAY controls (layout, channel, resolution, preview, LUT,
 * overlays, snapshot + compare, display mode, bookmarks, pop out) moved down
 * from the tabs row into this bar, and they brought their own shed order with
 * them. They go first, one control per level, right to left — they are the
 * controls you change least often and every one of them is a menu already —
 * and only once all ten are gone does the bar start on its own three groups.
 * `useTransportDemote` walks the whole ladder as one number; the two halves
 * are read back out of it with `displayLevelFor` and `isDemoted`.
 */

/**
 * The order the display controls leave the row, RIGHT to left — the last
 * control goes first. Layout, channel and resolution are what you change most,
 * so they hold on longest.
 */
export const DISPLAY_DEMOTE_ORDER = [
  'popout',
  'bookmarks',
  'displayMode',
  'compare',
  'lut',
  'overlays',
  'preview',
  'resolution',
  'channel',
  'layout',
] as const;

export type DisplayGroup = (typeof DISPLAY_DEMOTE_ORDER)[number];

/** Whether `group` has been shed at `level` — level 1 sheds the first, and so on. */
export function isDisplayShed(group: DisplayGroup, level: number): boolean {
  return DISPLAY_DEMOTE_ORDER.indexOf(group) < level;
}

/**
 * The bar's OWN groups, in the order they leave once the display controls
 * have all gone — least useful first.
 *
 * Each entry is a group, not a single button: splitting the three clip edits
 * across a row and a menu would be worse than having them in either one.
 */
export const TRANSPORT_GROUP_ORDER = ['loopMarker', 'zoom'] as const;

export type TransportGroup = (typeof TRANSPORT_GROUP_ORDER)[number];

/** The whole ladder: every display control, then the bar's own two groups. */
export const TRANSPORT_DEMOTE_ORDER = [...DISPLAY_DEMOTE_ORDER, ...TRANSPORT_GROUP_ORDER] as const;

export type TransportRung = (typeof TRANSPORT_DEMOTE_ORDER)[number];

/** How many rungs are demoted at `level` — level 1 demotes the first, and so on. */
export function isDemoted(group: TransportRung, level: number): boolean {
  return TRANSPORT_DEMOTE_ORDER.indexOf(group) < level;
}

/**
 * The display controls' own level, read out of the bar's — the first ten rungs
 * of the ladder are theirs, so the bar's level maps straight onto theirs until
 * it runs past them.
 */
export function displayLevelFor(level: number): number {
  return Math.max(0, Math.min(level, DISPLAY_DEMOTE_ORDER.length));
}

/** Levels beyond this demote nothing further, so measuring can stop. */
export const MAX_DEMOTE_LEVEL = TRANSPORT_DEMOTE_ORDER.length;
