/**
 * Edit ▸ Cut / Copy / Paste of layers through the engine API: Copy captures a
 * `copyLayers` fragment, Paste is ONE `pasteLayers` entry (the copy renamed
 * "<name> copy" and nudged +20 px, as the legacy clipboard did), undo takes it
 * back whole; Cut is Copy + the Delete command.
 */

import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import { engineIdle } from '@core/engine/engineInstance';
import { graph as docGraph, layerIdsOfComp } from '@core/engine/doc';
import { catalogFor, readStatic } from '@core/engine/props';
import { values } from '@core/engine/propRefs';
import { useSelectionStore } from '@stores/selectionStore';
import { useKeyframeSelectionStore } from '@stores/keyframeSelectionStore';
import { clearHeldClipboard, copyEdit, cutEdit, pasteEdit } from './clipboardEdits';

let h: Harness;

beforeEach(async () => {
  h = await setupAppEngine();
  clearHeldClipboard();
  useSelectionStore.getState().clear();
  useKeyframeSelectionStore.getState().set(new Set());
});

afterEach(async () => {
  clearHeldClipboard();
  await h.dispose();
});

async function addShape(name: string, x: number, y: number): Promise<string> {
  const { layer } = await h.run({
    type: 'createLayer', comp: 'comp_root', kind: 'shape', name,
    init: [{ path: 'transform/position', value: values.vec2(x, y) }],
  });
  await engineIdle();
  return layer;
}

const position = (id: string): unknown => {
  const v = readStatic(id, catalogFor(id).byPath.get('transform/position')!);
  return v.kind === 'vec2' ? v.value : v;
};

describe('Copy → Paste of layers', () => {
  it('pastes ONE entry: a renamed, nudged copy on top, selected — and undo removes it', async () => {
    const a = await addShape('Box', 100, 50);
    useSelectionStore.getState().set([a]);
    expect(await copyEdit()).toBe('layers');

    const before = h.doc();
    const layersBefore = layerIdsOfComp('comp_root');
    expect(await pasteEdit()).toBe('layers');
    await engineIdle();

    const added = layerIdsOfComp('comp_root').filter((id) => !layersBefore.includes(id));
    expect(added).toHaveLength(1);
    const copy = added[0]!;
    expect(docGraph.getNode(copy)?.name).toBe('Box copy');
    expect(position(copy)).toEqual({ x: 120, y: 70 });
    // The original is untouched, and the copy is what is selected.
    expect(position(a)).toEqual({ x: 100, y: 50 });
    expect(useSelectionStore.getState().ids).toEqual([copy]);
    expect(historyLabels().slice(-1)).toEqual(['Paste']);

    await h.run({ type: 'undo' });
    await engineIdle();
    expect(h.doc()).toBe(before);
  });

  it('pastes what Copy captured, even after the original is renamed', async () => {
    const a = await addShape('Box', 0, 0);
    useSelectionStore.getState().set([a]);
    await copyEdit();
    await h.run({ type: 'renameLayer', layer: a, name: 'Renamed' });
    await engineIdle();

    await pasteEdit();
    await engineIdle();
    const names = layerIdsOfComp('comp_root').map((id) => docGraph.getNode(id)?.name);
    expect(names).toContain('Box copy');
  });

  it('has nothing to paste before a Copy', async () => {
    await addShape('Box', 0, 0);
    const entries = historyLabels().length;
    // No app clipboard; jsdom has no OS clipboard either.
    expect(await pasteEdit()).toBeNull();
    expect(historyLabels()).toHaveLength(entries);
  });
});

describe('Cut of layers', () => {
  it('copies, then deletes the originals; Paste brings a copy back', async () => {
    const a = await addShape('Box', 10, 10);
    useSelectionStore.getState().set([a]);
    expect(await cutEdit()).toBe('layers');
    await engineIdle();
    expect(layerIdsOfComp('comp_root')).not.toContain(a);

    await pasteEdit();
    await engineIdle();
    const names = layerIdsOfComp('comp_root').map((id) => docGraph.getNode(id)?.name);
    expect(names).toContain('Box copy');
  });
});
