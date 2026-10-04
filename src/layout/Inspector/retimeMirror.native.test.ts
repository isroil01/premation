/**
 * B4: the Speed section's retime reads come from the MIRROR (core/mirror/retime.ts),
 * pinned on the app engine: the Speed curve against the engine's own
 * evaluation (getPropertyValues); the source times, the bar and the footage
 * budget against the fixture's numbers (the curve integrated by hand).
 */

import type { Keyframe } from '@motion/engine-api';
import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import { sec, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
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

let h: Harness;
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

/** The engine's own evaluation of the Speed property at comp time `t`. */
async function engineAt(t: number): Promise<{ speed: number | undefined }> {
  const v = await h.query({ type: 'getPropertyValues', props: [{ layer: s.V, path: SPEED_PATH }], time: sec(t), evaluated: true });
  const val = v.values[0]?.value;
  return { speed: val && val.kind === 'scalar' ? val.value : undefined };
}

/** The engine's `mapLayerTime`: comp seconds → the source seconds the layer shows (outward: back). */
async function engineMapped(t: number, outward = false): Promise<number | undefined> {
  const r = await h.query({ type: 'mapLayerTime', layer: s.V, time: sec(t), outward });
  return r.time === undefined ? undefined : r.time / 705_600_000;
}

async function settled(): Promise<ReturnType<typeof documentMirror>> {
  const m = documentMirror();
  await m.loadTree(s.V);
  await m.whenIdle();
  return m;
}

test('the clip bar: half a second in, the whole 4 s file at 30 fps', async () => {
  const bar = mirrorRetimeBar(await settled(), s.V)!;
  expect(bar).toMatchObject({ fps: 30, inSec: 0.5, outSec: 4.5, sourceInSec: 0, sourceDurationSec: 4, sourceFps: 30 });
  expect(bar.clip.offsetSec).toBeCloseTo(-0.5, 9);
  expect(bar.clip.inSec).toBeCloseTo(0.5, 9);
});

/**
 * The source time the layer shows at comp time t (inside the bar): the speed
 * curve integrated from the bar's start — 1.5 s easing 100 → 25 %, 1 s
 * linear 25 → 200 %, 1 s held at 200 %, then 80 %.
 */
const SOURCE_AT: ReadonlyArray<[number, number]> = [[0.5, 0], [2, 0.9375], [3.1, 2.2625], [4.4, 4.3825]];

test('Speed %: the curve is the engine\'s; the source time is the curve integrated', async () => {
  const m = await settled();
  const bar = mirrorRetimeBar(m, s.V);
  for (const t of TIMES) {
    const e = await engineAt(t);
    expect(e.speed).toBeDefined();
    expect(mirrorSpeedPercentAt(m, s.V, t, bar)).toBeCloseTo(e.speed!, 6);
  }
  for (const [t, src] of SOURCE_AT) {
    expect(mirrorRetimedSourceSeconds(m, s.V, t, bar)).toBeCloseTo(src, 6);
    // The frame shown is the source time on the file's 30 fps grid.
    expect(Math.abs(mirrorSourceFrameAt(m, s.V, t, bar) - src * 30)).toBeLessThan(1);
    // …and the engine's mapLayerTime answers the same (it once returned comp time unchanged).
    expect(await engineMapped(t)).toBeCloseTo(src, 6);
  }
  // Back out through a Speed curve has no single answer.
  expect(await engineMapped(1, true)).toBeUndefined();
});

test('the footage budget and Fit to Footage', async () => {
  const m = await settled();
  const summary = mirrorRetimeSummary(m, s.V)!;
  // The integral of the curve over the 4 s bar: 1.5 s at 62.5 %, 1 s at 112.5 %, 1 s held at 200 %, 0.5 s at 80 %.
  expect(summary).toMatchObject({ mode: 'speed', outputSec: 4, availableSec: 4 });
  expect(summary.usedSec).toBeCloseTo(4.4625, 6);
  expect(summary.runsOutAtSec!).toBeCloseTo(4, 6);
  expect(mirrorFitSpeedFactor(m, s.V)!).toBeCloseTo(8 / 9, 6);
});

test('Frame Number: the remap the switch writes keeps the source times', async () => {
  await h.run({ type: 'setRetime', layer: s.V, mode: 'frames' });
  await engineIdle();
  const m = await settled();
  const bar = mirrorRetimeBar(m, s.V);
  expect(mirrorRetimeSummary(m, s.V)!.mode).toBe('frames');
  for (const [t, src] of SOURCE_AT) {
    expect(mirrorRetimedSourceSeconds(m, s.V, t, bar)).toBeCloseTo(src, 6);
    expect(await engineMapped(t)).toBeCloseTo(src, 6);
  }
});

test('mapLayerTime without a retime: the clip offset, both ways', async () => {
  await h.run({ type: 'setRetime', layer: s.V, mode: 'normal' });
  await engineIdle();
  // Starts half a second in, plays the file from 0: source = comp − 0.5.
  expect(await engineMapped(2)).toBeCloseTo(1.5, 9);
  expect(await engineMapped(1.5, true)).toBeCloseTo(2, 9);
});

test('retimeEdits composes from the mirror: the key at the playhead, a preset across the bar', async () => {
  await settled();
  const keys = documentMirror().keyframes(s.V, SPEED_PATH);
  // The Speed field ON a key updates that key (by its engine id)…
  expect(setSpeedCommands(s.V, 2, 40)[0]).toEqual({
    type: 'updateKeyframes', patches: [{ id: keys[1]!.id, value: { kind: 'scalar', value: 40 }, spatialIn: [], spatialOut: [] }],
  });
  // …between keys it adds one shaped like the key before it (linear, from the key at 2 s).
  expect(setSpeedCommands(s.V, 2.5, 150)[0]).toMatchObject({
    type: 'addKeyframes', keys: [{ prop: { layer: s.V, path: SPEED_PATH }, time: sec(2.5), easing: 'linear' }],
  });
  // A preset spans the bar: from its in point to (just inside) its out point, eased.
  const cmd = speedPresetCommands(s.V, 'hero')!.commands[0] as { keys: Keyframe[] };
  const times = cmd.keys.map((k) => k.time / 705_600_000);
  expect(times[0]).toBeCloseTo(0.5, 9);
  expect(times.at(-1)!).toBeGreaterThan(4.4);
  expect(times.at(-1)!).toBeLessThanOrEqual(4.5);
  expect(new Set(cmd.keys.map((k) => k.easing))).toEqual(new Set(['easeInOut']));
});
