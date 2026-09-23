/**
 * The Audio panel's, the Audio section's and the audio dialogs' document
 * edits through the engine API (B3z, docs/B3_PATTERNS.md).
 *
 * Every analysis here (fades, ducking, the noise gate, drivers, Convert Audio
 * to Keyframes, silence detection) runs in the editor as before — it is not a
 * document write. Its RESULT goes out as ONE undo entry of existing primitives
 * (ENGINE_API.md §1 rule 7), labelled as the legacy writer labelled it:
 *
 *   level / pan         `audio/levels`, `audio/pan` (static or keyed, the
 *                       inspector's value rule); a fader drag is one gesture
 *   mute                `setLayerSwitches{audioEnabled}` (the same `__muted`)
 *   timing              `setLayerTiming` on the layer's bar; no bar → the
 *                       `audio/clipStart|clipIn|clipOut` fields
 *   fades               a 'span' splice of `audio/levels` (keys inside the fade
 *                       window dropped, the rest kept) + expression cleared
 *   ducking / gate      the record (`audio/ducking`, `audio/gate`) + expression
 *                       cleared + the level track replaced
 *   driver              the record (`audio/drivers`) + an expression, or the
 *                       baked track replacing the old one
 *   audio → keyframes   the `audioAmplitude` track replaced
 *   silence removal     split both edges, delete inside, shift ONLY the paired
 *                       later bars (a local ripple, not the comp-wide one)
 */

import type { Command, PropRef } from '@motion/engine-api';
import { defaultAnimation } from '@motion/animation';
import { edit } from '@core/engine/uiEdits';
import { compTime, propRefForTrack, values } from '@core/engine/propRefs';
import { compOfLayer, isLayer } from '@core/engine/doc';
import { AUDIO_LEVEL_DB_PROP } from '@core/audio/audioParams';
import { planFadeKeys, DEFAULT_FADE_SEC, type FadeSide } from '@core/audio/audioFades';
import { planDucking, readDucking, type ApplyDuckingResult, type DuckingParams } from '@core/audio/ducking';
import { planGate, readGate, DEFAULT_GATE, type GateParams } from '@core/audio/audioGate';
import { staticLevelDbOf } from '@core/audio/audioFades';
import {
  audioDriverExpression,
  computeDriverEnvelope,
  driverRange,
  expressionBlocker,
  readAudioDriver,
  readAudioDrivers,
  MIX_SOURCE,
  type ApplyDriverResult,
  type AudioDriver,
} from '@core/audio/audioDriver';
import { planAudioKeyframeTrack, type AudioKeyframeOptions } from '@core/audio/audioKeyframes';
import { mergeIntervals, rangesToCompIntervals, type RemoveSilencesResult, type SilenceRange } from '@core/audio/silenceRemoval';
import { readAudioClipTimings } from '@core/audio/audioScene';
import { apiUnitFactor } from '@core/engine/props';
import { readPropertyValue } from '@core/inspector/multiSelection';
import { staticOrDefaultValue } from '@core/inspector/propertyValue';
import { getTimelineController } from '@core/timeline/TimelineController';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { clearExpressionCommands, inOneEntry, removeAnimationCommands, spliceKeysEdit, type EntryStep, type KeySplice, type SpliceKey } from './keySpliceEdits';

/** The layer's Audio Levels property, or null when the engine does not address it. */
export function levelRef(nodeId: string): PropRef | null {
  return isLayer(nodeId) ? propRefForTrack(nodeId, AUDIO_LEVEL_DB_PROP)?.ref ?? null : null;
}

const scalarKeys = (keys: ReadonlyArray<{ seconds: number; value: number }>): SpliceKey[] =>
  keys.map((k) => ({ seconds: k.seconds, value: values.scalar(k.value) }));

// ── Fades ──────────────────────────────────────────────────────────────

/**
 * Fade In / Fade Out on each layer, ONE entry (a multi-layer selection is one
 * undo, as `applyFade`'s callers wrapped it). Resolves to how many layers had
 * an audible span to fade.
 */
export async function fadeEdit(nodeIds: readonly string[], side: FadeSide, durationSec = DEFAULT_FADE_SEC): Promise<number> {
  const splices: KeySplice[] = [];
  const before: Command[] = [];
  for (const id of nodeIds) {
    const ref = levelRef(id);
    if (!ref) continue;
    const keys = planFadeKeys(id, side, durationSec);
    if (keys.length === 0) continue;
    splices.push({ prop: ref, keys: scalarKeys(keys), replace: 'span', axisTrack: AUDIO_LEVEL_DB_PROP });
    before.push(...clearExpressionCommands(ref, [AUDIO_LEVEL_DB_PROP]));
  }
  if (splices.length === 0) return 0;
  const ok = await spliceKeysEdit(side === 'in' ? 'Fade Audio In' : 'Fade Audio Out', splices, before);
  return ok ? splices.length : 0;
}

// ── Ducking ────────────────────────────────────────────────────────────

/** Duck `musicId` under `voiceId`: the record + the level track, ONE entry ("Duck Music"). */
export async function duckEdit(musicId: string, voiceId: string, params: DuckingParams): Promise<ApplyDuckingResult> {
  const plan = await planDucking(musicId, voiceId, params);
  if (plan.error) return { keyframes: 0, peakDuckDb: 0, error: plan.error };
  const ref = levelRef(musicId);
  if (!ref) return { keyframes: 0, peakDuckDb: 0, error: 'That layer has no audio level to duck.' };
  const ok = await spliceKeysEdit(
    'Duck Music',
    [{ prop: ref, keys: scalarKeys(plan.keys), replace: 'all', axisTrack: AUDIO_LEVEL_DB_PROP }],
    [
      { type: 'setProperty', prop: { layer: musicId, path: 'audio/ducking' }, value: values.json(plan.record) },
      ...clearExpressionCommands(ref, [AUDIO_LEVEL_DB_PROP]),
    ],
  );
  return ok ? { keyframes: plan.keys.length, peakDuckDb: plan.peakDuckDb } : { keyframes: 0, peakDuckDb: 0, error: 'The ducking could not be written.' };
}

/** Re-run the ducking recorded on a layer. */
export async function reduckEdit(musicId: string): Promise<ApplyDuckingResult> {
  const node = defaultSceneGraph.getNode(musicId);
  const record = node ? readDucking(node) : null;
  if (!record) return { keyframes: 0, peakDuckDb: 0, error: 'This layer has no ducking to redo.' };
  return duckEdit(musicId, record.voiceNodeId, record);
}

/** Forget the ducking AND remove the level track it wrote, ONE entry. */
export async function removeDuckingEdit(musicId: string): Promise<boolean> {
  const node = defaultSceneGraph.getNode(musicId);
  const ref = levelRef(musicId);
  if (!node || !readDucking(node) || !ref) return false;
  const res = await edit('Remove Ducking', [
    { type: 'setProperty', prop: { layer: musicId, path: 'audio/ducking' }, value: values.json(null) },
    ...(await removeAnimationCommands(ref)),
  ]);
  return res.ok;
}

// ── Noise gate ─────────────────────────────────────────────────────────

/** Bake a gate from `env` (computeGateEnvelope's), ONE entry ("Noise Gate"). */
export async function gateEdit(
  nodeId: string,
  env: Float32Array,
  opts: { fps: number; startCompSec: number } & Partial<GateParams>,
): Promise<{ keyframes: number; error?: string }> {
  const ref = levelRef(nodeId);
  if (!ref || !defaultSceneGraph.getNode(nodeId)) return { keyframes: 0, error: 'That layer is gone.' };
  // Composition seconds: the engine converts to the layer's axis (the dedupe
  // of frames landing on one layer time happens in the splice).
  const keys = planGate(env, { ...opts, baseLevelDb: staticLevelDbOf(nodeId), toKeyframeTime: (t) => t });
  if (keys.length === 0) return { keyframes: 0, error: 'Nothing to gate in this range.' };
  const params: GateParams = { ...DEFAULT_GATE, ...opts };
  const ok = await spliceKeysEdit(
    'Noise Gate',
    [{ prop: ref, keys: keys.map((k) => ({ seconds: k.t, value: values.scalar(k.value) })), replace: 'all', axisTrack: AUDIO_LEVEL_DB_PROP }],
    [
      { type: 'setProperty', prop: { layer: nodeId, path: 'audio/gate' }, value: values.json(params) },
      ...clearExpressionCommands(ref, [AUDIO_LEVEL_DB_PROP]),
    ],
  );
  return ok ? { keyframes: keys.length } : { keyframes: 0, error: 'The gate could not be written.' };
}

/** Forget the gate AND remove the level track it wrote, ONE entry. */
export async function removeGateEdit(nodeId: string): Promise<boolean> {
  const node = defaultSceneGraph.getNode(nodeId);
  const ref = levelRef(nodeId);
  if (!node || !readGate(node) || !ref) return false;
  const res = await edit('Remove Noise Gate', [
    { type: 'setProperty', prop: { layer: nodeId, path: 'audio/gate' }, value: values.json(null) },
    ...(await removeAnimationCommands(ref)),
  ]);
  return res.ok;
}

// ── Audio driver ───────────────────────────────────────────────────────

/** The drivers record with `d` set (or `prop` removed when `d` is null), as the `audio/drivers` write. */
function driversWrite(nodeId: string, prop: string, d: AudioDriver | null): Command {
  const node = defaultSceneGraph.getNode(nodeId);
  const next = { ...(node ? readAudioDrivers(node) : {}) } as Record<string, AudioDriver>;
  if (d) next[prop] = d;
  else delete next[prop];
  return { type: 'setProperty', prop: { layer: nodeId, path: 'audio/drivers' }, value: values.json(next) };
}

/**
 * A driven track's value at comp `seconds` as the WHOLE API property value:
 * the driven member from the envelope, the other members as they are then
 * (the API keys Position / Scale as one vector — ENGINE_API.md §3.3).
 */
function memberKeyValue(nodeId: string, track: string, members: readonly string[], v: number, seconds: number): number[] {
  return members.map((m) => (m === track ? v : readPropertyValue(nodeId, m, seconds) ?? staticOrDefaultValue(nodeId, m)) * apiUnitFactor(m));
}

/**
 * Apply a driver: an expression (the member's own when the property is a
 * vector) or a bake replacing the property's keys, plus the record — ONE entry
 * ("Audio driver").
 */
export async function driverEdit(nodeId: string, d: AudioDriver): Promise<ApplyDriverResult> {
  const r = propRefForTrack(nodeId, d.prop);
  if (!r || !isLayer(nodeId)) return { mode: 'baked', keyframes: 0, error: 'That property cannot be driven through the engine.' };
  const blocker = d.mode === 'expression' ? expressionBlocker(d) : null;
  const expr = d.mode === 'expression' ? audioDriverExpression(d) : null;
  const member = r.members.length > 1 ? { member: r.member } : {};

  if (expr) {
    // The expression IS the value; a leftover baked track underneath it is
    // dead weight that reappears the moment the expression is disabled.
    const res = await edit('Audio driver', [
      driversWrite(nodeId, d.prop, { ...d, mode: 'expression' }),
      ...(await removeAnimationCommands(r.ref)),
      { type: 'setExpression', prop: r.ref, source: expr, enabled: true, ...member },
    ]);
    return res.ok ? { mode: 'expression', keyframes: 0 } : { mode: 'expression', keyframes: 0, error: 'The expression could not be set.' };
  }

  const range = driverRange();
  const env = await computeDriverEnvelope(d, range);
  if (!env || env.mapped.length === 0) {
    return {
      mode: 'baked',
      keyframes: 0,
      ...(blocker ? { fellBackBecause: blocker } : {}),
      error: d.sourceLayerId === MIX_SOURCE
        ? 'No audible audio in this range — import audio, or check the layer is not muted.'
        : 'That layer’s audio has not decoded (or has no sound in this range).',
    };
  }
  const keys: SpliceKey[] = [];
  for (let f = 0; f < env.mapped.length; f++) {
    const seconds = range.start + f / range.fps;
    if (seconds > range.end + 1e-9) break;
    const v = Math.round((env.mapped[f] ?? 0) * 1000) / 1000;
    const nums = memberKeyValue(nodeId, d.prop, r.members, v, seconds);
    keys.push({ seconds, value: r.members.length > 1 ? valueOf(r.valueType, nums) : values.scalar(nums[0]!) });
  }
  if (keys.length === 0) return { mode: 'baked', keyframes: 0, error: 'Nothing to write in this range.' };
  const hadExpr = defaultAnimation.hasExpression(nodeId, d.prop);
  const ok = await spliceKeysEdit(
    'Audio driver',
    [{ prop: r.ref, keys, replace: 'all', axisTrack: d.prop }],
    [
      driversWrite(nodeId, d.prop, { ...d, mode: 'baked' }),
      ...(hadExpr ? [{ type: 'setExpression', prop: r.ref, source: '', enabled: true, ...member } as Command] : []),
    ],
  );
  if (!ok) return { mode: 'baked', keyframes: 0, error: 'The driver could not be written.' };
  return { mode: 'baked', keyframes: keys.length, ...(blocker ? { fellBackBecause: blocker } : {}) };
}

function valueOf(type: string, nums: number[]): SpliceKey['value'] {
  if (type === 'vec3') return values.vec3(nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0);
  if (type === 'color') return values.color(nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0, nums[3] ?? 1);
  return values.vec2(nums[0] ?? 0, nums[1] ?? 0);
}

/** Remove a driver: forget it AND undo what it wrote (the expression, or the baked keys), ONE entry. */
export async function removeDriverEdit(nodeId: string, prop: string): Promise<void> {
  const node = defaultSceneGraph.getNode(nodeId);
  const d = node ? readAudioDriver(node, prop) : null;
  const r = propRefForTrack(nodeId, prop);
  const cmds: Command[] = [driversWrite(nodeId, prop, null)];
  if (d && r) {
    if (d.mode === 'expression') {
      if (defaultAnimation.hasExpression(nodeId, prop)) {
        cmds.push({ type: 'setExpression', prop: r.ref, source: '', enabled: true, ...(r.members.length > 1 ? { member: r.member } : {}) });
      }
    } else {
      cmds.push(...(await removeAnimationCommands(r.ref)));
    }
  }
  await edit('Remove audio driver', cmds);
}

// ── Convert audio to keyframes ─────────────────────────────────────────

/**
 * The loudness envelope as the layer's `audioAmplitude` track (replacing it),
 * ONE entry ("Convert audio to keyframes"). Resolves to the keys written.
 */
export async function convertAudioToKeyframesEdit(nodeId: string, opts: AudioKeyframeOptions): Promise<number> {
  const plan = await planAudioKeyframeTrack(nodeId, opts);
  if (plan.length === 0) return 0;
  const r = propRefForTrack(nodeId, opts.prop);
  if (!r) return 0;
  const ok = await spliceKeysEdit('Convert audio to keyframes', [{ prop: r.ref, keys: scalarKeys(plan), replace: 'all', axisTrack: opts.prop }]);
  return ok ? plan.length : 0;
}

// ── Level, pan, mute, timing ───────────────────────────────────────────

/** Mute / unmute (AE's audio switch). */
export function muteEdit(nodeId: string, muted: boolean): void {
  if (!isLayer(nodeId)) return;
  void edit(muted ? 'Mute audio' : 'Unmute audio', { type: 'setLayerSwitches', layers: [nodeId], patch: { audioEnabled: !muted } });
}

/**
 * The Audio section's Start / In / Out for a layer WITH a bar: the bar is the
 * layer (ENGINE_API.md §3.1), so these are `setLayerTiming` — absolute, so a
 * scrub is a gesture of them. `timing` is the bar as displayed (comp seconds
 * for the head, source seconds for In/Out).
 */
export function barTimingCommand(
  nodeId: string,
  field: 'start' | 'in' | 'out',
  timing: { startSec: number; inSec: number; outSec: number },
  v: number,
): Command {
  const patch = field === 'start'
    // The bar's head lands at `v`: the layer's start (where source 0 falls) moves with it.
    ? { startTime: compTime(v - timing.inSec) }
    : field === 'in'
      ? { inPoint: compTime(timing.startSec + (v - timing.inSec)) }
      : { outPoint: compTime(timing.startSec + (v - timing.inSec)) };
  return { type: 'setLayerTiming', items: [{ layer: nodeId, ...patch }] };
}

/** The same fields for a layer with NO bar: the Audio component's own props (`audio/clip*`). */
export function unbarredTimingCommand(nodeId: string, field: 'start' | 'in' | 'out', v: number): Command {
  const path = field === 'start' ? 'audio/clipStart' : field === 'in' ? 'audio/clipIn' : 'audio/clipOut';
  return { type: 'setProperty', prop: { layer: nodeId, path }, value: values.scalar(v) };
}

// ── Silence removal ────────────────────────────────────────────────────

/** One frame's worth of seconds — the tolerance for "this edge is that edge". */
const epsilon = (fps: number): number => 0.5 / Math.max(1, fps);

interface Bar { layer: string; start: number; end: number }

/** The bars (comp seconds) of `layers`, read as the document now stands. */
function barsOf(layers: ReadonlySet<string>): Bar[] {
  const out: Bar[] = [];
  for (const id of layers) {
    for (const t of readAudioClipTimings(id)) out.push({ layer: id, start: t.startSec, end: t.startSec + (t.outSec - t.inSec) });
  }
  return out;
}

/**
 * Remove `ranges` (SOURCE seconds) from every layer in `nodeIds` (the paired
 * set, `pairedAudioNodeIds`), keeping them in sync — ONE entry ("Remove
 * Silence"). Last interval first; per interval: split every paired bar that
 * crosses an edge (`splitLayers`; the right part is a new layer and joins the
 * set), delete the parts wholly inside, then close the gap on the PAIRED bars
 * only — never the comp-wide ripple, which would drag unrelated layers along.
 */
export async function removeSilencesEdit(nodeIds: readonly string[], ranges: readonly SilenceRange[]): Promise<RemoveSilencesResult> {
  const present = nodeIds.filter((id) => defaultSceneGraph.getNode(id) !== undefined && isLayer(id));
  if (present.length === 0) return { gaps: 0, secondsRemoved: 0, clipsDeleted: 0, error: 'Those layers are gone.' };
  if (ranges.length === 0) return { gaps: 0, secondsRemoved: 0, clipsDeleted: 0, error: 'Nothing to remove.' };
  const comp = compOfLayer(present[0]!);
  const fps = getTimelineController().fpsForNode(present[0]!) || 30;
  const intervals = mergeIntervals(present.flatMap((id) => rangesToCompIntervals(readAudioClipTimings(id), ranges)));
  if (intervals.length === 0 || !comp) {
    return { gaps: 0, secondsRemoved: 0, clipsDeleted: 0, error: 'Every silent stretch is already trimmed off these clips.' };
  }
  const working = new Set(present);
  const eps = epsilon(fps);
  let clipsDeleted = 0;
  const steps: EntryStep[] = [];
  for (let i = intervals.length - 1; i >= 0; i--) {
    const iv = intervals[i]!;
    for (const at of [iv.start, iv.end]) {
      steps.push(() => {
        const frame = Math.round(at * fps);
        const crossing = [...new Set(barsOf(working)
          .filter((b) => frame > Math.round(b.start * fps) && frame < Math.round(b.end * fps))
          .map((b) => b.layer))];
        return crossing.length > 0 ? [{ type: 'splitLayers', layers: crossing, time: compTime(at) } as Command] : [];
      });
      // Fold the right-hand halves into the working set.
      steps.push((earlier) => {
        const last = earlier[earlier.length - 1] as Array<{ type: string; layers?: string[] }> | undefined;
        for (const r of last ?? []) if (r.type === 'splitLayers') for (const id of r.layers ?? []) working.add(id);
        return [];
      });
    }
    steps.push(() => {
      const inside = [...new Set(barsOf(working)
        .filter((b) => b.end > b.start && b.start >= iv.start - eps && b.end <= iv.end + eps)
        .map((b) => b.layer))];
      for (const id of inside) working.delete(id);
      clipsDeleted += inside.length;
      return inside.length > 0 ? [{ type: 'deleteLayers', layers: inside } as Command] : [];
    });
    steps.push(() => {
      const gap = iv.end - iv.start;
      const later = [...new Set(barsOf(working).filter((b) => b.start >= iv.end - eps).map((b) => b.layer))];
      // Relative is right here: a one-shot action, not a gesture's message.
      return later.length > 0 ? [{ type: 'moveLayersInTime', layers: later, delta: -compTime(gap), ripple: false } as Command] : [];
    });
  }
  const res = await inOneEntry('Remove Silence', steps);
  if (!res) return { gaps: 0, secondsRemoved: 0, clipsDeleted: 0, error: 'The silences could not be removed.' };
  return {
    gaps: intervals.length,
    secondsRemoved: intervals.reduce((sum, iv) => sum + (iv.end - iv.start), 0),
    clipsDeleted,
  };
}
