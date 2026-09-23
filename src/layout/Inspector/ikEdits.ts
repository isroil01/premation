/**
 * ikEdits — 3D IK Bake as a CLIENT MACRO over the engine API (B3z,
 * docs/ENGINE_API.md §1 rule 7, §15.9 Rigging: "3D IK (Ik3DSection) is a
 * client macro over transform rotation keys").
 *
 * The solve is pure arithmetic over values the client reads (`planIk3DBake`,
 * boneIK3d.ts); its result is ONE batch of existing primitives: the joints'
 * current X / Y / Z Rotation keys deleted (`deleteKeyframes`, ids from
 * `getKeyframes`) and one linear key per frame added (`addKeyframes`, comp-time
 * flicks — the engine converts to each joint's keyframe axis). One undo entry;
 * undo restores the previous keys with their ids.
 */

import type { Command, KeyframeInsert, PropRef } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';
import { compTime, values } from '@core/engine/propRefs';
import { planIk3DBake, type IkOptions } from '@core/scene/boneIK3d';
import { trackRef } from './inspectorEdits';

const ROTATION_TRACKS = [['rotationX', 'rx'], ['rotationY', 'ry'], ['rotation', 'rz']] as const;

/**
 * The bake of `chain` (root → tip) against `targetId` over [t0, t1] comp
 * seconds, as commands — or null when the chain / target cannot resolve or a
 * joint's rotation is not addressable.
 */
export async function ik3DBakeCommands(
  chain: string[],
  targetId: string,
  t0: number,
  t1: number,
  fps: number,
  opts?: IkOptions,
): Promise<{ frames: number; commands: Command[] } | null> {
  const plan = planIk3DBake(chain, targetId, t0, t1, fps, opts);
  if (!plan) return null;
  const refs: PropRef[] = [];
  const keys: KeyframeInsert[] = [];
  for (const j of plan.joints) {
    for (const [track, field] of ROTATION_TRACKS) {
      const r = trackRef(j.id, track);
      if (!r) return null;
      refs.push(r.ref);
      for (const k of j[field]) {
        keys.push({ prop: r.ref, time: compTime(k.t), value: values.scalar(k.value), easing: 'linear', spatialIn: [], spatialOut: [] });
      }
    }
  }
  const res = await engine().query({ type: 'getKeyframes', props: refs });
  if (!res.ok) return null;
  const ids = res.value.sets.flatMap((s) => s.keyframes.map((k) => k.id));
  const commands: Command[] = [];
  if (ids.length > 0) commands.push({ type: 'deleteKeyframes', ids });
  if (keys.length > 0) commands.push({ type: 'addKeyframes', keys });
  return { frames: plan.frames, commands };
}
