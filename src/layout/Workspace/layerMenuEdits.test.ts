/**
 * The viewport's right-click layer actions through the engine API (B3): one
 * undo entry each, the legacy helper's rules, exact undo / redo.
 */

import { defaultAnimation } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { reorderSiblings, type StackAction } from '@core/scene/parenting';
import { is3DEnabled } from '@core/scene/threeD';
import { getNodeLayerTime } from '@core/scene/layerTime';
import { LABEL_COLORS } from '@core/scene/labelColor';
import { engineIdle } from '@core/engine/engineInstance';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { useSelectionStore } from '@stores/selectionStore';
import {
  addKeyframesAtPlayheadEdit,
  arrangeLayersEdit,
  deleteSelectedLayersEdit,
  duplicateSelectedLayersEdit,
  freezeFrameEdit,
  groupSelectedLayersEdit,
  set3DEdit,
  setFrameBlendEdit,
  setLabelColorEdit,
  setStretchEdit,
  timeReverseEdit,
  ungroupSelectedEdit,
} from './layerMenuEdits';

let h: Harness & { engine: LocalEngine };
let s: Scene;
const COMP = 'comp_root';

beforeEach(async () => {
  h = await setupAppEngine();
  s = await buildScene(h);
  useSelectionStore.getState().clear();
});

afterEach(async () => {
  await h.dispose();
});

async function roundTrip(run: () => Promise<unknown>, label: string): Promise<void> {
  const before = h.doc();
  const entries = historyLabels().length;
  await run();
  await engineIdle();
  const after = h.doc();
  expect(after).not.toBe(before);
  expect(historyLabels().length).toBe(entries + 1);
  expect(historyLabels().at(-1)).toBe(label);
  await h.run({ type: 'undo' });
  expect(h.doc()).toBe(before);
  await h.run({ type: 'redo' });
  expect(h.doc()).toBe(after);
}

const node = (id: string) => defaultSceneGraph.getNode(id)!;
const x = (id: string): number => node(id).components.find((c) => c.type === 'Transform')!.props.x as number;

describe('delete', () => {
  it('skips locked layers, one entry, clears the selection', async () => {
    await h.run({ type: 'setLayerSwitches', layers: [s.P], patch: { locked: true } });
    useSelectionStore.getState().set([s.A, s.P]);
    await roundTrip(() => deleteSelectedLayersEdit(), 'Delete layer');
    expect(defaultSceneGraph.getNode(s.A)).toBeUndefined();
    expect(defaultSceneGraph.getNode(s.P)).toBeDefined();
  });
});

describe('duplicate', () => {
  it('"<name> copy", nudged +20 px when Position is static, selected — ONE entry', async () => {
    useSelectionStore.getState().set([s.A]);
    const ax = x(s.A);
    let copies: string[] = [];
    await roundTrip(async () => { copies = await duplicateSelectedLayersEdit(); }, 'Duplicate Layer');
    // (after redo the copy exists again with the same id)
    const copy = copies[0]!;
    expect(node(copy).name).toBe('A copy');
    expect(x(copy)).toBe(ax + 20);
    expect(useSelectionStore.getState().ids).toEqual([copy]);
  });

  it('an animated Position is not nudged (it would be a new key)', async () => {
    useSelectionStore.getState().set([s.B]);
    const [copy] = await duplicateSelectedLayersEdit();
    expect(defaultAnimation.getTrackKeyframes(copy!, 'x')).toHaveLength(2);
    expect(defaultAnimation.getTrackKeyframes(copy!, 'x')!.map((k) => k.value))
      .toEqual(defaultAnimation.getTrackKeyframes(s.B, 'x')!.map((k) => k.value));
  });
});

describe('arrange', () => {
  it.each<StackAction>(['front', 'forward', 'backward', 'back'])('%s: the sibling order reorderSiblings computes, one entry', async (action) => {
    const kids = defaultSceneGraph.getChildOrder(COMP);
    const ids = [s.T, s.P];
    const expected = reorderSiblings(kids, ids, action);
    const label = { front: 'Bring to Front', forward: 'Bring Forward', backward: 'Send Backward', back: 'Send to Back' }[action];
    if (expected.every((id, i) => id === kids[i])) {
      expect(await arrangeLayersEdit(ids, action)).toBe(false);
      return;
    }
    await roundTrip(() => arrangeLayersEdit(ids, action), label);
    expect(defaultSceneGraph.getChildOrder(COMP)).toEqual(expected);
  });

  it('a non-contiguous Bring Forward moves each layer one step', async () => {
    const kids = defaultSceneGraph.getChildOrder(COMP);
    const ids = [kids[0]!, kids[2]!];
    const expected = reorderSiblings(kids, ids, 'forward');
    await arrangeLayersEdit(ids, 'forward');
    expect(defaultSceneGraph.getChildOrder(COMP)).toEqual(expected);
  });
});

describe('group / ungroup', () => {
  it('groups siblings, selects the group; ungroup frees them — one entry each', async () => {
    useSelectionStore.getState().set([s.A, s.B]);
    await roundTrip(async () => { expect(await groupSelectedLayersEdit()).toBe(true); }, 'Group Layers');
    const group = useSelectionStore.getState().ids[0]!;
    expect(node(s.A).parent).toBe(group);
    await roundTrip(() => ungroupSelectedEdit(), 'Ungroup');
    expect(node(s.A).parent).toBe(COMP);
  });

  it('a selection across parents is left to the legacy grouping (false)', async () => {
    useSelectionStore.getState().set([s.A, s.c2layer]);
    expect(await groupSelectedLayersEdit()).toBe(false);
  });
});

describe('switches and keys', () => {
  it('label colour by palette index', async () => {
    const c = LABEL_COLORS[2]!.color;
    await roundTrip(async () => { expect(await setLabelColorEdit([s.A, s.B], c)).toBe(true); }, 'Label Color');
    expect(node(s.A).color).toBe(c);
    expect(await setLabelColorEdit([s.A], '#123456')).toBe(false);
  });

  it('3D: flips each layer that can be 3D', async () => {
    await roundTrip(() => set3DEdit([s.A]), 'Enable 3D Layer');
    expect(is3DEnabled(node(s.A))).toBe(true);
  });

  it('Add Keyframe ▸ Position: one key holding the current value', async () => {
    const before = x(s.A);
    await roundTrip(() => addKeyframesAtPlayheadEdit(s.A, 'Position', ['x', 'y'], 0.5), 'Add Position keyframe');
    expect(defaultAnimation.getTrackKeyframes(s.A, 'x')).toHaveLength(1);
    expect(defaultAnimation.getTrackKeyframes(s.A, 'x')![0]!.value).toBeCloseTo(before);
  });
});

describe('footage time', () => {
  it('speed keeps the reversal; reverse; freeze; frame blending — one entry each', async () => {
    await roundTrip(() => setStretchEdit(s.V, 200, false), 'Time Stretch');
    expect(getNodeLayerTime(s.V).stretch).toBe(200);
    await roundTrip(() => timeReverseEdit(s.V), 'Time-Reverse Layer');
    expect(getNodeLayerTime(s.V).reverse).toBe(true);
    await setStretchEdit(s.V, 50, true);
    expect(getNodeLayerTime(s.V).reverse).toBe(true);
    expect(getNodeLayerTime(s.V).stretch).toBe(50);
    await roundTrip(() => freezeFrameEdit(s.V, 1), 'Freeze Frame');
    expect(getNodeLayerTime(s.V).freeze).toBe(true);
    await roundTrip(() => setFrameBlendEdit(s.V, 'pixelMotion'), 'Frame Blending');
    expect(getNodeLayerTime(s.V).frameBlend).toBe('pixelMotion');
  });
});
