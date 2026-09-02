/**
 * Saved ease curves — the user's own additions to the ease library.
 *
 * `easePresets.ts` is a fixed table of 24 Penner curves and stays that way: it
 * is a registry with a documented provenance, not a scratchpad. What it cannot
 * hold is the curve you just dialled in by dragging handles in the graph — the
 * one thing that is worth naming, because it is the one thing you cannot
 * reproduce on the next layer by picking from a list.
 *
 * So saved curves live here, alongside the library rather than inside it, and
 * are shown as their own row. A saved curve is JUST handles: applying one goes
 * through `applyCustomBezier` (the same write the ease clipboard uses), not
 * through `applyEasingToKeyframes`, because it has no preset id.
 *
 * Persisted, unlike `bounceStore`: a library that empties on relaunch is not a
 * library. localStorage rather than the project file, because a curve you named
 * is yours, not the document's — the same reasoning as a colour swatch.
 */

import { create } from 'zustand';
import type { BezierHandles } from '@motion/animation';

export interface CustomEase {
  /** Stable id — also the React key. Not an `EasePresetId`; see the header. */
  id: string;
  label: string;
  bezier: BezierHandles;
}

const STORAGE_KEY = 'premation.customEases';
/** A cap, so a stuck "save" cannot grow the row without bound. */
const MAX_CURVES = 40;

/** Best-effort read; a corrupt or absent entry is simply an empty library. */
function load(): CustomEase[] {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isCustomEase).slice(0, MAX_CURVES);
  } catch {
    return [];
  }
}

function isCustomEase(v: unknown): v is CustomEase {
  if (!v || typeof v !== 'object') return false;
  const c = v as Partial<CustomEase>;
  return (
    typeof c.id === 'string' &&
    typeof c.label === 'string' &&
    Array.isArray(c.bezier) &&
    c.bezier.length === 4 &&
    c.bezier.every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}

function save(curves: ReadonlyArray<CustomEase>): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(curves));
  } catch {
    /* private mode / quota — the session still has its curves */
  }
}

interface CustomEaseState {
  curves: ReadonlyArray<CustomEase>;
  /** Returns the saved entry, or null when the name or handles were unusable. */
  addCurve(label: string, bezier: BezierHandles): CustomEase | null;
  removeCurve(id: string): void;
}

export const useCustomEaseStore = create<CustomEaseState>((set, get) => ({
  curves: load(),

  addCurve: (label, bezier) => {
    const name = label.trim();
    if (!name || bezier.some((n) => !Number.isFinite(n))) return null;
    const entry: CustomEase = {
      id: `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      label: name,
      bezier: [...bezier] as BezierHandles,
    };
    // Same name saved twice replaces the first: "save" on a curve you already
    // named is how you correct it, and two identical chips are unusable.
    const curves = [...get().curves.filter((c) => c.label !== name), entry].slice(-MAX_CURVES);
    set({ curves });
    save(curves);
    return entry;
  },

  removeCurve: (id) => {
    const curves = get().curves.filter((c) => c.id !== id);
    set({ curves });
    save(curves);
  },
}));
