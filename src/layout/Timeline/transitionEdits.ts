/**
 * Cut transitions through the engine API (B3z): `addTransition`,
 * `setTransition`, `removeTransitions` — each one undo entry that restores the
 * cut exactly, and a drag of a transition's end as ONE gesture that sends the
 * absolute length per move (docs/B3_PATTERNS.md §3). The record model and its
 * rules are the engine's (src/core/engine/handlers/transitions.ts); the
 * timeline keeps READING the transition store for its brackets until B4.
 */

import type { TransitionAlignment as ApiAlignment, TransitionKind as ApiKind } from '@motion/engine-api';
import { edit, GestureSession } from '@core/engine/uiEdits';
import { framesToFlicks } from '@core/engine/time';
import { documentMirror } from '@stores/documentMirror';
import { compFps } from '@hooks/useMirror';
import { DEFAULT_TRANSITION_FRAMES, type TransitionAlignment, type TransitionKind } from '@core/timeline/transitionModel';

export type TransitionEditResult = { ok: true; id: string } | { ok: false; reason: string };

/** The frame rate of the composition that holds the layer. */
function rateFor(nodeId: string): number {
  const m = documentMirror();
  return compFps(m.comp(m.layer(nodeId)?.comp ?? ''));
}

/** Add (or replace) the transition on the cut between two layers. Refusals come back as a reason to show. */
export async function addTransitionEdit(
  leftNodeId: string,
  rightNodeId: string,
  kind: TransitionKind,
  durationFrames: number = DEFAULT_TRANSITION_FRAMES,
  alignment: TransitionAlignment = 'centred',
): Promise<TransitionEditResult> {
  const res = await edit('', {
    type: 'addTransition',
    left: leftNodeId,
    right: rightNodeId,
    kind: kind as ApiKind,
    duration: framesToFlicks(Math.max(1, Math.round(durationFrames)), rateFor(leftNodeId)),
    alignment: alignment as ApiAlignment,
  }, { quiet: true });
  if (!res.ok) return { ok: false, reason: res.error.message };
  const id = (res.value[0] as { transition?: string } | undefined)?.transition ?? '';
  return { ok: true, id };
}

export interface TransitionPatch {
  kind?: TransitionKind;
  durationFrames?: number;
  alignment?: TransitionAlignment;
}

function setCommand(leftNodeId: string, id: string, patch: TransitionPatch) {
  return {
    type: 'setTransition' as const,
    transition: id,
    ...(patch.kind !== undefined ? { kind: patch.kind as ApiKind } : {}),
    ...(patch.durationFrames !== undefined
      ? { duration: framesToFlicks(Math.max(1, Math.round(patch.durationFrames)), rateFor(leftNodeId)) }
      : {}),
    ...(patch.alignment !== undefined ? { alignment: patch.alignment as ApiAlignment } : {}),
  };
}

/** Change a transition's kind, length or alignment — one entry. */
export async function setTransitionEdit(leftNodeId: string, id: string, patch: TransitionPatch): Promise<TransitionEditResult> {
  const res = await edit('', setCommand(leftNodeId, id, patch), { quiet: true });
  return res.ok ? { ok: true, id } : { ok: false, reason: res.error.message };
}

/** Remove transitions, restoring each cut exactly. */
export async function removeTransitionsEdit(ids: readonly string[]): Promise<boolean> {
  if (ids.length === 0) return false;
  const res = await edit('', { type: 'removeTransitions', transitions: [...ids] });
  return res.ok;
}

/**
 * Dragging a transition's end: ONE gesture, `setTransition{duration}` with the
 * absolute length per move (a length the handles cannot pay for is refused and
 * the last good one stays, as the legacy preview did). `end(null)` abandons.
 */
export class TransitionLengthDrag {
  private readonly g: GestureSession;
  private last: number;

  constructor(private readonly leftNodeId: string, private readonly id: string, startFrames: number) {
    this.g = new GestureSession('Change Transition', { quiet: true });
    this.last = startFrames;
  }

  move(frames: number): void {
    const f = Math.max(1, Math.round(frames));
    if (f === this.last) return;
    this.last = f;
    this.g.send(setCommand(this.leftNodeId, this.id, { durationFrames: f }));
  }

  end(commit: boolean): Promise<void> {
    return this.g.end(commit);
  }
}
