/**
 * RangeInput — a native `<input type="range">` drawn the app's way: a slim
 * rounded track, the filled part in the accent, a round thumb that grows a
 * little on hover and while dragged.
 *
 * A drop-in for the raw range inputs settings pages and popovers used, which
 * Chromium drew as its stock light-blue control. Same props as the native
 * element; the fill follows `value` through a CSS variable, no extra render.
 */

import { forwardRef, type CSSProperties, type InputHTMLAttributes } from 'react';
import { cn } from '@utils/cn';
import styles from './RangeInput.module.css';

export type RangeInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>;

function percent(value: unknown, min: unknown, max: unknown): number {
  const v = Number(value);
  const lo = min === undefined ? 0 : Number(min);
  const hi = max === undefined ? 100 : Number(max);
  if (!Number.isFinite(v) || !Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return 0;
  return Math.min(100, Math.max(0, ((v - lo) / (hi - lo)) * 100));
}

export const RangeInput = forwardRef<HTMLInputElement, RangeInputProps>(function RangeInput(
  { className, style, value, min, max, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      type="range"
      className={cn(styles.range, className)}
      style={{ '--range-pct': `${percent(value, min, max)}%`, ...style } as CSSProperties}
      value={value}
      min={min}
      max={max}
      {...rest}
    />
  );
});
