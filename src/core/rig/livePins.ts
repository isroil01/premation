/**
 * The ONE place a stored `PuppetPin` becomes a live `DeformPin`.
 *
 * ## Why this exists as a function
 *
 * `buildSnapshot` and `PuppetOverlay` each had their own copy of this — the same
 * five `sample` calls and the same object literal, written out twice. They agree
 * today only because someone kept them in step by hand, and nothing would have
 * said a word if they stopped: both compile, both run, and the overlay would
 * simply draw a mesh the renderer does not produce. That is §2·0's shape exactly
 * — two consumers, one rule, nothing enforcing agreement — and it is a seam that
 * a new pin field walks straight through. Adding `kind` to the literal in one
 * file and not the other gives you an editor where bend pins bend on canvas and
 * do nothing in the export, with a clean `tsc` either way.
 *
 * So the rule gets one reader. Both call this.
 */

import type { PuppetPin, DeformPin } from './puppet';

/** The slice of the animation engine this needs — nothing more. */
export interface PinSampler {
  sample(nodeId: string, path: string, timeSec: number): unknown;
  sampleData(nodeId: string, path: string, timeSec: number): unknown;
}

/** The keyframeable scalar tracks a pin exposes, by property name. */
export const PIN_SCALAR_TRACKS = ['rotation', 'stiffness', 'scale', 'overlap'] as const;

/** `puppet.<pinId>.<prop>` — the animation path for a pin's scalar track. */
export function pinPropPath(pinId: string, prop: string): string {
  return `puppet.${pinId}.${prop}`;
}

function scalarOr(v: unknown, fallback: number | undefined): number | undefined {
  return typeof v === 'number' ? v : fallback;
}

/**
 * Resolve a rig's pins at `timeSec`, folding each pin's keyframe tracks over its
 * stored static values.
 *
 * A BEND pin's position tracks are deliberately not sampled. It has no position
 * to animate — the solve derives one — so reading a `puppet.<id>.position` track
 * here would hand `deform` a target it then ignores, which is the kind of value
 * that survives in a file and confuses the next person to read it. Rotation,
 * scale and stiffness animate exactly as they do on an advanced pin.
 */
export function resolveLivePins(
  pins: readonly PuppetPin[],
  nodeId: string,
  timeSec: number,
  anim: PinSampler,
): DeformPin[] {
  return pins.map((pin) => {
    let px = pin.x;
    let py = pin.y;
    if (pin.kind !== 'bend') {
      const livePos = anim.sampleData(nodeId, pinPropPath(pin.id, 'position'), timeSec);
      if (
        Array.isArray(livePos) && livePos.length > 0 &&
        livePos[0] && typeof livePos[0] === 'object' && 'x' in livePos[0]
      ) {
        const pt = livePos[0] as { x: number; y: number };
        px = pt.x;
        py = pt.y;
      }
    }
    return {
      id: pin.id,
      x: px,
      y: py,
      ...(pin.kind ? { kind: pin.kind } : {}),
      rotation: scalarOr(anim.sample(nodeId, pinPropPath(pin.id, 'rotation'), timeSec), pin.rotation),
      stiffness: scalarOr(anim.sample(nodeId, pinPropPath(pin.id, 'stiffness'), timeSec), pin.stiffness),
      scale: scalarOr(anim.sample(nodeId, pinPropPath(pin.id, 'scale'), timeSec), pin.scale),
      overlap: scalarOr(anim.sample(nodeId, pinPropPath(pin.id, 'overlap'), timeSec), pin.overlap),
      overlapExtent: pin.overlapExtent,
    };
  });
}
