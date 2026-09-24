/**
 * Frame-coalesced mirror subscriptions for the viewport's SVG overlays (B4).
 *
 * The mirror twin of `useSceneRevisionFrame`: a viewport drag lands one
 * document revision per POINTER EVENT (120-240/s), several times faster than
 * anything is painted, and an overlay that only tracks the document visually
 * needs at most one reconciliation per painted frame. The mirror notifies its
 * `doc` key once per engine batch — every document change, including writes
 * made around the engine (LocalEngine reports those as their own batch) — so
 * this sees every change the scene revision did, coalesced to one re-render
 * per animation frame.
 *
 *   useMirrorRevisionFrame()   a counter that moves at most once per frame after any document change
 *   useActiveCompSize()        the active composition's { width, height } (the old store's 1920×1080 default)
 *   useActiveTabCompSettings() the active TAB's composition settings (never a fallback composition's)
 *   useActiveMotionBlur()      the composition's motion-blur settings in the editor's shape
 *   useActiveCompRootId()      the active composition's id, the old store's placeholder id when no tab is open
 *   activeCompSettingsNow()    (callbacks) the active tab's composition settings, undefined with none
 *   activeCompSizeNow()        (callbacks) its { width, height }, 1920×1080 with none
 */

import { useEffect, useMemo, useState } from 'react';
import { documentMirror } from '@stores/documentMirror';
import type { CompSettings } from '@motion/engine-api';
import { DEFAULT_COMPOSITION } from '@stores/compositionStore';
import { DEFAULT_MOTION_BLUR_SETTINGS, type MotionBlurSettings } from '@stores/motionBlurStore';
import { useProjectStore } from '@stores/projectStore';
import { useActiveCompId, useMirrorComp } from './useMirror';

export function useMirrorRevisionFrame(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let raf: number | null = null;
    const unsub = documentMirror().subscribe(['doc'], () => {
      if (raf !== null) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        setTick((t) => t + 1);
      });
    });
    return () => {
      unsub();
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, []);
  return tick;
}

/**
 * The active composition's frame size, 1920×1080 when there is none (the
 * composition store's default). The same object until the size changes, so it
 * can go straight into the overlays' `{ width, height }` projection arguments.
 */
export function useActiveCompSize(): { readonly width: number; readonly height: number } {
  const s = useActiveTabCompSettings();
  const width = s?.width ?? DEFAULT_COMPOSITION.width;
  const height = s?.height ?? DEFAULT_COMPOSITION.height;
  return useMemo(() => ({ width, height }), [width, height]);
}

/**
 * The active tab's composition id — the scope the renderer resolves cameras
 * and 3D content in. With no tab open, the composition store's placeholder id
 * (`comp_default`, which names no node), exactly as `useCompositionStore((s) => s.id)` read.
 */
export function useActiveCompRootId(): string {
  return useActiveCompId() ?? DEFAULT_COMPOSITION.id;
}

/**
 * For a CALLBACK or a paint pass: the active TAB's composition settings from
 * the mirror — undefined when no tab is open or the mirror does not have it
 * (where `useCompositionStore.getState()` fell back to its defaults).
 */
export function activeCompSettingsNow(): CompSettings | undefined {
  const s = useProjectStore.getState();
  const id = s.activeTabId ? s.tabs[s.activeTabId]?.compositionId : undefined;
  return id ? documentMirror().comp(id)?.settings : undefined;
}

/** `activeCompSettingsNow`'s frame size, with the composition store's 1920×1080 default. */
export function activeCompSizeNow(): { width: number; height: number } {
  const c = activeCompSettingsNow();
  return { width: c?.width ?? DEFAULT_COMPOSITION.width, height: c?.height ?? DEFAULT_COMPOSITION.height };
}

/**
 * The active TAB's composition settings (undefined with no tab, or while the
 * mirror does not have it) — unlike `useActiveMirrorComp`, never another
 * composition's, so the defaults callers apply are the composition store's.
 */
export function useActiveTabCompSettings(): CompSettings | undefined {
  return useMirrorComp(useActiveCompId())?.settings;
}

/**
 * The active composition's motion-blur settings (`CompSettings.motionBlur`) in
 * the editor's shape (`samples`, not `samplesPerFrame`); the store's defaults
 * with no composition. Same object until a value changes.
 */
export function useActiveMotionBlur(): Readonly<MotionBlurSettings> {
  const mb = useActiveTabCompSettings()?.motionBlur;
  const d = DEFAULT_MOTION_BLUR_SETTINGS;
  const enabled = mb ? mb.enabled !== false : d.enabled;
  const shutterAngle = mb?.shutterAngle ?? d.shutterAngle;
  const shutterPhase = mb?.shutterPhase ?? d.shutterPhase;
  const samples = mb?.samplesPerFrame ?? d.samples;
  const adaptiveSampleLimit = mb?.adaptiveSampleLimit ?? d.adaptiveSampleLimit;
  return useMemo(
    () => ({ enabled, shutterAngle, shutterPhase, samples, adaptiveSampleLimit }),
    [enabled, shutterAngle, shutterPhase, samples, adaptiveSampleLimit],
  );
}
