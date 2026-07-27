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

import { useMemo } from 'react';
import { useProjectStore, type CompositionSettings } from './projectStore';
import { sortedStops, type FillPaint } from '@core/paint/fill';

export type { CompositionSettings };

/** The representative flat colour of a paint — the solid colour, or a
 *  gradient's first stop. Mirrored into `background` so the GPU engine's
 *  solid-color fallback and export solid-color fallback remain correct. */
function paintColor(p: FillPaint): string {
  return p.type === 'solid' ? p.color : sortedStops(p.stops)[0]?.color ?? '#000000';
}

/** Render/cache key — changes whenever anything that affects pixels changes.
 *  The gradient paint is serialized so the viewport repaints on any stop/angle
 *  edit (a flat `background` string alone would miss gradient changes). */
function compKeyFor(c: CompositionSettings): string {
  const paint = c.backgroundPaint ? JSON.stringify(c.backgroundPaint) : '';
  return `${c.width}x${c.height}:${c.fps}:${c.durationSeconds}:${c.background}:${c.transparent ? 1 : 0}:${c.startFrame ?? 0}:${paint}`;
}

export const DEFAULT_COMPOSITION: CompositionSettings = {
  id: 'comp_default',
  name: 'Composition 1',
  width: 1920,
  height: 1080,
  fps: 30,
  durationSeconds: 10,
  background: '#101014',
  transparent: false,
  startFrame: 0,
};

interface CompositionStore extends CompositionSettings {
  update: (patch: Partial<CompositionSettings>) => void;
  setBackground: (hex: string) => void;
  /** Set the rich background paint (solid/linear/radial). A solid clears the
   *  paint and keeps the back-compat flat `background` colour. */
  setBackgroundPaint: (paint: FillPaint) => void;
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
  if (patch.startFrame !== undefined) out.startFrame = clampInt(patch.startFrame, 0, 24 * 3600 * 240, 0);
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
  //
  // Subscribe to the tab's compositionId (a STRING), never to the tab object.
  // The tab is re-created by immer on every `setTime`, i.e. 60×/s during playback,
  // and because this is a plain hook rather than a real zustand store the selector
  // runs AFTER the subscription — so `useCompositionStore(s => s.fps)` gave zero
  // granularity and re-rendered all ~39 call sites across 17 components on every
  // playback frame (TitleBar, ViewportHeader, inspector sections, ExportDialog…),
  // none of which care about time. A scalar id is stable across those writes.
  const compId = useProjectStore((s) => (s.activeTabId ? s.tabs[s.activeTabId]?.compositionId : undefined));
  const compData = useProjectStore(s => (compId ? s.comps[compId] : undefined)) ?? DEFAULT_COMPOSITION;
  const updateComp = useProjectStore(s => s.actions.updateComp);

  // Memoized so the returned identity is stable between renders. Without this
  // every consumer that selects an object/function off this store (`comp`, `key`,
  // `update`) saw a fresh reference each render, defeating downstream memo and
  // putting unstable values into effect dependency arrays.
  const state = useMemo<CompositionStore>(() => ({
    ...compData,
    update: (patch) => { if (compId) updateComp(compId, sanitize(patch)); },
    setBackground: (hex) => { if (compId) updateComp(compId, { background: hex, backgroundPaint: undefined }); },
    setBackgroundPaint: (paint) => {
      if (!compId) return;
      if (paint.type === 'solid') updateComp(compId, { background: paint.color, backgroundPaint: undefined });
      else updateComp(compId, { background: paintColor(paint), backgroundPaint: paint });
    },
    setTransparent: (v) => { if (compId) updateComp(compId, { transparent: v }); },
    comp: () => compData,
    key: () => compKeyFor(compData),
  }), [compData, compId, updateComp]);

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
      setBackground: (hex) => { if (compId) s.actions.updateComp(compId, { background: hex, backgroundPaint: undefined }); },
      setBackgroundPaint: (paint) => {
        if (!compId) return;
        if (paint.type === 'solid') s.actions.updateComp(compId, { background: paint.color, backgroundPaint: undefined });
        else s.actions.updateComp(compId, { background: paintColor(paint), backgroundPaint: paint });
      },
      setTransparent: (v) => { if (compId) s.actions.updateComp(compId, { transparent: v }); },
      comp: () => compData,
      key: () => compKeyFor(compData),
    };
  },
  setState: (patch: Partial<CompositionSettings>) => {
    useCompositionStore.getState().update(patch);
  }
});

export function hydrateComposition(): void {
  // Persistence is now managed by project serialization
}
