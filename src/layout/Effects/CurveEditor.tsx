/**
 * CurveEditor — a tone-curve control for the Curves effect.
 *
 * Drag control points to reshape the input→output mapping; click an empty spot
 * to add a point; Alt-click a point to remove it. Points are `[inputX, outputY]`
 * in 0–255, which feed the colour LUT (see core/effects/colorLut). The two
 * endpoints stay pinned in X (0 and 255) so the curve always spans the range.
 *
 * AE parity 5.1: the `hue` and `luma` variants are Lumetri's Hue / Luma vs
 * curves — X is the hue (0–360°) or the luma, the neutral is the horizontal
 * midline (128), and a strip under the frame shows what X means.
 */

import { useRef, useState } from 'react';
import type { CurvePoints } from '@core/inspector/effectCatalog';

const SIZE = 168; // px, square
const PAD = 8;
const INNER = SIZE - PAD * 2;
const R = 4; // handle radius, px

/** value 0–255 → svg x/y (y is inverted: output 255 at the top). */
const toX = (v: number): number => PAD + (v / 255) * INNER;
const toY = (v: number): number => PAD + (1 - v / 255) * INNER;
/** svg x/y → value 0–255. */
const fromX = (px: number): number => ((px - PAD) / INNER) * 255;
const fromY = (py: number): number => (1 - (py - PAD) / INNER) * 255;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** Sorted copy, always at least the two endpoints. Exported for testing. */
export function sortPoints(pts: CurvePoints): [number, number][] {
  const arr = (pts.length >= 2 ? pts : ([[0, 0], [255, 255]] as const))
    .map((p) => [p[0], p[1]] as [number, number]);
  return arr.sort((a, b) => a[0] - b[0]);
}

/** Add a control point at value (x, y). x is clamped to the interior (1..254). */
export function addPoint(pts: CurvePoints, x: number, y: number): [number, number][] {
  const next = sortPoints(pts);
  next.push([clamp(Math.round(x), 1, 254), clamp(Math.round(y), 0, 255)]);
  return next.sort((a, b) => a[0] - b[0]);
}

/** Remove the interior point at index i (endpoints are never removed). */
export function removePoint(pts: CurvePoints, i: number): [number, number][] {
  const arr = sortPoints(pts);
  if (i === 0 || i === arr.length - 1) return arr;
  return arr.filter((_, j) => j !== i);
}

/**
 * Move point i to value (x, y). Endpoints keep their X (0 / 255) and move only
 * in Y; interior points can't cross their neighbours in X.
 */
export function movePoint(pts: CurvePoints, i: number, x: number, y: number): [number, number][] {
  const arr = sortPoints(pts);
  const cy = clamp(Math.round(y), 0, 255);
  if (i === 0) arr[0] = [0, cy];
  else if (i === arr.length - 1) arr[arr.length - 1] = [255, cy];
  else {
    const loX = arr[i - 1]![0] + 1;
    const hiX = arr[i + 1]![0] + -1;
    arr[i] = [clamp(Math.round(x), loX, hiX), cy];
  }
  return arr.sort((a, b) => a[0] - b[0]);
}

export type CurveVariant = 'tone' | 'hue' | 'luma';

/** The strip under a hue / luma curve: what its X axis means. */
const STRIP: Record<Exclude<CurveVariant, 'tone'>, ReadonlyArray<[number, string]>> = {
  hue: [[0, 'hsl(0 90% 55%)'], [1 / 6, 'hsl(60 90% 55%)'], [2 / 6, 'hsl(120 90% 45%)'], [3 / 6, 'hsl(180 90% 45%)'],
    [4 / 6, 'hsl(240 90% 60%)'], [5 / 6, 'hsl(300 90% 55%)'], [1, 'hsl(360 90% 55%)']],
  luma: [[0, 'hsl(0 0% 0%)'], [1, 'hsl(0 0% 100%)']],
};

export function CurveEditor({
  value,
  onChange,
  variant = 'tone',
  fallback,
}: {
  value: CurvePoints;
  onChange: (points: CurvePoints) => void;
  /** `tone` (input → output), or a Lumetri Hue / Luma vs curve. */
  variant?: CurveVariant;
  /** The param's default, drawn when the stored value is missing. */
  fallback?: CurvePoints;
}): JSX.Element {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const neutral: CurvePoints = fallback ?? (variant === 'tone' ? [[0, 0], [255, 255]] : [[0, 128], [255, 128]]);

  const points = sortPoints(value.length >= 2 ? value : neutral);

  const localPoint = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const rect = svgRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerDownHandle = (e: React.PointerEvent, i: number): void => {
    e.stopPropagation();
    // Alt-click removes an interior point (never the two endpoints).
    if (e.altKey && i !== 0 && i !== points.length - 1) {
      onChange(removePoint(points, i));
      return;
    }
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setDragIndex(i);
  };

  const onPointerMove = (e: React.PointerEvent): void => {
    if (dragIndex === null) return;
    const p = localPoint(e);
    onChange(movePoint(points, dragIndex, fromX(p.x), fromY(p.y)));
  };

  const onPointerUp = (): void => setDragIndex(null);

  const onBackgroundDown = (e: React.PointerEvent): void => {
    const p = localPoint(e);
    onChange(addPoint(points, fromX(p.x), fromY(p.y)));
  };

  const gradientId = `curve-strip-${variant}`;

  const path = points.map((pt, i) => `${i === 0 ? 'M' : 'L'}${toX(pt[0]).toFixed(1)},${toY(pt[1]).toFixed(1)}`).join(' ');

  return (
    <svg
      ref={svgRef}
      width={SIZE}
      height={SIZE}
      role="img"
      aria-label={variant === 'hue' ? 'Hue curve' : variant === 'luma' ? 'Luma curve' : 'Tone curve'}
      style={{ touchAction: 'none', cursor: 'crosshair', background: 'var(--color-surface-1)', borderRadius: 4 }}
      onPointerDown={onBackgroundDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {/* frame + identity diagonal + quarter grid */}
      <rect x={PAD} y={PAD} width={INNER} height={INNER} fill="none" stroke="var(--color-border)" />
      {[0.25, 0.5, 0.75].map((f) => (
        <g key={f} stroke="var(--color-border)" strokeOpacity={0.4}>
          <line x1={PAD + f * INNER} y1={PAD} x2={PAD + f * INNER} y2={PAD + INNER} />
          <line x1={PAD} y1={PAD + f * INNER} x2={PAD + INNER} y2={PAD + f * INNER} />
        </g>
      ))}
      {variant === 'tone' ? (
        <line x1={PAD} y1={PAD + INNER} x2={PAD + INNER} y2={PAD} stroke="var(--color-border)" strokeDasharray="2 3" />
      ) : (
        <>
          <line x1={PAD} y1={toY(128)} x2={PAD + INNER} y2={toY(128)} stroke="var(--color-border)" strokeDasharray="2 3" />
          <defs>
            <linearGradient id={gradientId} x1="0" x2="1" y1="0" y2="0">
              {STRIP[variant].map(([o, c]) => <stop key={o} offset={o} stopColor={c} />)}
            </linearGradient>
          </defs>
          <rect x={PAD} y={PAD + INNER - 4} width={INNER} height={4} fill={`url(#${gradientId})`} pointerEvents="none" />
        </>
      )}

      {/* the curve */}
      <path d={path} fill="none" stroke="var(--color-primary, #4c8dff)" strokeWidth={1.5} />

      {/* control points */}
      {points.map((pt, i) => (
        <circle
          key={i}
          cx={toX(pt[0])}
          cy={toY(pt[1])}
          r={R}
          fill="var(--color-primary, #4c8dff)"
          stroke="#fff"
          strokeWidth={1}
          style={{ cursor: 'grab' }}
          onPointerDown={(e) => onPointerDownHandle(e, i)}
        />
      ))}
    </svg>
  );
}

export default CurveEditor;
