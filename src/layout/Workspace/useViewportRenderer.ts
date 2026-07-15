/**
 * useViewportRenderer — the React⇄Renderer seam (TAD §6.4.3), content-only.
 *
 * React owns only a canvas element + a `RenderBackend` handle; it never touches
 * rendering internals. On scene/animation/time change it builds an immutable
 * snapshot and hands it to the backend, which fit-contains the composition.
 *
 * The main editor viewport uses {@link useWorkspace} instead (camera-driven +
 * interaction overlay). This lighter hook remains for read-only surfaces like
 * Presentation Mode, where there is no camera or interaction.
 */

import { useCallback, useEffect, useRef } from 'react';
import { createRenderBackend } from '@core/rendering/createRenderBackend';
import type { RenderBackend } from '@core/rendering/RenderBackend';
import { buildSnapshot, type SnapshotFocus } from '@core/rendering/buildSnapshot';
import renderCache from '@core/rendering/renderCache';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { getEventBus } from '@core/events/EventBus';
import { useGuidesStore } from '@stores/guidesStore';
import { useMotionBlurStore } from '@stores/motionBlurStore';
import { useCompositionStore } from '@stores/compositionStore';


export function useViewportRenderer(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  containerRef: React.RefObject<HTMLElement | null>,
  sceneRev: number,
  time: number,
  /** Focus Mode ghosting predicate (undefined = nothing ghosted). */
  focus?: SnapshotFocus,
  /** Signal that changes whenever `focus` changes, to force a re-render. */
  focusKey?: string,
): void {
  const backendRef = useRef<RenderBackend | null>(null);
  const timeRef = useRef(time);
  timeRef.current = time;
  const focusRef = useRef(focus);
  focusRef.current = focus;

  const rulers = useGuidesStore((s) => s.rulers);
  const grid = useGuidesStore((s) => s.grid);
  const safeArea = useGuidesStore((s) => s.safeArea);
  const camera3dMode = useGuidesStore((s) => s.camera3dMode);
  const overlaysRef = useRef({ rulers, grid, safeArea });
  overlaysRef.current = { rulers, grid, safeArea };
  // Threaded via ref (like the overlays) so the stable render callback always
  // sees the CURRENT view mode — a raw closure froze it at mount, deadening
  // the Active/Front (3D/2D) toggle.
  const camera3dModeRef = useRef(camera3dMode);
  camera3dModeRef.current = camera3dMode;

  const compKey = useCompositionStore((s) => s.key());
  const compRef = useRef(useCompositionStore.getState().comp());
  compRef.current = useCompositionStore.getState().comp();

  const mbEnabled = useMotionBlurStore((s) => s.enabled);
  const mbShutter = useMotionBlurStore((s) => s.shutterAngle);
  const mbPhase = useMotionBlurStore((s) => s.shutterPhase);
  const mbSamples = useMotionBlurStore((s) => s.samples);
  const mbLimit = useMotionBlurStore((s) => s.adaptiveSampleLimit);
  const activeFps = compRef.current.fps || 60;
  const motionBlurRef = useRef({ enabled: mbEnabled, shutterAngle: mbShutter, shutterPhase: mbPhase, samples: mbSamples, adaptiveSampleLimit: mbLimit, fps: activeFps });
  motionBlurRef.current = { enabled: mbEnabled, shutterAngle: mbShutter, shutterPhase: mbPhase, samples: mbSamples, adaptiveSampleLimit: mbLimit, fps: activeFps };

  const render = useCallback(() => {
    const b = backendRef.current;
    if (!b) return;
    b.renderFrame(
      buildSnapshot(
        defaultSceneGraph, defaultAnimation, timeRef.current, focusRef.current,
        overlaysRef.current, undefined, motionBlurRef.current, { ...compRef.current, camera3dMode: camera3dModeRef.current },
      ),
    );
    // The rendered frame is now cached (feeds the timeline cache bar).
    renderCache.mark(timeRef.current);
  }, []);

  // Attach the backend + observe size. Refs in a dependency array never re-fire
  // an effect, so the old `[canvasRef.current]` deps left the backend
  // unattached (blank canvas) whenever the refs filled in after the first
  // render — e.g. Presentation Mode's conditional portal. Instead this effect
  // runs on every commit, manages the attach lifecycle manually (attach is
  // idempotent per canvas), and a separate unmount effect tears down.
  const attachedRef = useRef<HTMLCanvasElement | null>(null);
  const teardownRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) {
      // The canvas left the DOM (portal closed) — release the old backend.
      if (teardownRef.current && attachedRef.current && !attachedRef.current.isConnected) {
        teardownRef.current();
      }
      return;
    }
    if (attachedRef.current === canvas && backendRef.current) return; // already attached
    teardownRef.current?.(); // canvas swapped — release the previous backend
    attachedRef.current = canvas;

    const backend = createRenderBackend();
    backend.attach(canvas);
    backend.setPreviewChrome?.(true);
    backendRef.current = backend;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const doResize = (): void => {
      const r = container.getBoundingClientRect();
      backend.resize(r.width, r.height, dpr);
      render();
    };
    const ro = new ResizeObserver(doResize);
    ro.observe(container);
    doResize();

    // Re-render when animation changes (e.g. keyframe edits).
    const sub = getEventBus().on('AnimationChanged', () => render());

    teardownRef.current = () => {
      ro.disconnect();
      sub.dispose();
      backend.dispose();
      backendRef.current = null;
      attachedRef.current = null;
      teardownRef.current = null;
    };
  });
  // Final unmount teardown.
  useEffect(() => () => teardownRef.current?.(), []);

  // Re-render on scene change, playhead move, focus change, guide toggle, or
  // camera view-mode flip (camera3dMode was previously missing — the 3D/2D
  // toggle never repainted this surface).
  useEffect(() => {
    render();
  }, [sceneRev, time, focusKey, rulers, grid, safeArea, camera3dMode, mbEnabled, mbShutter, mbSamples, compKey, render]);
}
