/**
 * ValueField — the signature numeric control of Motion Studio.
 *
 * Every numeric property in the app is edited through this one control, which
 * is simultaneously:
 *   • a scrubbable slider — click-drag horizontally to adjust (AE/Blender)
 *   • a text input — click (without dragging) to type an exact value
 *   • modifier-aware — Shift = 10× step, Alt = 0.1× step; ↑/↓ nudge
 *   • a calculator — accepts math: `960/2`, `+15`, `*1.5`, `(3+4)*2`
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
import {
  stepScale,
  clamp,
  format,
  beginScrub,
  advanceScrub,
  SCRUB_DEAD_ZONE_PX,
  type ScrubState,
} from './scrubMath';
import styles from './ValueField.module.css';

export interface ValueFieldProps {
  value: number;
  onChange: (value: number) => void;
  /** Optional live callback while scrubbing (defaults to onChange). */
  onScrub?: (value: number) => void;
  /**
   * Fired once when a pointer drag crosses the dead zone and becomes a scrub,
   * before the first `onScrub`. A caller that scrubs SEVERAL properties off
   * one field (proportional scrubbing) needs to snapshot their start values
   * here — by the first `onScrub` they have already moved.
   */
  onScrubStart?: () => void;
  /** Fired after the final `onChange` of a scrub. Not fired for a click. */
  onScrubEnd?: () => void;
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
  onScrubStart,
  onScrubEnd,
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
  const scrub = useRef<{
    startX: number;
    /** Previous clientX, for the pre-lock delta. Meaningless once locked —
     *  a locked pointer's clientX is frozen, which is the whole point. */
    lastX: number;
    moved: boolean;
    locked: boolean;
    state: ScrubState;
  }>({
    startX: 0,
    lastX: 0,
    moved: false,
    locked: false,
    state: beginScrub(value, { shiftKey: false, altKey: false }),
  });
  const fieldRef = useRef<HTMLDivElement>(null);
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
  //
  // Pointer lock is what makes the drag CONTINUOUS. Without it the gesture is
  // bounded by the monitor: the cursor reaches the screen edge, `clientX` stops
  // changing, and the value freezes mid-drag — so a wide range could not be
  // crossed in one gesture, which is the one thing this control exists to do.
  // Locked, the cursor is hidden and parked while `movementX` keeps arriving,
  // exactly like After Effects.
  //
  // The lock is requested only AFTER the dead zone is crossed. Requesting it on
  // pointer-down would hide the cursor on every click that turns out to be a
  // click, and the browser would flash its "press Esc to show your cursor"
  // banner for a gesture the user never made.
  const releaseLock = useCallback(() => {
    if (!scrub.current.locked) return;
    scrub.current.locked = false;
    try {
      if (typeof document !== 'undefined' && document.exitPointerLock) document.exitPointerLock();
    } catch {
      /* lock already gone (Esc, tab switch) — nothing to release */
    }
  }, []);

  /*
   * The window listeners are STABLE functions that forward to the latest
   * handlers through a ref, and they are removed only on pointer-up or unmount.
   *
   * This is the bug behind "dragging works, but not continuously like AE".
   * The handlers are `useCallback`s over `onChange`/`step`/`min`/`max`, and the
   * cleanup used to list them as effect dependencies — so the first committed
   * value re-rendered the parent, handed this field a fresh inline `onChange`,
   * changed the callbacks' identity, and the cleanup tore the listeners off
   * MID-GESTURE. The drag applied exactly one delta and then went dead until
   * you released and pressed again. Which is precisely what a user sees as
   * "it works, but it's not continuous".
   */
  const latest = useRef<{
    move: (e: PointerEvent) => void;
    up: () => void;
  }>({ move: () => {}, up: () => {} });

  const windowHandlers = useRef({
    move: (e: PointerEvent): void => latest.current.move(e),
    up: (): void => latest.current.up(),
  });

  const detachWindowListeners = useCallback((): void => {
    window.removeEventListener('pointermove', windowHandlers.current.move);
    window.removeEventListener('pointerup', windowHandlers.current.up);
  }, []);

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      const s = scrub.current;
      if (!s.moved) {
        // Dead-zone measured from the press point, not accumulated, so a shaky
        // click that returns to where it started stays a click.
        if (Math.abs(e.clientX - s.startX) < SCRUB_DEAD_ZONE_PX) return;
        s.moved = true;
        s.lastX = s.startX;
        setDragging(true);
        onScrubStart?.();
        const el = fieldRef.current;
        if (el && typeof el.requestPointerLock === 'function') {
          try {
            // Chromium returns a promise here; older engines return void. It
            // rejects when the user recently pressed Esc, or the document is
            // not focused. A scrub that stays cursor-bound is a fine fallback,
            // so both paths simply leave `locked` false.
            const req = el.requestPointerLock() as unknown as Promise<void> | undefined;
            if (req && typeof req.then === 'function') {
              req.then(
                () => { scrub.current.locked = true; },
                () => { scrub.current.locked = false; },
              );
            } else {
              s.locked = document.pointerLockElement === el;
            }
          } catch {
            s.locked = false;
          }
        }
      }
      // Locked: clientX is frozen, so movementX is the only signal.
      // Unlocked: clientX deltas are exact and free of the platform's raw-input
      // scaling, so prefer them. NaN guards the frame right after a lock is
      // lost, where the previous clientX belongs to a frozen cursor.
      const dx = s.lastX;
      const delta = s.locked
        ? e.movementX
        : Number.isFinite(dx) ? e.clientX - dx : 0;
      s.lastX = e.clientX;
      s.state = advanceScrub(s.state, delta, step, e, min, max);
      commitScrub(s.state.value);
    },
    [step, min, max, commitScrub, onScrubStart],
  );

  const onPointerUp = useCallback(() => {
    detachWindowListeners();
    releaseLock();
    const s = scrub.current;
    if (s.moved) {
      setDragging(false);
      // Ensure the final value is committed through onChange (not just onScrub).
      onChange(clamp(s.state.value, min, max));
      onScrubEnd?.();
    } else {
      // No drag → treat as a click: enter edit mode.
      beginEdit();
    }
  }, [detachWindowListeners, onChange, min, max, beginEdit, onScrubEnd, releaseLock]);

  // Refreshed every render so the stable listeners always call TODAY's
  // handlers, with today's `onChange`, `step`, `min` and `max`.
  latest.current.move = onPointerMove;
  latest.current.up = onPointerUp;

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (disabled || editing) return;
    if (e.button !== 0) return;
    // Stop the browser starting a text selection or a native drag under the
    // gesture: with the pointer locked a live selection keeps growing
    // invisibly and swallows the pointerup.
    e.preventDefault();
    scrub.current = {
      startX: e.clientX,
      lastX: e.clientX,
      moved: false,
      locked: false,
      state: beginScrub(value, e),
    };
    window.addEventListener('pointermove', windowHandlers.current.move);
    window.addEventListener('pointerup', windowHandlers.current.up);
  };

  // Esc, a tab switch or a window blur drops the lock out from under an
  // in-flight scrub. Fall back to cursor-bound tracking rather than freezing:
  // `lastX` is invalidated so the next move re-seeds it instead of measuring
  // against a frozen coordinate and jumping.
  useEffect(() => {
    const onLockChange = (): void => {
      if (scrub.current.locked && document.pointerLockElement !== fieldRef.current) {
        scrub.current.locked = false;
        scrub.current.lastX = Number.NaN;
      }
    };
    document.addEventListener('pointerlockchange', onLockChange);
    return () => document.removeEventListener('pointerlockchange', onLockChange);
  }, []);

  // Unmount only. Listing the handlers here (which is what this used to do) is
  // what killed a drag on its first re-render — see `windowHandlers` above.
  useEffect(() => detachWindowListeners, [detachWindowListeners]);

  // Release the lock if the field unmounts mid-scrub (panel closed, layer
  // deleted) — otherwise the cursor stays hidden with nothing listening.
  useEffect(() => releaseLock, [releaseLock]);

  return (
    <div
      ref={fieldRef}
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
