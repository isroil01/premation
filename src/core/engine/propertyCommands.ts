/**
 * Command builders for the inspector's per-property actions over a
 * multi-selection (B3) — the API spelling of `multiSelection.applyValues`,
 * `toggleAnimationAll` and `toggleKeyframeAll`:
 *
 *   valueCommands        set a value on every layer: animated layers (and every
 *                        layer under auto-keyframe) get a key at the playhead,
 *                        the rest a static write — as ONE command list, which
 *                        the caller sends as one batch or inside a gesture
 *   stopwatchCommands    the stopwatch: any layer animated → all off, else all on
 *   keyframeToggleCommands the navigator diamond: remove the keys at the playhead,
 *                        or add one on every animated layer (async: reads key ids)
 *
 * Deciding "is this layer animated" reads the live animation engine: that is a
 * DISPLAY read, which stays direct until B4's mirror. The writes are commands.
 */

import type { Command, EngineClient, KeyframeInsert, PropertyWrite } from '@motion/engine-api';
import { defaultAnimation } from '@motion/animation';
import { KEYFRAME_EPS } from '@core/inspector/multiSelection';
import { compTime, memberWrite, propRefForTrack } from './propRefs';

export interface ValueCommandOptions {
  /** The playhead, comp seconds. */
  seconds: number;
  /** The auto-keyframe preference: an unanimated layer gets a key too. */
  autoKeyframe?: boolean;
}

/**
 * Per-layer values for one track → commands. Layers without the property are
 * skipped (the row counts them as absent, not zero).
 */
export function valueCommands(
  track: string,
  writes: ReadonlyArray<{ nodeId: string; value: number }>,
  opts: ValueCommandOptions,
): Command[] {
  const sets: PropertyWrite[] = [];
  const keys: KeyframeInsert[] = [];
  for (const w of writes) {
    if (!Number.isFinite(w.value)) continue;
    const pw = memberWrite(w.nodeId, track, w.value, opts.seconds);
    if (!pw) continue;
    if (!defaultAnimation.isAnimated(w.nodeId, track) && opts.autoKeyframe) {
      keys.push({ prop: pw.prop, time: pw.time!, value: pw.value, spatialIn: [], spatialOut: [] });
    } else {
      sets.push(pw);
    }
  }
  const out: Command[] = [];
  if (sets.length > 0) out.push({ type: 'setProperties', writes: sets });
  if (keys.length > 0) out.push({ type: 'addKeyframes', keys });
  return out;
}

/** The stopwatch across the selection (AE: one click turns all on, or all off). */
export function stopwatchCommands(nodeIds: readonly string[], track: string, seconds: number): Command[] {
  const refs = nodeIds.map((id) => ({ id, r: propRefForTrack(id, track) })).filter((x) => x.r && x.r.animatable);
  if (refs.length === 0) return [];
  const anyAnimated = refs.some((x) => defaultAnimation.isAnimated(x.id, track));
  const time = compTime(seconds);
  return refs
    .filter((x) => defaultAnimation.isAnimated(x.id, track) === anyAnimated)
    .map((x) => ({ type: 'setAnimated', prop: x.r!.ref, animated: !anyAnimated, time }) as Command);
}

/**
 * The navigator diamond across the selection: on a keyframe → delete every
 * animated layer's key at the playhead; off → add one (holding the evaluated
 * value) on every animated layer. Key ids come from the engine (`getKeyframes`),
 * never from `makeKeyframeId` — positional ids are what B3 removes.
 */
export async function keyframeToggleCommands(
  client: EngineClient,
  nodeIds: readonly string[],
  track: string,
  seconds: number,
): Promise<Command[]> {
  const animated = nodeIds
    .filter((id) => defaultAnimation.isAnimated(id, track))
    .map((id) => propRefForTrack(id, track))
    .filter((r): r is NonNullable<typeof r> => r !== null);
  if (animated.length === 0) return [];
  const time = compTime(seconds);
  const eps = compTime(KEYFRAME_EPS);
  const res = await client.query({ type: 'getKeyframes', props: animated.map((r) => r.ref), range: { start: time - eps, duration: 2 * eps } });
  if (!res.ok) return [];
  const atTime = res.value.sets.flatMap((s) => s.keyframes.filter((k) => Math.abs(k.time - time) <= eps).map((k) => k.id));
  if (atTime.length > 0) return [{ type: 'deleteKeyframes', ids: atTime }];
  return [{
    type: 'addKeyframes',
    keys: animated.map((r) => ({ prop: r.ref, time, spatialIn: [], spatialOut: [] })),
  }];
}
