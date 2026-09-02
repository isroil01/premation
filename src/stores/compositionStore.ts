/**
 * Composition settings (Prompt E1). The single source of truth for the comp's
 * name, size, frame rate, duration and BACKGROUND — the background was hardcoded
 * to a near-black constant in buildSnapshot; it's now a real, persisted property.
 *
 * Mirrors the `motionBlurStore` pattern: a small Zustand store the render hooks
 * read and thread into `buildSnapshot`, with a `key` the hooks add to their
 * re-render deps (and the render cache) so edits repaint immediately.
 *
 * Persistence rides on the existing SettingsManager (like createRenderBackend).
 * Defaults equal the previous hardcoded values, so nothing changes visually
 * until the user edits the comp.
 */

import { useMemo } from 'react';
import { useProjectStore, DEFAULT_GLOBAL_LIGHT, type CompositionSettings } from './projectStore';
import { sortedStops, type FillPaint } from '@core/paint/fill';
import { isEnvironmentPresetId, DEFAULT_ENVIRONMENT_PRESET } from '@core/scene/environmentLight';

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
  // The global light MUST be in this key: it is the only thing that makes a
  // style-bound shadow move, and a key without it means dragging the light
  // changes the snapshot but never triggers the repaint that shows it.
  const light = `${c.globalLightAngle ?? ''}/${c.globalLightAltitude ?? ''}`;
  return `${c.width}x${c.height}:${c.fps}:${c.durationSeconds}:${c.background}:${c.transparent ? 1 : 0}:${c.startFrame ?? 0}:${paint}:${light}`;
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
  globalLightAngle: 90,
  globalLightAltitude: 45,
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

/** Exported for its tests — every store write passes through it. */
export function sanitize(patch: Partial<CompositionSettings>): Partial<CompositionSettings> {
  const out: Partial<CompositionSettings> = { ...patch };
  if (patch.width !== undefined) out.width = clampInt(patch.width, 1, 16384, DEFAULT_COMPOSITION.width);
  if (patch.height !== undefined) out.height = clampInt(patch.height, 1, 16384, DEFAULT_COMPOSITION.height);
  // fps is clamped but NEVER rounded: 23.976 and 29.97 are real broadcast
  // rates (see presets.ts — "rounding them to 24/30 is a real sync bug").
  // clampInt here silently turned the NTSC presets into 24/30, so the comp
  // record and the timeline disagreed and footage drifted against audio.
  if (patch.fps !== undefined) {
    out.fps = Number.isFinite(patch.fps)
      ? Math.max(1, Math.min(240, patch.fps))
      : DEFAULT_COMPOSITION.fps;
  }
  if (patch.durationSeconds !== undefined) {
    out.durationSeconds = Number.isFinite(patch.durationSeconds)
      ? Math.max(0.1, patch.durationSeconds)
      : DEFAULT_COMPOSITION.durationSeconds;
  }
  if (patch.startFrame !== undefined) out.startFrame = clampInt(patch.startFrame, 0, 24 * 3600 * 240, 0);
  // The light angle is deliberately NOT wrapped to 0-360: it is authored with
  // the same unbounded dial as layer rotation, and wrapping would break a
  // sweep that crosses 0.
  if (patch.globalLightAngle !== undefined) {
    out.globalLightAngle = Number.isFinite(patch.globalLightAngle)
      ? patch.globalLightAngle
      : DEFAULT_GLOBAL_LIGHT.angle;
  }
  if (patch.globalLightAltitude !== undefined) {
    out.globalLightAltitude = clampInt(patch.globalLightAltitude, 0, 90, DEFAULT_GLOBAL_LIGHT.altitude);
  }
  // World ▸ default sky. An unknown id would be written straight through to
  // every light the comp creates, so it is validated against the registry here
  // rather than trusted and coerced six layers down.
  if (patch.defaultEnvPreset !== undefined && !isEnvironmentPresetId(patch.defaultEnvPreset)) {
    out.defaultEnvPreset = DEFAULT_ENVIRONMENT_PRESET;
  }
  // World ▸ ground level. Unbounded (a scene can be blocked out anywhere) but
  // finite — a NaN here would take the whole reference grid off screen with no
  // way to tell why.
  if (patch.groundLevel !== undefined) {
    out.groundLevel = Number.isFinite(patch.groundLevel) ? patch.groundLevel : 0;
  }
  return out;
}

export interface CompositionStoreFn {
  <T>(selector: (state: CompositionStore) => T): T;
  (): CompositionStore;
  getState: () => CompositionStore;
  setState: (patch: Partial<CompositionSettings>) => void;
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
