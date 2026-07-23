/**
 * AngleDial — the purpose-built rotation control (AE's dial).
 *
 * A small ring with a needle showing the current angle. Dragging anywhere on
 * the dial rotates the needle to follow the pointer (pointer-captured), with
 * per-move deltas accumulated so a continuous drag winds through multiple
 * revolutions — shown AE-style as "1x+45°" beside the dial. Shift snaps to
 * 15°. The dial only VISUALIZES + writes: it always renders `value` from
 * props, and every change goes out through `onChange` — so a keyframed
 * property's write path (setKeyframe vs base prop) stays exactly whatever the
 * host row already does. Pair it with a ValueField for typed entry.
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { cn } from '@utils/cn';
import { pointerAngleDeg, wrapDeltaDeg, snapAngle, revolutionsOf, formatAngle } from './angleDialMath';
import styles from './AngleDial.module.css';

export interface AngleDialProps {
  /** Current angle in degrees (unbounded — revolutions welcome). */
  value: number;
  onChange: (value: number) => void;
  /** Dial diameter in px (compact default fits 24px inspector rows). */
  size?: number;
  /** Shift-drag snap increment (deg). */
  snap?: number;
  disabled?: boolean;
  'aria-label'?: string;
}

export function AngleDial({
  value,
  onChange,
  size = 18,
  snap = 15,
  disabled = false,
  'aria-label': ariaLabel,
}: AngleDialProps): JSX.Element {
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState(false);
  // Drag bookkeeping in a ref so pointer handlers never go stale: the live
  // (unsnapped) accumulated angle plus the last raw pointer angle.
  const drag = useRef({ live: 0, lastRaw: 0 });
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const centerOf = (): { cx: number; cy: number } => {
    const r = svgRef.current?.getBoundingClientRect();
    return r ? { cx: r.left + r.width / 2, cy: r.top + r.height / 2 } : { cx: 0, cy: 0 };
  };

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>): void => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const { cx, cy } = centerOf();
    drag.current = { live: value, lastRaw: pointerAngleDeg(cx, cy, e.clientX, e.clientY) };
    try {
      svgRef.current?.setPointerCapture(e.pointerId);
    } catch {
      /* best-effort */
    }
    setDragging(true);
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>): void => {
    if (!dragging) return;
    const { cx, cy } = centerOf();
    const raw = pointerAngleDeg(cx, cy, e.clientX, e.clientY);
    const d = wrapDeltaDeg(raw - drag.current.lastRaw);
    drag.current.lastRaw = raw;
    drag.current.live += d;
    onChangeRef.current(e.shiftKey ? snapAngle(drag.current.live, snap) : drag.current.live);
  };

  const endDrag = useCallback((): void => setDragging(false), []);
  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>): void => {
    if (!dragging) return;
    try {
      svgRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    endDrag();
  };

  // Safety net: a cancelled pointer (e.g. OS gesture) must not leave the dial
  // stuck in dragging state.
  useEffect(() => {
    if (!dragging) return;
    window.addEventListener('pointercancel', endDrag);
    return () => window.removeEventListener('pointercancel', endDrag);
  }, [dragging, endDrag]);

  const onKeyDown = (e: ReactKeyboardEvent<SVGSVGElement>): void => {
    if (disabled) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const dir = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 1 : -1;
      onChange(e.shiftKey ? snapAngle(value + dir * snap, snap) : value + dir);
    }
  };

  const r = size / 2;
  const needleLen = r - 2.5;
  const rad = ((value % 360) * Math.PI) / 180;
  // 0° points up, clockwise positive.
  const nx = r + Math.sin(rad) * needleLen;
  const ny = r - Math.cos(rad) * needleLen;
  const { turns } = revolutionsOf(value);

  return (
    <span className={styles.root}>
      <svg
        ref={svgRef}
        className={cn(styles.dial, dragging && styles.dragging)}
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={ariaLabel ?? 'Angle'}
        aria-valuenow={Number.isFinite(value) ? Math.round(value * 10) / 10 : undefined}
        aria-valuetext={formatAngle(value)}
        aria-disabled={disabled || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={onKeyDown}
      >
        <title>{formatAngle(value)}</title>
        <circle className={styles.ring} cx={r} cy={r} r={r - 1} />
        {/* 12 o'clock zero tick */}
        <line className={styles.tick} x1={r} y1={1.5} x2={r} y2={3.5} />
        <line className={styles.needle} x1={r} y1={r} x2={nx} y2={ny} />
        <circle className={styles.hub} cx={r} cy={r} r={1.2} />
      </svg>
      {turns !== 0 && (
        <span className={styles.turns} title={formatAngle(value)}>
          {turns}x
        </span>
      )}
    </span>
  );
}

export default AngleDial;
