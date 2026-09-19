/**
 * How the Layers panel is LOOKING at the scene — as opposed to what the scene
 * contains, which is the scene graph's job.
 *
 * Everything here used to be `useState` inside `ScenePanel`, which meant it
 * lived exactly as long as the panel was mounted. The Layers panel is a dock
 * tab: switching to Assets and back, or loading a workspace, unmounts it. So
 * a filter you set to find four layers in a stack of two hundred was gone the
 * next time you looked at the stack — and the search box, the four filters and
 * the expansion state all went with it.
 *
 * Filters are keyed per COMPOSITION. "Show me the cameras" is a question about
 * one comp; carrying the answer across to another comp, which may have no
 * cameras at all, produces an empty panel with no visible cause. The view
 * settings below them (density, scope, which switches the rows show) are about
 * the PANEL and are global, the way a preference is.
 *
 * Persisted to localStorage, like `assetsViewStore` beside it — same shape,
 * same only-keys-this-version-knows guard on load, same "storage is optional"
 * failure mode.
 */

import { create } from 'zustand';
import type { SceneKind } from '@core/scene/seedDefaultScene';
import type { LayerFlag } from '@core/scene/layerFlags';

const STORAGE_KEY = 'premation.sceneView.v1';

/** Row heights, matching the three density steps the rest of the dock uses. */
export const ROW_DENSITY = { compact: 22, cozy: 26, comfortable: 32 } as const;
export type RowDensity = keyof typeof ROW_DENSITY;

/**
 * Which layers the tree lists.
 *   'comp'    — the open composition only, as the timeline does (default).
 *   'project' — every composition's root and its layers, one tree.
 *
 * It used to be 'project' with no way to say otherwise: `sceneGraphToTree`
 * walked `getRoots()`, so a ten-comp project put ten roots in one tree while
 * the footer counted only the open one. Both views are useful; neither should
 * be the only one.
 */
export type SceneScope = 'comp' | 'project';

/** What the search box searches. Name alone misses the two things you most
 *  often want to find a layer BY once a comp is large. */
export type SearchField = 'name' | 'effects' | 'expressions' | 'source';

/** Per-composition filter state. */
export interface SceneFilterState {
  /** Kinds to show; null = every kind. */
  kinds: SceneKind[] | null;
  /** A label colour to match; `'none'` = unlabelled only; null = any. */
  label: string | 'none' | null;
  animatedOnly: boolean;
  effectsOnly: boolean;
  query: string;
  /** Which fields `query` is matched against. Empty is treated as `['name']`. */
  fields: SearchField[];
}

export const EMPTY_FILTER: SceneFilterState = {
  kinds: null,
  label: null,
  animatedOnly: false,
  effectsOnly: false,
  query: '',
  fields: ['name'],
};

export function isFilterActive(f: SceneFilterState): boolean {
  return (
    f.kinds !== null
    || f.label !== null
    || f.animatedOnly
    || f.effectsOnly
    || f.query.trim().length > 0
  );
}

interface SceneViewState {
  /** Panel-wide, not per comp. */
  scope: SceneScope;
  density: RowDensity;
  /** Which AE switches each row draws, in `LAYER_FLAGS` order. */
  switches: LayerFlag[];
  /** Show a source thumbnail on media rows. */
  thumbnails: boolean;
  /** Hide layers marked shy — the tree's half of the timeline's global toggle. */
  hideShy: boolean;
  /** compId → its filter. Absent means `EMPTY_FILTER`. */
  filters: Record<string, SceneFilterState>;
}

interface SceneViewStore extends SceneViewState {
  setScope(scope: SceneScope): void;
  setDensity(density: RowDensity): void;
  toggleSwitch(flag: LayerFlag): void;
  setThumbnails(on: boolean): void;
  setHideShy(on: boolean): void;
  /** The filter for one comp — never undefined. */
  filterFor(compId: string | undefined): SceneFilterState;
  patchFilter(compId: string | undefined, patch: Partial<SceneFilterState>): void;
  clearFilter(compId: string | undefined): void;
}

/**
 * Default switch column: the four AE users reach for from a layer LIST rather
 * than from the timeline. Motion blur and 3D because they are per-layer opt-ins
 * you set while building the stack; shy because hiding a layer from the list is
 * a list operation; adjustment because it changes what the layers under it
 * mean. Quality, frame blending and preserve-transparency are footage-grading
 * switches you set while scrubbing, which is the timeline.
 */
const DEFAULT_SWITCHES: LayerFlag[] = ['shy', 'motionBlur', 'adjustment', 'threeD'];

const DEFAULTS: SceneViewState = {
  scope: 'comp',
  density: 'cozy',
  switches: DEFAULT_SWITCHES,
  thumbnails: false,
  hideShy: false,
  filters: {},
};

function load(): Partial<SceneViewState> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<SceneViewState>;
    const out: Partial<SceneViewState> = {};
    for (const k of Object.keys(DEFAULTS) as Array<keyof SceneViewState>) {
      if (k in parsed) (out as Record<string, unknown>)[k] = parsed[k];
    }
    // A persisted filter set outlives the project it was written for: a comp id
    // from another document is dead weight that never matches. Filters are
    // cheap to re-set and confusing to inherit, so they do not survive a reload
    // — only the panel-wide view settings do.
    delete out.filters;
    return out;
  } catch {
    return {};
  }
}

function persist(s: SceneViewState): void {
  try {
    const { scope, density, switches, thumbnails, hideShy } = s;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ scope, density, switches, thumbnails, hideShy }));
  } catch {
    /* storage full or unavailable — the session still works */
  }
}

/** Filters are keyed by comp; a panel with no open comp still needs somewhere
 *  to put one, and this is a stable key for it rather than a special case. */
const NO_COMP = '__none__';

export const useSceneViewStore = create<SceneViewStore>((set, get) => {
  const update = (patch: Partial<SceneViewState>): void => {
    set(patch as Partial<SceneViewStore>);
    persist(get());
  };
  return {
    ...DEFAULTS,
    ...load(),

    setScope: (scope) => update({ scope }),
    setDensity: (density) => update({ density }),
    setThumbnails: (thumbnails) => update({ thumbnails }),
    setHideShy: (hideShy) => update({ hideShy }),

    toggleSwitch: (flag) => {
      const cur = get().switches;
      update({ switches: cur.includes(flag) ? cur.filter((f) => f !== flag) : [...cur, flag] });
    },

    filterFor: (compId) => get().filters[compId ?? NO_COMP] ?? EMPTY_FILTER,

    patchFilter: (compId, patch) => {
      const key = compId ?? NO_COMP;
      const cur = get().filters[key] ?? EMPTY_FILTER;
      set({ filters: { ...get().filters, [key]: { ...cur, ...patch } } });
    },

    clearFilter: (compId) => {
      const key = compId ?? NO_COMP;
      const next = { ...get().filters };
      delete next[key];
      set({ filters: next });
    },
  };
});
