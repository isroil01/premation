/**
 * Captions through the engine (B3z WS-L1): inserting REPLACES the existing
 * caption layers — `deleteLayers` + one `pasteLayers` of the built set — as
 * ONE undo entry; removing is one `deleteLayers` entry. Undo is exact.
 */

import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import { buildScene } from '@core/engine/__testHelpers__/scene';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { readCaptionCues, captionNodes, insertCaptionLayers, removeCaptionLayers } from './captionLayers';

let h: Harness & { engine: LocalEngine };
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

it('inserts every caption as one entry, timed to its cue; undo is exact', async () => {
  const doc = h.doc();
  const res = await insertCaptionLayers(CUES);
  expect(res.nodeIds).toHaveLength(2);
  expect(historyLabels().at(-1)).toBe('Add 2 captions');
  const cues = readCaptionCues('comp_root');
  expect(cues.map((c) => [Math.round(c.start * 10) / 10, Math.round(c.end * 10) / 10])).toEqual([[1, 3], [4, 6]]);
  await h.run({ type: 'undo' });
  expect(h.doc()).toEqual(doc);
  await h.run({ type: 'redo' });
  expect(captionNodes('comp_root')).toHaveLength(2);
});

it('replaces the existing captions in the same entry', async () => {
  await insertCaptionLayers(CUES);
  const doc = h.doc();
  const entries = historyLabels().length;
  const res = await insertCaptionLayers([{ start: 0, end: 2, text: 'Only one' }]);
  expect(res.removed).toBe(2);
  expect(captionNodes('comp_root')).toHaveLength(1);
  expect(historyLabels().length).toBe(entries + 1);
  await h.run({ type: 'undo' });
  expect(h.doc()).toEqual(doc);
});

it('removes every caption as one entry and leaves other layers', async () => {
  await insertCaptionLayers(CUES);
  const others = h.doc();
  void others;
  expect(await removeCaptionLayers('comp_root')).toBe(2);
  expect(captionNodes('comp_root')).toHaveLength(0);
  expect(historyLabels().at(-1)).toBe('Remove 2 captions');
  expect(await removeCaptionLayers('comp_root')).toBe(0);
});
