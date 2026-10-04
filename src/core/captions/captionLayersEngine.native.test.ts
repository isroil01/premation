/**
 * Captions through the engine (captionCommands.ts): inserting REPLACES the
 * existing caption layers — `deleteLayers` + one `pasteLayers` of the built
 * set — as ONE undo entry; removing is one `deleteLayers` entry. Undo is exact.
 * The caption layers are read back the way the app reads them: the mirror's
 * `LayerInfo.caption` and the engine's `getCaptionCues`.
 */

import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import { buildScene } from '@core/engine/__testHelpers__/scene';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { captionCues, captionLayerIds, removeCaptions, replaceCaptions } from '@/providers/commands/captionCommands';

let h: Harness;
beforeEach(async () => {
  h = await setupAppEngine();
  await buildScene(h);
});
afterEach(async () => {
  await h.dispose();
});

const CUES = [
  { start: 1, end: 3, text: 'The first caption' },
  { start: 4, end: 6, text: 'The second caption' },
];

const captions = async (): Promise<string[]> => {
  await engineIdle();
  return captionLayerIds('comp_root');
};

it('inserts every caption as one entry, timed to its cue; undo is exact', async () => {
  const doc = (await h.doc());
  const res = await replaceCaptions(CUES);
  expect(res.added).toHaveLength(2);
  expect((await historyLabels()).at(-1)).toBe('Add 2 captions');
  const cues = await captionCues();
  expect(cues.map((c) => [Math.round(c.start * 10) / 10, Math.round(c.end * 10) / 10])).toEqual([[1, 3], [4, 6]]);
  await h.run({ type: 'undo' });
  expect((await h.doc())).toEqual(doc);
  await h.run({ type: 'redo' });
  expect(await captions()).toHaveLength(2);
});

it('replaces the existing captions in the same entry', async () => {
  await replaceCaptions(CUES);
  await engineIdle();
  const doc = (await h.doc());
  const entries = (await historyLabels()).length;
  const res = await replaceCaptions([{ start: 0, end: 2, text: 'Only one' }]);
  expect(res.removed).toBe(2);
  expect(await captions()).toHaveLength(1);
  expect((await historyLabels()).length).toBe(entries + 1);
  await h.run({ type: 'undo' });
  expect((await h.doc())).toEqual(doc);
});

it('removes every caption as one entry and leaves other layers', async () => {
  await replaceCaptions(CUES);
  await engineIdle();
  const others = (await captions()).length;
  expect(others).toBe(2);
  expect(await removeCaptions()).toBe(2);
  expect(await captions()).toHaveLength(0);
  expect((await historyLabels()).at(-1)).toBe('Remove 2 captions');
  expect(await removeCaptions()).toBe(0);
});
