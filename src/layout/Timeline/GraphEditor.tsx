/**
 * GraphEditor — After Effects–style Value/Speed graph editor.
 *
 * Features:
 *  - Value mode: shows animated property curves as SVG Bézier paths.
 *  - Speed mode: shows the derivative (rate-of-change) of the curve.
 *  - Interactive keyframe diamonds: drag horizontally to retime, vertically to change value.
 *  - Bézier handle tangents: when a keyframe is selected, two circular handles appear;
 *    dragging them updates the easing via `defaultAnimation.setBezier()`.
 *  - Playhead scrubbing by clicking the graph background.
 *  - Property legend with color dots.
 *
 * Lives below the timeline; shares the same horizontal time axis (pps / scrollLeft).
 */

import { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { Icon } from '@components/Icon';
import { defaultAnimation } from '@motion/animation';
import { beginAnimEdit, recordAnimEdit } from '@core/animation/animationCommands';
import { clamp } from '@utils/lang';
import { ValueField } from '@components/ValueField';
import { useSceneRevision } from '@stores/sceneStore';
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
  value: number;
  y: number;
  /** Normalised min/max for this track — needed for drag math. */
  minV: number;
  maxV: number;
  /** Raw easing string ('linear' | 'easeIn' | … | 'bezier'). */
  easing?: string;
  /** Bezier handles [x1,y1,x2,y2] in [0,1] space. */
  bezier?: [number, number, number, number];
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
  height = GRAPH_HEIGHT_DEFAULT,
  onScrub,
}: GraphEditorProps): JSX.Element {
  const rev = useSceneRevision((s) => s.rev);
  const [mode, setMode] = useState<'value' | 'speed'>('value');
  const [selectedKf, setSelectedKf] = useState<SelectedKf | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

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

  const INNER_H = height - 40; // leave 40 px for toolbar
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
      
      for (let i = 0; i <= SAMPLES; i++) {
        const v = getVal((i / SAMPLES) * duration);
        if (v !== undefined) { minV = Math.min(minV, v); maxV = Math.max(maxV, v); }
      }
      if (maxV === minV) { minV -= 1; maxV += 1; }
      const pad = (maxV - minV) * 0.15;
      minV -= pad; maxV += pad;

      const pts: string[] = [];
      for (let i = 0; i <= SAMPLES; i++) {
        const tSec = (i / SAMPLES) * duration;
        const v = getVal(tSec) ?? minV;
        pts.push(`${tSec * pps},${valueToY(v, minV, maxV, INNER_H)}`);
      }

      const keyframes: KfPoint[] = kfs.map((kf) => {
        const val = getVal(kf.t) ?? kf.value;
        return {
          nodeId, prop,
          t: kf.t, value: val,
          y: valueToY(val, minV, maxV, INNER_H),
          minV, maxV,
          easing: kf.easing,
          bezier: kf.bezier,
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
        tx: beginAnimEdit(),
      };
    },
    [svgCoords],
  );

  // Start dragging a Bézier handle.
  const onHandlePointerDown = useCallback(
    (e: React.PointerEvent<SVGElement>, kf: KfPoint, which: 'handle-in' | 'handle-out') => {
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      const { x, y } = svgCoords(e);
      dragRef.current = {
        kind: which,
        nodeId: kf.nodeId,
        prop: kf.prop,
        origT: kf.t,
        origValue: kf.value,
        origBezier: kf.bezier ?? [0.25, 0.1, 0.25, 1],
        startX: x,
        startY: y,
        minV: kf.minV,
        maxV: kf.maxV,
        tx: beginAnimEdit(),
      };
    },
    [svgCoords],
  );

  const onSvgPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const d = dragRef.current;
      if (!d) return;
      const { x, y } = svgCoords(e);
      const dx = x - d.startX;
      const dy = y - d.startY;

      if (d.kind === 'kf') {
        const newT = clamp(d.origT + dx / pps, 0, duration);
        const newV = mode === 'value' ? clamp(
          yToValue(d.startY + dy, d.minV, d.maxV, INNER_H),
          d.minV,
          d.maxV,
        ) : d.origValue;
        defaultAnimation.updateKeyframe(d.nodeId, d.prop, d.origT, { t: newT, value: newV });
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
        const vHover = mode === 'value' ? clamp(yToValue(y, d.minV, d.maxV, INNER_H), d.minV, d.maxV) : d.origValue;
        
        const nx = dt === 0 ? 0 : Math.max(0, Math.min(1, (tHover - d.origT) / dt));
        const ny = dv === 0 ? 0 : Math.max(-1, Math.min(2, (vHover - d.origValue) / dv));
        
        if (d.kind === 'handle-in') {
          bz[0] = nx;
          bz[1] = ny;
        } else {
          bz[2] = nx;
          bz[3] = ny;
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
    <div className={styles.root} style={{ height }} ref={containerRef}>
      {/* ── Toolbar ────────────────────────────────────────────── */}
      <div className={styles.toolbar}>
        <button type="button" className={mode === 'value' ? styles.tabActive : styles.tab} onClick={() => setMode('value')} title="Value graph">
          <Icon name="track" size={13} /> Value
        </button>
        <button type="button" className={mode === 'speed' ? styles.tabActive : styles.tab} onClick={() => setMode('speed')} title="Speed graph">
          <Icon name="move" size={13} /> Speed
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
            <ValueField
              value={selectedKfData.value}
              precision={2}
              onChange={(newV: number) => {
                defaultAnimation.updateKeyframe(selectedKfData.nodeId, selectedKfData.prop, selectedKfData.t, { value: newV });
              }}
            />
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

              {/* Bézier handles for selected keyframe */}
              {keyframes.map((kf, i) => {
                const isSelected = selectedKf?.nodeId === kf.nodeId && selectedKf.prop === kf.prop && Math.abs(kf.t - selectedKf.t) < 0.001;
                if (!isSelected || kf.easing !== 'bezier' || !kf.bezier) return null;
                const nextKf = keyframes[i + 1];
                if (!nextKf) return null;

                const kx = kf.t * pps;
                const ky = kf.y;
                const dt = nextKf.t - kf.t;
                const dv = nextKf.value - kf.value;
                
                const inX = kx + dt * pps * kf.bezier[0];
                const inY = mode === 'value' ? valueToY(kf.value + dv * kf.bezier[1], kf.minV, kf.maxV, INNER_H) : ky;
                const outX = kx + dt * pps * kf.bezier[2];
                const outY = mode === 'value' ? valueToY(kf.value + dv * kf.bezier[3], kf.minV, kf.maxV, INNER_H) : ky;
                
                return (
                  <g key={`handle-${kf.t}`}>
                    <line className={styles.handleLine} x1={kx} y1={ky} x2={inX} y2={inY} strokeWidth={1} strokeDasharray="2 2" />
                    <line className={styles.handleLine} x1={nextKf.t * pps} y1={nextKf.y} x2={outX} y2={outY} strokeWidth={1} strokeDasharray="2 2" />
                    <circle className={styles.handleDot} cx={inX} cy={inY} r={HANDLE_RADIUS} strokeWidth={1.5}
                      onPointerDown={(e) => onHandlePointerDown(e, kf, 'handle-in')} />
                    <circle className={styles.handleDot} cx={outX} cy={outY} r={HANDLE_RADIUS} strokeWidth={1.5}
                      onPointerDown={(e) => onHandlePointerDown(e, kf, 'handle-out')} />
                  </g>
                );
              })}

              {/* Keyframe diamonds */}
              {keyframes.map((kf) => {
                const kx = kf.t * pps;
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
