/**
 * Off-document builders (offDocument.ts): a legacy layer builder runs on a
 * scratch state, the document is restored exactly, and the new layers arrive
 * as ONE pasteLayers entry.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { insertShape, insertText } from '@core/scene/sceneInsert';
import { useSelectionStore } from '@stores/selectionStore';
import { setupAppEngine, historyLabels } from '../__testHelpers__/appEngine';
import { buildScene } from '../__testHelpers__/scene';
import type { Harness } from '../__testHelpers__/harness';
import type { LocalEngine } from '../LocalEngine';
import { buildLayerFragment, insertBuiltLayers, offDocument, OffDocumentError } from '../offDocument';
import { layerIdsOfComp } from '../doc';

let h: Harness & { engine: LocalEngine };

beforeEach(async () => {
  h = await setupAppEngine();
  await buildScene(h);
});
afterEach(async () => {
  await h.dispose();
});

describe('offDocument', () => {
  it('restores the document exactly and records nothing', () => {
    const doc = h.doc();
    const entries = historyLabels().length;
    const frag = buildLayerFragment('comp_root', () => insertShape('rect', 'Box'));
    expect(frag).not.toBeNull();
    expect(h.doc()).toEqual(doc);
    expect(historyLabels().length).toBe(entries);
  });

  it('inserts the built layers as one pasteLayers entry; undo is exact', async () => {
    const doc = h.doc();
    const before = layerIdsOfComp('comp_root');
    const ids = await insertBuiltLayers('Insert Text', 'comp_root', () => insertText('Hello'));
    expect(ids).not.toBeNull();
    expect(ids!.length).toBeGreaterThan(0);
    expect(historyLabels().at(-1)).toBe('Insert Text');
    const after = layerIdsOfComp('comp_root');
    expect(after.length).toBe(before.length + ids!.length);
    expect(defaultSceneGraph.getNode(ids![0]!)?.name).toBe('Hello');
    expect(useSelectionStore.getState().ids).toEqual([ids![0]]);
    await h.run({ type: 'undo' });
    expect(h.doc()).toEqual(doc);
    await h.run({ type: 'redo' });
    expect(layerIdsOfComp('comp_root').length).toBe(after.length);
  });

  it('keeps the builder stack position', async () => {
    const stack = layerIdsOfComp('comp_root');
    useSelectionStore.getState().set([stack[2]!]);
    const frag = buildLayerFragment('comp_root', () => insertShape('ellipse', 'E'));
    const ids = await insertBuiltLayers('Insert', 'comp_root', () => insertShape('ellipse', 'E'));
    const now = layerIdsOfComp('comp_root');
    expect(now.indexOf(ids![0]!)).toBe(frag!.index);
  });

  it('refuses a builder that changes existing layers, and still restores', () => {
    const doc = h.doc();
    const victim = layerIdsOfComp('comp_root')[0]!;
    expect(() => buildLayerFragment('comp_root', () => {
      insertShape('rect', 'Box');
      const n = defaultSceneGraph.getNode(victim)!;
      defaultSceneGraph.setParent(n.id, n.parent!);
      n.components[0]!.props.__touched = 1;
      defaultSceneGraph.writeProp(n.id, n.components[0]!.id, '__touched', 2);
    })).toThrow(OffDocumentError);
    expect(h.doc()).toEqual(doc);
  });

  it('refuses an async builder', () => {
    expect(() => offDocument(() => Promise.resolve(1), () => 0)).toThrow(/synchronous/);
  });
});
