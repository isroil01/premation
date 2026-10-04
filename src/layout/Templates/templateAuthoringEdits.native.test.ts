/**
 * Authored template fields (label / input id / removal) through the engine:
 * each is ONE undo entry of `setCompositionSettings.templateFields`, read back
 * where the editor reads it, and undone exactly.
 */

import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { documentMirror } from '@stores/documentMirror';
import { activeCompIdNow } from '@hooks/useMirror';
import {
  exposeLayerAsFieldEdit, mirrorAuthoredFields, removeAuthoredFieldEdit, renameAuthoredFieldEdit, renameAuthoredFieldIdEdit, withFieldId,
} from './templateAuthoringEdits';

const FIELDS = [
  { id: 'title', label: 'Title', kind: 'text', group: 'Text', default: 'Hi', target: { nodeId: 'x', componentType: 'Text', prop: 'content' } },
  { id: 'accent', label: 'Accent', kind: 'color', group: 'Colours', default: '#fff', target: { nodeId: 'y', componentType: 'Style', prop: 'fill' } },
];

let h: Harness;
let comp: string;
beforeEach(async () => {
  h = await setupAppEngine();
  documentMirror().start();
  comp = activeCompIdNow()!;
  await h.run({ type: 'setCompositionSettings', comp, patch: { templateFields: JSON.stringify(FIELDS) } });
  await documentMirror().whenIdle();
});
afterEach(async () => { await h.dispose(); });

async function oneEntry(label: string, act: () => Promise<boolean>): Promise<void> {
  const before = (await h.doc());
  const n = (await historyLabels()).length;
  expect(await act()).toBe(true);
  await engineIdle();
  expect((await historyLabels()).slice(n)).toEqual([label]);
  await h.run({ type: 'undo' });
  expect((await h.doc())).toBe(before);
  await h.run({ type: 'redo' });
  await documentMirror().whenIdle();
}

test('rename, change the input id, remove — each one entry, stored on the comp', async () => {
  expect(mirrorAuthoredFields(comp).map((f) => f.id)).toEqual(['title', 'accent']);
  await oneEntry('Rename Template Field', () => renameAuthoredFieldEdit('title', 'Headline'));
  expect(mirrorAuthoredFields(comp)[0]?.label).toBe('Headline');
  await oneEntry('Change Template Input Id', () => renameAuthoredFieldIdEdit('title', 'headline'));
  expect(mirrorAuthoredFields(comp)[0]?.id).toBe('headline');
  await oneEntry('Remove Template Field', () => removeAuthoredFieldEdit('accent'));
  expect(mirrorAuthoredFields(comp).map((f) => f.id)).toEqual(['headline']);
});

test('a rejected input id sends nothing', async () => {
  const n = (await historyLabels()).length;
  expect(await renameAuthoredFieldIdEdit('title', 'accent')).toBe(false);
  expect(await renameAuthoredFieldIdEdit('title', 'Not A Slug')).toBe(false);
  expect((await historyLabels()).length).toBe(n);
  expect(withFieldId(FIELDS as never, 'title', ' headline ')?.[0]?.id).toBe('headline');
});

test('Expose as field (B4 round 5): a media slot declared through the engine, one entry, the id kept on re-expose', async () => {
  const { items: [clip] } = await h.run({ type: 'importFiles', files: [{ path: 'C:/m/clip.mp4', asSequence: false, createComposition: false }] });
  const { layer } = await h.run({ type: 'createLayer', comp, kind: 'video', name: 'Hero Clip', source: clip, init: [] });
  await documentMirror().whenIdle();
  const n = (await historyLabels()).length;
  const field = await exposeLayerAsFieldEdit(layer!, 0);
  await engineIdle();
  expect((await historyLabels()).slice(n)).toEqual(['Expose Template Field']);
  expect(field).toMatchObject({ id: 'heroClip', kind: 'media', fit: 'contain', target: { nodeId: layer, componentType: 'Transform', prop: 'src' } });
  expect(field!.default).toBe(documentMirror().item(clip!)?.mediaUrl);
  await documentMirror().whenIdle();
  expect(mirrorAuthoredFields(comp).map((f) => f.id)).toEqual(['title', 'accent', 'heroClip']);
  const tree = await h.query({ type: 'getPropertyTree', layer: layer!, path: 'layer/slotFit', depth: 1 });
  expect(tree.nodes[0]!.value).toEqual({ kind: 'choice', value: 'contain' });
  const w = await h.query({ type: 'getPropertyTree', layer: layer!, path: 'layer/slotWidth', depth: 1 });
  expect((w.nodes[0]!.value as { value: number }).value).toBeGreaterThan(0);
  // Re-exposing the same target keeps its id (no duplicate).
  const again = await exposeLayerAsFieldEdit(layer!, 0);
  await documentMirror().whenIdle();
  expect(again!.id).toBe('heroClip');
  expect(mirrorAuthoredFields(comp).filter((f) => f.target.nodeId === layer)).toHaveLength(1);
});
