/**
 * useGesture — a drag as ONE undo entry through the engine API (B3,
 * ENGINE_API.md §5). The React face of `GestureSession` (src/core/engine/uiEdits.ts).
 *
 *   const g = useGesture();
 *   onPointerDown: g.begin('Opacity', e)     beginGesture; captures the pointer when given an event
 *   onPointerMove: g.send(commands)          one message per move, latest wins
 *   onPointerUp:   g.end()                   endGesture(commit)
 *
 * Every way a drag can stop is covered, so a gesture can never leak open (an
 * open gesture refuses undo):
 *
 *   pointer up / cancel        → end (commit)          (the caller's handler, or
 *   lost pointer capture       → end (commit)           the capture listeners
 *   window blur                → end (commit)           installed by `begin(e)`)
 *   Escape                     → cancel (revert everything the drag applied)
 *   unmount mid-drag           → end (commit)
 *   `begin` while one is open  → the previous one ends (commit) first
 *
 * "Commit" on the involuntary endings follows §5.1: nothing the user saw is lost.
 *
 * Fields that own their pointer handling (ValueField: window listeners +
 * pointer lock, no capture) call `begin(label)` from `onScrubStart` and
 * `end()` from `onScrubEnd`; blur/Escape/unmount are still covered here.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Command } from '@motion/engine-api';
import { GestureSession, type EditOptions } from '@core/engine/uiEdits';

export interface GestureHandle {
  /** Open a gesture. Pass the pointerdown event to capture the pointer on its target. */
  begin(label: string, e?: { pointerId: number; currentTarget: EventTarget | null }): void;
  /** Send the edit for the current pointer position (no-op when no gesture is open). */
  send(commands: Command | readonly Command[]): void;
  /** Commit. */
  end(): Promise<void>;
  /** Revert everything the gesture applied. */
  cancel(): Promise<void>;
  /** True between begin and end/cancel (a ref read — does not re-render). */
  isActive(): boolean;
}

export interface UseGestureOptions extends EditOptions {
  /** Re-render the caller while a gesture is open (`active`). Default false: drags must not render per move. */
  trackActive?: boolean;
}

export function useGesture(opts: UseGestureOptions = {}): GestureHandle & { active: boolean } {
  const session = useRef<GestureSession | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  const [active, setActive] = useState(false);
  const optsRef = useRef(opts);
  useEffect(() => { optsRef.current = opts; });

  const detach = useCallback((): void => {
    cleanup.current?.();
    cleanup.current = null;
  }, []);

  const finish = useCallback((commit: boolean): Promise<void> => {
    const s = session.current;
    session.current = null;
    detach();
    if (optsRef.current.trackActive) setActive(false);
    return s ? s.end(commit) : Promise.resolve();
  }, [detach]);

  const begin = useCallback<GestureHandle['begin']>((label, e) => {
    if (session.current) void finish(true);
    const { trackActive: _t, ...editOpts } = optsRef.current;
    session.current = new GestureSession(label, editOpts);
    if (optsRef.current.trackActive) setActive(true);

    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      void finish(false);
    };
    const onBlur = (): void => { void finish(true); };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    const disposers: Array<() => void> = [
      () => window.removeEventListener('keydown', onKey, true),
      () => window.removeEventListener('blur', onBlur),
    ];

    const el = e?.currentTarget as (Element & Partial<Pick<Element, 'setPointerCapture' | 'releasePointerCapture' | 'hasPointerCapture'>>) | null | undefined;
    if (el && typeof el.addEventListener === 'function' && e) {
      const pointerId = e.pointerId;
      try { el.setPointerCapture?.(pointerId); } catch { /* element not connected: listeners below still end the drag */ }
      const onLost = (ev: Event): void => {
        if ((ev as PointerEvent).pointerId !== pointerId) return;
        void finish(true);
      };
      const onUp = (ev: Event): void => {
        if ((ev as PointerEvent).pointerId !== pointerId) return;
        void finish(true);
      };
      el.addEventListener('lostpointercapture', onLost);
      el.addEventListener('pointercancel', onUp);
      disposers.push(() => {
        el.removeEventListener('lostpointercapture', onLost);
        el.removeEventListener('pointercancel', onUp);
        try { if (el.hasPointerCapture?.(pointerId)) el.releasePointerCapture?.(pointerId); } catch { /* ignore */ }
      });
    }
    cleanup.current = () => { for (const d of disposers) d(); };
  }, [finish]);

  const send = useCallback<GestureHandle['send']>((commands) => {
    session.current?.send(commands);
  }, []);
  const end = useCallback(() => finish(true), [finish]);
  const cancel = useCallback(() => finish(false), [finish]);
  const isActive = useCallback(() => session.current !== null, []);

  // Unmount mid-drag commits (nothing the user saw is lost).
  useEffect(() => () => { void finish(true); }, [finish]);

  return useMemo(() => ({ begin, send, end, cancel, isActive, active }), [begin, send, end, cancel, isActive, active]);
}

export default useGesture;
