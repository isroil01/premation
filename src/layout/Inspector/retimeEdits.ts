/**
 * The Speed section's document edits through the engine API (B3z,
 * docs/B3_PATTERNS.md §4). Retime keys are ordinary keyframes of
 * `layer/timeSpeed` (Speed %, percent) and `timeRemap` (Frames, chain
 * seconds); the mode switch is `setRetime`. Everything else the section does is
 * a client macro over keyframe commands (ENGINE_API.md §1 rule 7):
 *
 *   add a point          addKeyframes, easing inherited from the point before
 *   speed field          one key: updateKeyframes{value}; a curve: the key at
 *                        the playhead updated, else a new one shaped like its
 *                        neighbour — plus Pixel Motion when it slows (the
 *                        `turnOnSmoothSlowMotion` rule)
 *   graph drag / nudge   updateKeyframes{id, time, value} (absolute; a key
 *                        moved onto another replaces it, as moveRetimeKey did)
 *   ramp style           updateKeyframes{easing, clearBezier}
 *   stopwatch off        setKeyframes: one constant key at the in-point
 *   preset               setKeyframes: the preset's keys across the bar
 *   fit to footage       updateKeyframes: every value × the fit factor
 *
 * Key ids are the engine's (`readKeys` — the engine's own read of the stored
 * track, one key per time); times sent are composition flicks.
 */

import type { Command, Easing, Keyframe } from '@motion/engine-api';
import { defaultAnimation, type EasingKind, type Keyframe as TsKeyframe } from '@motion/animation';
import { catalogFor, readKeys } from '@core/engine/props';
import { compTime, values } from '@core/engine/propRefs';
import { isLayer } from '@core/engine/doc';
import { keyAxisTimeForDisplay } from '@core/engine/displayTime';
import { getNodeLayerTime } from '@core/scene/layerTime';
import { REMAP_PROP, SPEED_PROP, clampSpeedPercent } from '@core/animation/retime';
import { RAMP_STYLE_EASING, fitSpeedFactor, fittedSpeed, planSpeedPreset, type RampStyle } from '@core/animation/retimeCommands';

export type RetimeTrack = typeof SPEED_PROP | typeof REMAP_PROP;

/** The API path of a retime track. */
export const retimePath = (track: RetimeTrack): string => (track === SPEED_PROP ? 'layer/timeSpeed' : 'timeRemap');

/** Stored key time → engine key id, for one retime track (empty when the engine does not address it). */
export function retimeKeyIds(nodeId: string, track: RetimeTrack): Map<number, string> {
  const out = new Map<number, string>();
  if (!isLayer(nodeId)) return out;
  const b = catalogFor(nodeId).byPath.get(retimePath(track));
  if (!b) return out;
  for (const k of readKeys(nodeId, b)) out.set(k.t, k.id);
  return out;
}

const ref = (nodeId: string, track: RetimeTrack) => ({ layer: nodeId, path: retimePath(track) });

/** A whole keyframe for `setKeyframes` (a new id unless `id` names one of the property's keys). */
function key(seconds: number, value: number, easing: EasingKind, id = ''): Keyframe {
  return {
    id, time: compTime(seconds), value: values.scalar(value), easing: easing as Easing,
    continuous: false, roving: false, spatialInterp: 'legacy', spatialIn: [], spatialOut: [], label: 0, dims: [],
  };
}

/** Pixel Motion on when a speed below 100 % is written and blending was off (retimeCommands `turnOnSmoothSlowMotion`). */
function smoothSlowMotion(nodeId: string, slows: boolean): Command[] {
  return slows && getNodeLayerTime(nodeId).frameBlend === 'none'
    ? [{ type: 'setLayerSwitches', layers: [nodeId], patch: { frameBlend: 'pixelMotion' } }]
    : [];
}

/** The stored key just before stored time `u` (what a new point inherits its shape from). */
function keyBefore(keys: readonly TsKeyframe[], u: number): TsKeyframe | undefined {
  let prev: TsKeyframe | undefined;
  for (const k of keys) if (k.t < u) prev = k;
  return prev;
}

/** Stopwatch off on a speed curve: one constant speed — `speed` — from the in-point. */
export function constantSpeedCommands(nodeId: string, inSec: number, speed: number): Command[] {
  return [{ type: 'setKeyframes', prop: ref(nodeId, SPEED_PROP), keys: [key(inSec, speed, 'linear')] }];
}

/** Add a retime key at comp time `t` holding `value` (percent, or chain seconds), shaped like the key before it. */
export function addRetimeKeyCommands(nodeId: string, track: RetimeTrack, t: number, value: number): Command[] {
  const stored = keyAxisTimeForDisplay(nodeId, t, track === REMAP_PROP ? REMAP_PROP : undefined);
  const keys = defaultAnimation.getTrackKeyframes(nodeId, track) ?? [];
  const easing = keyBefore(keys, stored)?.easing ?? keys[0]?.easing ?? (track === SPEED_PROP ? 'easeInOut' : 'linear');
  return [{
    type: 'addKeyframes',
    keys: [{
      prop: ref(nodeId, track), time: compTime(t), value: values.scalar(track === SPEED_PROP ? clampSpeedPercent(value) : value),
      easing: easing as Easing, spatialIn: [], spatialOut: [],
    }],
  }];
}

/**
 * The Speed field at comp time `t`: a constant speed (one key) just changes;
 * a curve gets its point at `t` changed, or a new one shaped like its
 * neighbour. Absolute, so a scrub is a gesture of these.
 */
export function setSpeedCommands(nodeId: string, t: number, percent: number): Command[] {
  const value = clampSpeedPercent(percent);
  const keys = defaultAnimation.getTrackKeyframes(nodeId, SPEED_PROP) ?? [];
  const ids = retimeKeyIds(nodeId, SPEED_PROP);
  const u = keyAxisTimeForDisplay(nodeId, t);
  let cmds: Command[];
  const only = keys.length <= 1 ? keys[0] : undefined;
  const at = keys.length > 1 ? keys.find((k) => Math.abs(k.t - u) < 1e-6) : only;
  const id = at ? ids.get(at.t) : undefined;
  if (id) {
    cmds = [{ type: 'updateKeyframes', patches: [{ id, value: values.scalar(value), spatialIn: [], spatialOut: [] }] }];
  } else if (keys.length === 0) {
    cmds = [{ type: 'setKeyframes', prop: ref(nodeId, SPEED_PROP), keys: [key(t, value, 'linear')] }];
  } else {
    const easing = keyBefore(keys, u)?.easing ?? keys[0]?.easing ?? 'easeInOut';
    cmds = [{
      type: 'addKeyframes',
      keys: [{ prop: ref(nodeId, SPEED_PROP), time: compTime(t), value: values.scalar(value), easing: easing as Easing, spatialIn: [], spatialOut: [] }],
    }];
  }
  return [...cmds, ...smoothSlowMotion(nodeId, value < 100)];
}

/** One retime key to (comp `compT`, `value`) — a graph drag's message or a nudge. */
export function moveRetimeKeyCommands(track: RetimeTrack, id: string, compT: number, value: number): Command[] {
  const v = track === SPEED_PROP ? clampSpeedPercent(value) : value;
  return [{ type: 'updateKeyframes', patches: [{ id, time: compTime(compT), value: values.scalar(v), spatialIn: [], spatialOut: [] }] }];
}

/** Ramp style for ONE key (by id) or, with null, every speed key. */
export function rampStyleCommands(nodeId: string, style: RampStyle, id: string | null): Command[] {
  const ids = id !== null ? [id] : [...retimeKeyIds(nodeId, SPEED_PROP).values()];
  if (ids.length === 0) return [];
  const easing = RAMP_STYLE_EASING[style] as Easing;
  return [{ type: 'updateKeyframes', patches: ids.map((k) => ({ id: k, easing, clearBezier: true, spatialIn: [], spatialOut: [] })) }];
}

/** A velocity preset across the bar, or null when the layer has no bar. */
export function speedPresetCommands(nodeId: string, presetId: string): { label: string; commands: Command[] } | null {
  const plan = planSpeedPreset(nodeId, presetId);
  if (!plan) return null;
  return {
    label: `Speed preset: ${plan.preset.label}`,
    commands: [
      { type: 'setKeyframes', prop: ref(nodeId, SPEED_PROP), keys: plan.keys.map((k) => key(k.seconds, k.value, k.easing)) },
      ...smoothSlowMotion(nodeId, plan.keys.some((k) => k.value < 100)),
    ],
  };
}

/** Fit to Footage: every speed key scaled so the bar ends on the last frame; null when there is nothing to fit. */
export function fitToFootageCommands(nodeId: string): Command[] | null {
  const factor = fitSpeedFactor(nodeId);
  if (factor === null) return null;
  const ids = retimeKeyIds(nodeId, SPEED_PROP);
  const patches = (defaultAnimation.getTrackKeyframes(nodeId, SPEED_PROP) ?? [])
    .map((k) => ({ id: ids.get(k.t), value: fittedSpeed(k.value, factor) }))
    .filter((p): p is { id: string; value: number } => p.id !== undefined)
    .map((p) => ({ id: p.id, value: values.scalar(p.value), spatialIn: [], spatialOut: [] }));
  return patches.length > 0 ? [{ type: 'updateKeyframes', patches }] : null;
}

/** Show chain seconds `chain` at comp time `t` — a Frame Number key (new keys are linear). */
export function setSourceFrameCommands(nodeId: string, t: number, chain: number): Command[] {
  const remapT = keyAxisTimeForDisplay(nodeId, t, REMAP_PROP);
  const existing = (defaultAnimation.getTrackKeyframes(nodeId, REMAP_PROP) ?? []).find((k) => Math.abs(k.t - remapT) < 1e-9);
  const id = existing ? retimeKeyIds(nodeId, REMAP_PROP).get(existing.t) : undefined;
  if (id) return [{ type: 'updateKeyframes', patches: [{ id, value: values.scalar(chain), spatialIn: [], spatialOut: [] }] }];
  return [{
    type: 'addKeyframes',
    keys: [{ prop: ref(nodeId, REMAP_PROP), time: compTime(t), value: values.scalar(chain), easing: 'linear', spatialIn: [], spatialOut: [] }],
  }];
}
