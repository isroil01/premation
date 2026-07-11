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
import { Canvas2DBackend } from '@core/rendering/Canvas2DBackend';
import { buildSnapshot, type SnapshotFocus } from '@core/rendering/buildSnapshot';
import renderCache from '@core/rendering/renderCache';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import defaultAnimation from '@core/animation/AnimationEngine';
import { getEventBus } from '@core/events/EventBus';
import { useGuidesStore } from '@stores/guidesStore';

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
  const backendRef = useRef<Canvas2DBackend | null>(null);
  const timeRef = useRef(time);
  timeRef.current = time;
  const focusRef = useRef(focus);
  focusRef.current = focus;

  // Guide overlays — subscribe so the consuming component re-renders on toggle.
  const rulers = useGuidesStore((s) => s.rulers);
  const grid = useGuidesStore((s) => s.grid);
  const safeArea = useGuidesStore((s) => s.safeArea);
  const overlaysRef = useRef({ rulers, grid, safeArea });
  overlaysRef.current = { rulers, grid, safeArea };

  const render = useCallback(() => {
    const b = backendRef.current;
    if (!b) return;
    b.renderFrame(
      buildSnapshot(defaultSceneGraph, defaultAnimation, timeRef.current, focusRef.current, overlaysRef.current),
    );
    // The rendered frame is now cached (feeds the timeline cache bar).
    renderCache.mark(timeRef.current);
  }, []);

  // Attach the backend + observe size (once).
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const backend = new Canvas2DBackend();
    backend.attach(canvas);
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

    return () => {
      ro.disconnect();
      sub.dispose();
      backend.dispose();
      backendRef.current = null;
    };
  }, [render, canvasRef, containerRef]);

  // Re-render on scene change, playhead move, focus change, or guide toggle.
  useEffect(() => {
    render();
  }, [sceneRev, time, focusKey, rulers, grid, safeArea, render]);
}
