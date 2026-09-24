/**
 * B3, layers area: the Layers panel's own edits (tree drag, rename, delete,
 * switch column, audio, time verbs, the Compositions list) are engine
 * commands — ONE undo entry per user action, undone exactly (the canonical
 * document before === after undo) and redone.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getNodeLayerTime } from '@core/scene/layerTime';
import { readNodeMotionBlur } from '@core/effects/motionBlur';
import { useProjectStore } from '@stores/projectStore';
import { useSelectionStore } from '@stores/selectionStore';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import {
  deleteCompositionEdit,
  deleteLayersEdit,
  duplicateCompositionEdit,
  freezeLayersEdit,
  moveLayersInTreeEdit,
  renameCompositionEdit,
  renameLayerEdit,
  reverseLayersEdit,
} from './sceneEdits';
import { toggleAudioAnchoredEdit, toggleLayerFlagsEdit } from './layerSwitchEdits';

jest.useFakeTimers();

let h: Harness & { engine: LocalEngine };
let s: Scene;
beforeEach(async () => {
  h = await setupAppEngine();
  s = await buildScene(h);
  useSelectionStore.getState().set([]);
});
afterEach(async () => { await h.dispose(); });

const node = (id: string) => defaultSceneGraph.getNode(id);

/** `action` adds exactly one entry labelled `label`; undo restores the document exactly; redo reapplies it. */
async function roundTrip(action: () => Promise<unknown>, label: string): Promise<void> {
  const before = h.doc();
  const n = historyLabels().length;
  await action();
  const after = h.doc();
  expect(after).not.toBe(before);
  expect(historyLabels().length).toBe(n + 1);
  expect(historyLabels().at(-1)).toBe(label);
  await h.run({ type: 'undo' });
  expect(h.doc()).toBe(before);
  await h.run({ type: 'redo' });
  expect(h.doc()).toBe(after);
}

describe('tree drag', () => {
  test('INSIDE a row parents the whole selection to it — one entry', async () => {
    await roundTrip(() => moveLayersInTreeEdit([s.A, s.B], s.P, 'inside'), 'Move 2 layers');
    expect(node(s.A)?.parent).toBe(s.P);
    expect(node(s.B)?.parent).toBe(s.P);
  });

  test('BEFORE a row in another branch re-parents then orders next to it — one entry', async () => {
    await h.run({ type: 'setParent', layers: [s.T], parent: s.P, keepWorldTransform: true });
    // Display "before" = in front of T among P's children.
    await roundTrip(() => moveLayersInTreeEdit([s.A], s.T, 'before'), 'Move layer');
    const kids = defaultSceneGraph.getChildOrder(s.P);
    expect(kids.indexOf(s.A)).toBe(kids.indexOf(s.T) + 1);
  });

  test('reorders among siblings', async () => {
    const kids = defaultSceneGraph.getChildOrder(s.comp);
    const back = kids[0]!;
    const front = kids[kids.length - 1]!;
    await roundTrip(() => moveLayersInTreeEdit([back], front, 'before'), 'Move layer');
    expect(defaultSceneGraph.getChildOrder(s.comp).at(-1)).toBe(back);
  });

  test('dropped below the last row: out to the composition', async () => {
    await h.run({ type: 'setParent', layers: [s.A], parent: s.P, keepWorldTransform: true });
    await roundTrip(() => moveLayersInTreeEdit([s.A], null, 'after'), 'Move layer');
    expect(node(s.A)?.parent).toBe(s.comp);
  });

  test('a drop that moves nothing records nothing', async () => {
    const n = historyLabels().length;
    await moveLayersInTreeEdit([s.A], s.comp, 'inside');
    expect(historyLabels().length).toBe(n);
  });
});

describe('rename', () => {
  test('no expression names it: the engine rename, one entry', async () => {
    await roundTrip(() => renameLayerEdit(s.A, 'Hero'), 'Rename “A” to “Hero”');
    expect(node(s.A)?.name).toBe('Hero');
  });

  test('an expression names it: the legacy rename repairs the reference', async () => {
    await h.run({ type: 'setExpression', prop: { layer: s.B, path: 'transform/opacity' }, source: "thisComp.layer('A').transform.opacity", enabled: true });
    const res = await renameLayerEdit(s.A, 'Hero');
    expect(res.repaired).toHaveLength(1);
    expect(node(s.A)?.name).toBe('Hero');
  });
});

describe('delete', () => {
  test('skips locked layers; one entry', async () => {
    await h.run({ type: 'setLayerSwitches', layers: [s.B], patch: { locked: true } });
    await roundTrip(() => deleteLayersEdit([s.A, s.B]), 'Delete layer');
    expect(node(s.A)).toBeUndefined();
    expect(node(s.B)).toBeDefined();
  });

  test('a group takes its members with it', async () => {
    const { layer: group } = await h.run({ type: 'groupLayers', layers: [s.A, s.B], name: 'G' });
    await roundTrip(() => deleteLayersEdit([group]), 'Delete layer');
    expect(node(group)).toBeUndefined();
    expect(node(s.A)).toBeUndefined();
    expect(node(s.B)).toBeUndefined();
  });
});

describe('switch column', () => {
  test('a flag over a selection, anchored, one entry', async () => {
    await roundTrip(() => toggleLayerFlagsEdit([s.A, s.B], 'motionBlur', s.A), 'Enable Motion Blur (2 layers)');
    expect(readNodeMotionBlur(node(s.A)!)).toBe(true);
    expect(readNodeMotionBlur(node(s.B)!)).toBe(true);
  });

  test('the speaker mutes the anchored set', async () => {
    useSelectionStore.getState().set([s.V]);
    await roundTrip(() => toggleAudioAnchoredEdit(s.V, () => true), 'Mute layer audio');
  });
});

describe('time verbs', () => {
  test('Time-Reverse reverses the set, one entry', async () => {
    await roundTrip(() => reverseLayersEdit([s.V]), 'Time-Reverse Layer');
    expect(getNodeLayerTime(s.V).reverse).toBe(true);
  });

  test('Freeze Frame, one entry; un-freeze is the legacy fallback', async () => {
    await roundTrip(() => freezeLayersEdit([s.V], 1), 'Freeze Frame');
    expect(getNodeLayerTime(s.V).freeze).toBe(true);
    expect(await freezeLayersEdit([s.V], 1)).toBe(false);
  });
});

describe('compositions', () => {
  test('rename renames the record and the root together', async () => {
    await roundTrip(() => renameCompositionEdit(s.comp2, 'Titles'), 'Rename Composition');
    expect(useProjectStore.getState().comps[s.comp2]?.name).toBe('Titles');
    expect(node(s.comp2)?.name).toBe('Titles');
  });

  test('duplicate is "<name> copy", one entry', async () => {
    let id: string | null = null;
    await roundTrip(async () => { id = await duplicateCompositionEdit(s.comp2); }, 'Duplicate Composition');
    expect(useProjectStore.getState().comps[id!]?.name).toBe('C2 copy');
  });

  test('delete removes the comp, one entry, undoable', async () => {
    await roundTrip(() => deleteCompositionEdit(s.comp2), 'Delete Composition');
    expect(useProjectStore.getState().comps[s.comp2]).toBeUndefined();
  });

  test('deleting the LAST composition leaves the pristine placeholder, one entry, undoable', async () => {
    await deleteCompositionEdit(s.comp2);
    const only = Object.keys(useProjectStore.getState().comps);
    expect(only).toHaveLength(1);
    await roundTrip(() => deleteCompositionEdit(only[0]!), 'Delete Composition');
    const comps = Object.values(useProjectStore.getState().comps);
    expect(comps).toHaveLength(1);
    expect(comps[0]).toMatchObject({ name: 'Composition 1', pristine: true });
    expect(comps[0]!.id).not.toBe(only[0]);
  });
});
