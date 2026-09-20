/**
 * Row selection arithmetic for the timeline — what a click on a layer name or
 * a bar does to the selection, given the modifiers.
 *
 * The panel used to collapse Shift and Ctrl into one `additive` boolean, so
 * both toggled a single row and there was NO way to grab a contiguous block.
 * That is fine with six layers and unusable with sixty: selecting rows 4–37
 * meant thirty-four Ctrl+clicks, each of which could miss and wipe the lot.
 *
 * The rules are the ones every list in every OS uses, and the ones After
 * Effects uses for its layer stack:
 *
 *   click              → replace the selection with this row
 *   Ctrl/Cmd + click   → toggle this row, leave the rest alone
 *   Shift + click      → select the span from the ANCHOR to this row
 *   Ctrl/Cmd + Shift   → add that span to the selection
 *
 * The anchor is the subtlety. Shift+click does NOT move it, which is what lets
 * you shift-click again to grow or shrink the same span — move the anchor to
 * the clicked row instead and a span can only ever grow. Plain and toggling
 * clicks do move it, because they are how you say "start a new span here".
 *
 * Pure over an ordered id list, so the rules can be pinned without a DOM: the
 * caller (the Timeline, which is the only thing that knows the render order of
 * its rows) supplies `order` and applies the result.
 */

/** What the modifiers asked for. */
export type TrackSelectIntent = 'replace' | 'toggle' | 'range' | 'range-add';

export interface SelectModifiers {
  shift: boolean;
  /** Ctrl on Windows/Linux, Cmd on macOS — the caller ORs them. */
  meta: boolean;
}

/** Map a click's modifiers to an intent. */
export function selectIntentFor(mods: SelectModifiers): TrackSelectIntent {
  if (mods.shift && mods.meta) return 'range-add';
  if (mods.shift) return 'range';
  if (mods.meta) return 'toggle';
  return 'replace';
}

export interface ResolveSelectionArgs {
  /** Selectable row ids in DISPLAY order — the order a Shift span runs along. */
  order: ReadonlyArray<string>;
  /** The selection before the click. */
  selected: ReadonlyArray<string>;
  /** Where the last span started; `null` before anything has been clicked. */
  anchor: string | null;
  /** The row that was clicked. */
  clicked: string;
  intent: TrackSelectIntent;
}

export interface ResolvedSelection {
  /** The selection after the click, in `order` order. */
  ids: string[];
  /** The anchor to remember for the next Shift+click. */
  anchor: string | null;
  /**
   * True when the click resolved to exactly what was already selected. The
   * caller uses it to skip the store write — a plain click on an already-sole
   * selection is the most common click there is, and re-publishing an
   * identical selection re-renders every row for nothing.
   */
  unchanged: boolean;
}

/** The ids of `order` between the two endpoints, inclusive, either direction. */
export function spanBetween(
  order: ReadonlyArray<string>,
  from: string,
  to: string,
): string[] {
  const a = order.indexOf(from);
  const b = order.indexOf(to);
  if (a < 0 || b < 0) return b >= 0 ? [to] : [];
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return order.slice(lo, hi + 1);
}

function sameSet(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  for (const id of b) if (!set.has(id)) return false;
  return true;
}

/** Order a selection by the row order, dropping ids no longer on screen. */
function inOrder(order: ReadonlyArray<string>, ids: Iterable<string>): string[] {
  const want = new Set(ids);
  const out = order.filter((id) => want.has(id));
  // Anything selected but not in `order` (a row inside a collapsed group, say)
  // survives at the end rather than being silently dropped by a click that was
  // never about it.
  for (const id of want) if (!out.includes(id)) out.push(id);
  return out;
}

/**
 * The selection a click produces.
 *
 * A Shift+click with no usable anchor degrades to `replace` rather than doing
 * nothing: the first click of a session is often a Shift+click by accident,
 * and "select the row I clicked" is the only non-surprising reading of it.
 */
export function resolveTrackSelection(args: ResolveSelectionArgs): ResolvedSelection {
  const { order, selected, anchor, clicked, intent } = args;

  const done = (ids: string[], nextAnchor: string | null): ResolvedSelection => ({
    ids,
    anchor: nextAnchor,
    unchanged: sameSet(ids, selected),
  });

  switch (intent) {
    case 'toggle': {
      const has = selected.includes(clicked);
      const next = has ? selected.filter((id) => id !== clicked) : [...selected, clicked];
      // Deselecting the anchor leaves it pointing at a row that is no longer
      // part of anything; the clicked row is still the right place to span
      // FROM next time, so it stays the anchor either way.
      return done(inOrder(order, next), clicked);
    }

    case 'range':
    case 'range-add': {
      const from = anchor && order.includes(anchor) ? anchor : null;
      if (!from) return done([clicked], clicked);
      const span = spanBetween(order, from, clicked);
      const next = intent === 'range-add' ? inOrder(order, [...selected, ...span]) : span;
      // The anchor deliberately survives a Shift+click — see the header.
      return done(next, from);
    }

    case 'replace':
    default:
      return done([clicked], clicked);
  }
}
