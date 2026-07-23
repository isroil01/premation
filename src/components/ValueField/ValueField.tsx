/**
 * ValueField — the signature numeric control of Motion Studio.
 *
 * Every numeric property in the app is edited through this one control, which
 * is simultaneously:
 *   • a scrubbable slider  — click-drag horizontally to adjust (AE/Blender)
 *   • a text input         — click (without dragging) to type an exact value
 *   • modifier-aware       — Shift = 10× step, Alt = 0.1× step; ↑/↓ nudge
 *   • a calculator         — accepts math: `960/2`, `+15`, `*1.5`, `(3+4)*2`
 *
 * The spec calls this the make-or-break interaction: "If this one interaction
 * feels perfect, the entire application feels professional."
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { cn } from '@utils/cn';
import { applyValueExpression } from '@utils/evalMath';
import { stepScale, clamp, format, scrubValue, SCRUB_DEAD_ZONE_PX } from './scrubMath';
import styles from './ValueField.module.css';

export interface ValueFieldProps {
  value: number;
  onChange: (value: number) => void;
  /** Optional live callback while scrubbing (defaults to onChange). */
  onScrub?: (value: number) => void;
  min?: number;
  max?: number;
  /** Base increment for one pixel of drag / one arrow press. */
  step?: number;
  /** Decimal places shown when not editing. Default 2, trailing zeros trimmed. */
  precision?: number;
  /** Unit label shown after the number (e.g. "°", "px", "%"). */
  unit?: string;
  disabled?: boolean;
  'aria-label'?: string;
}

// clamp / format / stepScale live in scrubMath.ts (pure + unit-tested).

export function ValueField({
  value,
  onChange,
  onScrub,
  min = -Infinity,
  max = Infinity,
  step = 1,
  precision = 2,
  unit,
  disabled = false,
  'aria-label': ariaLabel,
}: ValueFieldProps): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [dragging, setDragging] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Scrub bookkeeping held in refs so the pointer handlers never go stale.
  const scrub = useRef({ startX: 0, startVal: 0, moved: false, live: value });
  const commitScrub = onScrub ?? onChange;

  // Focus + select the input when we enter edit mode.
  useLayoutEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const beginEdit = useCallback(() => {
    setDraft(format(value, precision));
    setInvalid(false);
    setEditing(true);
  }, [value, precision]);

  const commitEdit = useCallback(() => {
    const next = applyValueExpression(value, draft);
    if (next === null) {
      // Invalid — flash and revert.
      setInvalid(true);
      setEditing(false);
      return;
    }
    setEditing(false);
    onChange(clamp(next, min, max));
  }, [draft, value, min, max, onChange]);

  const cancelEdit = useCallback(() => {
    setEditing(false);
    setInvalid(false);
  }, []);

  // ── Keyboard operation on the resting field (role="spinbutton") ─────
  // Reachable by Tab; arrows nudge (Shift 10× / Alt 0.1×), Enter opens edit.
  const onFieldKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (disabled || editing) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const delta = (e.key === 'ArrowUp' ? 1 : -1) * step * stepScale(e);
      onChange(clamp(value + delta, min, max));
    } else if (e.key === 'Home' && Number.isFinite(min)) {
      e.preventDefault();
      onChange(min);
    } else if (e.key === 'End' && Number.isFinite(max)) {
      e.preventDefault();
      onChange(max);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      beginEdit();
    }
  };

  const onInputKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      // While typing, arrows nudge the drafted number (if it is one).
      const cur = Number(draft);
      if (Number.isFinite(cur)) {
        e.preventDefault();
        const delta = (e.key === 'ArrowUp' ? 1 : -1) * step * stepScale(e);
        const next = clamp(cur + delta, min, max);
        setDraft(format(next, precision));
      }
    }
  };

  // ── Scrub (pointer drag on the field when not editing) ──────────────
  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      const s = scrub.current;
      const dx = e.clientX - s.startX;
      if (!s.moved && Math.abs(dx) < SCRUB_DEAD_ZONE_PX) return; // dead-zone: distinguish click
      if (!s.moved) {
        s.moved = true;
        setDragging(true);
      }
      const next = scrubValue(s.startVal, dx, step, e, min, max);
      s.live = next;
      commitScrub(next);
    },
    [step, min, max, commitScrub],
  );

  const onPointerUp = useCallback(() => {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    const s = scrub.current;
    if (s.moved) {
      setDragging(false);
      // Ensure the final value is committed through onChange (not just onScrub).
      onChange(clamp(s.live, min, max));
    } else {
      // No drag → treat as a click: enter edit mode.
      beginEdit();
    }
  }, [onPointerMove, onChange, min, max, beginEdit]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (disabled || editing) return;
    if (e.button !== 0) return;
    scrub.current = { startX: e.clientX, startVal: value, moved: false, live: value };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

  useEffect(
    () => () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    },
    [onPointerMove, onPointerUp],
  );

  return (
    <div
      className={cn(
        styles.field,
        dragging && styles.dragging,
        editing && styles.editing,
        invalid && styles.invalid,
        disabled && styles.disabled,
      )}
      onPointerDown={onPointerDown}
      onKeyDown={onFieldKeyDown}
      data-numeric
      {...(!editing
        ? {
            role: 'spinbutton',
            tabIndex: disabled ? -1 : 0,
            'aria-label': ariaLabel,
            'aria-valuenow': Number.isFinite(value) ? value : undefined,
            'aria-valuemin': Number.isFinite(min) ? min : undefined,
            'aria-valuemax': Number.isFinite(max) ? max : undefined,
            'aria-valuetext': `${format(value, precision)}${unit ?? ''}`,
            'aria-disabled': disabled || undefined,
          }
        : {})}
    >
      {editing ? (
        <input
          ref={inputRef}
          className={styles.input}
          value={draft}
          spellCheck={false}
          onChange={(e) => {
            setDraft(e.currentTarget.value);
            if (invalid) setInvalid(false);
          }}
          onKeyDown={onInputKeyDown}
          onBlur={commitEdit}
          aria-label={ariaLabel}
        />
      ) : (
        <span className={styles.value} aria-label={ariaLabel}>
          {format(value, precision)}
          {unit ? <span className={styles.unit}>{unit}</span> : null}
        </span>
      )}
    </div>
  );
}

export default ValueField;
