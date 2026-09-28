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
 *   audio waveform      the shape generator's config, `layer/audioWaveform`
 *                       (json field, written whole; null removes it)
 *
 * The document facts each edit is composed from (the remembered records, the
 * static level, the bars, the work area) are read from the document MIRROR at
 * call time (B4, `@core/mirror/audio`). The analyses themselves (decode,
 * envelope, the duck plan, audio → keyframes) run in the editor's audio engine
 * until audio moves into the engine (E2) — they are engine work, not reads.
 */

import type { Command, PropRef } from '@motion/engine-api';
import { edit } from '@core/engine/uiEdits';
import { engine } from '@core/engine/engineInstance';
import { compTime, propRefForTrack, values } from '@core/engine/propRefs';
import { isLayer } from '@core/engine/doc';
import { keyAxisTimeForDisplay } from '@core/engine/displayTime';
import { AUDIO_LEVEL_DB_PROP } from '@core/audio/audioParams';
import { DEFAULT_FADE_SEC, type FadeSide } from '@core/audio/audioFades';
import type { ApplyDuckingResult, DuckingParams } from '@core/audio/ducking';
import {
  audioDriverExpression,
  computeDriverEnvelope,
  expressionBlocker,
  MIX_SOURCE,
  type ApplyDriverResult,
  type AudioDriver,
} from '@core/audio/audioDriver';
import { DEFAULT_AUDIO_KEYFRAME_OPTIONS, type AudioKeyframeOptions } from '@core/audio/audioKeyframes';
import { useSelectionStore } from '@stores/selectionStore';
import { apiUnitFactor } from '@core/engine/props';
import { documentMirror } from '@stores/documentMirror';
import { activeCompIdNow } from '@hooks/useMirror';
import {
  audioDriversOf,
  driverRangeOf,
  duckingOf,
  gateOf,
  planFadeKeysIn,
} from '@core/mirror/audio';
import { memberHasExpression } from '@core/mirror/memberExpressions';
import { numbersOfValue } from '@core/mirror/trackIndex';
import type { AudioWaveformConfig } from '@core/audio/audioWaveformGen';
import { jsonFieldCommands } from './layerFieldEdits';
import { runEngineJob } from '@core/engine/engineJobs';
import { clearExpressionCommands, removeAnimationCommands, spliceKeysEdit, type KeySplice, type SpliceKey } from './keySpliceEdits';

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
  const m = documentMirror();
  for (const id of nodeIds) {
    const ref = levelRef(id);
    if (!ref) continue;
    const keys = planFadeKeysIn(m, id, side, durationSec, (t) => keyAxisTimeForDisplay(id, t, AUDIO_LEVEL_DB_PROP));
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
  // The engine decodes the voice, follows it and writes the record + level track (audioDuck job).
  const viaEngine = await runEngineJob<{ keyframes: number; peakDuckDb?: number }>({
    kind: 'audioDuck', value: { music: musicId, voices: [voiceId], params: JSON.stringify(params) },
  });
  if (!viaEngine) return { keyframes: 0, peakDuckDb: 0, error: 'Ducking runs in the engine, and this engine does not run it.' };
  if (viaEngine.status !== 'done') return { keyframes: 0, peakDuckDb: 0, error: viaEngine.error?.message ?? 'The ducking could not be written.' };
  return { keyframes: viaEngine.result?.keyframes ?? 0, peakDuckDb: viaEngine.result?.peakDuckDb ?? 0 };
}

/** Re-run the ducking recorded on a layer. */
export async function reduckEdit(musicId: string): Promise<ApplyDuckingResult> {
  const m = documentMirror();
  const record = m.layer(musicId) ? duckingOf(m, musicId) : null;
  if (!record) return { keyframes: 0, peakDuckDb: 0, error: 'This layer has no ducking to redo.' };
  return duckEdit(musicId, record.voiceNodeId, record);
}

/** Forget the ducking AND remove the level track it wrote, ONE entry. */
export async function removeDuckingEdit(musicId: string): Promise<boolean> {
  const m = documentMirror();
  const ref = levelRef(musicId);
  if (!m.layer(musicId) || !duckingOf(m, musicId) || !ref) return false;
  const res = await edit('Remove Ducking', [
    { type: 'setProperty', prop: { layer: musicId, path: 'audio/ducking' }, value: values.json(null) },
    ...(await removeAnimationCommands(ref)),
  ]);
  return res.ok;
}

// ── Noise gate ─────────────────────────────────────────────────────────

/** Forget the gate AND remove the level track it wrote, ONE entry. */
export async function removeGateEdit(nodeId: string): Promise<boolean> {
  const m = documentMirror();
  const ref = levelRef(nodeId);
  if (!m.layer(nodeId) || !gateOf(m, nodeId) || !ref) return false;
  const res = await edit('Remove Noise Gate', [
    { type: 'setProperty', prop: { layer: nodeId, path: 'audio/gate' }, value: values.json(null) },
    ...(await removeAnimationCommands(ref)),
  ]);
  return res.ok;
}

// ── Audio driver ───────────────────────────────────────────────────────

/** The drivers record with `d` set (or `prop` removed when `d` is null), as the `audio/drivers` write. */
function driversWrite(nodeId: string, prop: string, d: AudioDriver | null): Command {
  const m = documentMirror();
  const next = { ...(m.layer(nodeId) ? audioDriversOf(m, nodeId) : {}) } as Record<string, AudioDriver>;
  if (d) next[prop] = d;
  else delete next[prop];
  return { type: 'setProperty', prop: { layer: nodeId, path: 'audio/drivers' }, value: values.json(next) };
}

/**
 * A driven track's value at comp `seconds` as the WHOLE API property value:
 * the driven member from the envelope, the other members as they are then
 * (the API keys Position / Scale as one vector — ENGINE_API.md §3.3). The
 * other members' values at a time are a query (a write composes from the
 * document as it stands, not from a display cache); a scalar needs none.
 */
async function memberKeyValue(ref: PropRef, member: number, track: string, dims: number, v: number, seconds: number): Promise<number[]> {
  const driven = v * apiUnitFactor(track);
  if (dims <= 1) return [driven];
  const res = await engine().query({ type: 'getPropertyValues', props: [ref], time: compTime(seconds), evaluated: false });
  const nums = res.ok ? numbersOfValue(res.value.values[0]?.value) : [];
  return Array.from({ length: dims }, (_, i) => (i === member ? driven : nums[i] ?? 0));
}

/** Whether the driven dimension carries an expression now (the API's per-dimension record). */
function drivenHasExpression(nodeId: string, path: string, member: number): boolean {
  const m = documentMirror();
  return memberHasExpression(m.property(nodeId, path), member);
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

  // The bake range of the active composition (its work area, else all of it).
  const range = driverRangeOf(documentMirror().comp(activeCompIdNow() ?? '')?.settings);
  // Engine-side until E2: the source's decode (or the comp mixdown) and its envelope.
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
    const nums = await memberKeyValue(r.ref, r.member, d.prop, r.members.length, v, seconds);
    keys.push({ seconds, value: r.members.length > 1 ? valueOf(r.valueType, nums) : values.scalar(nums[0]!) });
  }
  if (keys.length === 0) return { mode: 'baked', keyframes: 0, error: 'Nothing to write in this range.' };
  const hadExpr = drivenHasExpression(nodeId, r.ref.path, r.member);
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
  const m = documentMirror();
  const d = m.layer(nodeId) ? audioDriversOf(m, nodeId)[prop] ?? null : null;
  const r = propRefForTrack(nodeId, prop);
  const cmds: Command[] = [driversWrite(nodeId, prop, null)];
  if (d && r) {
    if (d.mode === 'expression') {
      if (drivenHasExpression(nodeId, r.ref.path, r.member)) {
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
 * ONE entry: the engine's audioAnalysis job decodes and writes it. Resolves to
 * the keys written (0 when nothing was, or the engine does not run it).
 */
export async function convertAudioToKeyframesEdit(nodeId: string, opts: AudioKeyframeOptions): Promise<number> {
  const out = await runEngineJob<{ amplitude?: { keyframes: number } }>({
    kind: 'audioAnalysis',
    value: {
      layer: nodeId, beats: false, amplitudeKeyframes: true, silence: false, removeSilence: false, beatMarkers: false,
      amplitudeFrameStep: Math.max(1, Math.floor(opts.frameStep)), amplitudeMinDelta: opts.minDelta,
      amplitudeSmoothing: Math.max(1, Math.floor(opts.smoothing)), amplitudeGain: opts.gain,
    },
  });
  return out && out.status === 'done' ? out.result?.amplitude?.keyframes ?? 0 : 0;
}

/**
 * After Effects' Convert Audio to Keyframes (the Animation menu): a new "<layer> Amplitude" NULL with
 * Both Channels / Left / Right Slider Controls keyed from the layer's loudness — the engine's audioAnalysis
 * job (`amplitudeNull`) decodes, measures and builds it as ONE entry. Resolves to the new null's id (found
 * by name among the composition's layers) and the keys per channel, or null when nothing was written.
 */
export async function audioAmplitudeNullEdit(
  nodeId: string,
  opts: AudioKeyframeOptions = DEFAULT_AUDIO_KEYFRAME_OPTIONS,
): Promise<{ nullId: string | null; keys: { both: number; left: number; right: number } } | null> {
  const m = documentMirror();
  const comp = m.layer(nodeId)?.comp;
  const before = new Set(comp ? m.comp(comp)?.layers ?? [] : []);
  const out = await runEngineJob<{ amplitudeNull?: { both: number; left: number; right: number } }>({
    kind: 'audioAnalysis',
    value: {
      layer: nodeId, beats: false, amplitudeKeyframes: false, silence: false, removeSilence: false, beatMarkers: false, amplitudeNull: true,
      amplitudeFrameStep: Math.max(1, Math.floor(opts.frameStep)), amplitudeMinDelta: opts.minDelta,
      amplitudeSmoothing: Math.max(1, Math.floor(opts.smoothing)), amplitudeGain: opts.gain,
    },
  });
  const keys = out && out.status === 'done' ? out.result?.amplitudeNull : undefined;
  if (!keys || keys.both + keys.left + keys.right === 0) return null;
  await m.whenIdle();
  const nullId = (comp ? m.comp(comp)?.layers ?? [] : []).find((id) => !before.has(id) && m.layer(id)?.kind === 'null') ?? null;
  if (nullId) useSelectionStore.getState().set([nullId]);
  return { nullId, keys };
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

// ── Audio Waveform generator (shape layers) ─────────────────────────────

/**
 * `layer/audioWaveform` := `cfg` (the whole generator config; `null` removes
 * the generator). [] when the layer has no such field. Add, every field of the
 * section and Remove are this one command, sent as one entry per click / typed
 * value, or inside a scrub gesture.
 */
export function audioWaveformCommands(nodeId: string, cfg: AudioWaveformConfig | null): Command[] {
  return jsonFieldCommands(nodeId, 'layer/audioWaveform', cfg);
}
