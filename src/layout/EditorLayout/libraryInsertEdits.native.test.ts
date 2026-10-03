/**
 * The Library's Sound FX and Transitions (and the viewport drops that reuse
 * them) through the engine (B3): each user action is ONE undo entry, undo
 * restores the document exactly, redo reapplies.
 */

import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import { docView } from '@core/engine/__testHelpers__/docView';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { buildScene } from '@core/engine/__testHelpers__/scene';
import { engineIdle } from '@core/engine/engineInstance';
import { useAssetStore } from '@stores/assetStore';
import { useSelectionStore } from '@stores/selectionStore';
import { importPathsEdit } from '@layout/Assets/assetEdits';
import { insertSfxEdit } from './sfxInsertEdits';
import { applyTransitionEdit } from './transitionInsertEdits';
import { documentMirror } from '@stores/documentMirror';
import { readLayerFlag } from '@core/scene/layerFlags';

let h: Harness;
let scene: Awaited<ReturnType<typeof buildScene>>;

beforeEach(async () => {
  h = await setupAppEngine();
  scene = await buildScene(h);
});
afterEach(async () => {
  await h.dispose();
});

/** Run `act`, then pin: one new entry named `label`, undo === before, redo === after. */
async function oneEntry(label: string, act: () => Promise<unknown>): Promise<void> {
  const before = (await h.doc());
  const n = (await historyLabels()).length;
  await act();
  await engineIdle();
  const after = (await h.doc());
  expect(after).not.toBe(before);
  expect((await historyLabels()).length).toBe(n + 1);
  expect((await historyLabels()).at(-1)).toBe(label);
  await h.run({ type: 'undo' });
  expect((await h.doc())).toBe(before);
  await h.run({ type: 'redo' });
  expect((await h.doc())).toBe(after);
}

const audioAssetId = async (node: string): Promise<unknown> =>
  (await docView()).getNode(node)?.components.find((c) => c.type === 'Audio')?.props.__assetId;

describe('Sound FX', () => {
  it('places the item as an audio layer: one entry, the layer selected', async () => {
    // The project already holds the item (a previous insert imported it), so
    // the insert is the layer alone — exactly undoable.
    const { imported } = await importPathsEdit(['C:/sfx/UI Click.wav']);
    const item = imported[0]!;
    expect(item.type).toBe('audio');
    let layer: string | null = null;
    await oneEntry('Insert UI Click', async () => { layer = await insertSfxEdit('sfx-click'); });
    expect(layer).not.toBeNull();
    expect((await audioAssetId(layer!))).toBe(item.id);
    expect(useSelectionStore.getState().ids).toEqual([layer]);
    // No second item: the insert reused the project's.
    expect(useAssetStore.getState().assets.filter((a) => a.name === 'UI Click.wav')).toHaveLength(1);
  });

  it('an unknown item inserts nothing and records nothing', async () => {
    const n = (await historyLabels()).length;
    const before = (await h.doc());
    expect(await insertSfxEdit('sfx-nope')).toBeNull();
    await engineIdle();
    expect((await historyLabels()).length).toBe(n);
    expect((await h.doc())).toBe(before);
  });
});

describe('Transitions', () => {
  it('a solid-only item lands its panels as one entry, selected', async () => {
    useSelectionStore.getState().clear();
    let ids: string[] = [];
    await oneEntry('Apply Wipe Right', async () => {
      const r = await applyTransitionEdit('tr-wipe-right', 'Apply Wipe Right');
      expect(r?.mode).toBe('solid');
      ids = r?.nodeIds ?? [];
    });
    expect(ids).toHaveLength(1);
    expect(useSelectionStore.getState().ids).toEqual(ids);
  });

  it('a multi-panel item is still one entry', async () => {
    useSelectionStore.getState().clear();
    let ids: string[] = [];
    await oneEntry('Apply Venetian Bars', async () => {
      ids = (await applyTransitionEdit('tr-venetian', 'Apply Venetian Bars'))?.nodeIds ?? [];
    });
    expect(ids).toHaveLength(5);
  });

  it('layer mode keys the selected layer, adds its Blur effect: one entry, undone exactly', async () => {
    documentMirror().start();
    await documentMirror().whenIdle();
    useSelectionStore.getState().set([scene.T]);
    await oneEntry('Apply Blur Through', async () => {
      const r = await applyTransitionEdit('tr-blur-through', 'Apply Blur Through');
      expect(r?.mode).toBe('layer');
      expect(r?.nodeIds).toEqual([scene.T]);
    });
    const blur = (await docView()).getNodeEffects(scene.T).find((e) => e.type === 'blur');
    expect(blur).toBeDefined();
    const tree = await h.query({ type: 'getKeyframes', props: [{ layer: scene.T, path: `effects/${blur!.id}/amount` }] });
    expect(tree.sets[0]?.keyframes.length).toBe(2);
  });

  it('layer mode turns motion blur on when the recipe asks', async () => {
    documentMirror().start();
    await documentMirror().whenIdle();
    useSelectionStore.getState().set([scene.T]);
    await oneEntry('Apply Whip Pan', async () => {
      expect((await applyTransitionEdit('tr-whip-pan', 'Apply Whip Pan'))?.mode).toBe('layer');
    });
    expect(readLayerFlag((await docView()).getNode(scene.T)!, 'motionBlur')).toBe(true);
  });
});
