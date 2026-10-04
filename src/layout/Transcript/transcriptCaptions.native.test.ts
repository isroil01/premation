/**
 * Transcript ⇄ captions through the engine (B4 round 5): "Add as captions"
 * replaces the composition's caption layers (the mirror's `LayerInfo.caption`)
 * with ONE edit built off-document, and a transcript is rebuilt from the
 * captions the engine lists (`getCaptionCues`).
 */

import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { documentMirror } from '@stores/documentMirror';
import { useProjectStore } from '@stores/projectStore';
import { addTranscriptAsCaptions, transcriptFromCaptions } from './transcriptOps';
import { useTranscriptStore } from './transcriptStore';

const S = 705_600_000;

let h: Harness;
let comp: string;

beforeEach(async () => {
  h = await setupAppEngine();
  const r = await h.run({ type: 'createComposition', settings: { name: 'Talk', width: 1280, height: 720, frameRate: { num: 30, den: 1 }, duration: 20 * S }, fromItems: [] });
  comp = (r as { item: string }).item;
  const actions = useProjectStore.getState().actions;
  actions.setActiveTab(actions.openTab(comp, [comp], 'Talk'));
  useTranscriptStore.getState().setTranscript(comp, {
    words: [
      { id: 'w1', text: 'Hello', start: 1, end: 1.5, cueIndex: 0, estimated: false },
      { id: 'w2', text: 'world.', start: 1.5, end: 2, cueIndex: 0, estimated: false },
      { id: 'w3', text: 'Again.', start: 4, end: 5, cueIndex: 1, estimated: false },
    ],
    source: 'provider',
    range: { start: 0, end: 20 },
    edited: false,
  } as never);
  await documentMirror().whenIdle();
});
afterEach(async () => { await h.dispose(); });

function captionLayers(): string[] {
  const m = documentMirror();
  return (m.comp(comp)?.layers ?? []).filter((id) => m.layer(id)?.caption === true);
}

test('Add as captions: one entry, tagged layers; a second pass replaces them', async () => {
  const n = (await historyLabels()).length;
  expect(await addTranscriptAsCaptions(comp)).toBe(2);
  await engineIdle();
  await documentMirror().whenIdle();
  expect((await historyLabels()).slice(n)).toEqual(['Add 2 captions']);
  const first = captionLayers();
  expect(first).toHaveLength(2);

  expect(await addTranscriptAsCaptions(comp)).toBe(2);
  await engineIdle();
  await documentMirror().whenIdle();
  const second = captionLayers();
  expect(second).toHaveLength(2);
  expect(second.some((id) => first.includes(id))).toBe(false);
});

test('a transcript rebuilt from the captions the engine lists', async () => {
  await addTranscriptAsCaptions(comp);
  await engineIdle();
  const t = await transcriptFromCaptions(comp);
  expect(t).not.toBeNull();
  expect(t!.source).toBe('captions');
  expect(t!.words.map((w) => w.text).join(' ')).toBe('Hello world. Again.');
  expect(t!.range.start).toBeCloseTo(1, 3);
});
