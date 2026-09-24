/**
 * Layer ▸ Create ▸ Create Nulls From Path Points through the engine API: the
 * nulls are built off-document and land as ONE `pasteLayers` INTO the shape,
 * selected; undo removes them all.
 *
 * (Create Shapes from Text needs glyph outlines — a font file or a canvas
 * raster — which jsdom has neither of; its build is the same
 * `insertBuiltLayers` path.)
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import { engineIdle } from '@core/engine/engineInstance';
import { insertBuiltLayers } from '@core/engine/offDocument';
import { apiParentOf, graph as docGraph, layerKindOf } from '@core/engine/doc';
import { useSelectionStore } from '@stores/selectionStore';
import { nullsFromPathEdit } from './layerCreateEdits';

let h: Harness;

beforeEach(async () => {
  h = await setupAppEngine();
});

afterEach(async () => {
  await h.dispose();
});

/** A three-vertex path shape, inserted through the engine (a pasted fragment). */
async function addTriangle(): Promise<string> {
  const ids = await insertBuiltLayers('Fixture', 'comp_root', () => {
    defaultSceneGraph.addChild('comp_root', {
      id: 'tri', name: 'Tri', parent: 'comp_root', children: [], visible: true, locked: false,
      transform: { position: { x: 300, y: 200 }, rotation: 0, scale: { x: 1, y: 1 } },
      components: [
        { id: 'tri_t', type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 300, y: 200, rotation: 0, shapeType: 'path' } },
        { id: 'tri_g', type: 'Geometry', props: { points: [
          { x: 0, y: -50, inX: 0, inY: -50, outX: 0, outY: -50 },
          { x: 50, y: 50, inX: 50, inY: 50, outX: 50, outY: 50 },
          { x: -50, y: 50, inX: -50, inY: 50, outX: -50, outY: 50 },
        ] } },
      ],
    } as unknown as SceneNode);
  });
  await engineIdle();
  return ids![0]!;
}

describe('Create Nulls From Path Points', () => {
  it('lands a null per vertex inside the shape as ONE entry; undo removes them', async () => {
    const shape = await addTriangle();
    const before = h.doc();
    const entries = historyLabels().length;

    const made = await nullsFromPathEdit(shape, 0);
    await engineIdle();

    expect(made).toHaveLength(3);
    for (const id of made) {
      expect(apiParentOf(id)).toBe(shape);
      expect(layerKindOf(docGraph.getNode(id)!)).toBe('null');
    }
    expect([...useSelectionStore.getState().ids].sort()).toEqual([...made].sort());
    expect(historyLabels().slice(entries)).toEqual(['Create Nulls From Path Points']);

    await h.run({ type: 'undo' });
    await engineIdle();
    expect(h.doc()).toBe(before);
  });

  it('makes nothing, and no entry, for a layer with no path points', async () => {
    const { layer } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name: 'Solid', init: [] });
    await engineIdle();
    const entries = historyLabels().length;
    expect(await nullsFromPathEdit(layer, 0)).toEqual([]);
    expect(historyLabels()).toHaveLength(entries);
  });
});
