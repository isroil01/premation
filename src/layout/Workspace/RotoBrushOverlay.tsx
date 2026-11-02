/**
 * Roto Brush — the on-canvas half (Quick Selection, Selection Brush and
 * Refine Edge: the three brushes of the Object Matte group).
 *
 * Paint over the subject and the segmenter cuts a matte from your strokes;
 * Alt-paint marks background to take a piece back out. On release the stroke
 * edits the active subject's matte on this frame (`runSubjectEdit`) and
 * leaves the screen.
 *
 * ## What is not here
 *
 * No segmentation, no coordinate conversion to source pixels, no mask write:
 * that is `core/workspace/rotoBrushTool.ts`. This file is pointer plumbing,
 * SVG and one canvas — the part that cannot be unit-tested, and therefore
 * the part that should be smallest.
 *
 * ## Strokes live in LAYER-LOCAL pixels
 *
 * Screen coordinates would detach from the artwork the moment you pan, zoom or
 * scrub — and the segmenter wants source pixels anyway. Points are converted
 * once on the way in, through `layerScreenMapping` (the shared projection the
 * rig and effect-handle overlays use, which follows parenting AND animation),
 * and converted back for drawing.
 *
 * ## Brush feel
 *
 *   - the stroke in flight lives in a ref and is drawn by one rAF per frame
 *     (an SVG path, and for the Selection Brush its footprint on a canvas —
 *     what the matte will be, shown at once; the engine's result replaces
 *     it); the store gets ONE write per stroke, on release
 *   - every coalesced pointer sample is taken (`getCoalescedEvents`), so a
 *     fast stroke keeps its curves
 *   - a brush circle (size, and the hardness ring inside it) follows the
 *     pointer; `[` / `]` size it, Shift+`[` / `]` set the hardness, Ctrl-drag
 *     sizes it on the picture (Ctrl+Shift-drag: hardness)
 *   - a click (a press that did not move) waits out the double-click interval
 *     before it segments, as in After Effects, where a double-click opens the
 *     layer in the Layer panel; a stroke that moved applies at once
 *   - a job in flight (`busy`) queues the stroke made meanwhile rather than
 *     dropping it; a background walk (`tracking`) blocks nothing
 *
 * ## Why it takes the pointer
 *
 * `RotoTool` in the engine deliberately does nothing on pointer-down: a press
 * during a brush stroke must not start a marquee. This overlay is `inset: 0`
 * and claims the press, exactly as `PuppetOverlay` and `BoneOverlay` do for
 * their tools. It renders `null` unless a brush tool is active, so in every
 * other mode it is not in the DOM at all.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useUIStore } from '@stores/uiStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useActiveCompSize, useMirrorRevisionFrame } from '@hooks/useMirrorFrame';
import { useRestingTime } from '@hooks/useRestingTime';
import { useRotoBrushStore, type RotoStroke, type RotoStrokeKind } from '@stores/rotoBrushStore';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import { runSubjectEdit, type SubjectEditRequest } from '@core/workspace/rotoBrushTool';
import { activeSubjectId } from '@stores/subjectStore';
import { layerSubjects } from '@core/workspace/subjects';
import { secondsToFlicks } from '@motion/engine-api';
import { MAIN_VIEWPORT, overlayLayer } from '@stores/overlayGeometry';
import { openLayerOnDoubleClick } from '@layout/LayerViewer/openLayer';
import { useLayerScreenMapping } from './useLayerScreenMapping';
import { useDisplayedCamera2D } from './useOverlayView';
import { subjectBoundaryPath } from './subjectBoundary';
import { offerRefineEdgeMatting } from '@layout/Settings/objectMatteJob';
import { usePublishSubjectNotice } from './SubjectToolHud';
import { dragBrush, isClickTravel, stepBrushSize } from './brushFeel';
import styles from './RotoBrushOverlay.module.css';
import { t } from '@core/i18n';

/** How long a click waits for its second press (Windows' default is 500 ms). */
const DOUBLE_CLICK_MS = 350;
/** How far the second press may land from the first and still pair with it. */
const DOUBLE_CLICK_SLOP_PX = 6;
/** A press that travels further than this (screen px) is a stroke, never a click: it applies at once. */
const CLICK_SLOP_PX = 3;
/** Samples closer than this (layer px) to the last one are jitter, not path. */
const MIN_STEP_PX = 0.5;

type Pt = { x: number; y: number };
type BrushMode = 'snap' | 'exact' | 'refine';

/** The stroke in flight: layer-local points, and where the press started on screen. */
interface LiveStroke {
  kind: RotoStrokeKind;
  points: Pt[];
  startClient: Pt;
  maxTravel: number;
}

/** A Selection Brush footprint kept on the canvas until the engine's matte replaces it. */
interface Footprint {
  kind: RotoStrokeKind;
  points: Pt[];
  /** Screen px at the time it was painted (the brush size is a screen size). */
  size: number;
  hardness: number;
}

/** Paint one brush footprint (screen px) on the canvas: the subject's colour, soft when the brush is. */
function paintFootprint(ctx: CanvasRenderingContext2D, points: readonly Pt[], size: number, hardness: number, color: string, cut: boolean): void {
  if (points.length === 0) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = size;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.globalAlpha = cut ? 0.3 : 0.45;
  const soft = ((100 - hardness) / 100) * (size / 4);
  if (soft > 0.5 && 'filter' in ctx) ctx.filter = `blur(${soft.toFixed(1)}px)`;
  if (cut) ctx.setLineDash([Math.max(2, size / 3), Math.max(2, size / 3)]);
  if (points.length === 1) {
    ctx.beginPath();
    ctx.arc(points[0]!.x, points[0]!.y, size / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(points[0]!.x, points[0]!.y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i]!.x, points[i]!.y);
    ctx.stroke();
  }
  ctx.restore();
}

export function RotoBrushOverlay(): JSX.Element | null {
  const activeTool = useUIStore((s) => s.activeTool);
  // One overlay paints for the three brush tools of the Object Matte group.
  const active = activeTool === 'roto' || activeTool === 'selection-brush' || activeTool === 'refine-edge';
  return active ? <RotoBrushOverlayActive mode={activeTool === 'selection-brush' ? 'exact' : activeTool === 'refine-edge' ? 'refine' : 'snap'} /> : null;
}

function RotoBrushOverlayActive({ mode: brushMode }: { mode: BrushMode }): JSX.Element | null {
  const ids = useSelectionStore((s) => s.ids);
  const { time, playing } = useRestingTime();
  const comp = useActiveCompSize();
  const sceneTick = useMirrorRevisionFrame();

  const nodeId = ids.length === 1 ? ids[0]! : null;
  const strokes = useRotoBrushStore((s) => s.strokes);
  const size = useRotoBrushStore((s) => s.size);
  const hardness = useRotoBrushStore((s) => s.hardness);
  const status = useRotoBrushStore((s) => s.status);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const liveRef = useRef<LiveStroke | null>(null);
  const livePathRef = useRef<SVGPathElement | null>(null);
  const liveHaloRef = useRef<SVGPathElement | null>(null);
  const cursorRef = useRef<SVGGElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pointerRef = useRef<Pt | null>(null);
  const drawRaf = useRef<number | null>(null);
  const sizeDragRef = useRef<{ startX: number; size: number; hardness: number; what: 'size' | 'hardness' } | null>(null);
  // Selection Brush footprints awaiting the engine (stroke id → footprint), drawn at once.
  const footprintsRef = useRef<Map<string, Footprint>>(new Map());

  // Refine Edge offers its learned matting model once a session (it works without it).
  useEffect(() => {
    if (brushMode === 'refine') offerRefineEdgeMatting();
  }, [brushMode]);

  // Switching layer drops the strokes: they are in the OLD layer's local
  // pixels and mean nothing in the new one's.
  useEffect(() => {
    useRotoBrushStore.getState().setNode(nodeId);
    footprintsRef.current.clear();
  }, [nodeId]);

  // The comp ↔ stage mapping of the frame on screen: re-renders on a pan / zoom.
  const camera = useDisplayedCamera2D();
  const mapping = useLayerScreenMapping(nodeId, time, comp, camera, sceneTick);
  const subjectColor = useMemo(() => {
    if (!nodeId) return '#ff3fd4';
    const id = activeSubjectId(nodeId);
    return layerSubjects(nodeId).find((s) => s.id === id)?.color ?? '#ff3fd4';
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sceneTick: the subjects are read from the document at this revision
  }, [nodeId, sceneTick]);

  /** Client coords → layer-local px, or null when the projection is gone. */
  const toLocal = useCallback(
    (clientX: number, clientY: number): Pt | null => {
      const el = rootRef.current;
      if (!el || !mapping) return null;
      const r = el.getBoundingClientRect();
      return mapping.screenToLocal(clientX - r.left, clientY - r.top);
    },
    [mapping],
  );

  const pathOf = useCallback((points: readonly Pt[]): string => {
    if (!mapping) return '';
    let d = '';
    for (let i = 0; i < points.length; i++) {
      const sp = mapping.localToScreen(points[i]!.x, points[i]!.y);
      d += `${i === 0 ? 'M' : 'L'} ${sp.x.toFixed(1)} ${sp.y.toFixed(1)} `;
    }
    return d;
  }, [mapping]);

  /** The canvas, at the overlay's size and the display's pixel ratio. */
  const fitCanvas = useCallback((): CanvasRenderingContext2D | null => {
    const c = canvasRef.current;
    const root = rootRef.current;
    if (!c || !root) return null;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(root.clientWidth * dpr));
    const h = Math.max(1, Math.round(root.clientHeight * dpr));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }, []);

  /** Redraw the footprints (and the live Selection Brush stroke) through the current projection. */
  const paintCanvas = useCallback((): void => {
    const ctx = fitCanvas();
    if (!ctx || !mapping) return;
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    const toScreen = (pts: readonly Pt[]): Pt[] => pts.map((p) => mapping.localToScreen(p.x, p.y));
    for (const f of footprintsRef.current.values()) paintFootprint(ctx, toScreen(f.points), f.size, f.hardness, subjectColor, f.kind === 'bg');
    const live = liveRef.current;
    if (live && brushMode === 'exact') {
      const s = useRotoBrushStore.getState();
      paintFootprint(ctx, toScreen(live.points), s.size, s.hardness, subjectColor, live.kind === 'bg');
    }
  }, [fitCanvas, mapping, subjectColor, brushMode]);

  /** One frame's drawing: the cursor, the live stroke's path, the canvas. */
  const draw = useCallback((): void => {
    drawRaf.current = null;
    const cursor = cursorRef.current;
    const p = pointerRef.current;
    if (cursor) {
      cursor.setAttribute('transform', p ? `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})` : '');
      cursor.style.display = p ? '' : 'none';
    }
    const live = liveRef.current;
    const d = live && brushMode !== 'exact' ? pathOf(live.points) : '';
    livePathRef.current?.setAttribute('d', d);
    liveHaloRef.current?.setAttribute('d', d);
    livePathRef.current?.parentElement?.setAttribute('data-kind', live?.kind ?? 'fg');
    if (brushMode === 'exact') paintCanvas();
  }, [brushMode, pathOf, paintCanvas]);
  const scheduleDraw = useCallback((): void => {
    if (drawRaf.current === null) drawRaf.current = requestAnimationFrame(draw);
  }, [draw]);
  useEffect(() => () => {
    if (drawRaf.current !== null) cancelAnimationFrame(drawRaf.current);
  }, []);
  // A pan, zoom, scrub or resize re-projects the footprints.
  useEffect(() => {
    if (brushMode !== 'exact') return;
    paintCanvas();
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => paintCanvas());
    ro.observe(root);
    return () => ro.disconnect();
  }, [brushMode, paintCanvas]);

  /**
   * One stroke edits the subject's matte on this frame, then leaves the
   * screen: Quick Selection grows it to the subject's edges (the model, from
   * a few points along the stroke), Selection Brush paints exactly the
   * brush's footprint, Refine Edge works out soft alpha (hair) in the band
   * it covers. Alt-strokes subtract (Refine Edge has no subtract).
   *
   * While a job is in flight the stroke waits for it (one pending press, the
   * newest wins) rather than being dropped.
   */
  const applyStroke = useCallback((stroke: RotoStroke, radius: number) => {
    if (!nodeId) return;
    const run = (): void => {
      const store = useRotoBrushStore.getState();
      store.setBusy(true);
      store.setStatus(brushMode === 'refine'
        ? t('workspace.refineEdge.working', 'Refining the edge…')
        : t('workspace.rotoBrush.segmenting', 'Segmenting…'));
      const tool = brushMode === 'snap' ? 'segment' : brushMode === 'exact' ? 'paint' : 'refine';
      // `hardness` rides beside the request for the engine's paint / refine edit (0…100).
      const req: SubjectEditRequest & { hardness: number } = {
        tool,
        op: stroke.kind === 'bg' ? 'subtract' : 'add',
        strokes: [stroke.points],
        radius,
        hardness: stroke.hardness ?? 100,
      };
      void runSubjectEdit(nodeId, time, req, activeSubjectId(nodeId))
        .then((r) => {
          const s = useRotoBrushStore.getState();
          s.setStatus(r && r.coverage > 0 ? null : t('workspace.rotoBrush.nothing', 'Nothing selected there — paint through the middle of the subject.'));
          getWorkspaceController().requestRender();
        })
        .catch((err: unknown) => {
          useRotoBrushStore.getState().setStatus(err instanceof Error ? err.message : t('workspace.rotoBrush.failed', 'Segmentation failed.'));
        })
        .finally(() => {
          const s = useRotoBrushStore.getState();
          s.removeStroke(stroke.id);
          // The engine's matte is on screen now: the instant footprint gives way to it.
          footprintsRef.current.delete(stroke.id);
          scheduleDraw();
          s.setBusy(false);
        });
    };
    if (!useRotoBrushStore.getState().queuePress(run)) {
      useRotoBrushStore.getState().setStatus(t('workspace.rotoBrush.queued', 'Queued — applies when the current stroke finishes.'));
    }
  }, [nodeId, time, brushMode, scheduleDraw]);

  /** The brush's screen radius, in layer px (the strokes' space). */
  const radiusLocal = useCallback((): number => {
    const size = useRotoBrushStore.getState().size;
    const a = mapping?.screenToLocal(0, 0);
    const b = mapping?.screenToLocal(size / 2, 0);
    return a && b ? Math.hypot(b.x - a.x, b.y - a.y) : size / 2;
  }, [mapping]);

  /**
   * A CLICK (a press that never moved) waits out the double-click interval
   * before it segments: a second press on the layer inside it makes the pair a
   * double-click, which — as in After Effects, where the Roto Brush works in
   * the Layer panel — opens the layer there instead, taking the click back.
   * A stroke that moved cannot be a double-click: it applies at once.
   */
  const pendingClickRef = useRef<{ timer: number; stroke: RotoStroke; radius: number; x: number; y: number } | null>(null);
  const flushPendingClick = useCallback((): void => {
    const pending = pendingClickRef.current;
    if (!pending) return;
    window.clearTimeout(pending.timer);
    pendingClickRef.current = null;
    applyStroke(pending.stroke, pending.radius);
  }, [applyStroke]);
  useEffect(() => () => {
    if (pendingClickRef.current) window.clearTimeout(pendingClickRef.current.timer);
    pendingClickRef.current = null;
  }, [nodeId]);

  const finishStroke = useCallback((e?: { clientX: number; clientY: number }) => {
    if (sizeDragRef.current) {
      sizeDragRef.current = null;
      return;
    }
    const live = liveRef.current;
    if (!live) return;
    liveRef.current = null;
    scheduleDraw();
    if (!nodeId) return;
    const store = useRotoBrushStore.getState();
    // ONE store write per stroke: the committed stroke (drawn until the engine answers).
    const done = store.addStroke(live.kind, live.points, time);
    const radius = radiusLocal();
    if (brushMode === 'exact') {
      footprintsRef.current.set(done.id, { kind: done.kind, points: done.points, size: store.size, hardness: store.hardness });
      scheduleDraw();
    }
    if (isClickTravel(live.maxTravel, CLICK_SLOP_PX) && e) {
      // A click waits out the double-click interval (a double-click opens the Layer panel).
      pendingClickRef.current = {
        stroke: done,
        radius,
        x: e.clientX,
        y: e.clientY,
        timer: window.setTimeout(() => {
          pendingClickRef.current = null;
          applyStroke(done, radius);
        }, DOUBLE_CLICK_MS),
      };
      return;
    }
    applyStroke(done, radius);
  }, [nodeId, time, brushMode, applyStroke, radiusLocal, scheduleDraw]);

  /** A second press close to a pending click: open the layer, if it is under it. */
  const takeDoubleClick = (e: React.PointerEvent<HTMLDivElement>): boolean => {
    const pending = pendingClickRef.current;
    if (!pending || !nodeId) return false;
    if (Math.hypot(e.clientX - pending.x, e.clientY - pending.y) > DOUBLE_CLICK_SLOP_PX) {
      flushPendingClick();
      return false;
    }
    const r = rootRef.current?.getBoundingClientRect();
    // On the layer: the click, taken into the layer's own space (the frame's projection), falls in its drawn box.
    const box = overlayLayer(MAIN_VIEWPORT, nodeId, secondsToFlicks(time))?.box;
    const local = r && mapping ? mapping.screenToLocal(e.clientX - r.left, e.clientY - r.top) : null;
    const onLayer = !!local && !!box && box.length >= 4
      && local.x >= box[0]! && local.x <= box[0]! + box[2]! && local.y >= box[1]! && local.y <= box[1]! + box[3]!;
    if (!onLayer) {
      flushPendingClick();
      return false;
    }
    window.clearTimeout(pending.timer);
    pendingClickRef.current = null;
    if (!openLayerOnDoubleClick(nodeId, { alt: e.altKey })) {
      // Nothing opened: the click was a click after all.
      applyStroke(pending.stroke, pending.radius);
      return false;
    }
    useRotoBrushStore.getState().removeStroke(pending.stroke.id);
    footprintsRef.current.delete(pending.stroke.id);
    scheduleDraw();
    return true;
  };

  // A pointer-up outside the stage still ends the stroke; without this a drag
  // released over the timeline left the brush "down" forever.
  useEffect(() => {
    const onUp = (): void => finishStroke();
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [finishStroke]);

  // `[` / `]` size the brush; with Shift they set the hardness (Photoshop's keys).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== '[' && e.key !== ']') return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      const s = useRotoBrushStore.getState();
      const up = e.key === ']';
      if (e.shiftKey) s.setHardness(s.hardness + (up ? 10 : -10));
      else s.setSize(stepBrushSize(s.size, up));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /** Append the pointer's samples (coalesced: every one the OS delivered) to the live stroke. */
  const extendLive = (e: React.PointerEvent<HTMLDivElement>): void => {
    const live = liveRef.current;
    if (!live) return;
    const native = e.nativeEvent as PointerEvent & { getCoalescedEvents?: () => PointerEvent[] };
    const samples = typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : [];
    const list = samples.length > 0 ? samples : [native];
    for (const s of list) {
      const p = toLocal(s.clientX, s.clientY);
      if (!p) continue;
      const last = live.points[live.points.length - 1];
      // Skip sub-pixel jitter so a slow drag does not become a thousand points.
      if (last && Math.hypot(last.x - p.x, last.y - p.y) < MIN_STEP_PX) continue;
      live.points.push(p);
    }
    live.maxTravel = Math.max(live.maxTravel, Math.hypot(e.clientX - live.startClient.x, e.clientY - live.startClient.y));
  };

  const strokePath = (s: RotoStroke): string => pathOf(s.points);
  // Selection Brush strokes show as their footprint on the canvas, not as a line.
  const shown = brushMode === 'exact' ? strokes.filter((s) => !footprintsRef.current.has(s.id)) : strokes;
  // What to tell the user goes to the status bar, not over the picture (SubjectToolHud.tsx).
  const busy = useRotoBrushStore((s) => s.busy);
  usePublishSubjectNotice(!nodeId
    ? t('workspace.rotoBrush.selectLayer', 'Select one footage layer to roto.')
    : playing
      ? t('workspace.rotoBrush.playing', 'Stop playback to paint.')
      : status, busy);

  return (
    <div
      ref={rootRef}
      className={styles.root}
      data-roto-overlay=""
      data-brush-mode={brushMode}
      onPointerDown={(e) => {
        if (e.button !== 0 || !nodeId || playing) return;
        if (takeDoubleClick(e)) {
          e.preventDefault();
          return;
        }
        const p = toLocal(e.clientX, e.clientY);
        if (!p) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        // Ctrl-drag sizes the brush on the picture (Ctrl+Shift: its hardness) — the paint tool's gesture.
        if (e.ctrlKey || e.metaKey) {
          const s = useRotoBrushStore.getState();
          sizeDragRef.current = { startX: e.clientX, size: s.size, hardness: s.hardness, what: e.shiftKey ? 'hardness' : 'size' };
          return;
        }
        // Alt flips the meaning of THIS stroke without changing the tool's
        // default — the same "temporary opposite" Alt has everywhere else.
        const kind: RotoStrokeKind = e.altKey ? 'bg' : useRotoBrushStore.getState().kind;
        liveRef.current = { kind: brushMode === 'refine' ? 'fg' : kind, points: [p], startClient: { x: e.clientX, y: e.clientY }, maxTravel: 0 };
        scheduleDraw();
      }}
      onPointerMove={(e) => {
        const r = rootRef.current?.getBoundingClientRect();
        if (r) pointerRef.current = { x: e.clientX - r.left, y: e.clientY - r.top };
        const sizing = sizeDragRef.current;
        if (sizing) {
          const next = dragBrush({ size: sizing.size, hardness: sizing.hardness }, e.clientX - sizing.startX, sizing.what);
          const s = useRotoBrushStore.getState();
          if (sizing.what === 'size') s.setSize(next.size);
          else s.setHardness(next.hardness);
        } else if (liveRef.current) {
          extendLive(e);
        }
        scheduleDraw();
      }}
      onPointerUp={(e) => finishStroke(e)}
      onPointerLeave={() => {
        pointerRef.current = null;
        scheduleDraw();
      }}
    >
      {brushMode === 'exact' && <canvas ref={canvasRef} className={styles.footprint} aria-hidden="true" />}
      <svg className={styles.svg} aria-hidden="true">
        {nodeId && mapping && <path className={styles.boundary} d={subjectBoundaryPath(nodeId, time, mapping.localToScreen)} />}
        {shown.map((s) => {
          const d = strokePath(s);
          if (!d) return null;
          return (
            <g key={s.id}>
              <path className={styles.halo} d={d} strokeWidth={size + 2} />
              <path className={s.kind === 'fg' ? styles.fg : styles.bg} d={d} strokeWidth={size} />
            </g>
          );
        })}
        {/* The stroke in flight: its path data is set by the rAF, never by React. */}
        <g className={styles.live} data-live-stroke="">
          <path ref={liveHaloRef} className={styles.halo} strokeWidth={size + 2} />
          <path ref={livePathRef} className={styles.liveStroke} strokeWidth={size} />
        </g>
        {/* The brush: its size, and the hardness ring inside it; translated by the rAF. */}
        <g ref={cursorRef} className={styles.cursor} data-brush-cursor="" style={{ display: 'none' }}>
          <circle className={styles.cursorHalo} r={size / 2 + 0.75} />
          <circle className={styles.cursorRing} r={size / 2} />
          {hardness < 100 && <circle className={styles.cursorHardness} r={Math.max(0.5, (size / 2) * (hardness / 100))} />}
          <circle className={styles.cursorDot} r={1} />
        </g>
      </svg>
    </div>
  );
}
