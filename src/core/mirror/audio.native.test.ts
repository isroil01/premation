/**
 * The audio readers over the document mirror (B4) — on the app's engine, so
 * the mirror is fed by real events: levels, bars, fades, the remembered
 * driver / ducking / gate records (against the stored record), sound layers.
 */

import { act } from '@testing-library/react';
import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import { docView } from '@core/engine/__testHelpers__/docView';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import { sec, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { documentMirror } from '@stores/documentMirror';
import { readDucking } from '@core/audio/ducking';
import { readGate } from '@core/audio/audioGate';
import { defaultAudioDriver, readAudioDrivers } from '@core/audio/audioDriver';
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

let h: Harness;
let s: Scene;
beforeEach(async () => {
  h = await setupAppEngine();
  s = await buildScene(h);
  await act(async () => { await engineIdle(); });
});
afterEach(async () => { await h.dispose(); });

const idle = async (): Promise<void> => { await act(async () => { await engineIdle(); }); };
const json = (v: unknown) => ({ kind: 'json' as const, value: JSON.stringify(v) });

test('the static level, the bar and a fade', async () => {
  const m = documentMirror();
  await m.loadTree(s.V);
  expect(staticLevelDb(m, s.V)).toBe(0);
  await h.run({ type: 'setProperty', prop: { layer: s.V, path: 'audio/levels' }, value: { kind: 'scalar', value: -8 } });
  await h.run({ type: 'setLayerTiming', items: [{ layer: s.V, inPoint: sec(1), outPoint: sec(4), startTime: sec(0.5) }] });
  await idle();
  await m.whenIdle();
  expect(staticLevelDb(m, s.V)).toBe(-8);
  // The bar starts at 1 s in the comp and plays the source from 0.5 s (the clip starts at 0.5 s).
  expect(audioClipTimings(m, s.V).map(({ startSec, inSec, outSec }) => ({ startSec, inSec, outSec }))).toEqual([{ startSec: 1, inSec: 0.5, outSec: 3.5 }]);
  // A one-second fade from / to silence (-60 dB) at the bar's ends, to the static level.
  expect(planFadeKeysIn(m, s.V, 'in', 1, (t) => t)).toEqual([{ seconds: 1, value: -60 }, { seconds: 2, value: -8 }]);
  expect(planFadeKeysIn(m, s.V, 'out', 1, (t) => t)).toEqual([{ seconds: 3, value: -8 }, { seconds: 4, value: -60 }]);
});

test('a plain group’s member has no bar of its own (as the timeline gives it none)', async () => {
  const { layer: g } = await h.run({ type: 'createLayer', comp: s.comp, kind: 'group', name: 'G', init: [] });
  const { layer: child } = await h.run({ type: 'createLayer', comp: s.comp, kind: 'null', name: 'child', parent: g, init: [] });
  await idle();
  const m = documentMirror();
  expect(hasOwnBar(m, child)).toBe(false);
  expect(hasOwnBar(m, g)).toBe(true);
  expect(hasOwnBar(m, s.V)).toBe(true);
});

test('the remembered records normalise exactly as the stored record reads', async () => {
  const drivers = { opacity: { ...defaultAudioDriver('opacity'), band: 'low', min: 10 }, scale: { band: 'nonsense', curve: 'wobble' } };
  const ducking = { voiceNodeId: s.V, duckDb: -12, attackMs: 'soon' };
  const gate = { thresholdDb: -50 };
  await h.run({ type: 'setProperty', prop: { layer: s.V, path: 'audio/drivers' }, value: json(drivers) });
  await h.run({ type: 'setProperty', prop: { layer: s.V, path: 'audio/ducking' }, value: json(ducking) });
  await h.run({ type: 'setProperty', prop: { layer: s.V, path: 'audio/gate' }, value: json(gate) });
  await idle();
  const m = documentMirror();
  for (const id of [s.V, s.A]) await m.loadTree(id);
  await m.whenIdle();
  const node = (await docView()).getNode(s.V)! as never;
  expect(audioDriversOf(m, s.V)).toEqual(readAudioDrivers(node));
  expect(Object.keys(audioDriversOf(m, s.V)).sort()).toEqual(['opacity', 'scale']);
  expect(duckingOf(m, s.V)).toEqual(readDucking(node));
  expect(duckingOf(m, s.V)).toMatchObject({ voiceNodeId: s.V, duckDb: -12 });
  expect(gateOf(m, s.V)).toEqual(readGate(node));
  expect(duckingOf(m, s.A)).toBeNull();
  expect(audioDriversOf(m, s.A)).toEqual({});
});

test('layers with sound, the paired set and the bake range', async () => {
  const { layer: V2 } = await h.run({ type: 'createLayer', comp: s.comp, kind: 'video', name: 'V2', source: s.footage, init: [] });
  await idle();
  const m = documentMirror();
  // The two layers of the same footage: both have sound, and each pairs with the other.
  expect(soundLayers(m).map((l) => l.id).sort()).toEqual([s.V, V2].sort());
  expect(pairedSoundLayers(m, s.V).sort()).toEqual([s.V, V2].sort());
  expect(pairedSoundLayers(m, V2)).toContain(s.V);
  expect(pairedSoundLayers(m, s.A)).toEqual([s.A]);
  // The bake range is the work area (buildScene: 1 s – 4 s), on the comp's 30 fps.
  expect(driverRangeOf(m.comp(s.comp)?.settings)).toEqual({ start: 1, end: 4, fps: 30 });
});
