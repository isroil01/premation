/**
 * B4 round 8 — the dynamics commands in the TypeScript engine (the reference
 * the C++ engine's handlers_dynamics.cpp is checked against):
 *
 *   poseIk3D   CCD over a 3D parent chain aimed at a target's world origin,
 *              the joints' X / Y / Z Rotation written at `time` (setProperty
 *              rules: a keyed rotation gets a key)
 *   bakeIk3D   the same solve at every frame of a range, each joint's rotations
 *              replaced by one linear key per frame (boneIK3d.ts planIk3DBake)
 *
 * Both compose the property handlers' own plans (setProperties / setKeyframes),
 * so validation, key ids and undo are theirs.
 */

import type { Command, Keyframe, PropRef } from '@motion/engine-api';
import type { HandlerTable, HandlerCtx, Plan } from '../handler';
import { fail } from '../errors';
import { graph, requireLayer } from '../doc';
import { catalogFor } from '../props';
import { flicksToSeconds, secondsToFlicks, compFps } from '../time';
import { compOfLayer } from '../doc';
import { newScope, scopeLayer } from '../state';
import { propertyHandlers } from './properties';
import { is3DEnabled } from '@core/scene/threeD';
import { nodeWorldWithParents3d } from '@core/scene/liveWorld3d';
import { planIk3DBake, type IkOptions } from '@core/scene/boneIK3d';

/** The TOTAL-euler rotation tracks a joint is written on (X, Y, Z). */
const ROT_TRACKS = [['rotationX', 'rx'], ['rotationY', 'ry'], ['rotation', 'rz']] as const;

function ikOptions(o: { iterations?: number; tolerance?: number; maxStepRad?: number } | undefined): IkOptions {
  return {
    ...(o?.iterations !== undefined ? { iterations: o.iterations } : {}),
    ...(o?.tolerance !== undefined ? { tolerance: o.tolerance } : {}),
    ...(o?.maxStepRad !== undefined ? { maxStepRad: o.maxStepRad } : {}),
  };
}

function requireChain(chain: readonly string[], target: string): void {
  if (chain.length < 2) fail('invalidArgument', 'an IK chain needs at least two joints');
  for (const id of chain) {
    const n = requireLayer(id);
    if (!is3DEnabled(n)) fail('invalidArgument', `joint '${id}' is not a 3D layer`, { layer: id });
  }
  requireLayer(target);
}

/** The API property of a joint's rotation track. */
function rotationRef(layer: string, track: string): PropRef {
  const b = catalogFor(layer).byMember.get(track);
  if (!b) fail('notFound', `layer '${layer}' has no ${track}`, { layer });
  return { layer, path: b.path };
}

/** Run sub-commands' plans as one: their scopes merged, their applies in order. */
function composed(label: string, layers: readonly string[], plans: Array<Plan<unknown>>, result: () => { frames: number }): Plan<{ frames: number }> {
  const s = newScope();
  for (const l of layers) scopeLayer(s, l);
  return {
    scope: s,
    label,
    apply: () => {
      for (const p of plans) p.apply();
      return result();
    },
  };
}

function planOf(cmd: Command, ctx: HandlerCtx): Plan<unknown> {
  const h = (propertyHandlers as Record<string, (c: Command, x: HandlerCtx) => Plan<unknown>>)[cmd.type];
  if (!h) fail('internal', `no handler for ${cmd.type}`);
  return h(cmd, ctx);
}

export const dynamicsHandlers: HandlerTable = {
  poseIk3D: (cmd, ctx) => {
    requireChain(cmd.chain, cmd.target);
    const seconds = flicksToSeconds(cmd.time);
    const target = nodeWorldWithParents3d(graph.getNode(cmd.target)!, seconds);
    if (!target) fail('invalidArgument', `the target '${cmd.target}' has no resolvable 3D position`, { layer: cmd.target });
    // One frame of the bake IS the pose (the same solve, the same seed).
    const plan = planIk3DBake([...cmd.chain], cmd.target, seconds, seconds, compFps(compOfLayer(cmd.chain[0]!) ?? ''), ikOptions(cmd.options));
    if (!plan) fail('invalidArgument', 'the chain or the target could not resolve');
    const writes = plan.joints.flatMap((j) => ROT_TRACKS.map(([track, field]) => ({
      prop: rotationRef(j.id, track),
      value: { kind: 'scalar' as const, value: j[field][0]!.value },
      time: cmd.time,
    })));
    const sub = planOf({ type: 'setProperties', writes } as Command, ctx);
    return composed('Pose 3D IK', cmd.chain, [sub], () => ({ frames: 1 }));
  },

  bakeIk3D: (cmd, ctx) => {
    requireChain(cmd.chain, cmd.target);
    const comp = compOfLayer(cmd.chain[0]!) ?? '';
    const fps = compFps(comp);
    const t0 = flicksToSeconds(cmd.range.start);
    const t1 = flicksToSeconds(cmd.range.start + cmd.range.duration);
    const plan = planIk3DBake([...cmd.chain], cmd.target, t0, t1, fps, ikOptions(cmd.options));
    if (!plan) fail('invalidArgument', 'the chain or the target could not resolve');
    const subs = plan.joints.flatMap((j) => ROT_TRACKS.map(([track, field]) => planOf({
      type: 'setKeyframes',
      prop: rotationRef(j.id, track),
      keys: j[field].map((k): Keyframe => ({
        id: '', time: secondsToFlicks(k.t), value: { kind: 'scalar', value: k.value }, easing: 'linear',
        continuous: false, roving: false, spatialInterp: 'legacy', spatialIn: [], spatialOut: [], label: 0, dims: [],
      })),
    } as Command, ctx)));
    return composed('Bake 3D IK', cmd.chain, subs, () => ({ frames: plan.frames }));
  },
};
