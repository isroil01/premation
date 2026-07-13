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
import { createRenderBackend } from '@core/rendering/createRenderBackend';
import type { RenderBackend } from '@core/rendering/RenderBackend';
import { buildSnapshot, type SnapshotFocus } from '@core/rendering/buildSnapshot';
import type { WorkspaceOverlay } from '@motion/workspace';
import { modifiersFrom, type PointerInput, type WheelInput } from '@motion/workspace';
import renderCache from '@core/rendering/renderCache';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { getEventBus } from '@core/events/EventBus';
import { useGuidesStore } from '@stores/guidesStore';
import { useMotionBlurStore } from '@stores/motionBlurStore';
import { useRenderQualityStore } from '@stores/renderQualityStore';
import { useCompositionStore } from '@stores/compositionStore';
import { useUIStore } from '@stores/uiStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useRenderBackendStore } from '@stores/renderBackendStore';
import { getWorkspaceController, type WorkspaceController } from '@core/workspace/WorkspaceController';
import {
  hasPositionAnimation,
  motionPathSamples,
  motionPathKeyframes,
  positionSamplerFor,
} from '@core/motion/motionPath';
import { runAnimEdit } from '@core/animation/animationCommands';

/** Comp frame rate used for motion-blur sub-frame sampling (matches timeline). */
const MOTION_BLUR_FPS = 60;

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

  const backendRef = useRef<RenderBackend | null>(null);
  const dprRef = useRef(1);
  // Which render backend to build (Canvas2D vs experimental GPU). Changing it
  // re-runs the mount effect below, rebuilding the backend onto the new choice.
  const backendChoice = useRenderBackendStore((s) => s.choice);
  // Active on-canvas motion-path keyframe drag (E4): { nodeId, t } or null.
  const mpDragRef = useRef<{ nodeId: string; t: number } | null>(null);
  const timeRef = useRef(time);
  timeRef.current = time;
  const focusRef = useRef(focus);
  focusRef.current = focus;

  const rulers = useGuidesStore((s) => s.rulers);
  const grid = useGuidesStore((s) => s.grid);
  const gridDivisions = useGuidesStore((s) => s.gridDivisions);
  const safeArea = useGuidesStore((s) => s.safeArea);
  const camera3dMode = useGuidesStore((s) => s.camera3dMode);
  const overlaysRef = useRef({ rulers, grid, gridDivisions, safeArea });
  overlaysRef.current = { rulers, grid, gridDivisions, safeArea };

  const mbEnabled = useMotionBlurStore((s) => s.enabled);
  const mbShutter = useMotionBlurStore((s) => s.shutterAngle);
  const mbSamples = useMotionBlurStore((s) => s.samples);
  // Draft preview quality skips the expensive motion-blur multi-sample pass.
  const draft = useRenderQualityStore((s) => s.draft);
  const motionBlurRef = useRef({ enabled: mbEnabled && !draft, shutterAngle: mbShutter, samples: mbSamples, fps: MOTION_BLUR_FPS });
  motionBlurRef.current = { enabled: mbEnabled && !draft, shutterAngle: mbShutter, samples: mbSamples, fps: MOTION_BLUR_FPS };

  // Composition settings (size + background) feed the snapshot; `compKey`
  // changes whenever a render-affecting field does, re-triggering the render.
  const compKey = useCompositionStore((s) => s.key());
  const compRef = useRef(useCompositionStore.getState().comp());
  compRef.current = useCompositionStore.getState().comp();

  // ── Backend attach + size + render loop (once) ─────────────────────
  useEffect(() => {
    const controller = getWorkspaceController();
    const content = contentCanvasRef.current;
    const overlay = overlayCanvasRef.current;
    const stage = stageRef.current;
    if (!content || !overlay || !stage) return;

    const backend = createRenderBackend(backendChoice);
    backend.attach(content);
    backend.setPreviewChrome?.(true);
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
          motionBlurRef.current,
          { ...compRef.current, camera3dMode },
        ),
      );
      renderCache.mark(timeRef.current);
      paintOverlay(overlay, controller.ws.overlay(), dprRef.current);
      paintMotionPath(overlay, controller, timeRef.current, dprRef.current);
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
  }, [contentCanvasRef, overlayCanvasRef, stageRef, backendChoice]);

  // ── Re-render on scene / playhead / guide changes ──────────────────
  useEffect(() => {
    getWorkspaceController().requestRender();
  }, [sceneRev, time, focusKey, rulers, grid, gridDivisions, safeArea, draft, mbEnabled, mbShutter, mbSamples, compKey]);

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
      // E4: grabbing a motion-path keyframe dot starts a local drag that edits
      // the keyframe directly (the engine never sees it, so it can't also
      // move/marquee the layer).
      const hit = hitMotionPathKeyframe(controller, local(e));
      if (hit) {
        mpDragRef.current = hit;
        try {
          overlay.setPointerCapture(e.pointerId);
        } catch {
          /* best-effort */
        }
        useUIStore.getState().setDragging(true);
        return;
      }
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
      const drag = mpDragRef.current;
      if (drag) {
        const w = controller.ws.screenToWorld(local(e));
        // One coalesced undo step for the whole drag (stable merge key), moving
        // the point in 2D (both axis tracks get a key at this time).
        runAnimEdit(
          'Move keyframe',
          () => {
            defaultAnimation.setKeyframe(drag.nodeId, 'x', drag.t, w.x);
            defaultAnimation.setKeyframe(drag.nodeId, 'y', drag.t, w.y);
          },
          `mpdrag:${drag.nodeId}:${drag.t}`,
        );
        return;
      }
      controller.ws.feedPointerMove(toPointer(e));
    };
    const onUp = (e: PointerEvent): void => {
      try {
        if (overlay.hasPointerCapture(e.pointerId)) overlay.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      if (mpDragRef.current) {
        mpDragRef.current = null;
        useUIStore.getState().setDragging(false);
        return;
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
    } else if (h.kind === 'point') {
      // Vertex anchor: filled square
      ctx.fillStyle = ACCENT;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.fillRect(h.position.x - 4, h.position.y - 4, 8, 8);
      ctx.strokeRect(h.position.x - 4, h.position.y - 4, 8, 8);
    } else if (h.kind === 'tangent-in' || h.kind === 'tangent-out') {
      // Tangent handle: circle
      ctx.beginPath();
      ctx.arc(h.position.x, h.position.y, 4, 0, Math.PI * 2);
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

  // Draw tangent arm lines (connect vertex to its tangent handles)
  // We pair them by looking for handles with same node+index prefix
  const vertMap = new Map<string, { x: number; y: number }>();
  for (const h of overlay.handles) {
    if (h.kind === 'point') {
      // e.g. "vert_nodeId_i"
      const key = h.id.replace(/^vert_/, '');
      vertMap.set(key, h.position);
    }
  }
  for (const h of overlay.handles) {
    if (h.kind === 'tangent-in' || h.kind === 'tangent-out') {
      // e.g. "tin_nodeId_i" or "tout_nodeId_i"
      const key = h.id.replace(/^t(?:in|out)_/, '');
      const vert = vertMap.get(key);
      if (vert) {
        ctx.beginPath();
        ctx.moveTo(vert.x, vert.y);
        ctx.lineTo(h.position.x, h.position.y);
        ctx.strokeStyle = 'rgba(90,140,255,0.7)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  // Pending Path (Pen Tool) — drawn as live bezier preview
  if (overlay.pendingPath && overlay.pendingPath.length > 0) {
    const pts = overlay.pendingPath as Array<{x:number;y:number;inX:number;inY:number;outX:number;outY:number}>;

    // Draw the committed bezier curve segments
    if (pts.length >= 2) {
      ctx.beginPath();
      ctx.moveTo(pts[0]!.x, pts[0]!.y);
      for (let i = 0; i < pts.length - 1; i++) {
        const curr = pts[i]!;
        const next = pts[i + 1]!;
        ctx.bezierCurveTo(curr.outX, curr.outY, next.inX, next.inY, next.x, next.y);
      }
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Draw tangent arms + handles for each committed point
    for (const pt of pts) {
      const hasTangent = pt.outX !== pt.x || pt.outY !== pt.y;
      if (hasTangent) {
        // Out-handle arm
        ctx.beginPath();
        ctx.moveTo(pt.x, pt.y);
        ctx.lineTo(pt.outX, pt.outY);
        ctx.strokeStyle = 'rgba(90,140,255,0.7)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
        // In-handle arm
        ctx.beginPath();
        ctx.moveTo(pt.x, pt.y);
        ctx.lineTo(pt.inX, pt.inY);
        ctx.strokeStyle = 'rgba(90,140,255,0.7)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
        // Tangent handle dots
        ctx.beginPath();
        ctx.arc(pt.outX, pt.outY, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(pt.inX, pt.inY, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      // Anchor square
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1.5;
      ctx.fillRect(pt.x - 3, pt.y - 3, 6, 6);
      ctx.strokeRect(pt.x - 3, pt.y - 3, 6, 6);
    }
  }
}

/**
 * Hit-test the selected layer's motion-path keyframe dots at a screen point
 * (within a small radius). Returns the { nodeId, t } of the grabbed keyframe,
 * or null. Used to start an on-canvas keyframe drag.
 */
function hitMotionPathKeyframe(
  controller: WorkspaceController,
  screen: { x: number; y: number },
): { nodeId: string; t: number } | null {
  const ids = useSelectionStore.getState().ids;
  if (ids.length !== 1) return null;
  const nodeId = ids[0]!;
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node || !hasPositionAnimation(nodeId)) return null;
  const R = 8; // grab radius, screen px
  for (const k of motionPathKeyframes(node)) {
    const s = controller.ws.worldToScreen({ x: k.x, y: k.y });
    if (Math.hypot(s.x - screen.x, s.y - screen.y) <= R) return { nodeId, t: k.t };
  }
  return null;
}

/**
 * Motion path (E4) — draws the selected layer's animated-position trajectory
 * over the interaction overlay: a spatial curve through the sampled positions,
 * a dot at each keyframe, and a marker at the current playhead position. Comp
 * positions are projected to screen through the camera. Only shows for a single
 * selection that actually has a position animation.
 */
function paintMotionPath(
  canvas: HTMLCanvasElement,
  controller: WorkspaceController,
  time: number,
  dpr: number,
): void {
  const ids = useSelectionStore.getState().ids;
  if (ids.length !== 1) return;
  const nodeId = ids[0]!;
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node || !hasPositionAnimation(nodeId)) return;
  const samples = motionPathSamples(node);
  if (samples.length < 2) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // draw ON TOP of the overlay (no clear)
  const toS = (p: { x: number; y: number }): { x: number; y: number } =>
    controller.ws.worldToScreen({ x: p.x, y: p.y });

  // Trajectory curve.
  ctx.beginPath();
  const s0 = toS(samples[0]!);
  ctx.moveTo(s0.x, s0.y);
  for (let i = 1; i < samples.length; i++) {
    const s = toS(samples[i]!);
    ctx.lineTo(s.x, s.y);
  }
  ctx.strokeStyle = 'rgba(120,170,255,0.9)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Keyframe dots.
  for (const k of motionPathKeyframes(node)) {
    const s = toS(k);
    ctx.beginPath();
    ctx.arc(s.x, s.y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.strokeStyle = 'rgba(120,170,255,1)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Current-position marker at the playhead.
  const cur = toS(positionSamplerFor(node)(time));
  ctx.beginPath();
  ctx.arc(cur.x, cur.y, 5, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,214,90,1)';
  ctx.lineWidth = 2;
  ctx.stroke();
}

function strokeRect(ctx: CanvasRenderingContext2D, r: { x: number; y: number; width: number; height: number }): void {
  ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.width, r.height);
}
