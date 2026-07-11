/**
 * useWorkspace — the React⇄Workspace-engine seam for the viewport.
 *
 * React owns only DOM elements (a content canvas + an overlay canvas + the
 * stage) and forwards raw pointer/wheel input to the engine. The engine does
 * everything else: camera, tools, selection, hit-testing, snapping. This hook
 * (1) renders scene content through the Canvas2D backend using the engine's
 * camera view, (2) paints the interaction overlay (selection, handles, marquee,
 * snap lines, hover) from `ws.overlay()`, and (3) feeds normalized input in.
 *
 * It supersedes the old `useViewportRenderer` (content-only, fixed fit) — one
 * render loop now drives both content and interaction (consolidated).
 */

import { useEffect, useRef } from 'react';
import { Canvas2DBackend } from '@core/rendering/Canvas2DBackend';
import { buildSnapshot, type SnapshotFocus } from '@core/rendering/buildSnapshot';
import type { WorkspaceOverlay } from '@motion/workspace';
import { modifiersFrom, type PointerInput, type WheelInput } from '@motion/workspace';
import renderCache from '@core/rendering/renderCache';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import defaultAnimation from '@core/animation/AnimationEngine';
import { getEventBus } from '@core/events/EventBus';
import { useGuidesStore } from '@stores/guidesStore';
import { useUIStore } from '@stores/uiStore';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';

export interface UseWorkspaceArgs {
  contentCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  overlayCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  stageRef: React.RefObject<HTMLElement | null>;
  sceneRev: number;
  time: number;
  focus?: SnapshotFocus;
  focusKey?: string;
}

export function useWorkspace(args: UseWorkspaceArgs): void {
  const { contentCanvasRef, overlayCanvasRef, stageRef, sceneRev, time, focus, focusKey } = args;

  const backendRef = useRef<Canvas2DBackend | null>(null);
  const dprRef = useRef(1);
  const timeRef = useRef(time);
  timeRef.current = time;
  const focusRef = useRef(focus);
  focusRef.current = focus;

  const rulers = useGuidesStore((s) => s.rulers);
  const grid = useGuidesStore((s) => s.grid);
  const safeArea = useGuidesStore((s) => s.safeArea);
  const overlaysRef = useRef({ rulers, grid, safeArea });
  overlaysRef.current = { rulers, grid, safeArea };

  // ── Backend attach + size + render loop (once) ─────────────────────
  useEffect(() => {
    const controller = getWorkspaceController();
    const content = contentCanvasRef.current;
    const overlay = overlayCanvasRef.current;
    const stage = stageRef.current;
    if (!content || !overlay || !stage) return;

    const backend = new Canvas2DBackend();
    backend.attach(content);
    backendRef.current = backend;

    const render = (): void => {
      const b = backendRef.current;
      if (!b) return;
      b.renderFrame(
        buildSnapshot(
          defaultSceneGraph,
          defaultAnimation,
          timeRef.current,
          focusRef.current,
          overlaysRef.current,
          controller.getView(),
        ),
      );
      renderCache.mark(timeRef.current);
      paintOverlay(overlay, controller.ws.overlay(), dprRef.current);
    };
    controller.onRender(render);

    let firstFit = true;
    const sizeAll = (): void => {
      const rect = stage.getBoundingClientRect();
      // Skip degenerate layouts (0×0 during mount/transition) so we never poison
      // the engine viewport to 1×1 or waste the one-shot fit-to-composition.
      if (rect.width < 1 || rect.height < 1) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      dprRef.current = dpr;
      backend.resize(rect.width, rect.height, dpr);
      overlay.width = Math.max(1, Math.round(rect.width * dpr));
      overlay.height = Math.max(1, Math.round(rect.height * dpr));
      overlay.style.width = `${rect.width}px`;
      overlay.style.height = `${rect.height}px`;
      controller.resize(rect.width, rect.height, dpr, firstFit);
      firstFit = false;
      render();
    };
    const ro = new ResizeObserver(sizeAll);
    ro.observe(stage);
    sizeAll();
    // Catch the size once layout settles (first frame after mount).
    const raf = requestAnimationFrame(sizeAll);

    // Content also depends on the animation engine (keyframe edits, playback).
    const animSub = getEventBus().on('AnimationChanged', () => controller.requestRender());
    // Reflect the engine cursor on the overlay (rich resize/rotate cursors).
    const cursorSub = controller.ws.cursor.events.on('changed', ({ css }) => {
      overlay.style.cursor = css;
    });
    overlay.style.cursor = controller.ws.cursor.css;

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      animSub.dispose();
      cursorSub.dispose();
      controller.onRender(() => {});
      backend.dispose();
      backendRef.current = null;
    };
  }, [contentCanvasRef, overlayCanvasRef, stageRef]);

  // ── Re-render on scene / playhead / guide changes ──────────────────
  useEffect(() => {
    getWorkspaceController().requestRender();
  }, [sceneRev, time, focusKey, rulers, grid, safeArea]);

  // ── Tool bar → engine tool ─────────────────────────────────────────
  useEffect(() => {
    const controller = getWorkspaceController();
    controller.applyUITool(useUIStore.getState().activeTool);
    return useUIStore.subscribe(
      (s) => s.activeTool,
      (tool) => controller.applyUITool(tool),
    );
  }, []);

  // ── Pointer + wheel input on the overlay canvas ────────────────────
  useEffect(() => {
    const controller = getWorkspaceController();
    const overlay = overlayCanvasRef.current;
    const stage = stageRef.current;
    if (!overlay || !stage) return;

    const local = (e: PointerEvent | WheelEvent): { x: number; y: number } => {
      const rect = stage.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const buttonName = (b: number): PointerInput['button'] =>
      b === 0 ? 'left' : b === 1 ? 'middle' : b === 2 ? 'right' : 'none';
    const toPointer = (e: PointerEvent): PointerInput => ({
      position: local(e),
      pointerType: e.pointerType === 'pen' || e.pointerType === 'touch' ? e.pointerType : 'mouse',
      button: buttonName(e.button),
      buttons: { left: (e.buttons & 1) !== 0, right: (e.buttons & 2) !== 0, middle: (e.buttons & 4) !== 0 },
      modifiers: modifiersFrom(e),
      pressure: e.pressure || 0.5,
      time: performance.now(),
      pointerId: e.pointerId,
    });

    const onDown = (e: PointerEvent): void => {
      if (e.button !== 0) return; // left-button interactions only
      try {
        overlay.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic or already-released pointer — capture is best-effort */
      }
      useUIStore.getState().setDragging(true);
      controller.ws.setFocused(true);
      controller.ws.feedPointerDown(toPointer(e));
    };
    const onMove = (e: PointerEvent): void => {
      controller.ws.feedPointerMove(toPointer(e));
    };
    const onUp = (e: PointerEvent): void => {
      try {
        if (overlay.hasPointerCapture(e.pointerId)) overlay.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      useUIStore.getState().setDragging(false);
      controller.ws.feedPointerUp(toPointer(e));
    };
    const onDoubleClick = (e: MouseEvent): void => {
      controller.ws.feedPointerUp({
        position: local(e as unknown as PointerEvent),
        pointerType: 'mouse',
        button: 'left',
        buttons: { left: false, right: false, middle: false },
        modifiers: modifiersFrom(e),
        pressure: 0.5,
        time: performance.now(),
        pointerId: 0,
      });
    };
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const w: WheelInput = {
        position: local(e),
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        isZoom: e.ctrlKey,
        modifiers: modifiersFrom(e),
        time: performance.now(),
      };
      controller.ws.feedWheel(w);
    };

    overlay.addEventListener('pointerdown', onDown);
    overlay.addEventListener('pointermove', onMove);
    overlay.addEventListener('pointerup', onUp);
    overlay.addEventListener('pointercancel', onUp);
    overlay.addEventListener('dblclick', onDoubleClick);
    overlay.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      overlay.removeEventListener('pointerdown', onDown);
      overlay.removeEventListener('pointermove', onMove);
      overlay.removeEventListener('pointerup', onUp);
      overlay.removeEventListener('pointercancel', onUp);
      overlay.removeEventListener('dblclick', onDoubleClick);
      overlay.removeEventListener('wheel', onWheel);
    };
  }, [overlayCanvasRef, stageRef]);
}

// ── Overlay painter ──────────────────────────────────────────────────
function paintOverlay(canvas: HTMLCanvasElement, overlay: WorkspaceOverlay, dpr: number): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);

  // Selection chrome follows the theme's selection token (white in the
  // monochrome dark theme, the accent in light) — not a hardcoded blue.
  const root = getComputedStyle(document.documentElement);
  const ACCENT = root.getPropertyValue('--color-selection').trim() || '#f2f2f3';
  const ACCENT_SOFT = root.getPropertyValue('--color-primary-subtle').trim() || 'rgba(255,255,255,0.14)';
  const HOVER = root.getPropertyValue('--color-border-strong').trim() || 'rgba(255,255,255,0.35)';
  const SNAP = '#ff3ba7';

  // Hover outline (only when it isn't the active selection).
  if (overlay.hoveredBounds) {
    ctx.strokeStyle = HOVER;
    ctx.lineWidth = 1;
    strokeRect(ctx, overlay.hoveredBounds);
  }

  // Marquee.
  if (overlay.marquee) {
    ctx.fillStyle = ACCENT_SOFT;
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.fillRect(overlay.marquee.x, overlay.marquee.y, overlay.marquee.width, overlay.marquee.height);
    strokeRect(ctx, overlay.marquee);
    ctx.setLineDash([]);
  }

  // Snap lines.
  if (overlay.snapLines.length) {
    ctx.strokeStyle = SNAP;
    ctx.lineWidth = 1;
    for (const l of overlay.snapLines) {
      ctx.beginPath();
      if (l.axis === 'x') {
        ctx.moveTo(l.position + 0.5, l.from);
        ctx.lineTo(l.position + 0.5, l.to);
      } else {
        ctx.moveTo(l.from, l.position + 0.5);
        ctx.lineTo(l.to, l.position + 0.5);
      }
      ctx.stroke();
    }
  }

  // Selection bounding box.
  if (overlay.selectionBounds) {
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.5;
    strokeRect(ctx, overlay.selectionBounds);
  }

  // Handles.
  for (const h of overlay.handles) {
    if (h.kind === 'rotate') {
      ctx.beginPath();
      ctx.arc(h.position.x, h.position.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else {
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1.5;
      ctx.fillRect(h.position.x - 4, h.position.y - 4, 8, 8);
      ctx.strokeRect(h.position.x - 4, h.position.y - 4, 8, 8);
    }
  }
}

function strokeRect(ctx: CanvasRenderingContext2D, r: { x: number; y: number; width: number; height: number }): void {
  ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.width, r.height);
}
