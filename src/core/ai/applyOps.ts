/**
 * Apply AI-produced keyframe operations to the animation engine.
 *
 * The backend returns an ordered list of ops (set / remove / move / easing),
 * already validated against the document. We replay them inside a single
 * `runAnimEdit(...)` so the whole AI edit collapses to ONE reversible `anim.edit`
 * command — a single Cmd+Z reverses it, and the authored keyframes remain fully
 * editable in the timeline like any hand-made ones.
 */

import { defaultAnimation, type EasingKind } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';

export interface KeyframeOp {
  op: 'set' | 'remove' | 'move' | 'easing';
  nodeId: string;
  prop: string;
  t: number;
  value?: number;
  toT?: number;
  easing?: EasingKind;
}

export function applyAiOps(label: string, ops: KeyframeOp[]): void {
  if (!ops.length) return;
  runAnimEdit(label || 'AI edit', () => {
    for (const op of ops) {
      switch (op.op) {
        case 'set':
          if (typeof op.value === 'number') {
            defaultAnimation.setKeyframe(op.nodeId, op.prop, op.t, op.value, op.easing);
          }
          break;
        case 'remove':
          defaultAnimation.removeKeyframe(op.nodeId, op.prop, op.t);
          break;
        case 'move':
          if (typeof op.toT === 'number') {
            defaultAnimation.moveKeyframe(op.nodeId, op.prop, op.t, op.toT);
          }
          break;
        case 'easing':
          if (op.easing) {
            defaultAnimation.setEasing(op.nodeId, op.prop, op.t, op.easing);
          }
          break;
      }
    }
  });
}
