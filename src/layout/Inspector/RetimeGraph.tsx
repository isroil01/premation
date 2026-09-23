/**
 * RetimeGraph — the speed curve (or source-frame curve) of ONE layer, drawn
 * across its clip bar and edited in place.
 *
 * After Effects makes you shape speed indirectly, through Time Remap's value
 * graph in a separate Graph Editor. This puts the thing you actually mean on
 * the layer's own inspector: drag a point up for faster, down for slower,
 * sideways to move the ramp, double-click to add one, Delete to remove it.
 *
 *   - SPEED is drawn on a LOG scale. 50% and 200% are the same distance from
 *     100%, and the slow-motion band a velocity edit lives in (10–40%) gets
 *     room instead of being squashed against the floor of a linear axis.
 *   - Dragging snaps to 100% near it, since "back to normal" is the value
 *     people aim for most.
 *   - Where the footage runs out the graph tints the rest of the bar, so the
 *     cost of a speed-up is visible before it is a frozen frame in the render.
 *
 * Pure UI: every write goes through `retimeCommands`, one undo step per drag.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { beginAnimEdit, recordAnimEdit } from '@core/animation/animationCommands';
import styles from './RetimeSection.module.css';

export interface RetimeGraphKey {
  /** Stored keyframe time (the track's own axis). */
  t: number;
  /** Comp seconds where the key takes effect. */
  compT: number;
  /** Percent (speed) or source frame (frames). */
  value: number;
}

export interface RetimeGraphProps {
  kind: 'speed' | 'frames';
  inSec: number;
  outSec: number;
  fps: number;
  time: number;
  keys: ReadonlyArray<RetimeGraphKey>;
  /** Curve value at comp time. */
  sample: (compT: number) => number;
  /** Frames kind: the top of the axis (source length in frames). */
  maxValue?: number;
  runsOutAtSec?: number | null;
  selectedT: number | null;
  onSelect: (t: number | null) => void;
  /**
   * Mutate (unrecorded) — called on every pointer move; the drag records one
   * step. Returns the key's new STORED time, which the next move addresses.
   */
  onMove: (fromT: number, compT: number, value: number) => number;
  onAdd: (compT: number, value: number) => void;
  onRemove: (t: number) => void;
  onSeek: (compT: number) => void;
  /** Recorded nudge from the keyboard. */
  onNudge: (t: number, compT: number, value: number) => void;
  ariaLabel: string;
}

const HEIGHT = 104;
const PAD_X = 10;
const PAD_TOP = 10;
const PAD_BOTTOM = 10;
const LABEL_W = 30;

/** Log speed axis: 5% … 800%. */
const LOG_MIN = Math.log2(0.05);
const LOG_MAX = Math.log2(8);
const SPEED_GRID = [10, 25, 50, 100, 200, 400];
const SNAP_TO_NORMAL = 0.06;

function formatSec(s: number): string {
  return `${s.toFixed(2)}s`;
}

export function RetimeGraph(props: RetimeGraphProps): JSX.Element {
  const {
    kind, inSec, outSec, fps, time, keys, sample, maxValue, runsOutAtSec,
    selectedT, onSelect, onMove, onAdd, onRemove, onSeek, onNudge, ariaLabel,
  } = props;
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(280);
  const [dragT, setDragT] = useState<number | null>(null);
  const drag = useRef<{ t: number; tx: ReturnType<typeof beginAnimEdit>; lo: number; hi: number } | null>(null);
  const scrubbing = useRef(false);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 40) setWidth(Math.round(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const span = Math.max(1 / fps, outSec - inSec);
  const x0 = PAD_X + LABEL_W;
  const plotW = Math.max(20, width - x0 - PAD_X);
  const plotH = HEIGHT - PAD_TOP - PAD_BOTTOM;

  const frameTop = Math.max(1, maxValue ?? 1, ...keys.map((k) => k.value * 1.1));

  const xOf = (t: number): number => x0 + ((t - inSec) / span) * plotW;
  const tOf = (x: number): number => inSec + ((x - x0) / plotW) * span;
  const yOf = (v: number): number => {
    const norm = kind === 'speed'
      ? (Math.log2(Math.max(0.05, Math.min(8, v / 100))) - LOG_MIN) / (LOG_MAX - LOG_MIN)
      : Math.max(0, Math.min(1, v / frameTop));
    return PAD_TOP + (1 - norm) * plotH;
  };
  const vOf = (y: number): number => {
    const norm = Math.max(0, Math.min(1, 1 - (y - PAD_TOP) / plotH));
    if (kind === 'frames') return Math.round(norm * frameTop);
    const pct = 100 * 2 ** (LOG_MIN + norm * (LOG_MAX - LOG_MIN));
    if (Math.abs(Math.log2(pct / 100)) < SNAP_TO_NORMAL * 4) return 100;
    return Math.round(pct);
  };

  const curve = useMemo(() => {
    const n = Math.max(24, Math.min(160, Math.round(plotW / 2)));
    let d = '';
    for (let i = 0; i <= n; i++) {
      const t = inSec + (span * i) / n;
      d += `${i === 0 ? 'M' : 'L'}${xOf(t).toFixed(1)},${yOf(sample(t)).toFixed(1)}`;
    }
    return d;
    // `sample` is a fresh closure every render; the keys and the width are what change it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys, plotW, inSec, span, kind, frameTop]);
  const area = `${curve}L${xOf(outSec).toFixed(1)},${(PAD_TOP + plotH).toFixed(1)}L${x0.toFixed(1)},${(PAD_TOP + plotH).toFixed(1)}Z`;

  const localPoint = (e: PointerEvent<SVGSVGElement>): { x: number; y: number } => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };
  const snapTime = (t: number): number => Math.round(Math.max(inSec, Math.min(outSec - 1 / fps, t)) * fps) / fps;

  const onPointerDown = (e: PointerEvent<SVGSVGElement>): void => {
    if (e.button !== 0) return;
    const target = e.target as SVGElement;
    const keyT = target.dataset.keyT;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    if (keyT !== undefined) {
      const t = Number(keyT);
      const idx = keys.findIndex((k) => k.t === t);
      const prev = keys[idx - 1];
      const next = keys[idx + 1];
      onSelect(t);
      drag.current = {
        t,
        // B3-legacy: engine gap — retime graph point drags need retime-key semantics (speed integration) the API's updateKeyframes does not apply.
        tx: beginAnimEdit(),
        lo: prev ? prev.compT + 1 / fps : inSec,
        hi: next ? next.compT - 1 / fps : outSec - 1 / fps,
      };
      setDragT(t);
      return;
    }
    onSelect(null);
    scrubbing.current = true;
    onSeek(snapTime(tOf(localPoint(e).x)));
  };

  const onPointerMove = (e: PointerEvent<SVGSVGElement>): void => {
    const p = localPoint(e);
    if (drag.current) {
      const d = drag.current;
      const compT = Math.round(Math.max(d.lo, Math.min(d.hi, tOf(p.x))) * fps) / fps;
      // The stored time moves with the drag. Take it from the write itself:
      // the `keys` prop only catches up on the next render, and a fast drag
      // delivers several moves before that.
      d.t = onMove(d.t, compT, vOf(p.y));
      return;
    }
    if (scrubbing.current) onSeek(snapTime(tOf(p.x)));
  };

  const endPointer = (e: PointerEvent<SVGSVGElement>): void => {
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (drag.current) {
      // B3-legacy: engine gap — retime graph point drags need retime-key semantics (speed integration) the API's updateKeyframes does not apply.
      recordAnimEdit(drag.current.tx.commit(kind === 'speed' ? 'Move speed point' : 'Move frame key'));
      drag.current = null;
      setDragT(null);
    }
    scrubbing.current = false;
  };

  const onDoubleClick = (e: React.MouseEvent<SVGSVGElement>): void => {
    if ((e.target as SVGElement).dataset.keyT !== undefined) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const t = snapTime(tOf(e.clientX - rect.left));
    onAdd(t, Math.round(sample(t)));
  };

  const onKeyDown = (e: KeyboardEvent<SVGCircleElement>, k: RetimeGraphKey): void => {
    const big = e.shiftKey;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      onRemove(k.t);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const dir = e.key === 'ArrowUp' ? 1 : -1;
      const step = kind === 'speed' ? (big ? 25 : 5) : (big ? 10 : 1);
      onNudge(k.t, k.compT, Math.max(kind === 'speed' ? 1 : 0, k.value + dir * step));
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      onNudge(k.t, snapTime(k.compT + (dir * (big ? 10 : 1)) / fps), k.value);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      onSeek(k.compT);
    }
  };

  const grid = kind === 'speed'
    ? SPEED_GRID
    : [0, Math.round(frameTop / 2), Math.round(frameTop)];

  return (
    <div className={styles.graph} ref={wrapRef}>
      <svg
        height={HEIGHT}
        viewBox={`0 0 ${width} ${HEIGHT}`}
        role="group"
        aria-label={ariaLabel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onDoubleClick={onDoubleClick}
      >
        {grid.map((g) => (
          <g key={g}>
            <line
              className={kind === 'speed' && g === 100 ? styles.gridBase : styles.grid}
              x1={x0} x2={x0 + plotW} y1={yOf(g)} y2={yOf(g)}
            />
            <text className={styles.gridLabel} x={PAD_X - 2} y={yOf(g) + 3}>
              {kind === 'speed' ? `${g}%` : g}
            </text>
          </g>
        ))}
        {runsOutAtSec !== null && runsOutAtSec !== undefined && (
          <rect
            className={styles.runout}
            x={xOf(runsOutAtSec)} y={PAD_TOP}
            width={Math.max(0, xOf(outSec) - xOf(runsOutAtSec))} height={plotH}
          >
            <title>No footage left — the last frame holds</title>
          </rect>
        )}
        <path className={styles.area} d={area} />
        <path className={styles.curve} d={curve} />
        {time >= inSec && time <= outSec && (
          <line className={styles.playhead} x1={xOf(time)} x2={xOf(time)} y1={0} y2={HEIGHT} />
        )}
        {keys.map((k) => (
          <circle
            key={k.t}
            className={styles.key}
            data-key-t={k.t}
            data-selected={selectedT === k.t || undefined}
            data-dragging={dragT === k.t || undefined}
            cx={xOf(k.compT)}
            cy={yOf(k.value)}
            r={5}
            tabIndex={0}
            role="button"
            aria-label={kind === 'speed'
              ? `Speed point ${Math.round(k.value)}% at ${formatSec(k.compT)}`
              : `Source frame ${Math.round(k.value)} at ${formatSec(k.compT)}`}
            onFocus={() => onSelect(k.t)}
            onKeyDown={(e) => onKeyDown(e, k)}
          />
        ))}
      </svg>
      <div className={styles.graphFoot}>
        <span>{formatSec(inSec)}</span>
        <span>{kind === 'speed' ? 'Drag points · double-click to add' : 'Drag keys · double-click to add'}</span>
        <span>{formatSec(outSec)}</span>
      </div>
    </div>
  );
}

export default RetimeGraph;
