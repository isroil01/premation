/**
 * Inserting a saved component goes through the engine (B3z WS-L1): the tree
 * is built off-document and lands as ONE pasteLayers entry with fresh ids,
 * optionally placed at a drop point. Undo is exact.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { useComponentStore } from './componentStore';
import { useSelectionStore } from './selectionStore';

let h: Harness & { engine: LocalEngine };
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
  const defId = useComponentStore.getState().saveFromSelection('Card')!;
  const doc = h.doc();
  const newId = await useComponentStore.getState().insert(defId, { x: 300, y: 200 });
  expect(newId).toBeTruthy();
  expect(newId).not.toBe(G);
  expect(defaultSceneGraph.getNode(newId!)!.parent).toBe('comp_root');
  expect(defaultSceneGraph.getChildren(newId!)).toHaveLength(2);
  expect(useSelectionStore.getState().ids).toEqual([newId]);
  expect(historyLabels().at(-1)).toBe('Insert Card');
  const t = defaultSceneGraph.getNode(newId!)!.components.find((c) => c.type === 'Transform')!.props as Record<string, number>;
  expect([Math.round(t.x!), Math.round(t.y!)]).toEqual([300, 200]);
  await h.run({ type: 'undo' });
  expect(h.doc()).toEqual(doc);
});
