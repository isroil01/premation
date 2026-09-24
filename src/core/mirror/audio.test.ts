/**
 * The audio readers over the document mirror (B4) against the scene readers
 * they replace — on the app's engine, so the mirror is fed by real events.
 */

import { act } from '@testing-library/react';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import { sec, type Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { documentMirror } from '@stores/documentMirror';
import { readAudioClipTimings } from '@core/audio/audioScene';
import { planFadeKeys, staticLevelDbOf } from '@core/audio/audioFades';
import { readDucking } from '@core/audio/ducking';
import { readGate } from '@core/audio/audioGate';
import { defaultAudioDriver, driverRange, readAudioDrivers } from '@core/audio/audioDriver';
import { audioVoices, pairedAudioNodeIds } from '@core/audio/silenceRemoval';
import {
  audioClipTimings,
  audioDriversOf,
  driverRangeOf,
  duckingOf,
  gateOf,
  hasOwnBar,
  pairedSoundLayers,
  planFadeKeysIn,
  soundLayers,
  staticLevelDb,
} from './audio';

let h: Harness & { engine: LocalEngine };
let s: Scene;
beforeEach(async () => {
  h = await setupAppEngine();
  s = await buildScene(h);
  await act(async () => { await engineIdle(); });
});
afterEach(async () => { await h.dispose(); });

const idle = async (): Promise<void> => { await act(async () => { await engineIdle(); }); };
const json = (v: unknown) => ({ kind: 'json' as const, value: JSON.stringify(v) });

test('the static level, the bar and a fade read as the scene readers read them', async () => {
  const m = documentMirror();
  expect(staticLevelDb(m, s.V)).toBe(staticLevelDbOf(s.V));
  await h.run({ type: 'setProperty', prop: { layer: s.V, path: 'audio/levels' }, value: { kind: 'scalar', value: -8 } });
  await h.run({ type: 'setLayerTiming', items: [{ layer: s.V, inPoint: sec(1), outPoint: sec(4), startTime: sec(0.5) }] });
  await idle();
  expect(staticLevelDb(m, s.V)).toBe(-8);
  expect(staticLevelDb(m, s.V)).toBe(staticLevelDbOf(s.V));
  const legacy = readAudioClipTimings(s.V).map(({ startSec, inSec, outSec }) => ({ startSec, inSec, outSec }));
  const mirror = audioClipTimings(m, s.V).map(({ startSec, inSec, outSec }) => ({ startSec, inSec, outSec }));
  expect(mirror).toHaveLength(1);
  expect(mirror[0]!.startSec).toBeCloseTo(legacy[0]!.startSec, 9);
  expect(mirror[0]!.inSec).toBeCloseTo(legacy[0]!.inSec, 9);
  expect(mirror[0]!.outSec).toBeCloseTo(legacy[0]!.outSec, 9);
  for (const side of ['in', 'out'] as const) {
    const a = planFadeKeys(s.V, side, 1);
    const b = planFadeKeysIn(m, s.V, side, 1, (t) => t);
    expect(b).toHaveLength(a.length);
    b.forEach((k, i) => {
      expect(k.seconds).toBeCloseTo(a[i]!.seconds, 9);
      expect(k.value).toBe(a[i]!.value);
    });
  }
});

test('a plain group’s member has no bar of its own (as the timeline gives it none)', async () => {
  const { layer: g } = await h.run({ type: 'createLayer', comp: s.comp, kind: 'group', name: 'G', init: [] });
  const { layer: child } = await h.run({ type: 'createLayer', comp: s.comp, kind: 'null', name: 'child', parent: g, init: [] });
  await idle();
  const m = documentMirror();
  expect(hasOwnBar(m, child)).toBe(readAudioClipTimings(child).length > 0);
  expect(hasOwnBar(m, g)).toBe(true);
  expect(hasOwnBar(m, s.V)).toBe(true);
});

test('the remembered records normalise exactly as the node readers do', async () => {
  const drivers = { opacity: { ...defaultAudioDriver('opacity'), band: 'low', min: 10 }, scale: { band: 'nonsense', curve: 'wobble' } };
  const ducking = { voiceNodeId: s.V, duckDb: -12, attackMs: 'soon' };
  const gate = { thresholdDb: -50 };
  await h.run({ type: 'setProperty', prop: { layer: s.V, path: 'audio/drivers' }, value: json(drivers) });
  await h.run({ type: 'setProperty', prop: { layer: s.V, path: 'audio/ducking' }, value: json(ducking) });
  await h.run({ type: 'setProperty', prop: { layer: s.V, path: 'audio/gate' }, value: json(gate) });
  await idle();
  const m = documentMirror();
  const node = defaultSceneGraph.getNode(s.V)!;
  expect(audioDriversOf(m, s.V)).toEqual(readAudioDrivers(node));
  expect(duckingOf(m, s.V)).toEqual(readDucking(node));
  expect(gateOf(m, s.V)).toEqual(readGate(node));
  expect(duckingOf(m, s.A)).toBeNull();
  expect(audioDriversOf(m, s.A)).toEqual({});
});

test('layers with sound, the paired set and the bake range', async () => {
  const { layer: V2 } = await h.run({ type: 'createLayer', comp: s.comp, kind: 'video', name: 'V2', source: s.footage, init: [] });
  await idle();
  const m = documentMirror();
  expect(soundLayers(m).map((l) => l.id).sort()).toEqual(audioVoices().map((v) => v.nodeId).sort());
  expect(pairedSoundLayers(m, s.V).sort()).toEqual(pairedAudioNodeIds(s.V).sort());
  expect(pairedSoundLayers(m, V2)).toContain(s.V);
  expect(pairedSoundLayers(m, s.A)).toEqual(pairedAudioNodeIds(s.A));
  const legacy = driverRange();
  const mirror = driverRangeOf(m.comp(s.comp)?.settings);
  expect(mirror.fps).toBeCloseTo(legacy.fps, 9);
  expect(mirror.start).toBeCloseTo(legacy.start, 9);
  expect(mirror.end).toBeCloseTo(legacy.end, 9);
});
