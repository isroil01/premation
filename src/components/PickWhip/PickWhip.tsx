/**
 * PickWhip — drag a line from here onto a layer to link the two.
 *
 * The gesture After Effects users reach for a hundred times a day, and the one
 * whose absence reads as "this is not really AE" more than any missing effect.
 * Two things use it: parenting (drop on a layer → that layer becomes the
 * parent) and expressions (drop on a layer or property → insert a reference to
 * it).
 *
 * ── Why a rubber-band line and not HTML drag-and-drop ──────────────────
 * Native DnD cannot draw a line, cannot follow the cursor over a virtualised
 * list without the browser's own drag image getting in the way, and gives no
 * pointer position on Firefox during a drag. Pointer events plus a fixed
 * overlay is less machinery and behaves the same everywhere.
 *
 * Pointer CAPTURE is what makes the drag survive leaving the button: without
 * it, moving over the timeline sends the events to whatever is under the cursor
 * and the line stops following after ten pixels.
 *
 * Targets are resolved from the DOM, not from a registry — see
 * `@core/whip/whipTarget` for why.
 */

import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@utils/cn';
import { resolveWhipTargetAt, type WhipTarget } from '@core/whip/whipTarget';
import styles from './PickWhip.module.css';

/** Modifier keys held at the moment the whip was released. */
export interface WhipModifiers {
  altKey: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

export interface PickWhipProps {
  /**
   * Called on release over a valid target. Not called when released elsewhere.
   *
   * `modifiers` reports what was held at the drop, because After Effects gives
   * the parent whip a modified variant: Alt links without compensating the
   * transform. Callers that do not have one ignore the second argument.
   */
  onPick: (target: WhipTarget, modifiers: WhipModifiers) => void;
  /** Accessible name — "Parent pick-whip", "Expression pick-whip". */
  label: string;
  /**
   * Whether a target is droppable. Default: anything resolvable.
   *
   * A predicate rather than a list of refused ids, because both callers already
   * have a predicate and neither has a list: parenting asks "would this create
   * a cycle", and an expression whip asks "is this a different layer". Passing
   * a list would mean each caller enumerating its own descendants to build one.
   */
  accept?: (target: WhipTarget) => boolean;
  disabled?: boolean;
  className?: string;
}

interface DragState {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  /** True when the cursor is over something this whip would accept. */
  valid: boolean;
}

export function PickWhip({ onPick, label, accept, disabled, className }: PickWhipProps): JSX.Element {
  const [drag, setDrag] = useState<DragState | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  const targetAt = (x: number, y: number): WhipTarget | null => {
    const target = resolveWhipTargetAt(x, y);
    if (!target) return null;
    return accept && !accept(target) ? null : target;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({
      fromX: rect.left + rect.width / 2,
      fromY: rect.top + rect.height / 2,
      toX: event.clientX,
      toY: event.clientY,
      valid: false,
    });
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    setDrag((d) =>
      d
        ? { ...d, toX: event.clientX, toY: event.clientY, valid: targetAt(event.clientX, event.clientY) !== null }
        : d,
    );
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (!drag) return;
    // Released FIRST, so the element under the cursor is the drop target and
    // not this button — with capture still held, `elementFromPoint` would
    // still be answering about the row but the button would keep receiving
    // events, and a second drag could never start.
    event.currentTarget.releasePointerCapture(event.pointerId);
    setDrag(null);
    const target = targetAt(event.clientX, event.clientY);
    if (target) {
      onPick(target, {
        altKey: event.altKey, shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey, metaKey: event.metaKey,
      });
    }
  };

  const onPointerCancel = (): void => setDrag(null);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={cn(styles.whip, drag && styles.whipActive, className)}
        aria-label={label}
        title={label}
        disabled={disabled}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        {/* The spiral. Drawn rather than an icon-font glyph so it reads at 12px
            and matches the stroke weight of the controls beside it. */}
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <path
            d="M8 2.5a5.5 5.5 0 1 1-5.5 5.5A4 4 0 0 1 6.5 4a3 3 0 0 1 3 3 2 2 0 0 1-2 2 1.4 1.4 0 0 1-1.4-1.4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      </button>

      {/*
        The rubber band, in a portal on the body: the whip lives inside panels
        that clip and scroll, and a line drawn in place would be cut off at the
        first panel edge it crossed — which is every useful drag.
      */}
      {drag
        ? createPortal(
            <svg className={styles.overlay} aria-hidden="true">
              <line
                x1={drag.fromX}
                y1={drag.fromY}
                x2={drag.toX}
                y2={drag.toY}
                className={cn(styles.line, drag.valid && styles.lineValid)}
              />
              <circle cx={drag.toX} cy={drag.toY} r={drag.valid ? 4 : 2.5} className={cn(styles.tip, drag.valid && styles.tipValid)} />
            </svg>,
            document.body,
          )
        : null}
    </>
  );
}

export default PickWhip;
