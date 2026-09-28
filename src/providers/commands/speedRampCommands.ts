/**
 * Speed ramps as commands — ease into slow motion at the playhead — over the
 * engine (B4 round 7). The rules are the ones `core/animation/speedRamp.ts`
 * documents:
 *
 *   - the ramp STARTS at the playhead, eases over TRANSITION_SEC, then holds
 *     the new speed to the end of the composition;
 *   - it continues from the frame already on screen and from the speed the
 *     layer already plays at, so ramps compose;
 *   - slowing turns on Pixel Motion frame blending when blending was off.
 *
 * A layer in Speed % (or Normal) mode ramps its `layer/timeSpeed` keys: the
 * keys before the playhead stay, then the current speed at the playhead and
 * the target TRANSITION_SEC later. A layer keyed in Frame Number keeps its
 * remap curve: the ramp's source-time keys (`buildTimeRemap`) are spliced into
 * `timeRemap`. The current value / slope comes from `getPropertyValues`; the
 * keys from the document mirror (engine ids, comp flicks). ONE entry for the
 * whole selection.
 */

import { asCommandId } from '@app-types/common';
import { flicksToSeconds, type Command as EngineCommand, type Keyframe, type PropRef } from '@motion/engine-api';
import type { Command } from '@core/commands/Command';
import { engine } from '@core/engine/engineInstance';
import { compTime, values } from '@core/engine/propRefs';
import { edit } from '@core/engine/uiEdits';
import { buildTimeRemap, type SpeedPoint } from '@core/animation/speedRamp';
import { REMAP_PATH, SPEED_PATH } from '@core/mirror/retime';
import { numbersOfValue } from '@core/mirror/trackIndex';
import { documentMirror } from '@stores/documentMirror';
import { getTime } from '@stores/playbackClockStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import { activeCompIdNow } from '@hooks/useMirror';
import { isRetimable } from './layerTimeCommands';

/** How long the ease from the old speed to the new one takes. */
const TRANSITION_SEC = 0.5;
/** Window used to read the slope of an existing remap curve. */
const SLOPE_DT = 1 / 120;

function notify(message: string, level: 'info' | 'success' | 'warning' = 'info'): void {
  useUIStore.getState().notify({ level, message, durationMs: 5000 });
}

/** Selected layers a ramp can act on: a source to retime (video, audio, a precomp). */
export function rampTargets(): string[] {
  return useSelectionStore.getState().ids.filter(isRetimable);
}

async function valuesAt(props: PropRef[], seconds: number): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (props.length === 0) return out;
  const res = await engine().query({ type: 'getPropertyValues', props, time: compTime(seconds), evaluated: true });
  if (res.ok) for (const v of res.value.values) out.set(`${v.prop.layer}\u0000${v.prop.path}`, numbersOfValue(v.value)[0] ?? NaN);
  return out;
}

function whole(k: Omit<Keyframe, 'continuous' | 'roving' | 'spatialInterp' | 'spatialIn' | 'spatialOut' | 'label' | 'dims'>): Keyframe {
  return { ...k, continuous: false, roving: false, spatialInterp: 'legacy', spatialIn: [], spatialOut: [], label: 0, dims: [] };
}

/** The ramp's commands for `nodeIds` at comp `at` to `target` (1 = 100 %), or a refusal. */
export async function speedRampCommands(nodeIds: readonly string[], at: number, target: number, compEnd: number): Promise<EngineCommand[]> {
  const m = documentMirror();
  const key = (layer: string, path: string): string => `${layer}\u0000${path}`;
  const frames = nodeIds.filter((id) => m.layer(id)?.timing.retime === 'frames');
  const speed = nodeIds.filter((id) => !frames.includes(id));
  const refs: PropRef[] = [
    ...speed.filter((id) => m.keyframes(id, SPEED_PATH).length > 0).map((layer) => ({ layer, path: SPEED_PATH })),
    ...frames.map((layer) => ({ layer, path: REMAP_PATH })),
  ];
  const now = await valuesAt(refs, at);
  const later = await valuesAt(frames.map((layer) => ({ layer, path: REMAP_PATH })), at + SLOPE_DT);
  const cmds: EngineCommand[] = [];
  const u = compTime(at);
  for (const id of speed) {
    const existing = m.keyframes(id, SPEED_PATH);
    const from = existing.length > 0 ? (now.get(key(id, SPEED_PATH)) ?? 100) : 100;
    const kept = existing.filter((k) => k.time < u - 1);
    // A layer at Normal speed has no Speed % property yet: switch it to Speed % first (same batch).
    if (m.layer(id)?.timing.retime !== 'speed') cmds.push({ type: 'setRetime', layer: id, mode: 'speed' });
    cmds.push({
      type: 'setKeyframes',
      prop: { layer: id, path: SPEED_PATH },
      keys: [
        ...kept,
        whole({ id: '', time: u, value: values.scalar(Number.isFinite(from) ? from : 100), easing: 'linear' }),
        whole({ id: '', time: compTime(at + TRANSITION_SEC), value: values.scalar(target * 100), easing: 'linear' }),
      ],
    });
  }
  for (const id of frames) {
    const before = now.get(key(id, REMAP_PATH));
    const after = later.get(key(id, REMAP_PATH));
    const from = before !== undefined && after !== undefined && Number.isFinite(before) && Number.isFinite(after) ? (after - before) / SLOPE_DT : 1;
    const source = before !== undefined && Number.isFinite(before) ? before : at;
    const profile: SpeedPoint[] = [
      { t: at, speed: from },
      { t: at + TRANSITION_SEC, speed: target },
      { t: compEnd, speed: target },
    ];
    const recorded = buildTimeRemap(profile, source).map((k) => whole({
      id: '',
      time: compTime(k.t),
      value: values.scalar(k.value),
      ...(k.bezier
        ? { easing: 'bezier' as const, bezier: { x1: k.bezier[0], y1: k.bezier[1], x2: k.bezier[2], y2: k.bezier[3] } }
        : { easing: 'linear' as const }),
    }));
    if (recorded.length === 0) continue;
    const t0 = recorded[0]!.time;
    const t1 = recorded[recorded.length - 1]!.time;
    const kept = m.keyframes(id, REMAP_PATH).filter((k) => k.time < t0 - 1 || k.time > t1 + 1);
    cmds.push({ type: 'setKeyframes', prop: { layer: id, path: REMAP_PATH }, keys: [...kept, ...recorded].sort((a, b) => a.time - b.time) });
  }
  return cmds;
}

async function rampTo(target: number): Promise<void> {
  const nodeIds = rampTargets();
  if (nodeIds.length === 0) {
    notify(
      useSelectionStore.getState().ids.length > 0
        ? 'Speed ramps need a layer with a source to retime — video, audio, or a pre-comp.'
        : 'Select a video, audio or pre-composed layer to ramp.',
      'warning',
    );
    return;
  }
  const at = getTime();
  const comp = activeCompIdNow();
  const dur = comp ? documentMirror().comp(comp)?.settings.duration : undefined;
  const compEnd = dur ? flicksToSeconds(dur) : at + TRANSITION_SEC + 1;
  if (compEnd <= at + TRANSITION_SEC) {
    notify('Not enough time left after the playhead for a ramp.', 'warning');
    return;
  }
  const cmds = await speedRampCommands(nodeIds, at, target, compEnd);
  // Slowing turns on Pixel Motion where blending is off (never overriding a chosen mode).
  const blend = target < 1 ? nodeIds.filter((id) => documentMirror().layer(id)?.switches.frameBlend === 'off') : [];
  if (blend.length > 0) cmds.push({ type: 'setLayerSwitches', layers: blend, patch: { frameBlend: 'pixelMotion' } });
  const res = await edit(`Speed ramp to ${Math.round(target * 100)}%`, cmds);
  if (!res.ok) return;
  notify(
    `Ramped ${nodeIds.length} layer${nodeIds.length === 1 ? '' : 's'} to ${Math.round(target * 100)}% over ${TRANSITION_SEC}s.`
    + (blend.length > 0 ? ' Pixel Motion frame blending turned on for smooth slow motion.' : ''),
    'success',
  );
}

/** The speeds worth a command of their own. */
const RAMP_STEPS: ReadonlyArray<{ id: string; label: string; speed: number; hint: string }> = [
  { id: 'quarter', label: 'Ramp to 25% (Slow Motion)', speed: 0.25, hint: 'Ease into quarter speed at the playhead.' },
  { id: 'half', label: 'Ramp to 50%', speed: 0.5, hint: 'Ease into half speed at the playhead.' },
  { id: 'normal', label: 'Ramp back to 100%', speed: 1, hint: 'Ease back to full speed at the playhead.' },
  { id: 'double', label: 'Ramp to 200%', speed: 2, hint: 'Ease into double speed at the playhead.' },
  { id: 'freeze', label: 'Ramp to a Freeze', speed: 0, hint: 'Ease to a standstill and hold the frame.' },
];

/** Every speed-ramp command, for `buildStaticCommands`. */
export function buildSpeedRampCommands(): ReadonlyArray<Command> {
  return RAMP_STEPS.map((step) => ({
    id: asCommandId(`time.speedRamp.${step.id}`),
    label: step.label,
    description: step.hint,
    icon: 'clock',
    enabled: () => rampTargets().length > 0,
    execute: () => { void rampTo(step.speed); },
  }));
}
