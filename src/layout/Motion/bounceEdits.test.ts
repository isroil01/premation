/**
 * Bounce through the engine: the generator runs off-document and lands as
 * setKeyframes — ONE undo entry, undone exactly, on both a still layer (the
 * fall is generated) and an animated one (rebounds appended).
 */

import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { defaultAnimation } from '@motion/animation';
import { useBounceStore } from '@stores/bounceStore';
import { bounceEdit } from './bounceEdits';

let h: Harness & { engine: LocalEngine };
let s: Scene;
beforeEach(async () => {
  h = await setupAppEngine();
  s = await buildScene(h);
});
afterEach(async () => { await h.dispose(); });

async function oneEntry(act: () => Promise<unknown>): Promise<void> {
  const before = h.doc();
  const n = historyLabels().length;
  await act();
  await engineIdle();
  const after = h.doc();
  expect(after).not.toBe(before);
  expect(historyLabels().slice(n)).toEqual(['Bounce']);
  await h.run({ type: 'undo' });
  expect(h.doc()).toBe(before);
  await h.run({ type: 'redo' });
  expect(h.doc()).toBe(after);
}

it('drops a still layer in, as one entry', async () => {
  await oneEntry(async () => {
    const r = await bounceEdit(s.A, { atTime: 0, mode: 'drop', drop: useBounceStore.getState().drop, bounce: useBounceStore.getState().bounce });
    expect(r).not.toBeNull();
  });
  expect(defaultAnimation.isAnimated(s.A, 'y')).toBe(true);
});

it('appends rebounds to existing motion, as one entry', async () => {
  // B carries two Position keys (buildScene).
  const keysBefore = defaultAnimation.getTrackKeyframes(s.B, 'y')?.length ?? 0;
  await oneEntry(async () => {
    const r = await bounceEdit(s.B, { atTime: 0, mode: 'append', bounce: useBounceStore.getState().bounce });
    expect(r).not.toBeNull();
  });
  expect(defaultAnimation.getTrackKeyframes(s.B, 'y')!.length).toBeGreaterThan(keysBefore);
});
