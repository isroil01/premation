/**
 * Motion Sketch's write (B4 round 7): the take (`takeMotionSketch`, x / y
 * tracks at composition seconds) becomes ONE engine batch on the layer's
 * Position — the keys already inside the recorded span deleted (the mirror's
 * keyframes: engine ids, comp flicks), one key per recorded sample added (comp
 * time; the engine puts it on the layer's keyframe axis). An unseparated
 * Position gets vector keys (a 3D layer keeps its Z at the span's start);
 * separated dimensions get a scalar key each.
 */

import type { Command, KeyframeInsert, PropRef, Value } from '@motion/engine-api';
import type { Keyframe as TsKeyframe } from '@motion/animation';
import { takeMotionSketch } from '@core/animation/motionSketch';
import { engine } from '@core/engine/engineInstance';
import { compTime, values } from '@core/engine/propRefs';
import { edit } from '@core/engine/uiEdits';
import { numbersOfValue } from '@core/mirror/trackIndex';
import { documentMirror } from '@stores/documentMirror';
import { trackRef } from '@layout/Inspector/inspectorEdits';

const easingOf = (k: TsKeyframe): KeyframeInsert['easing'] => (k.easing === 'hold' ? 'hold' : 'linear');

function spanIds(prop: PropRef, t0: number, t1: number): string[] {
  return documentMirror().keyframes(prop.layer, prop.path)
    .filter((k) => k.time >= t0 - 1 && k.time <= t1 + 1)
    .map((k) => k.id);
}

/** The commands that write a take for `nodeId` (x / y tracks, comp seconds), or null when Position is not addressable. */
export async function motionSketchCommands(nodeId: string, xs: readonly TsKeyframe[], ys: readonly TsKeyframe[]): Promise<Command[] | null> {
  if (xs.length === 0) return [];
  const rx = trackRef(nodeId, 'x');
  const ry = trackRef(nodeId, 'y');
  if (!rx || !ry) return null;
  const t0 = compTime(xs[0]!.t);
  const t1 = compTime(xs[xs.length - 1]!.t);
  const cmds: Command[] = [];
  if (rx.ref.path === ry.ref.path) {
    let z = 0;
    if (rx.members.length > 2) {
      const res = await engine().query({ type: 'getPropertyValues', props: [rx.ref], time: t0, evaluated: false });
      z = res.ok ? numbersOfValue(res.value.values[0]?.value ?? values.scalar(0))[2] ?? 0 : 0;
    }
    const ids = spanIds(rx.ref, t0, t1);
    if (ids.length > 0) cmds.push({ type: 'deleteKeyframes', ids });
    const vec = (x: number, y: number): Value => (rx.members.length > 2 ? values.vec3(x, y, z) : values.vec2(x, y));
    cmds.push({
      type: 'addKeyframes',
      keys: xs.map((k, i) => ({ prop: rx.ref, time: compTime(k.t), value: vec(k.value, ys[i]?.value ?? 0), easing: easingOf(k), spatialIn: [], spatialOut: [] })),
    });
    return cmds;
  }
  const ids = [...spanIds(rx.ref, t0, t1), ...spanIds(ry.ref, t0, t1)];
  if (ids.length > 0) cmds.push({ type: 'deleteKeyframes', ids });
  cmds.push({
    type: 'addKeyframes',
    keys: [
      ...xs.map((k) => ({ prop: rx.ref, time: compTime(k.t), value: values.scalar(k.value), easing: easingOf(k), spatialIn: [], spatialOut: [] })),
      ...ys.map((k) => ({ prop: ry.ref, time: compTime(k.t), value: values.scalar(k.value), easing: easingOf(k), spatialIn: [], spatialOut: [] })),
    ],
  });
  return cmds;
}

/** End the armed recording and write it as ONE entry. Resolves to the keyframes written per axis (0 = nothing). */
export async function finishMotionSketchEdit(): Promise<number> {
  const take = takeMotionSketch();
  if (!take || take.tracks.x.length === 0) return 0;
  const cmds = await motionSketchCommands(take.nodeId, take.tracks.x, take.tracks.y);
  if (!cmds || cmds.length === 0) return 0;
  const res = await edit('Motion Sketch', cmds);
  return res.ok ? take.tracks.x.length : 0;
}
