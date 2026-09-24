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
 * B4: the current keys, the clip bar and the frame-blend switch are read from
 * the document MIRROR at call time (`documentMirror()`, `@core/mirror/retime`).
 * Its keys carry the engine's ids and COMPOSITION times (flicks), so "the key
 * at the playhead" / "the key before t" compare comp times — the same order
 * the legacy key axis had (it is a monotonic map of comp time).
 */

import { flicksToSeconds, type Command, type Easing, type Keyframe } from '@motion/engine-api';
import type { EasingKind } from '@motion/animation';
import { documentMirror } from '@stores/documentMirror';
import { compTime, values } from '@core/engine/propRefs';
import { REMAP_PROP, SPEED_PROP, clampSpeedPercent } from '@core/animation/retime';
import { RAMP_STYLE_EASING, SPEED_PRESETS, fittedSpeed, type RampStyle } from '@core/animation/retimeCommands';
import { REMAP_PATH, SPEED_PATH, mirrorFitSpeedFactor, mirrorRetimeBar } from '@core/mirror/retime';
import { numbersOfValue } from '@core/mirror/trackIndex';

export type RetimeTrack = typeof SPEED_PROP | typeof REMAP_PROP;

/** The API path of a retime track. */
export const retimePath = (track: RetimeTrack): string => (track === SPEED_PROP ? SPEED_PATH : REMAP_PATH);

/** The track's keys in the mirror (engine ids, comp flicks), read now. */
function currentKeys(nodeId: string, track: RetimeTrack): readonly Keyframe[] {
  return documentMirror().keyframes(nodeId, retimePath(track));
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
  return slows && documentMirror().layer(nodeId)?.switches.frameBlend === 'off'
    ? [{ type: 'setLayerSwitches', layers: [nodeId], patch: { frameBlend: 'pixelMotion' } }]
    : [];
}

/** The key just before comp flicks `time` (what a new point inherits its shape from). */
function keyBefore(keys: readonly Keyframe[], time: number): Keyframe | undefined {
  let prev: Keyframe | undefined;
  for (const k of keys) if (k.time < time) prev = k;
  return prev;
}

/** Stopwatch off on a speed curve: one constant speed — `speed` — from the in-point. */
export function constantSpeedCommands(nodeId: string, inSec: number, speed: number): Command[] {
  return [{ type: 'setKeyframes', prop: ref(nodeId, SPEED_PROP), keys: [key(inSec, speed, 'linear')] }];
}

/** Add a retime key at comp time `t` holding `value` (percent, or chain seconds), shaped like the key before it. */
export function addRetimeKeyCommands(nodeId: string, track: RetimeTrack, t: number, value: number): Command[] {
  const keys = currentKeys(nodeId, track);
  const easing = keyBefore(keys, compTime(t))?.easing ?? keys[0]?.easing ?? (track === SPEED_PROP ? 'easeInOut' : 'linear');
  return [{
    type: 'addKeyframes',
    keys: [{
      prop: ref(nodeId, track), time: compTime(t), value: values.scalar(track === SPEED_PROP ? clampSpeedPercent(value) : value),
      easing, spatialIn: [], spatialOut: [],
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
  const keys = currentKeys(nodeId, SPEED_PROP);
  const at = keys.length > 1 ? keys.find((k) => Math.abs(flicksToSeconds(k.time) - t) < 1e-6) : keys[0];
  let cmds: Command[];
  if (at) {
    cmds = [{ type: 'updateKeyframes', patches: [{ id: at.id, value: values.scalar(value), spatialIn: [], spatialOut: [] }] }];
  } else if (keys.length === 0) {
    cmds = [{ type: 'setKeyframes', prop: ref(nodeId, SPEED_PROP), keys: [key(t, value, 'linear')] }];
  } else {
    const easing = keyBefore(keys, compTime(t))?.easing ?? keys[0]?.easing ?? 'easeInOut';
    cmds = [{
      type: 'addKeyframes',
      keys: [{ prop: ref(nodeId, SPEED_PROP), time: compTime(t), value: values.scalar(value), easing, spatialIn: [], spatialOut: [] }],
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
  const ids = id !== null ? [id] : currentKeys(nodeId, SPEED_PROP).map((k) => k.id);
  if (ids.length === 0) return [];
  const easing = RAMP_STYLE_EASING[style] as Easing;
  return [{ type: 'updateKeyframes', patches: ids.map((k) => ({ id: k, easing, clearBezier: true, spatialIn: [], spatialOut: [] })) }];
}

/**
 * A velocity preset across the bar, or null when the layer has no bar (the
 * keys `planSpeedPreset` plans, over the mirror's bar).
 */
export function speedPresetCommands(nodeId: string, presetId: string): { label: string; commands: Command[] } | null {
  const preset = SPEED_PRESETS.find((p) => p.id === presetId);
  const bar = mirrorRetimeBar(documentMirror(), nodeId);
  if (!preset || !bar) return null;
  const span = bar.outSec - bar.inSec;
  const keys = preset.points.map(([pos, speed, style]) => ({
    seconds: Math.min(bar.inSec + pos * span, bar.outSec - 1 / bar.fps),
    value: speed,
    easing: RAMP_STYLE_EASING[style],
  }));
  return {
    label: `Speed preset: ${preset.label}`,
    commands: [
      { type: 'setKeyframes', prop: ref(nodeId, SPEED_PROP), keys: keys.map((k) => key(k.seconds, k.value, k.easing)) },
      ...smoothSlowMotion(nodeId, keys.some((k) => k.value < 100)),
    ],
  };
}

/** Fit to Footage: every speed key scaled so the bar ends on the last frame; null when there is nothing to fit. */
export function fitToFootageCommands(nodeId: string): Command[] | null {
  const m = documentMirror();
  const factor = mirrorFitSpeedFactor(m, nodeId);
  if (factor === null) return null;
  const patches = currentKeys(nodeId, SPEED_PROP).map((k) => ({
    id: k.id, value: values.scalar(fittedSpeed(numbersOfValue(k.value)[0] ?? 100, factor)), spatialIn: [], spatialOut: [],
  }));
  return patches.length > 0 ? [{ type: 'updateKeyframes', patches }] : null;
}

/** Show chain seconds `chain` at comp time `t` — a Frame Number key (new keys are linear). */
export function setSourceFrameCommands(nodeId: string, t: number, chain: number): Command[] {
  // Remap keys live on the chain axis, which is comp time (no animated ancestor remap): within a flick of `t`.
  const at = compTime(t);
  const existing = currentKeys(nodeId, REMAP_PROP).find((k) => Math.abs(k.time - at) <= 1);
  if (existing) return [{ type: 'updateKeyframes', patches: [{ id: existing.id, value: values.scalar(chain), spatialIn: [], spatialOut: [] }] }];
  return [{
    type: 'addKeyframes',
    keys: [{ prop: ref(nodeId, REMAP_PROP), time: compTime(t), value: values.scalar(chain), easing: 'linear', spatialIn: [], spatialOut: [] }],
  }];
}
