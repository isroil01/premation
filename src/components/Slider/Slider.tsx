/**
 * Slider — single-value slider. Range slider is a separate component.
 *
 * Controlled: pass `value` + `onChange`. Uncontrolled: pass `defaultValue`.
 * The component is fully keyboard accessible (Arrow, Home, End, PageUp/Down).
 */

import { useCallback, useId, useRef, type ChangeEvent, type KeyboardEvent } from 'react';
import { cn } from '@utils/cn';
import { clamp } from '@utils/lang';
import styles from './Slider.module.css';

export interface SliderProps {
  value?: number;
  defaultValue?: number;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  /** Renders a visible caption above the track, and names the input. */
  label?: string;
  /**
   * Names the input WITHOUT drawing a caption — for a slider sitting under a
   * row that already carries the property's name. Passing `label` there printed
   * the name twice ("Distance 6 px", then "Drop Shadow Distance" underneath);
   * omitting it left the range input with no accessible name at all. Ignored
   * when `label` is set, which already names the input.
   */
  'aria-label'?: string;
  showValue?: boolean;
  onChange?: (value: number) => void;
  className?: string;
  size?: 'sm' | 'md';
}

function formatValue(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return Number(v.toFixed(3)).toString();
}

export function Slider({
  value,
  defaultValue,
  min = 0,
  max = 100,
  step = 1,
  disabled = false,
  label,
  'aria-label': ariaLabel,
  showValue = false,
  onChange,
  className,
  size = 'md',
}: SliderProps): JSX.Element {
  const id = useId();
  const isControlled = value !== undefined;
  const internalRef = useRef<number>(defaultValue ?? min);

  const current = isControlled ? (value as number) : internalRef.current;

  const setVal = useCallback(
    (v: number) => {
      const next = clamp(v, min, max);
      if (!isControlled) internalRef.current = next;
      onChange?.(next);
    },
    [isControlled, max, min, onChange],
  );

  const onInput = (e: ChangeEvent<HTMLInputElement>): void => {
    setVal(Number(e.currentTarget.value));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    const big = step * 10;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowUp':    setVal(current + step); e.preventDefault(); break;
      case 'ArrowLeft':
      case 'ArrowDown':  setVal(current - step); e.preventDefault(); break;
      case 'PageUp':     setVal(current + big);  e.preventDefault(); break;
      case 'PageDown':   setVal(current - big);  e.preventDefault(); break;
      case 'Home':       setVal(min);            e.preventDefault(); break;
      case 'End':        setVal(max);            e.preventDefault(); break;
      default: break;
    }
  };

  const percent = ((current - min) / Math.max(max - min, 1e-9)) * 100;

  return (
    <div className={cn(styles.root, disabled && styles.disabled, className)} data-size={size}>
      {label || showValue ? (
        <div className={styles.head}>
          {label ? <label htmlFor={id} className={styles.label}>{label}</label> : null}
          {showValue ? <span className={styles.value}>{formatValue(current)}</span> : null}
        </div>
      ) : null}
      <div className={styles.track}>
        <div className={styles.fill} style={{ width: `${percent}%` }} />
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={current}
          disabled={disabled}
          onChange={onInput}
          onInput={onInput}
          onKeyDown={onKeyDown}
          className={styles.input}
          aria-label={label ?? ariaLabel}
        />
      </div>
    </div>
  );
}
