/**
 * `mirrorMographFields` (B4): an inserted motion-graphics element's blanks read
 * from the document mirror equal the ones the scene-graph walk derives
 * (`readMographFields`) — over the REAL catalog, since nothing declares a
 * per-item manifest and a drifting walk would silently drop every item's
 * fields at once.
 */

import { usePreferenceStore } from '@stores/preferenceStore';
import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { documentMirror } from '@stores/documentMirror';
import { MOGRAPH_ITEMS } from '@core/library/mographLibrary';
import { insertMographItem } from '@core/library/mographInsertLegacy';
import { readMographFields, findMographRoot } from '@core/library/mographParams';
import type { TemplateField } from '@core/template/templateTypes';
import {
  mirrorMographFieldValue, mirrorMographFields, mirrorMographRoot, mographPartIds, mographWatchKeys,
} from './mographFields';

let h: Harness;
beforeEach(async () => {
  usePreferenceStore.getState().set('editorReduceMotion', true);
  h = await setupAppEngine();
});
afterEach(async () => { await h.dispose(); });

/** Insert an item and load every part's tree into the mirror. */
async function inserted(id: string): Promise<string> {
  const root = insertMographItem(id)!;
  expect(root).toBeTruthy();
  await engineIdle();
  const m = documentMirror();
  for (const p of mographPartIds(m, root)) m.tree(p);
  await engineIdle();
  return root;
}

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * A field with its colour default normalised to #rrggbb, so '#FFF' and
 * '#ffffff' compare equal. A catalog `rgba(…)` fill is left out of the
 * comparison: the TS engine's `layer/fill` reads it as white (the B4-gap the
 * section keeps a stored read for — MographParamsSection `currentValue`).
 */
function normalised(f: TemplateField, legacy: TemplateField | undefined): unknown {
  const hex = (s: string): string => {
    const x = s.trim().toLowerCase().replace(/^#/, '');
    const full = x.length === 3 || x.length === 4 ? [...x].map((c) => c + c).join('') : x;
    return `#${full.length === 8 && full.endsWith('ff') ? full.slice(0, 6) : full}`;
  };
  const { componentType: _unused, ...target } = f.target;
  if (f.kind !== 'color') return { ...f, target };
  const comparable = HEX.test(String(legacy?.default ?? '').trim());
  return { ...f, target, default: comparable ? hex(String(f.default)) : 'css' };
}

describe('the mirror derives the same blanks as the scene walk', () => {
  it.each(MOGRAPH_ITEMS.map((i) => [i.id] as const))('%s', async (id) => {
    const root = await inserted(id);
    const m = documentMirror();
    expect(m.layer(root)?.mographId).toBe(id);
    const legacy = readMographFields(root);
    const byId = new Map(legacy.map((f) => [f.id, f]));
    expect(mirrorMographFields(m, root).map((f) => normalised(f, byId.get(f.id))))
      .toEqual(legacy.map((f) => normalised(f, f)));
  });
});

it('finds the element from a child selection, and nothing from an unrelated layer', async () => {
  const root = await inserted('mg-lower-line');
  const m = documentMirror();
  const [child] = mographPartIds(m, root);
  expect(child).toBeTruthy();
  expect(mirrorMographRoot(m, child!)).toBe(root);
  expect(mirrorMographRoot(m, child!)).toBe(findMographRoot(child!));
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
