/**
 * Authored template fields (label / input id / removal) through the engine:
 * each is ONE undo entry of `setCompositionSettings.templateFields`, read back
 * where the editor reads it, and undone exactly.
 */

import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import { engineIdle } from '@core/engine/engineInstance';
import { documentMirror } from '@stores/documentMirror';
import { readAuthoredFields } from '@core/template/templateAuthoring';
import { activeCompIdNow } from '@hooks/useMirror';
import {
  mirrorAuthoredFields, removeAuthoredFieldEdit, renameAuthoredFieldEdit, renameAuthoredFieldIdEdit, withFieldId,
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
  const before = h.doc();
  const n = historyLabels().length;
  expect(await act()).toBe(true);
  await engineIdle();
  expect(historyLabels().slice(n)).toEqual([label]);
  await h.run({ type: 'undo' });
  expect(h.doc()).toBe(before);
  await h.run({ type: 'redo' });
  await documentMirror().whenIdle();
}

test('rename, change the input id, remove — each one entry, stored on the comp', async () => {
  expect(mirrorAuthoredFields(comp).map((f) => f.id)).toEqual(['title', 'accent']);
  await oneEntry('Rename Template Field', () => renameAuthoredFieldEdit('title', 'Headline'));
  expect(readAuthoredFields(comp)[0]?.label).toBe('Headline');
  await oneEntry('Change Template Input Id', () => renameAuthoredFieldIdEdit('title', 'headline'));
  expect(readAuthoredFields(comp)[0]?.id).toBe('headline');
  await oneEntry('Remove Template Field', () => removeAuthoredFieldEdit('accent'));
  expect(readAuthoredFields(comp).map((f) => f.id)).toEqual(['headline']);
});

test('a rejected input id sends nothing', async () => {
  const n = historyLabels().length;
  expect(await renameAuthoredFieldIdEdit('title', 'accent')).toBe(false);
  expect(await renameAuthoredFieldIdEdit('title', 'Not A Slug')).toBe(false);
  expect(historyLabels().length).toBe(n);
  expect(withFieldId(FIELDS as never, 'title', ' headline ')?.[0]?.id).toBe('headline');
});
