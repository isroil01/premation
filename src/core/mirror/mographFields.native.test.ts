/**
 * `mirrorMographFields` (B4): an inserted motion-graphics element's blanks,
 * read from the document mirror — over the REAL catalog, since nothing
 * declares a per-item manifest and a drifting walk would silently drop every
 * item's fields at once: every static text part is a blank, each targets a
 * part of the element, and each reads back what the item was authored with.
 */

import { usePreferenceStore } from '@stores/preferenceStore';
import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { documentMirror } from '@stores/documentMirror';
import { MOGRAPH_ITEMS } from '@core/library/mographLibrary';
import { buildMographFragment } from '@core/library/mographLibrary';
import { insertFragment } from '@/engine-client/insertFragment';
import { docView } from '@core/engine/__testHelpers__/docView';
import {
  mirrorMographFieldValue, mirrorMographFields, mirrorMographRoot, mographPartIds, mographWatchKeys,
} from './mographFields';

let h: Harness;
beforeEach(async () => {
  usePreferenceStore.getState().set('editorReduceMotion', true);
  h = await setupAppEngine();
});
afterEach(async () => { await h.dispose(); });

/** Insert an item as the Library does (one pasteLayers) and load every part's tree into the mirror. */
async function inserted(id: string): Promise<string> {
  const ids = await insertFragment(`Insert ${id}`, (b, f) => buildMographFragment(b, f, id, 0), { comp: 'comp_root' });
  const root = ids?.[0];
  expect(root).toBeTruthy();
  await engineIdle();
  const m = documentMirror();
  for (const p of mographPartIds(m, root!)) await m.loadTree(p);
  await engineIdle();
  return root!;
}

describe('every catalog element exposes its blanks from the mirror', () => {
  it.each(MOGRAPH_ITEMS.map((i) => [i.id] as const))('%s', async (id) => {
    const root = await inserted(id);
    const m = documentMirror();
    expect(m.layer(root)?.mographId).toBe(id);
    const fields = mirrorMographFields(m, root);
    const parts = new Set(mographPartIds(m, root));
    // Every field targets a part of THIS element, and no two share an id.
    for (const f of fields) expect(parts.has(f.target.nodeId) || f.target.nodeId === root).toBe(true);
    expect(new Set(fields.map((f) => f.id)).size).toBe(fields.length);
    // A text blank reads back its default (what the item was authored with).
    for (const f of fields.filter((x) => x.kind === 'text')) expect(mirrorMographFieldValue(m, f, 0)).toBe(f.default);
    // Every static text part of the stored element is a blank (a keyed text source is the animation, not a field).
    const v = await docView();
    const textParts = [...parts].filter((p) => v.getNode(p)?.components.some((c) => c.type === 'Text') && !v.isDataAnimated(p, 'text.source'));
    expect(fields.filter((f) => f.kind === 'text').map((f) => f.target.nodeId).sort()).toEqual(textParts.sort());
  });
});

it('finds the element from a child selection, and nothing from an unrelated layer', async () => {
  const root = await inserted('mg-lower-line');
  const m = documentMirror();
  const [child] = mographPartIds(m, root);
  expect(child).toBeTruthy();
  expect(mirrorMographRoot(m, child!)).toBe(root);
  expect(mirrorMographRoot(m, null)).toBeNull();
  // The section watches the chain up to the root and each part's fields.
  const keys = mographWatchKeys(m, child!);
  expect(keys).toContain(`layer:${root}`);
  expect(keys).toContain(`value:${child}|layer/fill`);
});

it('reads a field back after its write lands', async () => {
  const root = await inserted('mg-lower-line');
  const m = documentMirror();
  const name = mirrorMographFields(m, root).find((f) => f.kind === 'text' && f.label === 'Name')!;
  expect(mirrorMographFieldValue(m, name, 0)).toBe('Name Surname');
  await h.run({
    type: 'setProperty',
    prop: { layer: name.target.nodeId, path: 'layer/fill' },
    value: { kind: 'color', value: { r: 1, g: 0, b: 0.4, a: 1 } },
  });
  await engineIdle();
  const colour = mirrorMographFields(m, root).find((f) => f.kind === 'color' && f.target.nodeId === name.target.nodeId);
  expect(colour && mirrorMographFieldValue(m, colour, 0)).toBe('#ff0066');
});
