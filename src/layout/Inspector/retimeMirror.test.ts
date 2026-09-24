/**
 * B4: the Speed section's retime reads come from the MIRROR (core/mirror/retime.ts).
 * Pinned on the app engine against the retimeCommands readers they replace,
 * so the section shows — and retimeEdits composes — exactly what it did.
 */

import { defaultAnimation } from '@motion/animation';
import type { Keyframe } from '@motion/engine-api';
import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import { sec, type Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { keyAxisTimeForDisplay } from '@core/engine/displayTime';
import { SPEED_PROP } from '@core/animation/retime';
import { fitSpeedFactor, planSpeedPreset, retimeBarInfo, retimeSummary, retimedSourceSeconds, sourceFrameAt } from '@core/animation/retimeCommands';
import { documentMirror } from '@stores/documentMirror';
import { setSpeedCommands, speedPresetCommands } from './retimeEdits';
import {
  SPEED_PATH,
  mirrorFitSpeedFactor,
  mirrorRetimeBar,
  mirrorRetimeSummary,
  mirrorRetimedSourceSeconds,
  mirrorSourceFrameAt,
  mirrorSpeedPercentAt,
} from '@core/mirror/retime';

jest.useFakeTimers();

let h: Harness & { engine: LocalEngine };
let s: Scene;
const f = (n: number): number => sec(n / 30);

function speedKey(frame: number, value: number, easing: Keyframe['easing']): Keyframe {
  return {
    id: '', time: f(frame), value: { kind: 'scalar', value }, easing,
    continuous: false, roving: false, spatialInterp: 'legacy', spatialIn: [], spatialOut: [], label: 0, dims: [],
  };
}

beforeEach(async () => {
  h = await setupAppEngine();
  s = await buildScene(h);
  // A clip that starts half a second in (so the clip offset is not zero) and plays its whole 4 s file.
  await h.run({ type: 'setLayerTiming', items: [{ layer: s.V, startTime: f(15), inPoint: f(15), outPoint: f(135) }] });
  await h.run({ type: 'setRetime', layer: s.V, mode: 'speed' });
  await h.run({
    type: 'setKeyframes',
    prop: { layer: s.V, path: SPEED_PATH },
    keys: [speedKey(15, 100, 'easeInOut'), speedKey(60, 25, 'linear'), speedKey(90, 200, 'hold'), speedKey(120, 80, 'linear')],
  });
  await engineIdle();
});
afterEach(async () => {
  await h.dispose();
});

const TIMES = [0, 0.5, 0.9, 1.25, 2, 2.6, 3.1, 4.4, 5.4];

test('the clip bar matches retimeBarInfo', () => {
  const legacy = retimeBarInfo(s.V)!;
  const bar = mirrorRetimeBar(documentMirror(), s.V)!;
  expect(bar.fps).toBeCloseTo(legacy.fps, 9);
  expect(bar.inSec).toBeCloseTo(legacy.inSec, 9);
  expect(bar.outSec).toBeCloseTo(legacy.outSec, 9);
  expect(bar.clip.offsetSec).toBeCloseTo(legacy.clip.offsetSec, 9);
  expect(bar.clip.inSec).toBeCloseTo(legacy.clip.inSec, 9);
  expect(bar.sourceInSec).toBeCloseTo(legacy.sourceInSec, 9);
  expect(bar.sourceDurationSec ?? -1).toBeCloseTo(legacy.sourceDurationSec ?? -1, 6);
  expect(bar.sourceFps).toBeCloseTo(legacy.sourceFps, 2);
  expect(bar.clip.offsetSec).toBeCloseTo(-0.5, 9);
});

test('Speed %: the curve, the source time and the frame at the playhead match the animation engine', () => {
  const m = documentMirror();
  const bar = mirrorRetimeBar(m, s.V);
  const legacyBar = retimeBarInfo(s.V);
  for (const t of TIMES) {
    const legacySpeed = defaultAnimation.sample(s.V, SPEED_PROP, keyAxisTimeForDisplay(s.V, t));
    expect(mirrorSpeedPercentAt(m, s.V, t, bar)).toBeCloseTo(legacySpeed!, 6);
    expect(mirrorRetimedSourceSeconds(m, s.V, t, bar)).toBeCloseTo(retimedSourceSeconds(s.V, t, legacyBar), 6);
    expect(mirrorSourceFrameAt(m, s.V, t, bar)).toBe(sourceFrameAt(s.V, t, legacyBar));
  }
});

test('the footage budget and Fit to Footage match retimeSummary / fitSpeedFactor', () => {
  const m = documentMirror();
  const legacy = retimeSummary(s.V)!;
  const summary = mirrorRetimeSummary(m, s.V)!;
  expect(summary.mode).toBe('speed');
  expect(summary.mode).toBe(legacy.mode);
  expect(summary.usedSec).toBeCloseTo(legacy.usedSec, 6);
  expect(summary.outputSec).toBeCloseTo(legacy.outputSec, 9);
  expect(summary.availableSec ?? -1).toBeCloseTo(legacy.availableSec ?? -1, 6);
  expect(summary.runsOutAtSec ?? -1).toBeCloseTo(legacy.runsOutAtSec ?? -1, 6);
  expect(legacy.availableSec).not.toBeNull();
  expect(fitSpeedFactor(s.V)).not.toBeNull();
  expect(mirrorFitSpeedFactor(m, s.V)!).toBeCloseTo(fitSpeedFactor(s.V)!, 6);
});

test('Frame Number: the remap curve matches the animation engine', async () => {
  await h.run({ type: 'setRetime', layer: s.V, mode: 'frames' });
  await engineIdle();
  const m = documentMirror();
  const bar = mirrorRetimeBar(m, s.V);
  const legacyBar = retimeBarInfo(s.V);
  expect(mirrorRetimeSummary(m, s.V)!.mode).toBe('frames');
  for (const t of TIMES) {
    expect(mirrorRetimedSourceSeconds(m, s.V, t, bar)).toBeCloseTo(retimedSourceSeconds(s.V, t, legacyBar), 6);
    expect(mirrorSourceFrameAt(m, s.V, t, bar)).toBe(sourceFrameAt(s.V, t, legacyBar));
  }
});

test('retimeEdits composes from the mirror: the key at the playhead, a preset across the bar', () => {
  const keys = documentMirror().keyframes(s.V, SPEED_PATH);
  // The Speed field ON a key updates that key (by its engine id)…
  expect(setSpeedCommands(s.V, 2, 40)[0]).toEqual({
    type: 'updateKeyframes', patches: [{ id: keys[1]!.id, value: { kind: 'scalar', value: 40 }, spatialIn: [], spatialOut: [] }],
  });
  // …between keys it adds one shaped like the key before it (linear, from the key at 2 s).
  expect(setSpeedCommands(s.V, 2.5, 150)[0]).toMatchObject({
    type: 'addKeyframes', keys: [{ prop: { layer: s.V, path: SPEED_PATH }, time: sec(2.5), easing: 'linear' }],
  });
  // A preset spans the same bar planSpeedPreset measures.
  const plan = planSpeedPreset(s.V, 'hero')!;
  const cmd = speedPresetCommands(s.V, 'hero')!.commands[0] as { keys: Keyframe[] };
  expect(cmd.keys.map((k) => k.time)).toEqual(plan.keys.map((k) => sec(k.seconds)));
  expect(cmd.keys.map((k) => k.easing)).toEqual(plan.keys.map((k) => k.easing));
});
