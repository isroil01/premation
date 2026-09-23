/**
 * Retime, as edits: switch a layer between Normal / Speed % / Frame Number,
 * shape a speed curve, apply a velocity preset, fit the footage.
 *
 * The maths lives in `retime.ts` (the integral) and `speedRamp.ts` (the exact
 * Bézier for a linear speed change). This file decides what a person means:
 *
 *   - SWITCHING MODES CONVERTS, it does not discard. Speed → Frames bakes the
 *     integral into remap keys (exact Béziers for linear and hold segments,
 *     subdivided for eased ones); Frames → Speed turns each remap segment's
 *     average slope into a hold speed, which lands on every remap key exactly.
 *     Both are one undo step.
 *   - PRESETS span the clip's bar, because a velocity edit is a shape across a
 *     clip, not a value at the playhead.
 *   - SLOWING TURNS ON PIXEL MOTION when blending was off — the same rule the
 *     one-click ramps follow, for the same reason (see `speedRampCommands.ts`).
 *
 * Everything reads the clip bar the way the renderer does: the earliest bar is
 * the in-point, and keyframe times go through `compToKeyframeTime`.
 */

import { defaultAnimation, type EasingKind, type Keyframe } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getNodeLayerTime, updateNodeLayerTime } from '@core/scene/layerTime';
import { footageSourceOf } from '@core/source/sourceInfo';
import { compToKeyframeTime, getTimelineController } from '@core/timeline/TimelineController';
import { runAnimEdit } from './animationCommands';
import { rampBezier } from './speedRamp';
import {
  REMAP_PROP,
  RETIME_PROPS,
  SPEED_PROP,
  clampSpeedPercent,
  readRetimeMode,
  retimedChainTime,
  speedAdvance,
  type RetimeClip,
  type RetimeMode,
} from './retime';

// ── The bar ────────────────────────────────────────────────────────────────

export interface RetimeBarInfo {
  /** Comp fps the bar is measured in. */
  fps: number;
  /** Comp seconds of the in-point and out-point (end exclusive). */
  inSec: number;
  outSec: number;
  /** The earliest bar's clip map. */
  clip: RetimeClip;
  /** Source seconds shown at the in-point. */
  sourceInSec: number;
  /** Source seconds available in the file, when known. */
  sourceDurationSec: number | null;
  /** The footage's own frame rate (falls back to the comp's). */
  sourceFps: number;
}

export function retimeBarInfo(nodeId: string): RetimeBarInfo | null {
  const c = getTimelineController();
  const bars = c.getLayersForNode(nodeId);
  if (bars.length === 0) return null;
  const fps = c.fpsForNode(nodeId) || 30;
  let first = bars[0]!;
  let end = first.end;
  for (const b of bars) {
    if (b.start < first.start) first = b;
    end = Math.max(end, b.end);
  }
  const node = defaultSceneGraph.getNode(nodeId);
  const source = node ? footageSourceOf(node) : null;
  const clipDur = first.clip.sourceDuration;
  const sourceDurationSec = clipDur !== null && clipDur !== undefined ? clipDur / fps : source?.durationSec ?? null;
  return {
    fps,
    inSec: first.start / fps,
    outSec: end / fps,
    clip: { offsetSec: (first.clip.sourceIn - first.start) / fps, inSec: first.start / fps },
    sourceInSec: first.clip.sourceIn / fps,
    sourceDurationSec,
    sourceFps: source?.fps ?? fps,
  };
}

/** Source seconds the layer shows at comp time `t` (stretch/loop not applied). */
export function retimedSourceSeconds(nodeId: string, t: number, bar = retimeBarInfo(nodeId)): number {
  const off = bar?.clip.offsetSec ?? 0;
  const chain = retimedChainTime(defaultAnimation, nodeId, t, bar?.clip ?? null);
  return (chain ?? t) + off;
}

/** Speed multiplier at comp time `t`, as the slope of the source curve (1 = 100%). */
export function retimedSpeedAt(nodeId: string, t: number, bar = retimeBarInfo(nodeId)): number {
  const dt = 1 / 240;
  return (retimedSourceSeconds(nodeId, t + dt, bar) - retimedSourceSeconds(nodeId, t, bar)) / dt;
}

// ── Modes ──────────────────────────────────────────────────────────────────

/** Subdivisions used when baking a shaped speed segment into remap keys. */
const BAKE_SUBDIVISIONS = 8;

function speedTrack(nodeId: string): Keyframe[] {
  return defaultAnimation.getTrackKeyframes(nodeId, SPEED_PROP) ?? [];
}

function turnOnSmoothSlowMotion(ids: ReadonlyArray<string>): void {
  for (const id of ids) {
    if (getNodeLayerTime(id).frameBlend === 'none') updateNodeLayerTime(id, { frameBlend: 'pixelMotion' });
  }
}

/** Speed → Frame Number: bake the integral into remap keys on the chain axis. */
function bakeSpeedToRemap(nodeId: string, bar: RetimeBarInfo | null): Keyframe[] {
  const inSec = bar?.inSec ?? 0;
  const outSec = bar?.outSec ?? inSec + 1;
  const off = bar?.clip.offsetSec ?? 0;
  const keys = speedTrack(nodeId).sort((a, b) => a.t - b.t);
  // Segment boundaries in comp time: the bar's ends plus every key inside it.
  const bounds = new Set<number>([inSec, outSec]);
  for (const k of keys) {
    const t = k.t - off;
    if (t > inSec && t < outSec) bounds.add(t);
  }
  const times = [...bounds].sort((a, b) => a - b);
  const chainAt = (t: number): number => retimedChainTime(defaultAnimation, nodeId, t, bar?.clip ?? null) ?? t;
  const speedOf = (t: number): number => (defaultAnimation.sample(nodeId, SPEED_PROP, t + off) ?? 100) / 100;
  const easingOf = (t: number): EasingKind | undefined => {
    let found: Keyframe | undefined;
    for (const k of keys) if (k.t - off <= t + 1e-9) found = k;
    return found?.easing ?? keys[0]?.easing;
  };

  const out: Keyframe[] = [];
  const push = (t: number, v0: number, v1: number): void => {
    out.push({ t, value: chainAt(t), easing: 'bezier', bezier: rampBezier(v0, v1) });
  };
  for (let i = 0; i < times.length - 1; i++) {
    const a = times[i]!;
    const b = times[i + 1]!;
    const easing = easingOf(a);
    if (easing === 'step' || easing === 'hold') {
      push(a, speedOf(a), speedOf(a));
    } else if (easing === 'linear') {
      push(a, speedOf(a), speedOf(b - 1e-9));
    } else {
      for (let j = 0; j < BAKE_SUBDIVISIONS; j++) {
        const s0 = a + ((b - a) * j) / BAKE_SUBDIVISIONS;
        const s1 = a + ((b - a) * (j + 1)) / BAKE_SUBDIVISIONS;
        push(s0, speedOf(s0), speedOf(s1));
      }
    }
  }
  const last = times[times.length - 1]!;
  out.push({ t: last, value: chainAt(last), easing: 'linear' });
  // A segment whose ends cover no source time has no slope to encode.
  return out.map((k, i) => {
    const next = out[i + 1];
    if (next && Math.abs(next.value - k.value) < 1e-9 && k.easing === 'bezier') {
      const { bezier: _b, ...rest } = k;
      return { ...rest, easing: 'linear' as const };
    }
    return k;
  });
}

/** Frame Number → Speed: each remap segment's average slope becomes a hold speed. */
function bakeRemapToSpeed(nodeId: string, bar: RetimeBarInfo | null): Keyframe[] {
  const inSec = bar?.inSec ?? 0;
  const outSec = bar?.outSec ?? inSec + 1;
  const remap = defaultAnimation.getTrackKeyframes(nodeId, REMAP_PROP) ?? [];
  const bounds = new Set<number>([inSec, outSec]);
  for (const k of remap) {
    if (k.t > inSec && k.t < outSec) {
      bounds.add(k.t);
      // Shaped segments: a few interior points so a curve stays a curve.
      if (k.easing !== 'linear' && k.easing !== 'step' && k.easing !== 'hold') {
        const next = remap.find((n) => n.t > k.t);
        if (next) for (let j = 1; j < 4; j++) bounds.add(k.t + ((Math.min(next.t, outSec) - k.t) * j) / 4);
      }
    }
  }
  const times = [...bounds].filter((t) => t >= inSec && t <= outSec).sort((a, b) => a - b);
  const out: Keyframe[] = [];
  for (let i = 0; i < times.length - 1; i++) {
    const a = times[i]!;
    const b = times[i + 1]!;
    const slope = (retimedSourceSeconds(nodeId, b, bar) - retimedSourceSeconds(nodeId, a, bar)) / (b - a);
    out.push({ t: compToKeyframeTime(nodeId, a), value: Math.round(clampSpeedPercent(slope * 100) * 10) / 10, easing: 'step' });
  }
  if (out.length === 0) out.push({ t: compToKeyframeTime(nodeId, inSec), value: 100, easing: 'linear' });
  return out;
}

/**
 * Put every layer in `ids` into `mode`, converting what it had. One undo step.
 * Returns true when a conversion was approximate (Frames → Speed can only
 * guarantee the frames at the old remap keys).
 */
export function setRetimeMode(ids: ReadonlyArray<string>, mode: RetimeMode): boolean {
  let approximate = false;
  const label = mode === 'normal' ? 'Normal Speed' : mode === 'speed' ? 'Retime: Speed %' : 'Retime: Frame Number';
  runAnimEdit(label, () => defaultAnimation.batch(() => {
    for (const id of ids) {
      const from = readRetimeMode(defaultAnimation, id);
      if (from === mode) continue;
      const bar = retimeBarInfo(id);
      if (mode === 'normal') {
        for (const prop of RETIME_PROPS) defaultAnimation.removeTrack(id, prop);
        continue;
      }
      if (mode === 'speed') {
        const keys = from === 'frames'
          ? bakeRemapToSpeed(id, bar)
          : [{ t: compToKeyframeTime(id, bar?.inSec ?? 0), value: 100, easing: 'linear' as const }];
        if (from === 'frames') approximate = true;
        for (const prop of RETIME_PROPS) defaultAnimation.removeTrack(id, prop);
        defaultAnimation.setKeyframes(id, SPEED_PROP, keys);
        continue;
      }
      // Frame Number. From Normal: AE's two identity keys at the in and out points.
      const keys = from === 'speed'
        ? bakeSpeedToRemap(id, bar)
        : [bar?.inSec ?? 0, Math.max((bar?.outSec ?? 1) - 1 / (bar?.fps ?? 30), (bar?.inSec ?? 0) + 1 / (bar?.fps ?? 30))]
          .map((t) => ({ t: compToKeyframeTime(id, t, REMAP_PROP), value: t, easing: 'linear' as const }));
      for (const prop of RETIME_PROPS) defaultAnimation.removeTrack(id, prop);
      defaultAnimation.setKeyframes(id, REMAP_PROP, keys);
    }
  }));
  return approximate;
}

// ── Speed curve edits ──────────────────────────────────────────────────────

export type RampStyle = 'smooth' | 'linear' | 'instant';

export const RAMP_STYLE_EASING: Readonly<Record<RampStyle, EasingKind>> = {
  smooth: 'easeInOut',
  linear: 'linear',
  instant: 'step',
};

export function rampStyleOf(easing: EasingKind | undefined): RampStyle {
  if (easing === 'step' || easing === 'hold') return 'instant';
  if (easing === 'linear' || easing === undefined) return 'linear';
  return 'smooth';
}

/**
 * Set the speed at comp time `t`. A constant speed (one key) just changes;
 * a curve gets a point at `t`, shaped like its neighbour.
 */
export function setSpeedAt(nodeId: string, t: number, percent: number, mergeKey?: string): void {
  const value = clampSpeedPercent(percent);
  const keys = speedTrack(nodeId);
  const u = compToKeyframeTime(nodeId, t);
  runAnimEdit('Set speed', () => {
    if (keys.length <= 1) {
      const k = keys[0];
      defaultAnimation.setKeyframes(nodeId, SPEED_PROP, [{ ...(k ?? { t: u, easing: 'linear' }), value }]);
      return;
    }
    const existing = keys.find((k) => Math.abs(k.t - u) < 1e-6);
    if (existing) {
      defaultAnimation.setKeyframe(nodeId, SPEED_PROP, existing.t, value);
      return;
    }
    let prev: Keyframe | undefined;
    for (const k of keys) if (k.t < u) prev = k;
    defaultAnimation.setKeyframe(nodeId, SPEED_PROP, u, value, prev?.easing ?? keys[0]?.easing ?? 'easeInOut');
  }, mergeKey);
  if (value < 100) turnOnSmoothSlowMotion([nodeId]);
}

/**
 * Replace a retime key (by its stored time) with a new stored time and value —
 * one step of a graph drag. Unrecorded: the drag's transaction records it.
 */
export function moveRetimeKey(nodeId: string, prop: typeof SPEED_PROP | typeof REMAP_PROP, fromT: number, toT: number, value: number): void {
  const keys = defaultAnimation.getTrackKeyframes(nodeId, prop) ?? [];
  const k = keys.find((kf) => Math.abs(kf.t - fromT) < 1e-9);
  if (!k) return;
  const rest = keys.filter((kf) => kf !== k && Math.abs(kf.t - toT) > 1e-9);
  const v = prop === SPEED_PROP ? clampSpeedPercent(value) : value;
  defaultAnimation.setKeyframes(nodeId, prop, [...rest, { ...k, t: toT, value: v }]);
}

/** Add a retime key at comp time `t` holding `value` (percent, or chain seconds). */
export function addRetimeKey(nodeId: string, prop: typeof SPEED_PROP | typeof REMAP_PROP, t: number, value: number): void {
  const stored = compToKeyframeTime(nodeId, t, prop === REMAP_PROP ? REMAP_PROP : undefined);
  const keys = defaultAnimation.getTrackKeyframes(nodeId, prop) ?? [];
  let prev: Keyframe | undefined;
  for (const k of keys) if (k.t < stored) prev = k;
  runAnimEdit(prop === SPEED_PROP ? 'Add speed point' : 'Add frame key', () => {
    defaultAnimation.setKeyframe(
      nodeId, prop, stored,
      prop === SPEED_PROP ? clampSpeedPercent(value) : value,
      prev?.easing ?? keys[0]?.easing ?? (prop === SPEED_PROP ? 'easeInOut' : 'linear'),
    );
  });
}

/** Ramp style for ONE key (by stored time) or, with `t` null, the whole curve. */
export function setRampStyle(nodeId: string, style: RampStyle, t: number | null): void {
  const easing = RAMP_STYLE_EASING[style];
  runAnimEdit(`Ramp: ${style}`, () => {
    const keys = speedTrack(nodeId).map((k) => {
      if (t !== null && Math.abs(k.t - t) > 1e-9) return k;
      const { bezier: _b, ...rest } = k;
      return { ...rest, easing };
    });
    defaultAnimation.setKeyframes(nodeId, SPEED_PROP, keys);
  });
}

export function removeSpeedKey(nodeId: string, t: number): void {
  const keys = speedTrack(nodeId);
  if (keys.length <= 1) return;
  runAnimEdit('Remove speed point', () => defaultAnimation.removeKeyframe(nodeId, SPEED_PROP, t));
}

// ── Presets ────────────────────────────────────────────────────────────────

export interface SpeedPreset {
  id: string;
  label: string;
  hint: string;
  /** [position across the bar 0..1, speed %, ramp]. */
  points: ReadonlyArray<readonly [number, number, RampStyle]>;
}

export const SPEED_PRESETS: ReadonlyArray<SpeedPreset> = [
  {
    id: 'velocity', label: 'Velocity', hint: 'Fast, a slow-motion hit in the middle, fast again',
    points: [[0, 250, 'smooth'], [0.36, 250, 'smooth'], [0.48, 20, 'smooth'], [0.66, 20, 'smooth'], [0.78, 250, 'smooth'], [1, 250, 'smooth']],
  },
  {
    id: 'hero', label: 'Hero', hint: 'Normal, then a long dramatic slow-motion moment',
    points: [[0, 100, 'smooth'], [0.28, 100, 'smooth'], [0.4, 15, 'smooth'], [0.74, 15, 'smooth'], [0.86, 100, 'smooth'], [1, 100, 'smooth']],
  },
  {
    id: 'bullet', label: 'Bullet', hint: 'Very fast into a near-freeze and out again',
    points: [[0, 300, 'smooth'], [0.34, 300, 'smooth'], [0.44, 8, 'smooth'], [0.6, 8, 'smooth'], [0.7, 300, 'smooth'], [1, 300, 'smooth']],
  },
  {
    id: 'montage', label: 'Montage', hint: 'Pulses between fast and slow',
    points: [[0, 100, 'smooth'], [0.2, 250, 'smooth'], [0.4, 40, 'smooth'], [0.6, 250, 'smooth'], [0.8, 40, 'smooth'], [1, 100, 'smooth']],
  },
  {
    id: 'flashIn', label: 'Flash In', hint: 'Rush in fast, settle to normal',
    points: [[0, 500, 'smooth'], [0.35, 100, 'smooth'], [1, 100, 'smooth']],
  },
  {
    id: 'flashOut', label: 'Flash Out', hint: 'Normal, then rush out fast',
    points: [[0, 100, 'smooth'], [0.65, 100, 'smooth'], [1, 500, 'smooth']],
  },
  {
    id: 'jumpCut', label: 'Jump Cut', hint: 'Hard cuts between normal and 4× — no ramps',
    points: [[0, 100, 'instant'], [0.3, 400, 'instant'], [0.55, 100, 'instant'], [0.8, 400, 'instant'], [1, 100, 'instant']],
  },
];

/**
 * A preset's speed keys for one layer at COMPOSITION seconds (B3z: the
 * inspector sends them as the layer's whole `layer/timeSpeed` track), or null
 * when the layer has no bar to shape it across / the preset is unknown.
 */
export function planSpeedPreset(
  nodeId: string,
  presetId: string,
): { preset: SpeedPreset; keys: Array<{ seconds: number; value: number; easing: EasingKind }> } | null {
  const preset = SPEED_PRESETS.find((p) => p.id === presetId);
  const bar = retimeBarInfo(nodeId);
  if (!preset || !bar) return null;
  const span = bar.outSec - bar.inSec;
  return {
    preset,
    keys: preset.points.map(([pos, speed, style]) => ({
      seconds: Math.min(bar.inSec + pos * span, bar.outSec - 1 / bar.fps),
      value: speed,
      easing: RAMP_STYLE_EASING[style],
    })),
  };
}

export function applySpeedPreset(ids: ReadonlyArray<string>, presetId: string): number {
  const preset = SPEED_PRESETS.find((p) => p.id === presetId);
  if (!preset) return 0;
  let applied = 0;
  runAnimEdit(`Speed preset: ${preset.label}`, () => defaultAnimation.batch(() => {
    for (const id of ids) {
      const bar = retimeBarInfo(id);
      if (!bar) continue;
      const span = bar.outSec - bar.inSec;
      const keys: Keyframe[] = preset.points.map(([pos, speed, style]) => ({
        t: compToKeyframeTime(id, Math.min(bar.inSec + pos * span, bar.outSec - 1 / bar.fps)),
        value: speed,
        easing: RAMP_STYLE_EASING[style],
      }));
      for (const prop of RETIME_PROPS) defaultAnimation.removeTrack(id, prop);
      defaultAnimation.setKeyframes(id, SPEED_PROP, keys);
      applied++;
    }
  }));
  if (preset.points.some(([, s]) => s < 100)) turnOnSmoothSlowMotion(ids);
  return applied;
}

// ── Footage budget ─────────────────────────────────────────────────────────

export interface RetimeSummary {
  mode: RetimeMode;
  /** Source seconds the bar plays through. */
  usedSec: number;
  /** Source seconds after the in-point, when the file length is known. */
  availableSec: number | null;
  /** Comp time where the footage runs out (or before the head), when it does. */
  runsOutAtSec: number | null;
  /** Output (bar) seconds. */
  outputSec: number;
}

export function retimeSummary(nodeId: string): RetimeSummary | null {
  const bar = retimeBarInfo(nodeId);
  if (!bar) return null;
  const mode = readRetimeMode(defaultAnimation, nodeId);
  const end = bar.sourceDurationSec;
  const start = retimedSourceSeconds(nodeId, bar.inSec, bar);
  const last = retimedSourceSeconds(nodeId, bar.outSec, bar);
  let runsOutAtSec: number | null = null;
  if (end !== null) {
    const step = 1 / bar.fps;
    for (let t = bar.inSec; t < bar.outSec; t += step) {
      const s = retimedSourceSeconds(nodeId, t, bar);
      if (s > end + 1e-6 || s < -1e-6) { runsOutAtSec = t; break; }
    }
  }
  return {
    mode,
    usedSec: last - start,
    availableSec: end !== null ? end - bar.sourceInSec : null,
    runsOutAtSec,
    outputSec: bar.outSec - bar.inSec,
  };
}

/**
 * Scale the whole speed curve so the bar ends exactly on the footage's last
 * frame. Linear in the speeds, so one factor does it for any shape.
 */
/**
 * The factor Fit to Footage scales every speed key by (B3z: the inspector
 * sends the scaled values as `updateKeyframes`), or null when there is nothing
 * to fit (no bar, unknown file length, no source advance).
 */
export function fitSpeedFactor(nodeId: string): number | null {
  const bar = retimeBarInfo(nodeId);
  if (!bar || bar.sourceDurationSec === null) return null;
  const uIn = bar.inSec + bar.clip.offsetSec;
  const uOut = bar.outSec + bar.clip.offsetSec;
  const used = speedAdvance(defaultAnimation, nodeId, uIn, uOut);
  const available = bar.sourceDurationSec - bar.sourceInSec - 1 / bar.sourceFps;
  if (!(used > 1e-6) || !(available > 0)) return null;
  return available / used;
}

/** A speed key's value after Fit to Footage's scaling (clamped, 0.1 % steps). */
export function fittedSpeed(value: number, factor: number): number {
  return Math.round(clampSpeedPercent(value * factor) * 10) / 10;
}

export function fitSpeedToFootage(nodeId: string): boolean {
  const k = fitSpeedFactor(nodeId);
  if (k === null) return false;
  runAnimEdit('Fit speed to footage', () => {
    defaultAnimation.setKeyframes(nodeId, SPEED_PROP, speedTrack(nodeId).map((kf) => ({
      ...kf,
      value: Math.round(clampSpeedPercent(kf.value * k) * 10) / 10,
    })));
  });
  return true;
}

// ── Frame Number edits ─────────────────────────────────────────────────────

/** Source frame (in the footage's own rate) shown at comp time `t`. */
export function sourceFrameAt(nodeId: string, t: number, bar = retimeBarInfo(nodeId)): number {
  return Math.round(retimedSourceSeconds(nodeId, t, bar) * (bar?.sourceFps ?? 30));
}

/** Show source frame `frame` at comp time `t` — a Frame Number keyframe. */
export function setSourceFrameAt(nodeId: string, t: number, frame: number, mergeKey?: string): void {
  const bar = retimeBarInfo(nodeId);
  const seconds = Math.max(0, frame) / (bar?.sourceFps ?? 30);
  const chain = seconds - (bar?.clip.offsetSec ?? 0);
  const remapT = compToKeyframeTime(nodeId, t, REMAP_PROP);
  const isNew = !(defaultAnimation.getTrackKeyframes(nodeId, REMAP_PROP) ?? []).some((k) => Math.abs(k.t - remapT) < 1e-9);
  runAnimEdit('Set source frame', () => {
    defaultAnimation.setKeyframe(nodeId, REMAP_PROP, remapT, chain, isNew ? 'linear' : undefined);
  }, mergeKey);
}
