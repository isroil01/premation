/**
 * Which curves the Graph Editor is allowed to plot.
 *
 * Two independent gates, in this order:
 *
 *  1. **The timeline's property filter.** The graph used to plot every animated
 *     track of every selected layer, so typing "opacity" into the timeline's
 *     filter narrowed the rows to one line and left the graph showing eleven
 *     curves. The graph is a view OF the timeline's rows; it has to respect the
 *     same filter or the two panels are describing different compositions.
 *
 *  2. **The visibility mode** — After Effects' "Show Selected Properties" vs
 *     "Show Animated Properties". Selected mode plots only the property ROWS
 *     the user picked (propertySelectionStore), and falls back to every
 *     animated track when nothing is selected, because an empty graph is never
 *     the useful answer to "I deselected everything".
 *
 * ## Duplication worth knowing about
 *
 * `matchesGraphFilter` re-implements the row predicate that lives INLINE in the
 * `rows` memo of Timeline.tsx (~line 460). It is deliberately the same rule:
 *
 *   • the query is trimmed and lower-cased; empty means "everything passes";
 *   • a property matches on its engine prop path OR its display label;
 *   • if ANY property of a layer matches, only the matching ones survive;
 *   • otherwise, if the LAYER NAME matches, all of its properties survive;
 *   • otherwise the layer contributes nothing.
 *
 * Timeline.tsx additionally honours expansion state and the P/S/R/T reveal set,
 * neither of which the graph has a notion of. When the timeline's predicate is
 * extracted into this file, delete the copy there and pass rows through
 * `filterGraphTracks`.
 */

import { expandKeyframeProp } from '@motion/animation';

/** The minimum a track has to say about itself to be filtered. */
export interface GraphTrackDescriptor {
  nodeId: string;
  /** Engine property path, e.g. `x`, `opacity`, `effect.glow.radius`. */
  prop: string;
  /** The layer name as the timeline's header column shows it. */
  layerName: string;
  /** The property label as the timeline's row shows it. */
  label: string;
}

export type GraphVisibilityMode = 'animated' | 'selected';

/** Normalise a raw search field value; `''` means "no filter". */
export function normalizeGraphQuery(query: string | undefined | null): string {
  return (query ?? '').trim().toLowerCase();
}

/** Does this one track's own text match the query? (Layer name not consulted.) */
export function matchesGraphFilter(track: GraphTrackDescriptor, query: string): boolean {
  if (query === '') return true;
  return (
    track.prop.toLowerCase().includes(query) ||
    track.label.toLowerCase().includes(query)
  );
}

/**
 * Apply the timeline's property filter to a flat list of tracks.
 *
 * Grouped by layer, because the rule is per-layer: "the layer name matched" is
 * only a reason to keep a property when NO property of that layer matched.
 * Input order is preserved.
 */
export function filterGraphTracks<T extends GraphTrackDescriptor>(
  tracks: ReadonlyArray<T>,
  query: string | undefined | null,
): T[] {
  const q = normalizeGraphQuery(query);
  if (q === '') return [...tracks];

  const byLayer = new Map<string, T[]>();
  for (const track of tracks) {
    const group = byLayer.get(track.nodeId);
    if (group) group.push(track);
    else byLayer.set(track.nodeId, [track]);
  }

  const keep = new Set<T>();
  for (const group of byLayer.values()) {
    const propHits = group.filter((t) => matchesGraphFilter(t, q));
    if (propHits.length > 0) {
      for (const t of propHits) keep.add(t);
      continue;
    }
    const layerName = (group[0]?.layerName ?? '').toLowerCase();
    if (layerName.includes(q)) for (const t of group) keep.add(t);
  }
  // Filter the ORIGINAL list so the caller's ordering (and colour assignment)
  // survives the grouping above.
  return tracks.filter((t) => keep.has(t));
}

/** `${nodeId}::${prop}` — the key shape propertySelectionStore uses. */
function key(nodeId: string, prop: string): string {
  return `${nodeId}::${prop}`;
}

/**
 * The engine tracks a set of selected property ROWS stands for.
 *
 * A row is not always a track: with Separate Dimensions off the timeline shows
 * one "Position" row for the x/y/z tracks behind it, so a selection has to be
 * expanded before it can be compared against anything the graph plots. Skipping
 * that is a silent no-op — Position is also the most-selected row there is.
 */
export function graphSelectedTrackKeys(
  entries: ReadonlyArray<{ nodeId: string; prop: string }>,
): Set<string> {
  const out = new Set<string>();
  for (const entry of entries) {
    for (const prop of expandKeyframeProp(entry.prop)) out.add(key(entry.nodeId, prop));
  }
  return out;
}

/**
 * Narrow tracks to the visibility mode.
 *
 * `animated` is the identity. `selected` keeps the tracks named by
 * `selectedKeys` — and, when that leaves nothing, hands back everything it was
 * given: AE shows the animated set rather than a blank graph when the property
 * selection is empty, and so does this.
 */
export function selectGraphTracksForMode<T extends { nodeId: string; prop: string }>(
  tracks: ReadonlyArray<T>,
  mode: GraphVisibilityMode,
  selectedKeys: ReadonlySet<string>,
): T[] {
  if (mode === 'animated') return [...tracks];
  const picked = tracks.filter((t) => selectedKeys.has(key(t.nodeId, t.prop)));
  return picked.length > 0 ? picked : [...tracks];
}

/**
 * Both gates, in the order the graph applies them: the timeline's filter first
 * (it decides what the panel is even about), then the visibility mode inside
 * what survived.
 */
export function visibleGraphTracks<T extends GraphTrackDescriptor>(args: {
  tracks: ReadonlyArray<T>;
  query: string | undefined | null;
  mode: GraphVisibilityMode;
  selectedKeys: ReadonlySet<string>;
}): T[] {
  return selectGraphTracksForMode(
    filterGraphTracks(args.tracks, args.query),
    args.mode,
    args.selectedKeys,
  );
}
