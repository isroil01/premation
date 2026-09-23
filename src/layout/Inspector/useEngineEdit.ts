/**
 * useEngineEdit — the send half of an inspector control that writes through
 * the engine API (B3, docs/B3_PATTERNS.md §1/§3), for rows that are not a
 * `useMultiPropertyField`.
 *
 *   const e = useEngineEdit();
 *   <ValueField {...e.scrub(`Set ${label}`)} onChange={(v) => e.send(`Set ${label}`, cmds(v))} />
 *
 * A ValueField calls `onChange` on every scrub move: inside a scrub the commands
 * go into ONE gesture (one undo entry, latest-wins messages); outside one (a
 * typed value, a click, a menu pick) each `send` is one `edit` — one entry.
 * `scrub(label, when)` only opens a gesture when `when()` says the write will
 * take the engine route, so a control that falls back to a legacy writer never
 * holds an empty gesture open.
 *
 * `press(label, when)` is the same for a control that has no scrub events of
 * its own (a colour picker's drag): pointer down anywhere inside the wrapper —
 * portals included, React events bubble through them — opens the gesture, the
 * next pointer up (or blur / Esc / unmount, see useGesture) ends it. A press
 * that changes nothing leaves no entry (an empty gesture is not recorded).
 */

import { useMemo } from 'react';
import type { Command } from '@motion/engine-api';
import { edit } from '@core/engine/uiEdits';
import { useGesture } from '@hooks/useGesture';

export interface EngineEdit {
  /** Props for a ValueField: a scrub is one gesture. */
  scrub(label: string, when?: () => boolean): { onScrubStart: () => void; onScrubEnd: () => void };
  /** Props for a wrapper element: a press-drag-release inside it is one gesture. */
  press(label: string, when?: () => boolean): { onPointerDownCapture: () => void };
  /** Into the open gesture, else as one `edit` named `label`. Empty = no-op. */
  send(label: string, commands: Command | readonly Command[]): void;
  /** True while a scrub gesture is open. */
  active(): boolean;
}

export function useEngineEdit(): EngineEdit {
  const g = useGesture();
  return useMemo<EngineEdit>(() => ({
    scrub: (label, when) => ({
      onScrubStart: () => { if (!when || when()) g.begin(label); },
      onScrubEnd: () => { if (g.isActive()) void g.end(); },
    }),
    press: (label, when) => ({
      onPointerDownCapture: () => {
        if (when && !when()) return;
        g.begin(label);
        const up = (): void => {
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', up);
          if (g.isActive()) void g.end();
        };
        // Bubble phase: the control's own pointerup handlers (a final onChange) run first.
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
      },
    }),
    send: (label, commands) => {
      const list = Array.isArray(commands) ? commands as readonly Command[] : [commands as Command];
      if (list.length === 0) return;
      if (g.isActive()) g.send(list);
      else void edit(label, list);
    },
    active: () => g.isActive(),
  }), [g]);
}

export default useEngineEdit;
