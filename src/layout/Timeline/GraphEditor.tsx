/**
 * GraphEditor — After Effects–style Value/Speed graph editor.
 *
 * Features:
 *  - Value mode: shows animated property curves as SVG paths sampled per segment
 *    (so the curve passes exactly through every keyframe, holds draw as steps).
 *  - Speed mode: shows the speed magnitude (|dv/dt|) of the curve; a keyframe
 *    whose in/out speeds differ shows the AE-style vertical jump.
 *  - Keyframe diamonds: drag horizontally to retime (frame-snapped, never past a
 *    neighbour), vertically to change the value (value mode) or speed (speed mode).
 *    Shift constrains to one axis while dragging; Shift-click toggles multi-select
 *    (shared with the timeline via keyframeSelectionStore). Dragging any diamond
 *    in a multi-selection moves the whole set in time (and value, in value mode).
 *    Time snaps to playhead / other keys / frames; value snaps to other keys /
 *    zero. Alt disables snapping. Guide lines show the active snap target.
 *  - Bézier handles: drag to shape the curve. Linked keyframes keep both sides
 *    collinear (value) / equal speed (speed); Alt-drag breaks the link.
 *  - The vertical range is FROZEN for the whole drag — the graph no longer re-fits
 *    under the cursor — and re-fits on release (AE "auto-zoom graph height").
 *  - Toolbar: Easy Ease / In / Out / Linear / Hold, numeric t / value / in+out
 *    speed & influence fields (each field edits ONLY its own side), link toggle.
 *    Easing presets apply to the multi-keyframe selection (same set as F9).
 *  - Click-drag on the background scrubs the playhead. Alt-drag draws a box
 *    zoom (time span → fill viewport), matching AE’s graph box-zoom gesture.
 *  - Selected keyframes always show value labels; at high horizontal zoom every
 *    in-view diamond gets a label too.
 *  - Legend chips solo a curve (click) or toggle into a multi-solo set (Shift).
 *  - Click a curve body (not a diamond) to select the nearest keyframe on that
 *    track — Shift toggles it into the multi-selection, same as diamonds.
 *
 * Interaction notes (the bugs this design exists to avoid):
 *  - Pointer capture is taken on the <svg>, not the grabbed element. Diamonds
 *    re-mount while they retime, and capture on a removed element is lost.
 *  - All drags are ORIGIN + DELTA: the grabbed thing's start position plus the
 *    pointer's movement since pointer-down. Absolute pointer→value mapping made
 *    the thing jump to the cursor hotspot on the first move.
 *  - The <svg> is CSS-translated by -scrollLeft, so getBoundingClientRect()
 *    already accounts for scroll: client - rect.left IS the svg x coordinate.
 */

import { useState, useRef, useCallback, useMemo, useEffect, useLayoutEffect } from 'react';
import { Icon } from '@components/Icon';
import { defaultAnimation, makeKeyframeId, parseKeyframeId, EASY_EASE_BEZIER, EASY_EASE_IN_BEZIER, EASY_EASE_OUT_BEZIER } from '@motion/animation';
import { beginAnimEdit, recordAnimEdit, runAnimEdit } from '@core/animation/animationCommands';
import { type EasingPreset } from '@core/animation/keyframeAssistants';
import { applyEasingToSelection } from '@core/animation/easingSelection';
import { useKeyframeSelectionStore } from '@stores/keyframeSelectionStore';
import { compToKeyframeTime, keyframeToCompTime } from '@core/timeline/TimelineController';
import { clamp } from '@utils/lang';
import { ValueField } from '@components/ValueField';
import { useSceneRevision } from '@stores/sceneStore';
import {
  withOutgoingSpeed,
  withIncomingSpeed,
  withOutgoingInfluence,
  withIncomingInfluence,
  withOutgoingSlope,
  withIncomingSlope,
  outgoingSpeed,
  incomingSpeed,
  outgoingSlope,
  incomingSlope,
  effectiveBezier,
  isHoldEasing,
  type Bezier,
} from './speedGraph';
import { snapKeyframeTime, snapKeyframeValue, type SnapTarget, type ValueSnapTarget } from './keyframeSnap';
import { computeBoxZoomFromSvg } from './graphBoxZoom';
import { nearestKeyframeOnCurve } from './graphCurveClick';
import {
  planGraphGroupTimes,
  applyGroupValueDelta,
  type GraphGroupMemberStart,
} from './graphGroupMove';
import { useResizeObserver } from '@hooks/useResizeObserver';
import styles from './GraphEditor.module.css';

export interface GraphEditorProps {
  selectedNodeIds: ReadonlyArray<string>;
  currentTime: number;
  duration: number;
  pixelsPerSecond: number;
  scrollLeft: number;
  /** The graph scrolled itself (wheel / scrollbar) — keep the host's scroll state in step. */
  onScrollChange?: (scrollLeft: number) => void;
  /** Ctrl/⌘ + wheel zoom (pixels per second). Omit to disable. */
  onZoom?: (pixelsPerSecond: number) => void;
  /** Comp frame rate — keyframe retimes snap to this grid. */
  frameRate?: number;
  height?: number;
  onScrub?: (t: number) => void;
}

interface KfPoint {
  nodeId: string;
  prop: string;
  index: number;
  t: number;
  value: number;
  /** What is plotted on the y axis: the value, or (speed mode) the outgoing speed. */
  plotted: number;
  tAbs: number;
  y: number;
  minV: number;
  maxV: number;
  easing?: string;
  bezier?: [number, number, number, number];
  continuous?: boolean;
  inSpeed?: number;
  outSpeed?: number;
  inInfluence?: number;
  outInfluence?: number;
}

interface SelectedKf {
  nodeId: string;
  prop: string;
  t: number;
}

/** Keep keyframeSelectionStore ids valid when a diamond’s time (embedded in the id) changes. */
function rewriteSelectedKeyframeId(oldId: string, newId: string): void {
  if (oldId === newId) return;
  const store = useKeyframeSelectionStore.getState();
  if (!store.ids.has(oldId)) return;
  const next = new Set(store.ids);
  next.delete(oldId);
  next.add(newId);
  store.set(next);
}

interface Range {
  minV: number;
  maxV: number;
}

type DragKind = 'kf' | 'handle-in' | 'handle-out' | 'scrub' | 'box-zoom';

interface DragState {
  kind: DragKind;
  pointerId: number;
  nodeId: string;
  prop: string;
  /** Current layer time of the anchor keyframe (updated as a retime progresses). */
  kfT: number;
  origValue: number;
  /** svg coords of the grabbed thing (diamond / handle) at pointer-down. */
  ox: number;
  oy: number;
  /** svg coords of the pointer at pointer-down. */
  px0: number;
  py0: number;
  minV: number;
  maxV: number;
  mode: 'value' | 'speed';
  moved: boolean;
  tx?: ReturnType<typeof beginAnimEdit>;
  /** Live box-zoom corner (svg); start corner is ox/oy. */
  boxX?: number;
  boxY?: number;
  /** Multi-select body at pointer-down (origin+delta). Absent = single diamond. */
  group?: GraphGroupMemberStart[];
  /** Index of the grabbed diamond inside `group`. */
  grabIndex?: number;
  /** Current layer times for `group` members (parallel; mutated while dragging). */
  groupCurrentT?: number[];
}

/** Fixed multi-curve series palette (data-viz, not chrome) — shared across themes. */
const COLORS = ['#2988ff', '#ff6b6b', '#4cdf8e', '#ffd770', '#bf8cff', '#ff8cde'];
const GRAPH_HEIGHT_DEFAULT = 200;
const HANDLE_RADIUS = 4.5;
/** Invisible grab radius around handles / diamonds — AE-sized hit targets. */
const HIT_RADIUS = 10;
const KF_SIZE = 8;
/** Show value labels next to every in-view diamond once zoomed in this far. */
const LABEL_PPS = 120;
const GRAPH_PPS_MIN = 4;
const GRAPH_PPS_MAX = 800;
/** Pointer must travel this far before a press becomes a drag (click ≠ nudge). */
const DRAG_DEAD_ZONE_PX = 2;
/** Handle y is clamped to this band around the segment (overshoot allowed, runaway not). */
const MIN_HANDLE_Y = -2;
const MAX_HANDLE_Y = 3;
const MIN_INFLUENCE = 0.001;
const MAX_INFLUENCE = 0.999;

function valueToY(val: number, min: number, max: number, h: number): number {
  if (max === min) return h / 2;
  return h - ((val - min) / (max - min)) * h;
}

function yToValue(y: number, min: number, max: number, h: number): number {
  return min + (1 - y / h) * (max - min);
}

function trackKey(nodeId: string, prop: string): string {
  return `${nodeId}:${prop}`;
}

function findKfIndex(kfs: ReadonlyArray<{ t: number }>, t: number): number {
  return kfs.findIndex((k) => Math.abs(k.t - t) < 1e-9);
}

/** Format an axis label compactly (1234.5 → "1234.5", 0.00012 → "0"). */
function fmtAxis(v: number): string {
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1).replace(/\.0$/, '');
  return v.toFixed(2).replace(/\.?0+$/, '');
}

/**
 * Make the keyframe at `t` linked (continuous) by re-solving the PREVIOUS
 * segment's arriving slope to match the outgoing slope — the value-graph
 * meaning of "link": collinear tangents.
 */
function alignKeyframeTangents(nodeId: string, prop: string, t: number): void {
  const kfs = defaultAnimation.getTrackKeyframes(nodeId, prop);
  if (!kfs) return;
  const idx = findKfIndex(kfs, t);
  if (idx <= 0 || idx >= kfs.length - 1) return;
  const prevKf = kfs[idx - 1]!;
  const kf = kfs[idx]!;
  const nextKf = kfs[idx + 1]!;
  const slope = outgoingSlope(effectiveBezier(kf), nextKf.value - kf.value, nextKf.t - kf.t);
  const prevBz = withIncomingSlope(effectiveBezier(prevKf), kf.value - prevKf.value, kf.t - prevKf.t, slope);
  defaultAnimation.setBezier(nodeId, prop, prevKf.t, prevBz, prevKf.continuous);
}

/**
 * Set the speed magnitude at keyframe `t`. `side` picks which segment(s) are
 * rewritten: 'in' / 'out' touch ONE side only; 'linked' writes the outgoing
 * side and, when the keyframe is continuous, the incoming one too.
 */
function applySpeedAt(
  nodeId: string,
  prop: string,
  t: number,
  speed: number,
  side: 'in' | 'out' | 'linked',
): void {
  const kfs = defaultAnimation.getTrackKeyframes(nodeId, prop);
  if (!kfs) return;
  const i = findKfIndex(kfs, t);
  if (i < 0) return;
  const self = kfs[i]!;
  const next = kfs[i + 1];
  const prev = kfs[i - 1];
  const target = Math.max(0, speed);

  const doOut = side === 'out' || side === 'linked';
  const doIn = side === 'in' || (side === 'linked' && (self.continuous !== false || !next));

  if (doOut && next) {
    const bz = withOutgoingSpeed(effectiveBezier(self), next.value - self.value, next.t - self.t, target);
    defaultAnimation.setBezier(nodeId, prop, self.t, bz, self.continuous);
  }
  if (doIn && prev) {
    const bz = withIncomingSpeed(effectiveBezier(prev), self.value - prev.value, self.t - prev.t, target);
    defaultAnimation.setBezier(nodeId, prop, prev.t, bz, prev.continuous);
  }
}

export function GraphEditor({
  selectedNodeIds,
  currentTime,
  duration,
  pixelsPerSecond: pps,
  scrollLeft,
  onScrollChange,
  onZoom,
  frameRate = 30,
  height: propsHeight,
  onScrub,
}: GraphEditorProps): JSX.Element {
  const rev = useSceneRevision((s) => s.rev);
  const [mode, setMode] = useState<'value' | 'speed'>('value');
  const [selectedKf, setSelectedKf] = useState<SelectedKf | null>(null);
  const selectedKfIds = useKeyframeSelectionStore((s) => s.ids);
  const setSelectedKfIds = useKeyframeSelectionStore((s) => s.set);
  const [dragging, setDragging] = useState(false);
  /** null = show all curves; non-empty = only these trackKeys at full opacity. */
  const [soloKeys, setSoloKeys] = useState<Set<string> | null>(null);
  /** Live Alt-drag box-zoom rectangle (svg coords), or null. */
  const [boxZoom, setBoxZoom] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  /** Live snap guides while dragging a diamond (time vertical / value horizontal). */
  const [graphSnap, setGraphSnap] = useState<{
    time: SnapTarget | null;
    value: ValueSnapTarget | null;
    minV: number;
    maxV: number;
  } | null>(null);
  // Bumped when a drag ends so the range re-fits once (the memo below reads the
  // frozen ranges through a ref, which a state change must flush).
  const [refitTick, setRefitTick] = useState(0);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const { ref: containerRef, size } = useResizeObserver<HTMLDivElement>();

  const height = propsHeight ?? (size.height > 0 ? size.height : GRAPH_HEIGHT_DEFAULT);
  const viewportW = size.width > 0 ? size.width : 800;

  // Clear focus when selected nodes change. Solo follows the visible tracks.
  useEffect(() => {
    setSelectedKf(null);
    setSoloKeys(null);
  }, [selectedNodeIds]);

  // ── Track / curve data ─────────────────────────────────────────
  const allTracks = useMemo(() => {
    const out: { nodeId: string; prop: string; color: string }[] = [];
    let colorIdx = 0;
    for (const nodeId of selectedNodeIds) {
      for (const track of defaultAnimation.tracksFor(nodeId)) {
        out.push({ nodeId, prop: track.prop, color: COLORS[colorIdx++ % COLORS.length] ?? '#2988ff' });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNodeIds, rev]);

  const INNER_H = Math.max(40, height - 40); // leave 40 px for toolbar
  const totalWidth = Math.max(duration * pps, 1);
  const graphWidth = Math.max(totalWidth, viewportW);

  /**
   * Vertical ranges frozen for the duration of a drag. While this is set the
   * graph does NOT re-fit to the data, so the thing under the cursor stays
   * under the cursor. Cleared (and re-fitted) on release.
   */
  const frozenRangesRef = useRef<Map<string, Range> | null>(null);
  const dragRef = useRef<DragState | null>(null);

  const sampledPaths = useMemo(() => {
    const paths: {
      color: string;
      d: string;
      keyframes: KfPoint[];
      prop: string;
      nodeId: string;
      minV: number;
      maxV: number;
    }[] = [];

    // Visible comp-time window (plus margin) — only this stretch is sampled
    // densely; offscreen segments get their endpoints only.
    const visT0 = Math.max(0, (scrollLeft - 50) / pps);
    const visT1 = Math.min(duration, (scrollLeft + viewportW + 50) / pps);

    for (const { nodeId, prop, color } of allTracks) {
      const kfs = defaultAnimation.getTrackKeyframes(nodeId, prop);
      if (!kfs || kfs.length === 0) continue;

      const toAbs = (layerT: number): number => keyframeToCompTime(nodeId, layerT, prop);
      const toLayer = (absT: number): number => compToKeyframeTime(nodeId, absT, prop);
      const valueAt = (layerT: number): number => defaultAnimation.sample(nodeId, prop, layerT) ?? 0;

      /**
       * Speed INSIDE segment [a,b] at layer time t — a finite difference that
       * never straddles a keyframe, so the curve meets each keyframe at the
       * analytic in/out speed instead of averaging the two segments.
       */
      const speedIn = (a: { t: number; easing?: string }, b: { t: number }, t: number): number => {
        if (isHoldEasing(a.easing)) return 0;
        const span = b.t - a.t;
        if (span <= 0) return 0;
        const h = Math.min(0.002, span / 8);
        const t0 = Math.max(a.t, t - h);
        const t1 = Math.min(b.t, t + h);
        if (t1 - t0 <= 0) return 0;
        return Math.abs((valueAt(t1) - valueAt(t0)) / (t1 - t0));
      };

      // ── Sample per segment: [x px, plotted value] ──
      const samples: [number, number][] = [];
      const firstAbs = toAbs(kfs[0]!.t);
      const lastAbs = toAbs(kfs[kfs.length - 1]!.t);

      // Before the first keyframe: flat (value) / zero (speed).
      if (firstAbs > 0) {
        const v = mode === 'speed' ? 0 : kfs[0]!.value;
        samples.push([0, v], [firstAbs * pps, v]);
      }

      for (let s = 0; s < kfs.length - 1; s++) {
        const a = kfs[s]!;
        const b = kfs[s + 1]!;
        const aAbs = toAbs(a.t);
        const bAbs = toAbs(b.t);
        if (mode === 'value' && isHoldEasing(a.easing)) {
          samples.push([aAbs * pps, a.value], [bAbs * pps, a.value], [bAbs * pps, b.value]);
          continue;
        }
        const widthPx = Math.max(1, (bAbs - aAbs) * pps);
        const visible = bAbs >= visT0 && aAbs <= visT1;
        const n = visible ? clamp(Math.ceil(widthPx / 2), 2, 600) : 1;
        for (let i = 0; i <= n; i++) {
          const f = i / n;
          const tAbs = aAbs + (bAbs - aAbs) * f;
          const tl = toLayer(tAbs);
          const v = mode === 'speed' ? speedIn(a, b, tl) : valueAt(tl);
          samples.push([tAbs * pps, v]);
        }
      }

      if (lastAbs < duration) {
        const v = mode === 'speed' ? 0 : kfs[kfs.length - 1]!.value;
        samples.push([lastAbs * pps, v], [duration * pps, v]);
      }
      if (kfs.length === 1) {
        const v = mode === 'speed' ? 0 : kfs[0]!.value;
        samples.push([0, v], [duration * pps, v]);
      }

      // ── Range: frozen during a drag, auto-fit otherwise ──
      let range = frozenRangesRef.current?.get(trackKey(nodeId, prop));
      if (!range) {
        let minV = Infinity;
        let maxV = -Infinity;
        for (const [, v] of samples) {
          if (Number.isFinite(v)) {
            minV = Math.min(minV, v);
            maxV = Math.max(maxV, v);
          }
        }
        if (mode === 'value') {
          for (const kf of kfs) {
            minV = Math.min(minV, kf.value);
            maxV = Math.max(maxV, kf.value);
          }
        }
        if (!Number.isFinite(minV) || !Number.isFinite(maxV)) {
          minV = 0;
          maxV = 1;
        }
        if (mode === 'speed') {
          minV = 0;
          if (maxV <= 0) maxV = 100;
          maxV *= 1.25; // headroom
        } else {
          if (maxV === minV) {
            minV -= 1;
            maxV += 1;
          }
          const pad = (maxV - minV) * 0.15;
          minV -= pad;
          maxV += pad;
        }
        range = { minV, maxV };
      }
      const { minV, maxV } = range;

      const d = samples.length
        ? `M${samples.map(([x, v]) => `${x.toFixed(2)},${valueToY(v, minV, maxV, INNER_H).toFixed(2)}`).join('L')}`
        : '';

      const keyframes: KfPoint[] = kfs.map((kf, i) => {
        const prev = i > 0 ? kfs[i - 1] : null;
        const next = i < kfs.length - 1 ? kfs[i + 1] : null;

        let inSpd: number | undefined;
        let inInf: number | undefined;
        let outSpd: number | undefined;
        let outInf: number | undefined;

        if (prev) {
          const prevBz = effectiveBezier(prev);
          inSpd = isHoldEasing(prev.easing) ? 0 : incomingSpeed(prevBz, kf.value - prev.value, kf.t - prev.t);
          inInf = 1 - prevBz[2];
        }
        if (next) {
          const bz = effectiveBezier(kf);
          outSpd = isHoldEasing(kf.easing) ? 0 : outgoingSpeed(bz, next.value - kf.value, next.t - kf.t);
          outInf = bz[0];
        }

        const plotted = mode === 'speed' ? (outSpd ?? inSpd ?? 0) : kf.value;

        return {
          nodeId,
          prop,
          index: i,
          t: kf.t,
          tAbs: toAbs(kf.t),
          value: kf.value,
          plotted,
          y: valueToY(plotted, minV, maxV, INNER_H),
          minV,
          maxV,
          easing: kf.easing,
          bezier: kf.bezier,
          continuous: kf.continuous,
          inSpeed: inSpd,
          outSpeed: outSpd,
          inInfluence: inInf,
          outInfluence: outInf,
        };
      });

      paths.push({ color, d, keyframes, prop, nodeId, minV, maxV });
    }
    return paths;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allTracks, duration, pps, INNER_H, rev, mode, scrollLeft, viewportW, refitTick]);

  // ── Pointer helpers ───────────────────────────────────────────
  const svgCoords = useCallback((e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    // The svg lives inside a natively scrolling container; its client rect
    // already reflects the scroll, so this IS the svg-space coordinate.
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }, []);

  // ── Horizontal scroll / zoom ──────────────────────────────────
  const canvasRef = useRef<HTMLDivElement | null>(null);
  // Follow the host's scroll (the Timeline's lanes) when it changes under us.
  useEffect(() => {
    const el = canvasRef.current;
    if (el && Math.abs(el.scrollLeft - scrollLeft) > 0.5) el.scrollLeft = scrollLeft;
  }, [scrollLeft, totalWidth]);

  const onCanvasScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      onScrollChange?.(e.currentTarget.scrollLeft);
    },
    [onScrollChange],
  );

  // Wheel: plain / shift → pan horizontally (the graph has no vertical scroll);
  // ctrl / ⌘ → zoom, keeping the time under the cursor fixed.
  const onCanvasWheel = useCallback(
    (e: WheelEvent) => {
      const el = canvasRef.current;
      if (!el) return;
      if (e.ctrlKey || e.metaKey) {
        if (!onZoom) return;
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        const next = clamp(pps * factor, 4, 800);
        const rect = el.getBoundingClientRect();
        const localX = e.clientX - rect.left;
        // Re-anchored by the layout effect below once the new pps has rendered.
        zoomAnchorRef.current = { t: (el.scrollLeft + localX) / pps, localX };
        onZoom(next);
        return;
      }
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (delta === 0) return;
      el.scrollLeft += delta;
    },
    [pps, onZoom],
  );
  // Keep the time under the cursor fixed across a wheel zoom. Runs after the
  // svg has been laid out at the new width, so the scroll can actually land.
  const zoomAnchorRef = useRef<{ t: number; localX: number } | null>(null);
  useLayoutEffect(() => {
    const a = zoomAnchorRef.current;
    const el = canvasRef.current;
    if (!a || !el) return;
    zoomAnchorRef.current = null;
    el.scrollLeft = Math.max(0, a.t * pps - a.localX);
    onScrollChange?.(el.scrollLeft);
  }, [pps, onScrollChange]);

  // Native, non-passive: React's wheel listener is passive, so preventDefault
  // there cannot stop the browser's own ctrl+wheel zoom.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    el.addEventListener('wheel', onCanvasWheel, { passive: false });
    return () => el.removeEventListener('wheel', onCanvasWheel);
  }, [onCanvasWheel]);

  const freezeRanges = useCallback(() => {
    const m = new Map<string, Range>();
    for (const p of sampledPaths) m.set(trackKey(p.nodeId, p.prop), { minV: p.minV, maxV: p.maxV });
    frozenRangesRef.current = m;
  }, [sampledPaths]);

  const beginDrag = useCallback(
    (e: React.PointerEvent<Element>, state: Omit<DragState, 'pointerId' | 'moved'>) => {
      e.stopPropagation();
      e.preventDefault();
      // Capture on the SVG: it survives child re-mounts (diamonds re-key as they retime).
      try {
        svgRef.current?.setPointerCapture(e.pointerId);
      } catch {
        /* capture is best-effort */
      }
      freezeRanges();
      dragRef.current = { ...state, pointerId: e.pointerId, moved: false };
      setDragging(true);
    },
    [freezeRanges],
  );

  const endDrag = useCallback(() => {
    const d = dragRef.current;
    if (!d) return;
    if (d.kind === 'box-zoom') {
      const x1 = d.boxX ?? d.ox;
      if (d.moved && onZoom) {
        const result = computeBoxZoomFromSvg({
          x0: d.ox,
          x1,
          currentPps: pps,
          viewportW,
          minPps: GRAPH_PPS_MIN,
          maxPps: GRAPH_PPS_MAX,
        });
        if (result) {
          zoomAnchorRef.current = { t: result.t0, localX: 0 };
          onZoom(result.pps);
          // scrollLeft applied by the layout effect after pps lands; also set
          // immediately so a no-op clamp still pans to the box.
          const el = canvasRef.current;
          if (el) {
            el.scrollLeft = result.scrollLeft;
            onScrollChange?.(result.scrollLeft);
          }
        }
      }
      setBoxZoom(null);
    } else if (d.tx) {
      if (d.moved) {
        const label = d.kind === 'kf' ? 'Move Keyframe' : 'Edit Curve';
        recordAnimEdit(d.tx.commit(label));
      }
    }
    try {
      if (svgRef.current?.hasPointerCapture(d.pointerId)) svgRef.current.releasePointerCapture(d.pointerId);
    } catch {
      /* ignore */
    }
    dragRef.current = null;
    frozenRangesRef.current = null;
    setDragging(false);
    setGraphSnap(null);
    setRefitTick((n) => n + 1);
  }, [onZoom, onScrollChange, pps, viewportW]);

  // Start dragging a keyframe diamond. Shift-click toggles multi-select (same
  // set the timeline / F9 commands use); plain click focuses and replaces the
  // set unless the diamond was already part of a multi-selection (group drag
  // keeps the set and moves every selected diamond together).
  const onKfPointerDown = useCallback(
    (e: React.PointerEvent<SVGElement>, kf: KfPoint) => {
      if (e.button !== 0) return;
      const id = makeKeyframeId(kf.nodeId, kf.prop, kf.t);
      const next = new Set(selectedKfIds);
      if (e.shiftKey) {
        if (next.has(id)) next.delete(id);
        else next.add(id);
      } else if (!next.has(id)) {
        next.clear();
        next.add(id);
      }
      setSelectedKfIds(next);
      setSelectedKf({ nodeId: kf.nodeId, prop: kf.prop, t: kf.t });

      // Snapshot the moving body at pointer-down (origin+delta). Prefer the
      // multi-selection when the grab is already in it; otherwise just the grab.
      const idsForGroup = next.has(id) && next.size > 1 ? next : new Set([id]);
      const group: GraphGroupMemberStart[] = [];
      for (const sid of idsForGroup) {
        const ref = parseKeyframeId(sid);
        if (!ref) continue;
        let point: KfPoint | undefined;
        for (const p of sampledPaths) {
          if (p.nodeId !== ref.nodeId || p.prop !== ref.prop) continue;
          point = p.keyframes.find((k) => Math.abs(k.t - ref.t) < 1e-9);
          if (point) break;
        }
        if (!point) continue;
        group.push({
          nodeId: point.nodeId,
          prop: point.prop,
          startT: point.t,
          startCompT: point.tAbs,
          startValue: point.value,
          minV: point.minV,
          maxV: point.maxV,
        });
      }
      const grabIndex = Math.max(0, group.findIndex(
        (m) => m.nodeId === kf.nodeId && m.prop === kf.prop && Math.abs(m.startT - kf.t) < 1e-9,
      ));

      const { x, y } = svgCoords(e);
      beginDrag(e, {
        kind: 'kf',
        nodeId: kf.nodeId,
        prop: kf.prop,
        kfT: kf.t,
        origValue: kf.value,
        ox: kf.tAbs * pps,
        oy: kf.y,
        px0: x,
        py0: y,
        minV: kf.minV,
        maxV: kf.maxV,
        mode,
        tx: beginAnimEdit(),
        group: group.length > 0 ? group : undefined,
        grabIndex,
        groupCurrentT: group.length > 0 ? group.map((m) => m.startT) : undefined,
      });
    },
    [svgCoords, beginDrag, pps, mode, selectedKfIds, setSelectedKfIds, sampledPaths],
  );

  // Click the curve body (fat invisible stroke) → nearest keyframe on that track.
  // Does not start a drag; scrubbing stays on empty background.
  const onCurvePointerDown = useCallback(
    (e: React.PointerEvent<SVGPathElement>, nodeId: string, prop: string) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const path = sampledPaths.find((p) => p.nodeId === nodeId && p.prop === prop);
      if (!path) return;
      const { x } = svgCoords(e);
      const near = nearestKeyframeOnCurve(path.keyframes, x / pps);
      if (!near) return;
      const kf = path.keyframes.find((k) => Math.abs(k.t - near.t) < 1e-9);
      if (!kf) return;
      const id = makeKeyframeId(kf.nodeId, kf.prop, kf.t);
      const next = new Set(selectedKfIds);
      if (e.shiftKey) {
        if (next.has(id)) next.delete(id);
        else next.add(id);
      } else {
        next.clear();
        next.add(id);
      }
      setSelectedKfIds(next);
      setSelectedKf({ nodeId: kf.nodeId, prop: kf.prop, t: kf.t });
    },
    [sampledPaths, svgCoords, pps, selectedKfIds, setSelectedKfIds],
  );

  // Start dragging a Bézier handle. `hx/hy` = the handle's current svg position.
  const onHandlePointerDown = useCallback(
    (e: React.PointerEvent<SVGElement>, kf: KfPoint, which: 'handle-in' | 'handle-out', hx: number, hy: number) => {
      if (e.button !== 0) return;
      const { x, y } = svgCoords(e);
      const tx = beginAnimEdit();
      beginDrag(e, {
        kind: which,
        nodeId: kf.nodeId,
        prop: kf.prop,
        kfT: kf.t,
        origValue: kf.value,
        ox: hx,
        oy: hy,
        px0: x,
        py0: y,
        minV: kf.minV,
        maxV: kf.maxV,
        mode,
        tx,
      });
    },
    [svgCoords, beginDrag, mode],
  );

  // Background: Alt-drag box-zooms; plain click-drag scrubs the playhead.
  const onSvgPointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (e.button !== 0) return;
      const { x, y } = svgCoords(e);
      if (e.altKey && onZoom) {
        setBoxZoom({ x0: x, y0: y, x1: x, y1: y });
        beginDrag(e, {
          kind: 'box-zoom',
          nodeId: '',
          prop: '',
          kfT: 0,
          origValue: 0,
          ox: x,
          oy: y,
          px0: x,
          py0: y,
          minV: 0,
          maxV: 1,
          mode,
          boxX: x,
          boxY: y,
        });
        return;
      }
      if (!onScrub) return;
      onScrub(clamp(x / pps, 0, duration));
      beginDrag(e, {
        kind: 'scrub',
        nodeId: '',
        prop: '',
        kfT: 0,
        origValue: 0,
        ox: x,
        oy: y,
        px0: x,
        py0: y,
        minV: 0,
        maxV: 1,
        mode,
      });
    },
    [onScrub, onZoom, svgCoords, pps, duration, beginDrag, mode],
  );

  // ── Drag: keyframe diamond ────────────────────────────────────
  const moveKeyframe = useCallback(
    (d: DragState, ex: number, ey: number, e: React.PointerEvent) => {
      const frameDur = frameRate > 0 ? 1 / frameRate : 0;
      const rawComp = clamp((d.ox + ex) / pps, 0, duration);
      const range = Math.max(1e-9, d.maxV - d.minV);
      const pixelsPerUnit = INNER_H / range;

      const collectOtherValues = (movingIds: ReadonlySet<string>): number[] => {
        const vals: number[] = [];
        for (const p of sampledPaths) {
          for (const k of p.keyframes) {
            const id = makeKeyframeId(p.nodeId, p.prop, k.t);
            if (!movingIds.has(id)) vals.push(k.value);
          }
        }
        return vals;
      };

      // Multi-select body: move every selected diamond by the same time (and
      // value) delta. Single-diamond path below stays the neighbour-clamped one.
      if (d.group && d.group.length > 1 && d.groupCurrentT && d.grabIndex !== undefined) {
        const moving = new Set(d.group.map((m, i) => makeKeyframeId(m.nodeId, m.prop, d.groupCurrentT![i]!)));
        const otherTimes: number[] = [];
        for (const p of sampledPaths) {
          for (const k of p.keyframes) {
            const id = makeKeyframeId(p.nodeId, p.prop, k.t);
            if (!moving.has(id)) otherTimes.push(k.tAbs);
          }
        }
        const plan = planGraphGroupTimes({
          members: d.group,
          grabIndex: d.grabIndex,
          rawGrabCompT: rawComp,
          duration,
          pixelsPerSecond: pps,
          frameDuration: frameDur,
          playheadTime: currentTime,
          otherCompTimes: otherTimes,
          disableSnap: e.altKey,
        });
        const grab = d.group[d.grabIndex]!;
        let valueSnap: ValueSnapTarget | null = null;
        let snappedGrabValue: number | null = null;
        if (d.mode === 'value') {
          const rawV = yToValue(d.oy + ey, d.minV, d.maxV, INNER_H);
          const snapped = snapKeyframeValue(rawV, {
            pixelsPerUnit,
            keyframeValues: collectOtherValues(moving),
            disabled: e.altKey,
          });
          snappedGrabValue = snapped.value;
          valueSnap = snapped.target;
        }

        setGraphSnap({
          time: plan.snapTarget?.kind === 'frame' ? null : plan.snapTarget,
          value: valueSnap,
          minV: d.minV,
          maxV: d.maxV,
        });

        for (let i = 0; i < d.group.length; i++) {
          const m = d.group[i]!;
          const fromT = d.groupCurrentT[i]!;
          let newT = compToKeyframeTime(m.nodeId, plan.compTimes[i]!, m.prop);
          const kfs = defaultAnimation.getTrackKeyframes(m.nodeId, m.prop);
          if (!kfs) continue;
          const idx = findKfIndex(kfs, fromT);
          if (idx < 0) continue;
          const prev = kfs[idx - 1];
          const next = kfs[idx + 1];
          if (prev) {
            const gap = Math.min(frameDur || 1e-3, (fromT - prev.t) / 2);
            newT = Math.max(newT, prev.t + gap);
          }
          if (next) {
            const gap = Math.min(frameDur || 1e-3, (next.t - fromT) / 2);
            newT = Math.min(newT, next.t - gap);
          }
          if (d.mode === 'value' && snappedGrabValue !== null) {
            const newV = applyGroupValueDelta(m, grab, snappedGrabValue);
            defaultAnimation.updateKeyframe(m.nodeId, m.prop, fromT, { t: newT, value: newV });
          } else {
            defaultAnimation.updateKeyframe(m.nodeId, m.prop, fromT, { t: newT, value: m.startValue });
            if (d.mode === 'speed' && i === d.grabIndex) {
              const speed = Math.max(0, yToValue(d.oy + ey, d.minV, d.maxV, INNER_H));
              applySpeedAt(m.nodeId, m.prop, newT, speed, 'linked');
            }
          }
          const oldId = makeKeyframeId(m.nodeId, m.prop, fromT);
          d.groupCurrentT[i] = newT;
          rewriteSelectedKeyframeId(oldId, makeKeyframeId(m.nodeId, m.prop, newT));
          if (i === d.grabIndex) {
            d.kfT = newT;
            setSelectedKf({ nodeId: m.nodeId, prop: m.prop, t: newT });
          }
        }
        return;
      }

      const kfs = defaultAnimation.getTrackKeyframes(d.nodeId, d.prop);
      if (!kfs) return;
      const idx = findKfIndex(kfs, d.kfT);
      if (idx < 0) return;
      const prev = kfs[idx - 1];
      const next = kfs[idx + 1];

      // Time (comp) = origin + delta, snapped to playhead / other keys / frames.
      const otherTimes: number[] = [];
      for (const p of sampledPaths) {
        for (const k of p.keyframes) {
          if (p.nodeId === d.nodeId && p.prop === d.prop) continue;
          otherTimes.push(k.tAbs);
        }
      }
      const timeSnap = snapKeyframeTime(rawComp, {
        pixelsPerSecond: pps,
        frameDuration: frameDur,
        playheadTime: currentTime,
        keyframeTimes: otherTimes,
        disabled: e.altKey,
      });
      let newT = compToKeyframeTime(d.nodeId, clamp(timeSnap.time, 0, duration), d.prop);

      // Never cross (or land on) a neighbour — upsert would swallow it.
      if (prev) {
        const gap = Math.min(frameDur || 1e-3, (d.kfT - prev.t) / 2);
        newT = Math.max(newT, prev.t + gap);
      }
      if (next) {
        const gap = Math.min(frameDur || 1e-3, (next.t - d.kfT) / 2);
        newT = Math.min(newT, next.t - gap);
      }

      let valueSnap: ValueSnapTarget | null = null;
      if (d.mode === 'value') {
        const rawV = yToValue(d.oy + ey, d.minV, d.maxV, INNER_H);
        const moving = new Set([makeKeyframeId(d.nodeId, d.prop, d.kfT)]);
        const snapped = snapKeyframeValue(rawV, {
          pixelsPerUnit,
          keyframeValues: collectOtherValues(moving),
          disabled: e.altKey,
        });
        valueSnap = snapped.target;
        defaultAnimation.updateKeyframe(d.nodeId, d.prop, d.kfT, { t: newT, value: snapped.value });
      } else {
        defaultAnimation.updateKeyframe(d.nodeId, d.prop, d.kfT, { t: newT, value: d.origValue });
        const speed = Math.max(0, yToValue(d.oy + ey, d.minV, d.maxV, INNER_H));
        applySpeedAt(d.nodeId, d.prop, newT, speed, 'linked');
      }

      setGraphSnap({
        time: timeSnap.target?.kind === 'frame' ? null : timeSnap.target,
        value: valueSnap,
        minV: d.minV,
        maxV: d.maxV,
      });

      const oldId = makeKeyframeId(d.nodeId, d.prop, d.kfT);
      d.kfT = newT;
      setSelectedKf({ nodeId: d.nodeId, prop: d.prop, t: newT });
      rewriteSelectedKeyframeId(oldId, makeKeyframeId(d.nodeId, d.prop, newT));
    },
    [pps, duration, INNER_H, frameRate, currentTime, sampledPaths],
  );

  // ── Drag: Bézier handle ───────────────────────────────────────
  const moveHandle = useCallback(
    (d: DragState, ex: number, ey: number, e: React.PointerEvent) => {
      const kfs = defaultAnimation.getTrackKeyframes(d.nodeId, d.prop);
      if (!kfs) return;
      const selfIdx = findKfIndex(kfs, d.kfT);
      if (selfIdx < 0) return;
      const selfKf = kfs[selfIdx]!;

      // Alt breaks the link for this keyframe (AE: Alt/Option-drag a handle).
      if (e.altKey && selfKf.continuous !== false) {
        defaultAnimation.updateKeyframe(d.nodeId, d.prop, selfKf.t, { continuous: false });
      }
      const linked = selfKf.continuous !== false && !e.altKey;

      const hx = d.ox + ex;
      const hy = d.oy + ey;
      const selfTComp = keyframeToCompTime(d.nodeId, selfKf.t, d.prop);

      if (d.kind === 'handle-out') {
        const nextKf = kfs[selfIdx + 1];
        if (!nextKf) return;
        const prevKf = selfIdx > 0 ? kfs[selfIdx - 1] : null;
        const dt = nextKf.t - selfKf.t;
        const dv = nextKf.value - selfKf.value;

        // Influence is a FRACTION of the segment — measured in comp pixels so it
        // stays continuous (compToKeyframeTime snaps to the frame grid).
        const segPx = (keyframeToCompTime(d.nodeId, nextKf.t, d.prop) - selfTComp) * pps;
        const influence = segPx <= 0 ? 1 / 3 : clamp((hx - selfTComp * pps) / segPx, MIN_INFLUENCE, MAX_INFLUENCE);
        const curBz = effectiveBezier(selfKf);

        if (d.mode === 'value') {
          const vHover = yToValue(hy, d.minV, d.maxV, INNER_H);
          const y1 = dv === 0 ? curBz[1] : clamp((vHover - selfKf.value) / dv, MIN_HANDLE_Y, MAX_HANDLE_Y);
          const bz: Bezier = [influence, y1, curBz[2], curBz[3]];
          defaultAnimation.setBezier(d.nodeId, d.prop, selfKf.t, bz, linked);
          if (linked && prevKf && !isHoldEasing(prevKf.easing)) {
            const slope = outgoingSlope(bz, dv, dt);
            const prevBz = withIncomingSlope(effectiveBezier(prevKf), selfKf.value - prevKf.value, selfKf.t - prevKf.t, slope);
            defaultAnimation.setBezier(d.nodeId, d.prop, prevKf.t, prevBz, prevKf.continuous);
          }
        } else {
          const speed = Math.max(0, yToValue(hy, d.minV, d.maxV, INNER_H));
          const bz = withOutgoingSpeed([influence, curBz[1], curBz[2], curBz[3]], dv, dt, speed);
          defaultAnimation.setBezier(d.nodeId, d.prop, selfKf.t, bz, linked);
          if (linked && prevKf && !isHoldEasing(prevKf.easing)) {
            const prevBz = withIncomingSpeed(effectiveBezier(prevKf), selfKf.value - prevKf.value, selfKf.t - prevKf.t, speed);
            defaultAnimation.setBezier(d.nodeId, d.prop, prevKf.t, prevBz, prevKf.continuous);
          }
        }
      } else if (d.kind === 'handle-in') {
        const prevKf = kfs[selfIdx - 1];
        if (!prevKf) return;
        const nextKf = selfIdx < kfs.length - 1 ? kfs[selfIdx + 1] : null;
        const dtPrev = selfKf.t - prevKf.t;
        const dvPrev = selfKf.value - prevKf.value;

        const segPx = (selfTComp - keyframeToCompTime(d.nodeId, prevKf.t, d.prop)) * pps;
        const influence = segPx <= 0 ? 1 / 3 : clamp((selfTComp * pps - hx) / segPx, MIN_INFLUENCE, MAX_INFLUENCE);
        const prevBz = effectiveBezier(prevKf);

        if (d.mode === 'value') {
          const vHover = yToValue(hy, d.minV, d.maxV, INNER_H);
          const y2 = dvPrev === 0
            ? prevBz[3]
            : clamp(1 - (selfKf.value - vHover) / dvPrev, 1 - MAX_HANDLE_Y, 1 - MIN_HANDLE_Y);
          const bz: Bezier = [prevBz[0], prevBz[1], 1 - influence, y2];
          defaultAnimation.setBezier(d.nodeId, d.prop, prevKf.t, bz, prevKf.continuous);
          if (linked && nextKf && !isHoldEasing(selfKf.easing)) {
            const slope = incomingSlope(bz, dvPrev, dtPrev);
            const curBz = withOutgoingSlope(effectiveBezier(selfKf), nextKf.value - selfKf.value, nextKf.t - selfKf.t, slope);
            defaultAnimation.setBezier(d.nodeId, d.prop, selfKf.t, curBz, true);
          }
        } else {
          const speed = Math.max(0, yToValue(hy, d.minV, d.maxV, INNER_H));
          const bz = withIncomingSpeed([prevBz[0], prevBz[1], 1 - influence, prevBz[3]], dvPrev, dtPrev, speed);
          defaultAnimation.setBezier(d.nodeId, d.prop, prevKf.t, bz, prevKf.continuous);
          if (linked && nextKf && !isHoldEasing(selfKf.easing)) {
            const curBz = withOutgoingSpeed(effectiveBezier(selfKf), nextKf.value - selfKf.value, nextKf.t - selfKf.t, speed);
            defaultAnimation.setBezier(d.nodeId, d.prop, selfKf.t, curBz, true);
          }
        }
      }
    },
    [pps, INNER_H],
  );

  const onSvgPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const d = dragRef.current;
      if (!d || e.pointerId !== d.pointerId) return;
      const { x, y } = svgCoords(e);
      let ex = x - d.px0;
      let ey = y - d.py0;

      if (d.kind === 'scrub') {
        onScrub?.(clamp(x / pps, 0, duration));
        return;
      }

      if (d.kind === 'box-zoom') {
        if (!d.moved && Math.hypot(ex, ey) < DRAG_DEAD_ZONE_PX) return;
        d.moved = true;
        d.boxX = x;
        d.boxY = y;
        setBoxZoom({ x0: d.ox, y0: d.oy, x1: x, y1: y });
        return;
      }

      if (!d.moved && Math.hypot(ex, ey) < DRAG_DEAD_ZONE_PX) return;
      d.moved = true;

      // Shift constrains to the dominant axis.
      if (e.shiftKey) {
        if (Math.abs(ex) >= Math.abs(ey)) ey = 0;
        else ex = 0;
      }

      if (d.kind === 'kf') moveKeyframe(d, ex, ey, e);
      else moveHandle(d, ex, ey, e);
    },
    [svgCoords, onScrub, pps, duration, moveKeyframe, moveHandle],
  );

  const onSvgPointerUp = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const d = dragRef.current;
      if (!d || e.pointerId !== d.pointerId) return;
      endDrag();
    },
    [endDrag],
  );

  // Belt and braces: a drag must never outlive its pointer.
  useEffect(() => {
    if (!dragging) return;
    const up = () => endDrag();
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('blur', up);
    return () => {
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('blur', up);
    };
  }, [dragging, endDrag]);

  const playheadX = currentTime * pps;

  // ── Find selected keyframe for handle rendering ───────────────
  const selectedKfData = selectedKf
    ? sampledPaths
        .flatMap((p) => p.keyframes)
        .find((kf) => kf.nodeId === selectedKf.nodeId && kf.prop === selectedKf.prop && Math.abs(kf.t - selectedKf.t) < 1e-6)
    : null;

  const handleApplyPreset = useCallback((preset: EasingPreset) => {
    applyEasingToSelection(preset);
  }, []);

  // Which quick-ease pill matches the selected keyframe's ACTUAL easing, so
  // the applied one lights up (`iconBtnActive` existed in the CSS unused —
  // the pills never showed state, which read as "did that click work?").
  const bezierEq = (a?: readonly number[], b?: readonly number[]): boolean =>
    !!a && !!b && a.length === 4 && b.length === 4 &&
    a.every((v, i) => Math.abs(v - b[i]!) < 1e-6);
  const activePreset: EasingPreset | null = !selectedKfData
    ? null
    : isHoldEasing(selectedKfData.easing) ? 'Hold'
    : selectedKfData.easing === 'bezier' && bezierEq(selectedKfData.bezier, EASY_EASE_BEZIER) ? 'Ease'
    : selectedKfData.easing === 'bezier' && bezierEq(selectedKfData.bezier, EASY_EASE_IN_BEZIER) ? 'EaseIn'
    : selectedKfData.easing === 'bezier' && bezierEq(selectedKfData.bezier, EASY_EASE_OUT_BEZIER) ? 'EaseOut'
    : !selectedKfData.easing || selectedKfData.easing === 'linear' ? 'Linear'
    : null;
  const pillClass = (preset: EasingPreset): string | undefined =>
    activePreset === preset ? styles.iconBtnActive : styles.iconBtn;

  // Axis labels follow the selected track (or the first one).
  const axisTrack = selectedKfData
    ? sampledPaths.find((p) => p.nodeId === selectedKfData.nodeId && p.prop === selectedKfData.prop)
    : sampledPaths[0];

  // ── Handle geometry for the selected keyframe ─────────────────
  const handleGeom = useMemo(() => {
    if (!selectedKfData) return null;
    const path = sampledPaths.find((p) => p.nodeId === selectedKfData.nodeId && p.prop === selectedKfData.prop);
    if (!path) return null;
    const kf = selectedKfData;
    const i = kf.index;
    const prevKf = i > 0 ? path.keyframes[i - 1] : null;
    const nextKf = i < path.keyframes.length - 1 ? path.keyframes[i + 1] : null;
    const kx = kf.tAbs * pps;
    const ky = kf.y;

    const showIn = !!prevKf && !isHoldEasing(prevKf.easing);
    const showOut = !!nextKf && !isHoldEasing(kf.easing);

    let inX = kx, inY = ky, inAnchorY = ky;
    let outX = kx, outY = ky;

    if (showIn && prevKf) {
      const prevBz = effectiveBezier(prevKf);
      const dtPrev = kf.t - prevKf.t;
      const dvPrev = kf.value - prevKf.value;
      inX = kx - (kx - prevKf.tAbs * pps) * (1 - prevBz[2]);
      if (mode === 'value') {
        inY = valueToY(kf.value - dvPrev * (1 - prevBz[3]), kf.minV, kf.maxV, INNER_H);
      } else {
        const inSpd = incomingSpeed(prevBz, dvPrev, dtPrev);
        inY = valueToY(inSpd, kf.minV, kf.maxV, INNER_H);
        inAnchorY = inY; // the in-handle hangs off the INCOMING speed point
      }
    }
    if (showOut && nextKf) {
      const bz = effectiveBezier(kf);
      const dt = nextKf.t - kf.t;
      const dv = nextKf.value - kf.value;
      outX = kx + (nextKf.tAbs * pps - kx) * bz[0];
      outY = mode === 'value'
        ? valueToY(kf.value + dv * bz[1], kf.minV, kf.maxV, INNER_H)
        : valueToY(outgoingSpeed(bz, dv, dt), kf.minV, kf.maxV, INNER_H);
    }
    return { kf, color: path.color, kx, ky, showIn, showOut, inX, inY, inAnchorY, outX, outY };
  }, [selectedKfData, sampledPaths, pps, mode, INNER_H]);

  const cursorClass = dragging
    ? dragRef.current?.kind === 'scrub'
      ? styles.svgScrubbing
      : dragRef.current?.kind === 'box-zoom'
        ? styles.svgBoxZoom
        : styles.svgDragging
    : '';

  const showDenseLabels = pps >= LABEL_PPS;
  const visT0 = Math.max(0, (scrollLeft - 40) / pps);
  const visT1 = Math.min(duration, (scrollLeft + viewportW + 40) / pps);

  const toggleSolo = useCallback((key: string, additive: boolean) => {
    setSoloKeys((prev) => {
      if (!additive) {
        // Click the only soloed track again → show all.
        if (prev && prev.size === 1 && prev.has(key)) return null;
        return new Set([key]);
      }
      const next = new Set(prev ?? []);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next.size === 0 ? null : next;
    });
  }, []);

  return (
    <div className={styles.root} style={propsHeight ? { height: propsHeight } : undefined} ref={containerRef}>
      {/* ── Toolbar ────────────────────────────────────────────── */}
      <div className={styles.toolbar}>
        <button
          type="button"
          className={mode === 'value' ? styles.tabActive : styles.tab}
          onClick={() => setMode('value')}
          title="Value graph (edit values & curve paths)"
        >
          <Icon name="graph-value" size="sm" /> Value
        </button>
        <button
          type="button"
          className={mode === 'speed' ? styles.tabActive : styles.tab}
          onClick={() => setMode('speed')}
          title="Speed graph (edit velocity & influence %)"
        >
          <Icon name="graph-speed" size="sm" /> Speed
        </button>

        {/* Quick Ease Presets Group — aria-pressed + the active class reflect
            the selected keyframe's real easing, so the pills answer "which one
            is applied?" instead of only "which ones exist?". */}
        {selectedKfData && (
          <div className={styles.btnGroup}>
            <button type="button" className={pillClass('Ease')} aria-pressed={activePreset === 'Ease'} aria-label="Easy Ease" onClick={() => handleApplyPreset('Ease')} title="Easy Ease (F9)">
              <Icon name="ease" size="sm" />
            </button>
            <button type="button" className={pillClass('EaseIn')} aria-pressed={activePreset === 'EaseIn'} aria-label="Easy Ease In" onClick={() => handleApplyPreset('EaseIn')} title="Easy Ease In (Shift+F9)">
              <Icon name="arrow-right" size="sm" />
            </button>
            <button type="button" className={pillClass('EaseOut')} aria-pressed={activePreset === 'EaseOut'} aria-label="Easy Ease Out" onClick={() => handleApplyPreset('EaseOut')} title="Easy Ease Out (Ctrl+Shift+F9)">
              <Icon name="arrow-left" size="sm" />
            </button>
            <button type="button" className={pillClass('Linear')} aria-pressed={activePreset === 'Linear'} aria-label="Linear interpolation" onClick={() => handleApplyPreset('Linear')} title="Linear">
              <Icon name="line" size="sm" />
            </button>
            <button type="button" className={pillClass('Hold')} aria-pressed={activePreset === 'Hold'} aria-label="Hold interpolation" onClick={() => handleApplyPreset('Hold')} title="Toggle Hold">
              <Icon name="keyframe" size="sm" />
            </button>
          </div>
        )}

        <span className={styles.spacer} />

        {selectedKfData && (
          <div className={styles.hint} style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <div style={{ width: 62 }}>
              <span className={styles.fieldLabel}>t=</span>
              <ValueField
                value={selectedKfData.t}
                unit="s"
                precision={2}
                min={0}
                max={duration}
                onChange={(newT: number) => {
                  const oldT = selectedKfData.t;
                  runAnimEdit('Move Keyframe', () => {
                    defaultAnimation.updateKeyframe(selectedKfData.nodeId, selectedKfData.prop, oldT, { t: newT });
                  });
                  setSelectedKf(selectedKf ? { ...selectedKf, t: newT } : null);
                  rewriteSelectedKeyframeId(
                    makeKeyframeId(selectedKfData.nodeId, selectedKfData.prop, oldT),
                    makeKeyframeId(selectedKfData.nodeId, selectedKfData.prop, newT),
                  );
                }}
              />
            </div>

            {mode === 'value' ? (
              <div style={{ width: 65 }}>
                <span className={styles.fieldLabel}>v=</span>
                <ValueField
                  value={selectedKfData.value}
                  precision={2}
                  onChange={(newV: number) => {
                    runAnimEdit('Set Keyframe Value', () => {
                      defaultAnimation.updateKeyframe(selectedKfData.nodeId, selectedKfData.prop, selectedKfData.t, { value: newV });
                    });
                  }}
                />
              </div>
            ) : (
              <>
                {selectedKfData.inSpeed !== undefined && (
                  <div style={{ width: 68 }}>
                    <span className={styles.fieldLabel}>In:</span>
                    <ValueField
                      value={selectedKfData.inSpeed}
                      precision={1}
                      min={0}
                      onChange={(newSpeed: number) => {
                        runAnimEdit('Set Incoming Speed', () => {
                          applySpeedAt(selectedKfData.nodeId, selectedKfData.prop, selectedKfData.t, newSpeed, 'in');
                          // Typing a one-sided speed is an explicit split.
                          if (selectedKfData.outSpeed !== undefined && Math.abs(newSpeed - selectedKfData.outSpeed) > 1e-6) {
                            defaultAnimation.updateKeyframe(selectedKfData.nodeId, selectedKfData.prop, selectedKfData.t, { continuous: false });
                          }
                        });
                      }}
                    />
                  </div>
                )}
                {selectedKfData.inInfluence !== undefined && (
                  <div style={{ width: 62 }}>
                    <span className={styles.fieldLabel}>In%:</span>
                    <ValueField
                      value={Math.round(selectedKfData.inInfluence * 100)}
                      unit="%"
                      precision={0}
                      min={1}
                      max={99}
                      onChange={(newPct: number) => {
                        const trackKfs = defaultAnimation.getTrackKeyframes(selectedKfData.nodeId, selectedKfData.prop);
                        const idx = trackKfs ? findKfIndex(trackKfs, selectedKfData.t) : -1;
                        if (idx > 0 && trackKfs) {
                          const prevKf = trackKfs[idx - 1]!;
                          const dtPrev = selectedKfData.t - prevKf.t;
                          const dvPrev = selectedKfData.value - prevKf.value;
                          const bz = withIncomingInfluence(effectiveBezier(prevKf), dvPrev, dtPrev, newPct / 100);
                          runAnimEdit('Set Incoming Influence', () => {
                            defaultAnimation.setBezier(selectedKfData.nodeId, selectedKfData.prop, prevKf.t, bz, prevKf.continuous);
                          });
                        }
                      }}
                    />
                  </div>
                )}
                {selectedKfData.outSpeed !== undefined && (
                  <div style={{ width: 68 }}>
                    <span className={styles.fieldLabel}>Out:</span>
                    <ValueField
                      value={selectedKfData.outSpeed}
                      precision={1}
                      min={0}
                      onChange={(newSpeed: number) => {
                        runAnimEdit('Set Outgoing Speed', () => {
                          applySpeedAt(selectedKfData.nodeId, selectedKfData.prop, selectedKfData.t, newSpeed, 'out');
                          if (selectedKfData.inSpeed !== undefined && Math.abs(newSpeed - selectedKfData.inSpeed) > 1e-6) {
                            defaultAnimation.updateKeyframe(selectedKfData.nodeId, selectedKfData.prop, selectedKfData.t, { continuous: false });
                          }
                        });
                      }}
                    />
                  </div>
                )}
                {selectedKfData.outInfluence !== undefined && (
                  <div style={{ width: 62 }}>
                    <span className={styles.fieldLabel}>Out%:</span>
                    <ValueField
                      value={Math.round(selectedKfData.outInfluence * 100)}
                      unit="%"
                      precision={0}
                      min={1}
                      max={99}
                      onChange={(newPct: number) => {
                        const trackKfs = defaultAnimation.getTrackKeyframes(selectedKfData.nodeId, selectedKfData.prop);
                        const idx = trackKfs ? findKfIndex(trackKfs, selectedKfData.t) : -1;
                        if (idx >= 0 && trackKfs && idx < trackKfs.length - 1) {
                          const self = trackKfs[idx]!;
                          const nextKf = trackKfs[idx + 1]!;
                          const dt = nextKf.t - self.t;
                          const dv = nextKf.value - self.value;
                          const bz = withOutgoingInfluence(effectiveBezier(self), dv, dt, newPct / 100);
                          runAnimEdit('Set Outgoing Influence', () => {
                            defaultAnimation.setBezier(selectedKfData.nodeId, selectedKfData.prop, self.t, bz, self.continuous);
                          });
                        }
                      }}
                    />
                  </div>
                )}
              </>
            )}

            {selectedKfData.easing === 'bezier' && (
              <button
                type="button"
                className={selectedKfData.continuous !== false ? styles.tabActive : styles.tab}
                style={{ padding: '2px 6px', fontSize: 'var(--font-size-micro, 10px)', display: 'inline-flex', alignItems: 'center', gap: 3 }}
                title={selectedKfData.continuous !== false
                  ? 'Handles are linked — drag moves both sides (Alt-drag to split). Click to break.'
                  : 'Handles are split — each side moves alone. Click to link.'}
                onClick={() => {
                  const nextContinuous = selectedKfData.continuous === false;
                  runAnimEdit(nextContinuous ? 'Link Tangents' : 'Break Tangents', () => {
                    defaultAnimation.updateKeyframe(selectedKfData.nodeId, selectedKfData.prop, selectedKfData.t, {
                      continuous: nextContinuous,
                    });
                    if (nextContinuous) alignKeyframeTangents(selectedKfData.nodeId, selectedKfData.prop, selectedKfData.t);
                  });
                }}
              >
                {selectedKfData.continuous !== false ? '🔗 Linked' : '🔓 Broken'}
              </button>
            )}

            {selectedKfData.easing ? <span className={styles.easingLabel}>· {selectedKfData.easing}</span> : null}
          </div>
        )}

        {allTracks.length === 0 && (
          <span className={styles.hint}>Select a layer with keyframes to view curves</span>
        )}

        {allTracks.map(({ nodeId, prop, color }) => {
          const key = trackKey(nodeId, prop);
          const soloed = !soloKeys || soloKeys.has(key);
          return (
            <button
              key={key}
              type="button"
              className={soloed ? styles.legendItem : styles.legendItemDim}
              title={soloKeys ? 'Click to solo / Shift-click to toggle · click soloed chip to show all' : 'Click to solo this curve · Shift-click to multi-solo'}
              onClick={(e) => toggleSolo(key, e.shiftKey)}
            >
              <span className={styles.legendDot} style={{ background: color }} />
              {prop}
            </button>
          );
        })}
      </div>

      {/* ── SVG graph canvas ───────────────────────────────────── */}
      <div ref={canvasRef} className={styles.canvas} onScroll={onCanvasScroll}>
        <svg
          ref={svgRef}
          className={`${styles.svg} ${cursorClass}`}
          width={graphWidth}
          height={INNER_H}
          onPointerDown={onSvgPointerDown}
          onPointerMove={onSvgPointerMove}
          onPointerUp={onSvgPointerUp}
          onPointerCancel={onSvgPointerUp}
          onLostPointerCapture={onSvgPointerUp}
        >
          {/* Grid — horizontal */}
          {[0, 0.25, 0.5, 0.75, 1].map((frac) => {
            const y = frac * INNER_H;
            return <line key={frac} className={styles.gridLine} x1={0} y1={y} x2={graphWidth} y2={y} strokeWidth={1} />;
          })}

          {/* Grid — vertical (seconds) */}
          {Array.from({ length: Math.ceil(duration) + 1 }, (_, i) => i).map((sec) => (
            <g key={sec}>
              <line className={styles.gridLineMinor} x1={sec * pps} y1={0} x2={sec * pps} y2={INNER_H} strokeWidth={1} />
              <text className={styles.axisLabel} x={sec * pps + 3} y={INNER_H - 3} fontSize={9}>{sec}s</text>
            </g>
          ))}

          {/* Value axis labels — pinned to the visible left edge, follow the selected track */}
          {axisTrack && [0, 0.25, 0.5, 0.75, 1].map((frac) => {
            const y = frac * INNER_H;
            const v = yToValue(y, axisTrack.minV, axisTrack.maxV, INNER_H);
            return (
              <text
                key={`ax-${frac}`}
                className={styles.axisLabel}
                x={scrollLeft + 4}
                y={frac === 0 ? y + 10 : y - 3}
                fontSize={9}
              >
                {fmtAxis(v)}{mode === 'speed' ? '/s' : ''}
              </text>
            );
          })}

          {/* Curves */}
          {sampledPaths.map(({ color, d, nodeId, prop }) => {
            const dimmed = !!soloKeys && !soloKeys.has(trackKey(nodeId, prop));
            return (
              <g key={`curve-${nodeId}:${prop}`}>
                {/* Fat invisible stroke — AE-sized grab for curve-body click. */}
                <path
                  d={d}
                  stroke="transparent"
                  strokeWidth={12}
                  fill="none"
                  style={{ pointerEvents: dimmed ? 'none' : 'stroke', cursor: 'pointer' }}
                  onPointerDown={(e) => onCurvePointerDown(e, nodeId, prop)}
                >
                  <title>{`Select ${prop} curve`}</title>
                </path>
                <path
                  className={styles.curve}
                  d={d}
                  stroke={color}
                  strokeWidth={1.5}
                  fill="none"
                  opacity={dimmed ? 0.12 : 0.9}
                  style={{ pointerEvents: 'none' }}
                />
              </g>
            );
          })}

          {/* Keyframe diamonds (all tracks) */}
          {sampledPaths.map(({ color, keyframes, nodeId, prop }) => {
            const dimmed = !!soloKeys && !soloKeys.has(trackKey(nodeId, prop));
            return (
            <g key={`kfs-${nodeId}:${prop}`} opacity={dimmed ? 0.2 : 1}>
              {keyframes.map((kf) => {
                const kx = kf.tAbs * pps;
                const ky = kf.y;
                const isSelected = selectedKfIds.has(makeKeyframeId(kf.nodeId, kf.prop, kf.t));
                const inView = kf.tAbs >= visT0 && kf.tAbs <= visT1;
                const showLabel = inView && (isSelected || showDenseLabels);
                const hasInJump = mode === 'speed' && kf.inSpeed !== undefined && kf.outSpeed !== undefined
                  && Math.abs(kf.inSpeed - kf.outSpeed) > 1e-6;
                const inJumpY = hasInJump ? valueToY(kf.inSpeed!, kf.minV, kf.maxV, INNER_H) : ky;
                return (
                  // Keyed by INDEX: a retiming diamond keeps its element (and its hover state).
                  <g key={kf.index}>
                    {hasInJump && (
                      <>
                        <line className={styles.speedJump} x1={kx} y1={inJumpY} x2={kx} y2={ky} strokeWidth={1} />
                        <circle className={styles.speedInDot} cx={kx} cy={inJumpY} r={2.5} stroke={color} strokeWidth={1.2} />
                      </>
                    )}
                    <rect
                      className={isSelected ? styles.keyframeSelected : styles.keyframe}
                      x={kx - KF_SIZE / 2}
                      y={ky - KF_SIZE / 2}
                      width={KF_SIZE}
                      height={KF_SIZE}
                      transform={`rotate(45, ${kx}, ${ky})`}
                      fill={color}
                      strokeWidth={isSelected ? 2 : 1.5}
                    />
                    {showLabel && (
                      <text
                        className={styles.kfLabel}
                        x={kx + KF_SIZE}
                        y={ky - 4}
                        fontSize={9}
                        fill={color}
                      >
                        {fmtAxis(mode === 'speed' ? kf.plotted : kf.value)}
                        {mode === 'speed' ? '/s' : ''}
                      </text>
                    )}
                    <circle
                      className={styles.kfHit}
                      cx={kx}
                      cy={ky}
                      r={HIT_RADIUS}
                      onPointerDown={(e) => onKfPointerDown(e, kf)}
                    >
                      <title>{`${kf.prop} @ ${kf.tAbs.toFixed(2)}s = ${fmtAxis(kf.value)}`}</title>
                    </circle>
                  </g>
                );
              })}
            </g>
            );
          })}

          {boxZoom && (
            <rect
              className={styles.boxZoomRect}
              x={Math.min(boxZoom.x0, boxZoom.x1)}
              y={Math.min(boxZoom.y0, boxZoom.y1)}
              width={Math.abs(boxZoom.x1 - boxZoom.x0)}
              height={Math.abs(boxZoom.y1 - boxZoom.y0)}
            />
          )}

          {graphSnap?.time && (
            <line
              className={`${styles.snapLine} ${graphSnap.time.kind === 'playhead' ? styles.snapPlayhead : styles.snapKeyframe}`}
              x1={graphSnap.time.time * pps}
              x2={graphSnap.time.time * pps}
              y1={0}
              y2={INNER_H}
            />
          )}
          {graphSnap?.value && (
            <line
              className={`${styles.snapLine} ${styles.snapValue}`}
              x1={0}
              x2={totalWidth}
              y1={valueToY(graphSnap.value.value, graphSnap.minV, graphSnap.maxV, INNER_H)}
              y2={valueToY(graphSnap.value.value, graphSnap.minV, graphSnap.maxV, INNER_H)}
            />
          )}

          {/* Bézier handles — drawn LAST so they sit above every diamond. */}
          {handleGeom && (
            <g>
              {handleGeom.showIn && (
                <>
                  <line className={styles.handleLine} x1={handleGeom.kx} y1={handleGeom.inAnchorY} x2={handleGeom.inX} y2={handleGeom.inY} strokeWidth={1} />
                  <circle className={styles.handleDot} cx={handleGeom.inX} cy={handleGeom.inY} r={HANDLE_RADIUS} strokeWidth={1.5} />
                  <circle
                    className={styles.handleHit}
                    cx={handleGeom.inX}
                    cy={handleGeom.inY}
                    r={HIT_RADIUS}
                    onPointerDown={(e) => onHandlePointerDown(e, handleGeom.kf, 'handle-in', handleGeom.inX, handleGeom.inY)}
                  />
                </>
              )}
              {handleGeom.showOut && (
                <>
                  <line className={styles.handleLine} x1={handleGeom.kx} y1={handleGeom.ky} x2={handleGeom.outX} y2={handleGeom.outY} strokeWidth={1} />
                  <circle className={styles.handleDot} cx={handleGeom.outX} cy={handleGeom.outY} r={HANDLE_RADIUS} strokeWidth={1.5} />
                  <circle
                    className={styles.handleHit}
                    cx={handleGeom.outX}
                    cy={handleGeom.outY}
                    r={HIT_RADIUS}
                    onPointerDown={(e) => onHandlePointerDown(e, handleGeom.kf, 'handle-out', handleGeom.outX, handleGeom.outY)}
                  />
                </>
              )}
            </g>
          )}

          {/* Playhead (never intercepts the pointer) */}
          <g className={styles.playhead}>
            <line className={styles.playheadLine} x1={playheadX} y1={0} x2={playheadX} y2={INNER_H} strokeWidth={1.5} />
            <polygon className={styles.playheadCap} points={`${playheadX - 5},0 ${playheadX + 5},0 ${playheadX},8`} />
          </g>
        </svg>
      </div>
    </div>
  );
}
