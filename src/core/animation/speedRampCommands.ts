/**
 * Speed ramps, as commands: ease into slow motion at the playhead.
 *
 * The maths is in `speedRamp.ts` and is exact. This is the part that has to
 * decide what a person means by "ramp to 25% here":
 *
 *   - the ramp STARTS at the playhead and eases over a fixed transition, then
 *     holds the new speed to the end of the composition — because a ramp that
 *     also had to be told where to stop would need two clicks and a decision;
 *   - it continues from the frame ALREADY on screen, so inserting a ramp
 *     mid-clip does not jump the footage back to its head;
 *   - it picks up the speed the layer is already playing at, so ramps compose:
 *     ramp to 25%, move on, ramp back to 100%, and the second one starts from
 *     a quarter rather than from full speed;
 *   - and slowing turns on optical-flow frame blending, because 25% without it
 *     is the same frames held four times each, which reads as broken rather
 *     than as slow motion.
 *
 * WHAT IT APPLIES TO. Layers that have a SOURCE to retime: video, audio, and
 * precomps. `buildSnapshot` samples a node's own `timeRemap` when it computes
 * that layer's `sourceTime`, so a ramp retimes the frames a video layer shows
 * exactly as it retimes a precomp's contents.
 *
 * A shape or solid is excluded, and not arbitrarily: `timeRemap` feeds
 * `sourceTime` only. It does NOT move the layer's own transform keyframes,
 * which is the same separation After Effects makes — time-remapping footage
 * retimes the picture, not the animation you put on top of it. A shape has no
 * source, so nothing would read the value and the ramp would be inert.
 *
 * (An earlier version of this file restricted ramps to precomps, on the
 * strength of `precompSourceTime` and the precomp ancestor chain — while the
 * general layer path a hundred lines further down samples `timeRemap` for
 * every node. The restriction blocked the main use case, ramping a video clip,
 * and the docs asserted it was impossible. Verified the other way now, in
 * `speedRampRender.test.ts`, against a real video layer.)
 */

import { asCommandId } from '@app-types/common';
import type { Command } from '@core/commands/Command';
import { defaultAnimation, type Keyframe } from '@motion/animation';
import { useUIStore } from '@stores/uiStore';
import { useProjectStore } from '@stores/projectStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useCompositionStore } from '@stores/compositionStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { isPrecomp } from '@core/scene/precomp';
import { readNodeKind } from '@core/scene/sceneDerive';
import { getNodeLayerTime, updateNodeLayerTime } from '@core/scene/layerTime';
import { runAnimEdit } from './animationCommands';
import { spliceRecordedRange } from './motionSketch';
import { buildTimeRemap, type SpeedPoint } from './speedRamp';

/** How long the ease from the old speed to the new one takes. */
const TRANSITION_SEC = 0.5;

/** Window used to read the slope of an existing remap curve. */
const SLOPE_DT = 1 / 120;

function notify(message: string, level: 'info' | 'success' | 'warning' = 'info'): void {
  useUIStore.getState().notify({ level, message, durationMs: 5000 });
}

function playhead(): number {
  const project = useProjectStore.getState();
  return (project.activeTabId ? project.tabs[project.activeTabId]?.time : 0) ?? 0;
}

/** Kinds whose rendering reads `sourceTime`, and so can actually be retimed. */
function hasRetimableSource(nodeId: string): boolean {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return false;
  const kind = readNodeKind(node);
  return kind === 'video' || kind === 'audio' || isPrecomp(node);
}

/** Selected layers a ramp can actually act on. */
export function rampTargets(): string[] {
  return useSelectionStore.getState().ids.filter(hasRetimableSource);
}

/**
 * The speed the layer is already playing at, read as the SLOPE of its remap
 * curve rather than stored anywhere.
 *
 * Slope is the honest source: the curve is the only record of speed, and a
 * layer part-way through an earlier ramp is genuinely between two values. With
 * no curve at all the layer plays at 100% by definition.
 */
function currentSpeed(nodeId: string, atTime: number): number {
  if (!defaultAnimation.isAnimated(nodeId, 'timeRemap')) return 1;
  const before = defaultAnimation.sample(nodeId, 'timeRemap', atTime);
  const after = defaultAnimation.sample(nodeId, 'timeRemap', atTime + SLOPE_DT);
  if (before === undefined || after === undefined) return 1;
  return (after - before) / SLOPE_DT;
}

/** Source time on screen now — where the ramp has to continue from. */
function sourceAt(nodeId: string, atTime: number): number {
  return defaultAnimation.sample(nodeId, 'timeRemap', atTime) ?? atTime;
}

function rampTo(target: number): void {
  const nodeIds = rampTargets();
  if (nodeIds.length === 0) {
    const anySelected = useSelectionStore.getState().ids.length > 0;
    notify(
      anySelected
        ? 'Speed ramps need a layer with a source to retime — video, audio, or a pre-comp.'
        : 'Select a video, audio or pre-composed layer to ramp.',
      'warning',
    );
    return;
  }

  const at = playhead();
  const compEnd = useCompositionStore.getState().durationSeconds || at + TRANSITION_SEC + 1;
  // A ramp needs somewhere to go. At the very end of the comp there is no room
  // for the transition, let alone the tail.
  if (compEnd <= at + TRANSITION_SEC) {
    notify('Not enough time left after the playhead for a ramp.', 'warning');
    return;
  }

  let ramped = 0;
  let blended = 0;
  runAnimEdit(`Speed ramp to ${Math.round(target * 100)}%`, () => {
    for (const nodeId of nodeIds) {
      const from = currentSpeed(nodeId, at);
      const profile: SpeedPoint[] = [
        { t: at, speed: from },
        { t: at + TRANSITION_SEC, speed: target },
        { t: compEnd, speed: target },
      ];
      const keys = buildTimeRemap(profile, sourceAt(nodeId, at));
      const recorded: Keyframe[] = keys.map((k) => ({
        t: k.t,
        value: k.value,
        ...(k.bezier ? { easing: 'bezier' as const, bezier: k.bezier } : { easing: 'linear' as const }),
      }));
      const existing = defaultAnimation.tracksFor(nodeId).find((tr) => tr.prop === 'timeRemap')?.keyframes ?? [];
      defaultAnimation.setKeyframes(nodeId, 'timeRemap', spliceRecordedRange(existing, recorded));
      ramped++;
    }
  });

  // Frame blending is a SCENE edit, not an animation one, so it is applied
  // outside the transaction — and only when the layer has none, because
  // overriding a deliberate "Off" would be the command deciding it knows
  // better about a setting the user went and found.
  if (target < 1) {
    for (const nodeId of nodeIds) {
      if (getNodeLayerTime(nodeId).frameBlend === 'none') {
        updateNodeLayerTime(nodeId, { frameBlend: 'pixelMotion' });
        blended++;
      }
    }
  }

  notify(
    `Ramped ${ramped} layer${ramped === 1 ? '' : 's'} to ${Math.round(target * 100)}% `
    + `over ${TRANSITION_SEC}s.`
    + (blended > 0 ? ` Pixel Motion frame blending turned on for smooth slow motion.` : ''),
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
    execute: () => rampTo(step.speed),
  }));
}
