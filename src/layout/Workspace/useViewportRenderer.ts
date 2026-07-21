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
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { getEventBus } from '@core/events/EventBus';
import { useGuidesStore } from '@stores/guidesStore';
import { useMotionBlurStore } from '@stores/motionBlurStore';
import { useCompositionStore } from '@stores/compositionStore';
import { useRenderQualityStore } from '@stores/renderQualityStore';



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
  const gridDivisions = useGuidesStore((s) => s.gridDivisions);
  const gridColor = useGuidesStore((s) => s.gridColor);
  const safeArea = useGuidesStore((s) => s.safeArea);
  const camera3dMode = useGuidesStore((s) => s.camera3dMode);
  const overlaysRef = useRef({ rulers, grid, gridDivisions, gridColor, safeArea });
  overlaysRef.current = { rulers, grid, gridDivisions, gridColor, safeArea };
  // Threaded via ref (like the overlays) so the stable render callback always
  // sees the CURRENT view mode — a raw closure froze it at mount, deadening
  // the Active/Front (3D/2D) toggle.
  const camera3dModeRef = useRef(camera3dMode);
  camera3dModeRef.current = camera3dMode;
  const channel = useGuidesStore((s) => s.channel);
  const channelRef = useRef(channel);
  channelRef.current = channel;

  const compKey = useCompositionStore((s) => s.key());
  const compRef = useRef(useCompositionStore.getState().comp());
  compRef.current = useCompositionStore.getState().comp();

  // Preview resolution: the content canvas renders at dpr/N (fewer pixels,
  // browser-upscaled) so heavy comps preview faster. Threaded via ref so the
  // stable render callback / resize path always read the current value.
  const previewResolution = useRenderQualityStore((s) => s.resolution);
  const resolutionRef = useRef(previewResolution);
  resolutionRef.current = previewResolution;



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
    b.renderFrame({
      ...buildSnapshot(
        defaultSceneGraph, defaultAnimation, timeRef.current, focusRef.current,
        overlaysRef.current, undefined, motionBlurRef.current,
        // rootId scopes the render to THIS composition's subtree.
        { ...compRef.current, rootId: compRef.current.id, camera3dMode: camera3dModeRef.current },
      ),
      // View-only: the channel never reaches export, which always writes colour.
      channel: channelRef.current,
    });
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
    // Rebuild when the canvas swapped OR the renderer choice changed — a GPU
    // backend can't re-bind a canvas that already handed out a 2D context, so
    // a choice change must attach a fresh backend (and, via the canvas key in
    // the host, a fresh element).
    if (attachedRef.current === canvas && backendRef.current) return;
    teardownRef.current?.(); // canvas swapped — release the previous backend
    attachedRef.current = canvas;

    const backend = createRenderBackend();
    backend.attach(canvas);
    backend.setPreviewChrome?.(true);
    backendRef.current = backend;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const doResize = (): void => {
      const r = container.getBoundingClientRect();
      backend.resize(r.width, r.height, dpr / resolutionRef.current);
      render();
    };
    const ro = new ResizeObserver(doResize);
    ro.observe(container);
    doResize();

    // The GPU backend initializes asynchronously; its first renderFrame before
    // that coalesces to a pending frame. Re-render once it's ready so the
    // preview isn't left blank when the comp is small or the container settled
    // before the device came up (the editor viewport has many retry triggers;
    // this lighter surface had almost none).
    let cancelled = false;
    backend.readyPromise?.then(() => {
      if (!cancelled && backendRef.current === backend) doResize();
    });

    // Re-render when animation changes (e.g. keyframe edits).
    const sub = getEventBus().on('AnimationChanged', () => render());

    teardownRef.current = () => {
      cancelled = true;
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
  }, [sceneRev, time, focusKey, rulers, grid, gridDivisions, gridColor, safeArea, camera3dMode, mbEnabled, mbShutter, mbSamples, compKey, render]);

  // Preview-quality change: re-size the content buffer (dpr/N) and repaint.
  useEffect(() => {
    const backend = backendRef.current;
    const container = containerRef.current;
    if (!backend || !container) return;
    const r = container.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    backend.resize(r.width, r.height, dpr / previewResolution);
    render();
  }, [previewResolution, containerRef, render]);
}
