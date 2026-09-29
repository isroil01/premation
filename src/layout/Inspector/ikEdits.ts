/**
 * 3D IK through the engine (B4 round 8): `poseIk3D` solves once at a time and
 * writes the joints' rotations; `bakeIk3D` solves every frame of a range and
 * replaces the joints' X / Y / Z Rotation with one linear key per frame. Both
 * are ONE engine command (one undo entry); the solver runs in the engine
 * (C++ handlers_dynamics.cpp, TS handlers/dynamics.ts).
 */

import { secondsToFlicks, type IkOptions as ApiIkOptions } from '@motion/engine-api';
import type { IkOptions } from '@core/scene/boneIK3d';
import { edit } from '@core/engine/uiEdits';

function apiOptions(o: IkOptions | undefined): ApiIkOptions | undefined {
  if (!o) return undefined;
  return {
    ...(o.iterations !== undefined ? { iterations: Math.max(1, Math.round(o.iterations)) } : {}),
    ...(o.tolerance !== undefined ? { tolerance: o.tolerance } : {}),
    ...(o.maxStepRad !== undefined ? { maxStepRad: o.maxStepRad } : {}),
  };
}

/** Pose `chain` (root → tip) at `target` once, at comp `seconds`. Resolves to whether the engine did it. */
export async function poseIk3DEdit(chain: readonly string[], target: string, seconds: number, opts?: IkOptions): Promise<boolean> {
  const options = apiOptions(opts);
  const res = await edit('Pose 3D IK', {
    type: 'poseIk3D', chain: [...chain], target, time: secondsToFlicks(seconds), ...(options ? { options } : {}),
  });
  return res.ok;
}

/** Bake `chain` against `target` over [t0, t1] comp seconds. Resolves to the frames baked (0 = refused). */
export async function bakeIk3DEdit(chain: readonly string[], target: string, t0: number, t1: number, opts?: IkOptions): Promise<number> {
  const options = apiOptions(opts);
  const res = await edit('Bake 3D IK', {
    type: 'bakeIk3D', chain: [...chain], target,
    range: { start: secondsToFlicks(t0), duration: secondsToFlicks(Math.max(0, t1 - t0)) },
    ...(options ? { options } : {}),
  });
  return res.ok ? (res.value[0] as { frames?: number } | undefined)?.frames ?? 0 : 0;
}
