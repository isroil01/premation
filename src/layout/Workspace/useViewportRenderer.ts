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
import { useGuidesStore, type Camera3dMode } from '@stores/guidesStore';
import { resolveViewCameraInput } from '@core/workspace/cameraNav';
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
  /**
   * Render through THIS view instead of the store's camera3dMode — the 2-up
   * secondary pane shows a different view of the same scene. Undefined =
   * follow the store (Presentation Mode, unchanged behavior).
   */
  viewOverride?: Camera3dMode,
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
  const camera3dMode = useGuidesStore((s) => viewOverride ?? s.camera3dMode);
  // Custom-view params re-render this surface while a custom view is orbited.
  const customViews = useGuidesStore((s) => s.customViews);
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

  const rafIdRef = useRef<number | null>(null);

  // Wrap in try/finally so a buildSnapshot/renderFrame exception never
  // permanently wedges rafIdRef.current at a non-null handle — if it got
  // stuck, the RAF deduplication guard would silently halt all future renders.
  const renderImmediate = useCallback(() => {
    const b = backendRef.current;
    if (!b) return;
    try {
      b.renderFrame({
        ...buildSnapshot(
          defaultSceneGraph, defaultAnimation, timeRef.current, focusRef.current,
          overlaysRef.current, undefined, motionBlurRef.current,
          // rootId scopes the render to THIS composition's subtree. Custom views
          // resolve to a pre-built override camera (scene camera ignored).
          {
            ...compRef.current,
            rootId: compRef.current.id,
            ...resolveViewCameraInput(compRef.current.width, compRef.current.height, camera3dModeRef.current),
          },
        ),
        // View-only: the channel never reaches export, which always writes colour.
        channel: channelRef.current,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[useViewportRenderer] renderImmediate failed:', err);
    } finally {
      // Always clear the guard so future render() calls can schedule a new RAF.
      rafIdRef.current = null;
    }
  }, []);

  // Coalesce render requests into requestAnimationFrame so complex 2D/3D frames
  // yield execution to the browser event loop between renders. Without RAF
  // coalescing, synchronous rendering at 60 FPS on heavy 3D scenes locks up
  // the main thread and prevents user interactions (clicks, keyboard, Esc) from
  // processing.
  const render = useCallback(() => {
    if (rafIdRef.current !== null) return;
    rafIdRef.current = requestAnimationFrame(() => {
      // rafIdRef.current is reset inside renderImmediate's finally block,
      // which covers both the success and exception paths.
      renderImmediate();
    });
  }, [renderImmediate]);

  // Attach the backend + observe size.
  //
  // NOTE: The dep array is intentionally [] (not [canvasRef.current, ...]).
  // Ref `.current` values are NOT reactive — React won't re-run the effect
  // when they change, so listing them as deps is incorrect and the backend
  // never re-attached when PresentationMode opened a new canvas (blank stage).
  // Instead we rely on:
  //   a) Reading current DOM nodes at effect run-time (set before paint).
  //   b) The `attachedRef.current === canvas` identity guard to skip
  //      redundant re-attaches (idempotent).
  //   c) The hook being mounted inside components that re-mount when the
  //      portal opens/closes (PresentationMode, SecondaryViewPane), so the
  //      [] effect re-runs naturally whenever a fresh canvas is mounted.
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
      renderImmediate();
    };
    const ro = new ResizeObserver(doResize);
    ro.observe(container);
    doResize();

    // The GPU backend initializes asynchronously; its first renderFrame before
    // that coalesces to a pending frame. Re-render once it's ready so the
    // preview isn't left blank when the comp is small or the container settled
    // before the device came up.
    let cancelled = false;
    backend.readyPromise?.then(() => {
      if (!cancelled && backendRef.current === backend) doResize();
    });

    // Re-render when animation changes (e.g. keyframe edits).
    const sub = getEventBus().on('AnimationChanged', () => render());

    teardownRef.current = () => {
      cancelled = true;
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      ro.disconnect();
      sub.dispose();
      backend.dispose();
      backendRef.current = null;
      attachedRef.current = null;
      teardownRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Final unmount teardown.
  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      teardownRef.current?.();
    };
  }, []);

  // Re-render on scene change, playhead move, focus change, guide toggle, or
  // camera view-mode flip (camera3dMode was previously missing — the 3D/2D
  // toggle never repainted this surface).
  useEffect(() => {
    render();
  }, [sceneRev, time, focusKey, rulers, grid, gridDivisions, gridColor, safeArea, camera3dMode, customViews, mbEnabled, mbShutter, mbSamples, compKey, render]);

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
