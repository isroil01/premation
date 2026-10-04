/**
 * Inserting a saved component goes through the engine (B3z WS-L1): the tree
 * is built off-document and lands as ONE pasteLayers entry with fresh ids,
 * optionally placed at a drop point. Undo is exact.
 */

import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import { docView } from '@core/engine/__testHelpers__/docView';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { useComponentStore, type ComponentDef } from './componentStore';
import { useSelectionStore } from './selectionStore';

let h: Harness;
let s: Scene;
beforeEach(async () => {
  h = await setupAppEngine();
  s = await buildScene(h);
  useComponentStore.setState({ components: [] });
});
afterEach(async () => {
  await h.dispose();
});

it('inserts an independent copy with fresh ids as one entry; undo is exact', async () => {
  const { layer: G } = await h.run({ type: 'groupLayers', layers: [s.A, s.B], name: 'Card' });
  useSelectionStore.getState().set([G]);
  const defId = (await useComponentStore.getState().saveFromSelection('Card'))!;
  const doc = (await h.doc());
  const newId = await useComponentStore.getState().insert(defId, { x: 300, y: 200 });
  expect(newId).toBeTruthy();
  expect(newId).not.toBe(G);
  expect((await docView()).getNode(newId!)!.parent).toBe('comp_root');
  expect((await docView()).getChildren(newId!)).toHaveLength(2);
  expect(useSelectionStore.getState().ids).toEqual([newId]);
  expect((await historyLabels()).at(-1)).toBe('Insert Card');
  const t = (await docView()).getNode(newId!)!.components.find((c) => c.type === 'Transform')!.props as Record<string, number>;
  expect([Math.round(t.x!), Math.round(t.y!)]).toEqual([300, 200]);
  await h.run({ type: 'undo' });
  expect((await h.doc())).toEqual(doc);
});

it('a multi-layer component lands grouped under its name, placed at the comp centre, one entry', async () => {
  useSelectionStore.getState().set([s.A, s.B]);
  const defId = (await useComponentStore.getState().saveFromSelection('Pair'))!;
  const n = (await historyLabels()).length;
  const root = await useComponentStore.getState().insert(defId);
  expect(root).toBeTruthy();
  expect((await historyLabels()).slice(n)).toEqual(['Insert Pair']);
  expect((await docView()).getNode(root!)!.name).toBe('Pair');
  expect((await docView()).getChildren(root!)).toHaveLength(2);
  expect(useSelectionStore.getState().ids).toEqual([root]);
});

it('a legacy (tree) component inserts from its tree and is migrated to a fragment', async () => {
  const legacy: ComponentDef = {
    id: 'def_old', name: 'Old', createdAt: 1,
    root: {
      name: 'Old',
      transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
      components: [{ id: 't', type: 'Transform', props: { __kind: 'shape', x: 0, y: 0, width: 40, height: 40 } }] as never,
      children: [],
    },
  };
  useComponentStore.setState({ components: [legacy] });
  const root = await useComponentStore.getState().insert('def_old');
  expect(root).toBeTruthy();
  const def = useComponentStore.getState().components[0]!;
  expect(def.root).toBeUndefined();
  expect(def.fragment?.data).toContain(root!);
  // …and inserts from the fragment from now on.
  const again = await useComponentStore.getState().insert('def_old');
  expect(again).toBeTruthy();
  expect(again).not.toBe(root);
});
