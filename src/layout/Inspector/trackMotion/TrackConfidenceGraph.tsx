/**
 * The tracker's confidence graph (AE parity 3.6): each point's match
 * confidence over time, coasted frames marked, the playhead and any hand
 * corrections drawn. A static SVG of the held result; it re-renders when the
 * result or the playhead changes, not per decoded frame.
 */

import { useMemo } from 'react';
import type { TrackerResult } from '@stores/trackerStore';
import styles from '../TrackMotionSection.module.css';

const W = 240;
const H = 56;
const COLOURS = ['var(--color-accent)', 'var(--color-success)', 'var(--color-warning)', 'var(--color-text-secondary)'];

export function TrackConfidenceGraph({ result, time, corrections, minConfidence = 0.55 }: {
  result: TrackerResult;
  time: number;
  corrections: readonly number[];
  minConfidence?: number;
}): JSX.Element | null {
  const geom = useMemo(() => {
    let t0 = Infinity;
    let t1 = -Infinity;
    for (const t of result.tracks) for (const s of t) { t0 = Math.min(t0, s.compTime); t1 = Math.max(t1, s.compTime); }
    if (!Number.isFinite(t0) || t1 <= t0) return null;
    const x = (t: number): number => ((t - t0) / (t1 - t0)) * W;
    const y = (c: number): number => H - 2 - Math.max(0, Math.min(1, c)) * (H - 4);
    const lines = result.tracks.slice(0, 8).map((track) => track.map((s) => `${x(s.compTime).toFixed(1)},${y(s.confidence).toFixed(1)}`).join(' '));
    const coasted = result.tracks.flatMap((track) => track.filter((s) => s.coasted).map((s) => x(s.compTime)));
    const lost = result.tracks.flatMap((track) => track.filter((s) => !s.coasted && s.confidence < minConfidence).map((s) => x(s.compTime)));
    return { x, y, lines, coasted, lost, t0, t1 };
  }, [result, minConfidence]);
  if (!geom) return null;
  const playX = time >= geom.t0 && time <= geom.t1 ? geom.x(time) : null;
  const low = result.tracks.reduce((n, t) => n + t.filter((s) => s.coasted || s.confidence < minConfidence).length, 0);
  return (
    <figure className={styles.group} style={{ margin: 0 }}>
      <svg
        role="img"
        aria-label={`Track confidence: ${low} weak or coasted samples`}
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        preserveAspectRatio="none"
        style={{ background: 'var(--color-surface-2, var(--color-surface-1))', borderRadius: 4 }}
      >
        <line x1={0} x2={W} y1={geom.y(minConfidence)} y2={geom.y(minConfidence)} stroke="var(--color-border-subtle)" strokeDasharray="3 3" />
        {geom.coasted.map((cx, i) => <rect key={`c${i}`} x={cx - 0.5} y={0} width={1} height={H} fill="var(--color-warning)" opacity={0.35} />)}
        {geom.lost.map((cx, i) => <rect key={`l${i}`} x={cx - 0.5} y={0} width={1} height={H} fill="var(--color-danger)" opacity={0.3} />)}
        {geom.lines.map((pts, i) => (
          <polyline key={i} points={pts} fill="none" stroke={COLOURS[i % COLOURS.length]} strokeWidth={1.25} vectorEffect="non-scaling-stroke" />
        ))}
        {corrections.map((t, i) => (t >= geom.t0 && t <= geom.t1 ? (
          <circle key={`k${i}`} cx={geom.x(t)} cy={4} r={2.5} fill="var(--color-accent)" />
        ) : null))}
        {playX !== null ? <line x1={playX} x2={playX} y1={0} y2={H} stroke="var(--color-text-primary)" strokeWidth={1} vectorEffect="non-scaling-stroke" /> : null}
      </svg>
      <figcaption className={styles.cardHint}>
        Confidence per point{low > 0 ? ` · ${low} weak or coasted frames (shaded)` : ''}. Drag a point on a weak frame to correct it, then track on.
      </figcaption>
    </figure>
  );
}
