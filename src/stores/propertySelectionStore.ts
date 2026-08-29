/**
 * Property selection — which property ROWS in the timeline are selected, in
 * the order they were clicked.
 *
 * Distinct from layer selection (`selectionStore`) and keyframe selection
 * (`keyframeSelectionStore`): those answer "which layer" and "which diamond";
 * this answers "which property", and the ORDER matters, because After Effects'
 * Proportional Scrubbing (26.2) is defined on it — scrub any selected value
 * and the first-selected property receives 0 % of the change, the last 100 %,
 * the rest a linear ramp between. One drag, a cascade across ten layers.
 *
 * Until this existed, a value drag edited exactly one property, however many
 * rows were highlighted. Now that the timeline lists every property of every
 * layer, the selection this acts on finally has something to be made of.
 */

import { create } from 'zustand';

export interface PropertyRef {
  nodeId: string;
  prop: string;
}

export const propertyKey = (r: PropertyRef): string => `${r.nodeId}::${r.prop}`;

interface PropertySelectionStore {
  /** Selection order is meaning, not incidental — see the header. */
  entries: ReadonlyArray<PropertyRef>;
  /**
   * When several properties are selected, a scrub distributes PROPORTIONALLY
   * (AE 26.2). Off, every selected property moves by the same amount — AE's
   * classic multi-scrub. Both are reachable; this is which one a plain drag
   * means.
   */
  proportional: boolean;
  /** Replace the selection with one property. */
  select: (ref: PropertyRef) => void;
  /** Add to the end, or remove if already present (Ctrl/Cmd-click). */
  toggle: (ref: PropertyRef) => void;
  clear: () => void;
  setProportional: (v: boolean) => void;
  has: (ref: PropertyRef) => boolean;
}

export const usePropertySelectionStore = create<PropertySelectionStore>((set, get) => ({
  entries: [],
  proportional: true,
  select: (ref) => set({ entries: [ref] }),
  toggle: (ref) =>
    set((s) => {
      const k = propertyKey(ref);
      const without = s.entries.filter((e) => propertyKey(e) !== k);
      return { entries: without.length === s.entries.length ? [...s.entries, ref] : without };
    }),
  clear: () => set({ entries: [] }),
  setProportional: (v) => set({ proportional: v }),
  has: (ref) => {
    const k = propertyKey(ref);
    return get().entries.some((e) => propertyKey(e) === k);
  },
}));

export function prunePropertySelectionToNodes(nodeIds: ReadonlySet<string>): void {
  usePropertySelectionStore.setState((s) => {
    const entries = s.entries.filter((entry) => nodeIds.has(entry.nodeId));
    return entries.length === s.entries.length ? s : { entries };
  });
}

/**
 * The per-property weights of a multi-scrub.
 *
 * Proportional: a linear ramp from 0 at the first-selected to 1 at the last —
 * Adobe's own definition. Uniform: 1 everywhere. With a single entry both
 * collapse to [1], so a lone selection scrubs exactly as if none existed.
 *
 * Pure and exported so the ramp is a tested fact rather than a drag handler's
 * private arithmetic.
 */
export function scrubWeights(count: number, proportional: boolean): number[] {
  if (count <= 1) return count === 1 ? [1] : [];
  if (!proportional) return Array(count).fill(1);
  return Array.from({ length: count }, (_, i) => i / (count - 1));
}

/**
 * New values for every selected property given the scrubbed one's delta.
 *
 * `starts` are the values each entry had when the drag BEGAN — a scrub is
 * relative to where things were, not to wherever the previous move left
 * them, or the ramp would compound every frame of the drag.
 */
export function distributeScrub(
  entries: ReadonlyArray<PropertyRef>,
  starts: ReadonlyMap<string, number>,
  delta: number,
  proportional: boolean,
): Array<{ ref: PropertyRef; value: number }> {
  const w = scrubWeights(entries.length, proportional);
  const out: Array<{ ref: PropertyRef; value: number }> = [];
  entries.forEach((ref, i) => {
    const start = starts.get(propertyKey(ref));
    if (start === undefined) return;
    out.push({ ref, value: start + delta * w[i]! });
  });
  return out;
}
