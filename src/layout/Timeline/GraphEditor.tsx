/**
 * GraphEditor — After Effects–style Value/Speed graph editor.
 *
 * Features:
 *  - Value mode: shows animated property curves as SVG Bézier paths.
 *  - Speed mode: shows the derivative (rate-of-change) of the curve. A y
 *    position here is a SPEED, so a vertical drag solves the segment's bezier
 *    for that speed (holding influence) rather than writing a value — see
 *    speedGraph.ts. Being able to say "leave this keyframe at 240 px/s" is the
 *    entire reason a speed graph exists; without it the mode was a read-out.
 *  - Interactive keyframe diamonds: drag horizontally to retime; vertically to
 *    change the value (value mode) or the speed (speed mode).
 *  - Bézier handle tangents: when a keyframe is selected, two circular handles appear;
 *    dragging them updates the easing via `defaultAnimation.setBezier`.
 *  - Playhead scrubbing by clicking the graph background.
 *  - Property legend with color dots.
 *
 * Lives below the timeline; shares the same horizontal time axis (pps /
 * scrollLeft). That axis is COMP time, while the animation engine stores
 * keyframes in LAYER time — every conversion happens in `sampledPaths`.
 */

import { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { Icon } from '@components/Icon';
import { defaultAnimation } from '@motion/animation';
import { beginAnimEdit, recordAnimEdit } from '@core/animation/animationCommands';
import { compToKeyframeTime, keyframeToCompTime } from '@core/timeline/TimelineController';
import { clamp } from '@utils/lang';
import { ValueField } from '@components/ValueField';
import { useSceneRevision } from '@stores/sceneStore';
import { withOutgoingSpeed, withIncomingSpeed, type Bezier } from './speedGraph';
import { useResizeObserver } from '@hooks/useResizeObserver';
import styles from './GraphEditor.module.css';

export interface GraphEditorProps {
  selectedNodeIds: ReadonlyArray<string>;
  currentTime: number;
  duration: number;
  pixelsPerSecond: number;
  scrollLeft: number;
  height?: number;
  onScrub?: (t: number) => void;
}

interface KfPoint {
  nodeId: string;
  prop: string;
  t: number;
  /**
   * The keyframe's REAL value — what gets written back.
   *
   * Distinct from `plotted` on purpose. These used to be the same field, set to
   * whatever the active graph displayed; in speed mode that is the DERIVATIVE,
   * so dragging a keyframe wrote its speed into its value. A position key at
   * x=100 travelling 250px/s silently became x=250, and because it looked like
   * an ordinary edit, undo was the only way back.
   */
  value: number;
  /** The value this graph plots: the value itself, or the speed in speed mode. */
  plotted: number;
  /**
   * `t` in COMP time — what the x axis and the playhead are measured in.
   *
   * `t` itself is LAYER time (the engine's base). They differ by the layer's
   * clip start, so plotting `t` directly drew every trimmed layer's curve
   * shifted away from its own keyframes by exactly that offset.
   */
  tAbs: number;
  y: number;
  /** Normalised min/max for this track — needed for drag math. */
  minV: number;
  maxV: number;
  /** Raw easing string ('linear' | 'easeIn' | … | 'bezier'). */
  easing?: string;
  /** Bezier handles [x1,y1,x2,y2] in [0,1] space. */
  bezier?: [number, number, number, number];
  continuous?: boolean;
}

interface SelectedKf {
  nodeId: string;
  prop: string;
  t: number;
}

/** Fixed multi-curve series palette (data-viz, not chrome) — shared across themes. */
const COLORS = ['#2988ff', '#ff6b6b', '#4cdf8e', '#ffd770', '#bf8cff', '#ff8cde'];
const GRAPH_HEIGHT_DEFAULT = 200;
const HANDLE_RADIUS = 4.5;
const KF_SIZE = 8;
/** cubic-bezier equivalent of linear — handles at ⅓ along the segment. */
const LINEAR_BEZIER: [number, number, number, number] = [1 / 3, 1 / 3, 2 / 3, 2 / 3];

function alignKeyframeTangents(nodeId: string, prop: string, t: number): void {
  const kfs = defaultAnimation.getTrackKeyframes(nodeId, prop);
  if (!kfs) return;
  const idx = kfs.findIndex((k) => Math.abs(k.t - t) < 0.001);
  if (idx <= 0 || idx >= kfs.length - 1) return;
  const prevKf = kfs[idx - 1]!;
  const kf = kfs[idx]!;
  const nextKf = kfs[idx + 1]!;
  
  const bz_A = [...(prevKf.bezier ?? LINEAR_BEZIER)] as [number, number, number, number];
  const bz_B = [...(kf.bezier ?? LINEAR_BEZIER)] as [number, number, number, number];
  
  const dt_A = kf.t - prevKf.t;
  const dv_A = kf.value - prevKf.value;
  const dt_B = nextKf.t - kf.t;
  const dv_B = nextKf.value - kf.value;
  
  if (bz_B[0] > 0 && dv_A !== 0) {
    const S = (bz_B[1] * dv_B) / (bz_B[0] * dt_B);
    const new_y2 = 1 - (S * (1 - bz_A[2]) * dt_A) / dv_A;
    bz_A[3] = Math.max(-1, Math.min(2, new_y2));
    defaultAnimation.setBezier(nodeId, prop, prevKf.t, bz_A, true);
  }
}

function valueToY(val: number, min: number, max: number, h: number): number {
  if (max === min) return h / 2;
  return h - ((val - min) / (max - min)) * h;
}

function yToValue(y: number, min: number, max: number, h: number): number {
  return min + (1 - y / h) * (max - min);
}

export function GraphEditor({
  selectedNodeIds,
  currentTime,
  duration,
  pixelsPerSecond: pps,
  scrollLeft,
  height: propsHeight,
  onScrub,
}: GraphEditorProps): JSX.Element {
  const rev = useSceneRevision((s) => s.rev);
  const [mode, setMode] = useState<'value' | 'speed'>('value');
  const [selectedKf, setSelectedKf] = useState<SelectedKf | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const { ref: containerRef, size } = useResizeObserver<HTMLDivElement>();

  const height = propsHeight ?? (size.height > 0 ? size.height : GRAPH_HEIGHT_DEFAULT);

  // Clear selection when selected nodes change.
  useEffect(() => { setSelectedKf(null); }, [selectedNodeIds]);

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
  const SAMPLES = 200;

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

    for (const { nodeId, prop, color } of allTracks) {
      const kfs = defaultAnimation.getTrackKeyframes(nodeId, prop);
      if (!kfs || kfs.length === 0) continue;

      // The engine stores keyframes on the canonical keyframe axis; this axis
      // (and the playhead) are COMP time. Convert at the boundary, per track —
      // the canonical pair honors trim/sourceIn, the active clip, stretch and
      // precomp remaps, so curves plot where the renderer applies them.
      const toAbs = (layerT: number): number => keyframeToCompTime(nodeId, layerT, prop);
      const toLayer = (absT: number): number => compToKeyframeTime(nodeId, absT, prop);

      let minV = Infinity, maxV = -Infinity;
      const getVal = (t: number) => {
        if (mode === 'speed') {
          const dt = 0.005;
          const v1 = defaultAnimation.sample(nodeId, prop, Math.max(0, t - dt)) ?? 0;
          const v2 = defaultAnimation.sample(nodeId, prop, Math.min(duration, t + dt)) ?? 0;
          return (v2 - v1) / (2 * dt);
        }
        return defaultAnimation.sample(nodeId, prop, t);
      };

      if (mode === 'value') {
        for (const kf of kfs) { minV = Math.min(minV, kf.value); maxV = Math.max(maxV, kf.value); }
      }
      
      // Sweep the axis in comp time, sample the engine in layer time.
      for (let i = 0; i <= SAMPLES; i++) {
        const v = getVal(toLayer((i / SAMPLES) * duration));
        if (v !== undefined) { minV = Math.min(minV, v); maxV = Math.max(maxV, v); }
      }
      if (maxV === minV) { minV -= 1; maxV += 1; }
      const pad = (maxV - minV) * 0.15;
      minV -= pad; maxV += pad;

      const pts: string[] = [];
      for (let i = 0; i <= SAMPLES; i++) {
        const tAbs = (i / SAMPLES) * duration;
        const v = getVal(toLayer(tAbs)) ?? minV;
        pts.push(`${tAbs * pps},${valueToY(v, minV, maxV, INNER_H)}`);
      }

      const keyframes: KfPoint[] = kfs.map((kf) => {
        // `plotted` is what this graph draws (speed in speed mode); `value` is
        // always the keyframe's own value, so writes can never confuse the two.
        const plotted = getVal(kf.t) ?? kf.value;
        return {
          nodeId, prop,
          t: kf.t,
          tAbs: toAbs(kf.t),
          value: kf.value,
          plotted,
          y: valueToY(plotted, minV, maxV, INNER_H),
          minV, maxV,
          easing: kf.easing,
          bezier: kf.bezier,
          continuous: kf.continuous,
        };
      });

      paths.push({ color, d: `M${pts.join('L')}`, keyframes, prop, nodeId, minV, maxV });
    }
    return paths;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allTracks, duration, pps, INNER_H, rev, mode]);

  // ── Drag state ────────────────────────────────────────────────
  const dragRef = useRef<{
    kind: 'kf' | 'handle-in' | 'handle-out';
    nodeId: string;
    prop: string;
    origT: number;
    origValue: number;
    origBezier: [number, number, number, number];
    startX: number;
    startY: number;
    minV: number;
    maxV: number;
    /** Graph mode FROZEN at drag-start. The move handler reads this, not the
     *  live `mode` state, so a mode switch mid-drag (only reachable via
     *  multi-touch, since pointer capture blocks a mouse) can never pair
     *  value-mode math with the speed-mode bounds captured here. */
    mode: 'value' | 'speed';
    tx?: ReturnType<typeof beginAnimEdit>;
  } | null>(null);

  const svgCoords = useCallback(
    (e: PointerEvent | React.PointerEvent<Element>): { x: number; y: number } => {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      return {
        x: e.clientX - rect.left + scrollLeft,
        y: e.clientY - rect.top,
      };
    },
    [scrollLeft],
  );

  // Start dragging a keyframe diamond.
  const onKfPointerDown = useCallback(
    (e: React.PointerEvent<SVGElement>, kf: KfPoint) => {
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      setSelectedKf({ nodeId: kf.nodeId, prop: kf.prop, t: kf.t });
      const { x, y } = svgCoords(e);
      dragRef.current = {
        kind: 'kf',
        nodeId: kf.nodeId,
        prop: kf.prop,
        origT: kf.t,
        origValue: kf.value,
        origBezier: kf.bezier ?? [0.25, 0.1, 0.25, 1],
        startX: x,
        startY: y,
        minV: kf.minV,
        maxV: kf.maxV,
        mode,
        tx: beginAnimEdit(),
      };
    },
    [svgCoords, mode],
  );

  // Start dragging a Bézier handle. Works on LINEAR keyframes too: grabbing a
  // handle converts the segment to bezier seeded with the linear-equivalent
  // curve, so the graph doesn't jump — only your drag bends it. (Previously
  // handles existed only after F9/Ease, a hidden extra step.)
  const onHandlePointerDown = useCallback(
    (e: React.PointerEvent<SVGElement>, kf: KfPoint, which: 'handle-in' | 'handle-out') => {
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      const { x, y } = svgCoords(e);
      const tx = beginAnimEdit();
      if (kf.easing !== 'bezier' || !kf.bezier) {
        defaultAnimation.setEasing(kf.nodeId, kf.prop, kf.t, 'bezier');
        defaultAnimation.setBezier(kf.nodeId, kf.prop, kf.t, LINEAR_BEZIER);
      }
      dragRef.current = {
        kind: which,
        nodeId: kf.nodeId,
        prop: kf.prop,
        origT: kf.t,
        origValue: kf.value,
        origBezier: kf.bezier ?? LINEAR_BEZIER,
        startX: x,
        startY: y,
        minV: kf.minV,
        maxV: kf.maxV,
        mode,
        tx,
      };
    },
    [svgCoords, mode],
  );

  /**
   * Apply a speed-graph vertical drag: set the speed LEAVING this keyframe, and
   * — when the keyframe is continuous — the matching speed ARRIVING at it, so
   * the two sides stay joined exactly as they do in the value graph.
   *
   * Seeds a linear-equivalent bezier first when the segment is not already
   * bezier, so the curve does not jump on the first pixel of the drag.
   */
  const applySpeedDrag = useCallback(
    (nodeId: string, prop: string, t: number, targetSpeed: number) => {
      const kfs = defaultAnimation.getTrackKeyframes(nodeId, prop);
      if (!kfs) return;
      const i = kfs.findIndex((k) => Math.abs(k.t - t) < 1e-6);
      if (i < 0) return;
      const self = kfs[i]!;
      const next = kfs[i + 1];
      const prev = kfs[i - 1];

      // Outgoing side — this keyframe's own easing governs the segment to `next`.
      if (next) {
        const dv = next.value - self.value;
        const dt = next.t - self.t;
        const base: Bezier = (self.easing === 'bezier' && self.bezier ? self.bezier : LINEAR_BEZIER) as Bezier;
        const bz = withOutgoingSpeed(base, dv, dt, targetSpeed);
        defaultAnimation.setBezier(nodeId, prop, self.t, bz, self.continuous);
      }

      // Incoming side lives on the PREVIOUS keyframe's bezier. Only matched when
      // the keyframe is continuous — a broken (alt-dragged) key is meant to have
      // two independent speeds, and forcing them equal would undo that.
      if (prev && self.continuous !== false) {
        const dv = self.value - prev.value;
        const dt = self.t - prev.t;
        const base: Bezier = (prev.easing === 'bezier' && prev.bezier ? prev.bezier : LINEAR_BEZIER) as Bezier;
        const bz = withIncomingSpeed(base, dv, dt, targetSpeed);
        defaultAnimation.setBezier(nodeId, prop, prev.t, bz, prev.continuous);
      }
    },
    [],
  );

  const onSvgPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const d = dragRef.current;
      if (!d) return;
      const { x, y } = svgCoords(e);
      const dx = x - d.startX;
      const dy = y - d.startY;

      if (d.kind === 'kf') {
        // Drag in COMP time (what the x axis measures), clamp to the comp, and
        // convert back through the canonical pair. A time delta is NOT the same
        // in both bases once a layer is stretched or remapped, so the naive
        // `origT + dx/pps` shortcut only held for plain clips.
        const newT = compToKeyframeTime(
          d.nodeId,
          clamp(keyframeToCompTime(d.nodeId, d.origT, d.prop) + dx / pps, 0, duration),
          d.prop,
        );
        // In SPEED mode the vertical axis is the derivative, so a y position is
        // a speed, not a value. Dragging vertically therefore solves the
        // segment's bezier for that speed (holding influence) rather than
        // writing the y into the keyframe's value — which is what it used to do
        // before `plotted` was split from `value`, silently turning a position
        // key at x=100 travelling 250px/s into x=250.
        const newV = d.mode === 'value'
          ? clamp(yToValue(d.startY + dy, d.minV, d.maxV, INNER_H), d.minV, d.maxV)
          : d.origValue;
        // `newT` is canonical keyframe time — same axis `d.origT` is stored on.
        defaultAnimation.updateKeyframe(d.nodeId, d.prop, d.origT, { t: newT, value: newV });
        if (d.mode === 'speed' && Math.abs(dy) > 0) {
          applySpeedDrag(d.nodeId, d.prop, newT, yToValue(y, d.minV, d.maxV, INNER_H));
        }
        dragRef.current!.origT = newT;
        dragRef.current!.startX = x;
        dragRef.current!.startY = y;
        dragRef.current!.origValue = newV;
        setSelectedKf({ nodeId: d.nodeId, prop: d.prop, t: newT });
      } else {
        // Handle drag — modifies bezier x1/y1 or x2/y2 based on proportional screen-space mapping.
        const bz = [...d.origBezier] as [number, number, number, number];
        const nextKf = sampledPaths.find(p => p.nodeId === d.nodeId && p.prop === d.prop)?.keyframes.find(k => k.t > d.origT);
        if (!nextKf) return;
        const dt = nextKf.t - d.origT;
        const dv = nextKf.value - d.origValue;
        
        const tHover = clamp(x / pps, d.origT, nextKf.t);
        const vHover = d.mode === 'value' ? clamp(yToValue(y, d.minV, d.maxV, INNER_H), d.minV, d.maxV) : d.origValue;
        
        const nx = dt === 0 ? 0 : Math.max(0, Math.min(1, (tHover - d.origT) / dt));
        const ny = dv === 0 ? 0 : Math.max(-1, Math.min(2, (vHover - d.origValue) / dv));
        
        const trackKfs = sampledPaths.find(p => p.nodeId === d.nodeId && p.prop === d.prop)?.keyframes;
        const anchorT = d.kind === 'handle-in' ? d.origT : nextKf.t;
        const anchorKf = trackKfs?.find(k => Math.abs(k.t - anchorT) < 0.001);
        
        const isContinuous = anchorKf && anchorKf.continuous !== false && !e.altKey;
        
        if (anchorKf && e.altKey && anchorKf.continuous !== false) {
          defaultAnimation.updateKeyframe(d.nodeId, d.prop, anchorKf.t, { continuous: false });
        }

        if (d.kind === 'handle-in') {
          bz[0] = nx;
          bz[1] = ny;
          
          if (isContinuous) {
            const idx = trackKfs ? trackKfs.findIndex(k => Math.abs(k.t - anchorT) < 0.001) : -1;
            if (idx > 0) {
              const prevKf = trackKfs![idx - 1]!;
              const prevBz = [...(prevKf.bezier ?? LINEAR_BEZIER)] as [number, number, number, number];
              const dt_A = anchorT - prevKf.t;
              const dv_A = anchorKf.value - prevKf.value;
              const dt_B = nextKf.t - anchorT;
              const dv_B = nextKf.value - anchorKf.value;
              
              if (nx > 0 && dv_A !== 0) {
                const S = (ny * dv_B) / (nx * dt_B);
                const new_y2 = 1 - (S * (1 - prevBz[2]) * dt_A) / dv_A;
                prevBz[3] = Math.max(-1, Math.min(2, new_y2));
                defaultAnimation.setBezier(d.nodeId, d.prop, prevKf.t, prevBz, true);
              }
            }
          }
        } else {
          bz[2] = nx;
          bz[3] = ny;
          
          if (isContinuous) {
            const idx = trackKfs ? trackKfs.findIndex(k => Math.abs(k.t - anchorT) < 0.001) : -1;
            if (idx >= 0 && idx < trackKfs!.length - 1) {
              const nextOfAnchor = trackKfs![idx + 1]!;
              const bz_B = [...(anchorKf.bezier ?? LINEAR_BEZIER)] as [number, number, number, number];
              const dt_A = anchorT - d.origT;
              const dv_A = anchorKf.value - d.origValue;
              const dt_B = nextOfAnchor.t - anchorT;
              const dv_B = nextOfAnchor.value - anchorKf.value;
              
              const denom = (1 - nx) * dt_A;
              if (denom !== 0 && dv_B !== 0) {
                const S = ((1 - ny) * dv_A) / denom;
                const new_y1 = (S * bz_B[0] * dt_B) / dv_B;
                bz_B[1] = Math.max(-1, Math.min(2, new_y1));
                defaultAnimation.setBezier(d.nodeId, d.prop, anchorKf.t, bz_B, true);
              }
            }
          }
        }
        
        defaultAnimation.setBezier(d.nodeId, d.prop, d.origT, bz);
        dragRef.current!.origBezier = bz;
      }
    },
    [svgCoords, pps, duration, INNER_H, sampledPaths, mode],
  );

  const onSvgPointerUp = useCallback(() => {
    const d = dragRef.current;
    if (d && d.tx) {
      const label = d.kind === 'kf' ? 'Move Keyframe' : 'Edit Curve';
      const cmd = d.tx.commit(label);
      recordAnimEdit(cmd);
    }
    dragRef.current = null;
  }, []);

  // Background scrub (only when not dragging a kf/handle).
  const onSvgPointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (!onScrub) return;
      const { x } = svgCoords(e);
      onScrub(clamp(x / pps, 0, duration));
    },
    [onScrub, svgCoords, pps, duration],
  );

  const totalWidth = Math.max(duration * pps, 1);
  const playheadX = currentTime * pps;

  // ── Find selected keyframe for handle rendering ───────────────
  const selectedKfData = selectedKf
    ? sampledPaths
        .flatMap((p) => p.keyframes)
        .find((kf) => kf.nodeId === selectedKf.nodeId && kf.prop === selectedKf.prop && Math.abs(kf.t - selectedKf.t) < 0.001)
    : null;

  return (
    <div className={styles.root} style={propsHeight ? { height: propsHeight } : undefined} ref={containerRef}>
      {/* ── Toolbar ────────────────────────────────────────────── */}
      <div className={styles.toolbar}>
        <button type="button" className={mode === 'value' ? styles.tabActive : styles.tab} onClick={() => setMode('value')} title="Value graph">
          <Icon name="graph-value" size={13} /> Value
        </button>
        <button type="button" className={mode === 'speed' ? styles.tabActive : styles.tab} onClick={() => setMode('speed')} title="Speed graph">
          <Icon name="graph-speed" size={13} /> Speed
        </button>
        <span className={styles.spacer} />
        {selectedKfData && (
          <div className={styles.hint} style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <div style={{ width: 60 }}>
              <span>t=</span>
              <ValueField
                value={selectedKfData.t}
                unit="s"
                precision={2}
                min={0}
                max={duration}
              onChange={(newT: number) => {
                defaultAnimation.updateKeyframe(selectedKfData.nodeId, selectedKfData.prop, selectedKfData.t, { t: newT });
                setSelectedKf(selectedKf ? { ...selectedKf, t: newT } : null);
              }}
            />
          </div>
          <div style={{ width: 60 }}>
            <span>v=</span>
            {/* Always the keyframe's own value, in both modes — this field
                used to display (and write back) the speed in speed mode. */}
            <ValueField
              value={selectedKfData.value}
              precision={2}
              onChange={(newV: number) => {
                defaultAnimation.updateKeyframe(selectedKfData.nodeId, selectedKfData.prop, selectedKfData.t, { value: newV });
              }}
            />
          </div>
          {selectedKfData.easing === 'bezier' && (
            <button
              type="button"
              className={selectedKfData.continuous !== false ? styles.tabActive : styles.tab}
              style={{ padding: '2px 6px', fontSize: 10, display: 'inline-flex', alignItems: 'center', gap: 3 }}
              title={selectedKfData.continuous !== false ? "Click to break tangent handles" : "Click to link tangent handles"}
              onClick={() => {
                const nextContinuous = selectedKfData.continuous === false;
                defaultAnimation.updateKeyframe(selectedKfData.nodeId, selectedKfData.prop, selectedKfData.t, {
                  continuous: nextContinuous
                });
                if (nextContinuous) {
                  alignKeyframeTangents(selectedKfData.nodeId, selectedKfData.prop, selectedKfData.t);
                }
              }}
            >
              {selectedKfData.continuous !== false ? "🔗 Linked" : "🔓 Broken"}
            </button>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            {mode === 'speed' ? (
              <span className={styles.easingLabel}>{selectedKfData.plotted.toFixed(1)}/s</span>
            ) : null}
            {selectedKfData.easing ? <span className={styles.easingLabel}>· {selectedKfData.easing}</span> : null}
          </div>
          </div>
        )}
        {allTracks.length === 0 && (
          <span className={styles.hint}>Select a layer with keyframes to view curves</span>
        )}
        {allTracks.map(({ nodeId, prop, color }) => (
          <span key={`${nodeId}:${prop}`} className={styles.legendItem}>
            <span className={styles.legendDot} style={{ background: color }} />
            {prop}
          </span>
        ))}
      </div>

      {/* ── SVG graph canvas ───────────────────────────────────── */}
      <div className={styles.canvas} style={{ overflow: 'hidden' }}>
        <svg
          ref={svgRef}
          className={styles.svg}
          width={totalWidth}
          height={INNER_H}
          style={{ transform: `translateX(${-scrollLeft}px)` }}
          onPointerDown={onSvgPointerDown}
          onPointerMove={onSvgPointerMove}
          onPointerUp={onSvgPointerUp}
          onPointerLeave={onSvgPointerUp}
        >
          {/* Grid — horizontal */}
          {[0, 0.25, 0.5, 0.75, 1].map((frac) => {
            const y = frac * INNER_H;
            return <line key={frac} className={styles.gridLine} x1={0} y1={y} x2={totalWidth} y2={y} strokeWidth={1} />;
          })}

          {/* Grid — vertical (seconds) */}
          {Array.from({ length: Math.ceil(duration) + 1 }, (_, i) => i).map((sec) => (
            <g key={sec}>
              <line className={styles.gridLineMinor} x1={sec * pps} y1={0} x2={sec * pps} y2={INNER_H} strokeWidth={1} />
              <text className={styles.axisLabel} x={sec * pps + 3} y={INNER_H - 3} fontSize={9}>{sec}s</text>
            </g>
          ))}

          {/* Value curves + keyframes */}
          {sampledPaths.map(({ color, d, keyframes, nodeId, prop }) => (
            <g key={`${nodeId}:${prop}`}>
              {/* Curve */}
              <path d={d} stroke={color} strokeWidth={1.5} fill="none" opacity={0.9} />

              {/* Bézier handles for the selected keyframe. Linear keyframes
                  show handles at the linear-equivalent positions — grabbing
                  one converts the segment to bezier (see onHandlePointerDown),
                  so easing never requires a separate F9 step first. */}
              {/* Bézier handles centered around the selected keyframe (AE-style). */}
              {keyframes.map((kf, i) => {
                const isSelected = selectedKf?.nodeId === kf.nodeId && selectedKf.prop === kf.prop && Math.abs(kf.t - selectedKf.t) < 0.001;
                if (!isSelected) return null;

                const kx = kf.tAbs * pps;
                const ky = kf.y;

                const prevKf = i > 0 ? keyframes[i - 1] : null;
                const nextKf = i < keyframes.length - 1 ? keyframes[i + 1] : null;

                const showIn = prevKf && kf.easing !== 'hold' && prevKf.easing !== 'hold';
                const showOut = nextKf && kf.easing !== 'hold';

                let inX = 0, inY = 0;
                let outX = 0, outY = 0;

                if (showIn && prevKf) {
                  const prevBz = prevKf.easing === 'bezier' && prevKf.bezier ? prevKf.bezier : LINEAR_BEZIER;
                  const dtPrev = kf.t - prevKf.t;
                  const dvPrev = kf.value - prevKf.value;
                  inX = kx - dtPrev * pps * (1 - prevBz[2]);
                  inY = mode === 'value' ? valueToY(kf.value - dvPrev * (1 - prevBz[3]), kf.minV, kf.maxV, INNER_H) : ky;
                }

                if (showOut && nextKf) {
                  const bz = kf.easing === 'bezier' && kf.bezier ? kf.bezier : LINEAR_BEZIER;
                  const dt = nextKf.t - kf.t;
                  const dv = nextKf.value - kf.value;
                  outX = kx + dt * pps * bz[0];
                  outY = mode === 'value' ? valueToY(kf.value + dv * bz[1], kf.minV, kf.maxV, INNER_H) : ky;
                }

                return (
                  <g key={`handle-${kf.t}`}>
                    {showIn && prevKf && (
                      <>
                        <line className={styles.handleLine} x1={kx} y1={ky} x2={inX} y2={inY} strokeWidth={1} strokeDasharray="2 2" />
                        <circle className={styles.handleDot} cx={inX} cy={inY} r={HANDLE_RADIUS} strokeWidth={1.5}
                          onPointerDown={(e) => onHandlePointerDown(e, prevKf, 'handle-out')} />
                      </>
                    )}
                    {showOut && nextKf && (
                      <>
                        <line className={styles.handleLine} x1={kx} y1={ky} x2={outX} y2={outY} strokeWidth={1} strokeDasharray="2 2" />
                        <circle className={styles.handleDot} cx={outX} cy={outY} r={HANDLE_RADIUS} strokeWidth={1.5}
                          onPointerDown={(e) => onHandlePointerDown(e, kf, 'handle-in')} />
                      </>
                    )}
                  </g>
                );
              })}

              {/* Keyframe diamonds */}
              {keyframes.map((kf) => {
                const kx = kf.tAbs * pps;
                const ky = kf.y;
                const isSelected = selectedKf?.nodeId === kf.nodeId && selectedKf.prop === kf.prop && Math.abs(kf.t - selectedKf.t) < 0.001;
                return (
                  <rect
                    key={`${kf.t}`}
                    className={isSelected ? styles.keyframeSelected : styles.keyframe}
                    x={kx - KF_SIZE / 2}
                    y={ky - KF_SIZE / 2}
                    width={KF_SIZE}
                    height={KF_SIZE}
                    transform={`rotate(45, ${kx}, ${ky})`}
                    fill={color}
                    strokeWidth={isSelected ? 2 : 1.5}
                    onPointerDown={(e) => onKfPointerDown(e, kf)}
                  />
                );
              })}
            </g>
          ))}

          {/* Playhead */}
          <line className={styles.playheadLine} x1={playheadX} y1={0} x2={playheadX} y2={INNER_H} strokeWidth={1.5} />
          <polygon className={styles.playheadCap} points={`${playheadX - 5},0 ${playheadX + 5},0 ${playheadX},8`} />
        </svg>
      </div>
    </div>
  );
}
