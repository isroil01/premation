/**
 * Bounce through the engine: the generator runs off-document and lands as
 * setKeyframes — ONE undo entry, undone exactly, on both a still layer (the
 * fall is generated) and an animated one (rebounds appended).
 */

import { setupAppEngine, historyLabels, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import { engineIdle } from '@core/engine/engineInstance';
import { useBounceStore } from '@stores/bounceStore';
import { bounceEdit } from './bounceEdits';

let h: Harness;
let s: Scene;
beforeEach(async () => {
  h = await setupAppEngine();
  s = await buildScene(h);
});
afterEach(async () => { await h.dispose(); });

async function oneEntry(act: () => Promise<unknown>): Promise<void> {
  const before = await h.doc();
  const n = (await historyLabels()).length;
  await act();
  await engineIdle();
  const after = await h.doc();
  expect(after).not.toBe(before);
  expect((await historyLabels()).slice(n)).toEqual(['Bounce']);
  await h.run({ type: 'undo' });
  expect(await h.doc()).toBe(before);
  await h.run({ type: 'redo' });
  expect(await h.doc()).toBe(after);
}

/** The keys a layer's Position Y member stores (the engine's member records). */
async function yKeys(layer: string): Promise<number> {
  const r = await h.query({ type: 'getMemberKeyframes', layer, members: ['y'] });
  return r.tracks.find((t) => t.member === 'y')?.keyframes.length ?? 0;
}

it('drops a still layer in, as one entry', async () => {
  await oneEntry(async () => {
    const r = await bounceEdit(s.A, { atTime: 0, mode: 'drop', drop: useBounceStore.getState().drop, bounce: useBounceStore.getState().bounce });
    expect(r).not.toBeNull();
  });
  expect(await yKeys(s.A)).toBeGreaterThan(0);
});

it('appends rebounds to existing motion, as one entry', async () => {
  // B carries two Position keys (buildScene).
  const keysBefore = await yKeys(s.B);
  await oneEntry(async () => {
    const r = await bounceEdit(s.B, { atTime: 0, mode: 'append', bounce: useBounceStore.getState().bounce });
    expect(r).not.toBeNull();
  });
  expect(await yKeys(s.B)).toBeGreaterThan(keysBefore);
});
