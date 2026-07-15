/**
 * Composition settings (Prompt E1). The single source of truth for the comp's
 * name, size, frame rate, duration and BACKGROUND — the background was hardcoded
 * to a near-black constant in buildSnapshot; it's now a real, persisted property.
 *
 * Mirrors the `motionBlurStore` pattern: a small Zustand store the render hooks
 * read and thread into `buildSnapshot`, with a `key()` the hooks add to their
 * re-render deps (and the render cache) so edits repaint immediately.
 *
 * Persistence rides on the existing SettingsManager (like createRenderBackend).
 * Defaults equal the previous hardcoded values, so nothing changes visually
 * until the user edits the comp.
 */

import { useProjectStore, type CompositionSettings } from './projectStore';

export type { CompositionSettings };

export const DEFAULT_COMPOSITION: CompositionSettings = {
  id: 'comp_default',
  name: 'Composition 1',
  width: 1920,
  height: 1080,
  fps: 30,
  durationSeconds: 10,
  background: '#101014',
  transparent: false,
};

interface CompositionStore extends CompositionSettings {
  update: (patch: Partial<CompositionSettings>) => void;
  setBackground: (hex: string) => void;
  setTransparent: (v: boolean) => void;
  comp: () => CompositionSettings;
  key: () => string;
}

function clampInt(v: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : fallback;
}

function sanitize(patch: Partial<CompositionSettings>): Partial<CompositionSettings> {
  const out: Partial<CompositionSettings> = { ...patch };
  if (patch.width !== undefined) out.width = clampInt(patch.width, 1, 16384, DEFAULT_COMPOSITION.width);
  if (patch.height !== undefined) out.height = clampInt(patch.height, 1, 16384, DEFAULT_COMPOSITION.height);
  if (patch.fps !== undefined) out.fps = clampInt(patch.fps, 1, 240, DEFAULT_COMPOSITION.fps);
  if (patch.durationSeconds !== undefined) {
    out.durationSeconds = Number.isFinite(patch.durationSeconds)
      ? Math.max(0.1, patch.durationSeconds)
      : DEFAULT_COMPOSITION.durationSeconds;
  }
  return out;
}

export interface CompositionStoreFn {
  <T>(selector: (state: CompositionStore) => T): T;
  (): CompositionStore;
  getState: () => CompositionStore;
  setState: (patch: any) => void;
}

export const useCompositionStore = function <T>(selector?: (state: CompositionStore) => T): T | CompositionStore {
  // Hooks must be unconditional — a null↔set transition of activeTabId while
  // consumers stay mounted would otherwise change the hook count and crash.
  const tab = useProjectStore(s => (s.activeTabId ? s.tabs[s.activeTabId] : undefined)) ?? null;
  const compId = tab?.compositionId;
  const compData = useProjectStore(s => (compId ? s.comps[compId] : undefined)) ?? DEFAULT_COMPOSITION;
  const updateComp = useProjectStore(s => s.actions.updateComp);

  const state: CompositionStore = {
    ...compData,
    update: (patch) => { if (compId) updateComp(compId, sanitize(patch)); },
    setBackground: (hex) => { if (compId) updateComp(compId, { background: hex }); },
    setTransparent: (v) => { if (compId) updateComp(compId, { transparent: v }); },
    comp: () => compData,
    key: () => `${compData.width}x${compData.height}:${compData.fps}:${compData.durationSeconds}:${compData.background}:${compData.transparent ? 1 : 0}`
  };

  return selector ? selector(state) : state;
} as CompositionStoreFn;

Object.assign(useCompositionStore, {
  getState: (): CompositionStore => {
    const s = useProjectStore.getState();
    const activeTabId = s.activeTabId;
    const tab = activeTabId ? s.tabs[activeTabId] : null;
    const compId = tab?.compositionId;
    const compData = (compId ? s.comps[compId] : undefined) ?? DEFAULT_COMPOSITION;

    return {
      ...compData,
      update: (patch) => { if (compId) s.actions.updateComp(compId, sanitize(patch)); },
      setBackground: (hex) => { if (compId) s.actions.updateComp(compId, { background: hex }); },
      setTransparent: (v) => { if (compId) s.actions.updateComp(compId, { transparent: v }); },
      comp: () => compData,
      key: () => `${compData.width}x${compData.height}:${compData.fps}:${compData.durationSeconds}:${compData.background}:${compData.transparent ? 1 : 0}`
    };
  },
  setState: (patch: Partial<CompositionSettings>) => {
    useCompositionStore.getState().update(patch);
  }
});

export function hydrateComposition(): void {
  // Persistence is now managed by project serialization
}
