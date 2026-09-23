/**
 * One regression test per defect ENGINE_API.md §2.5 lists that B2 fixes —
 * through the API AND at the underlying seam the pre-API UI still uses.
 */

import { defaultAnimation, AnimationEngine } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { sceneProjectIO } from '@core/scene/sceneProjectIO';
import { toggleLayerFlag } from '@core/scene/layerFlags';
import { cloneLayerNode } from '@core/scene/cloneLayerNode';
import { captureLayerSnapshot, restoreLayerSnapshot } from '@core/scene/layerSnapshot';
import { captureAnimEdit, AnimEditCommand } from '@core/animation/animationCommands';
import { readAnimatorData, removeTextAnimator, addTextAnimator, removeSelector, addSelector } from '@core/text/textAnimators';
import { captureDocument, restoreDocument } from '@core/api/cloudDocument';
import { useAssetStore } from '@stores/assetStore';
import { useSelectionStore } from '@stores/selectionStore';
import { copySelection, pasteSelection, clearClipboard } from '@core/commands/clipboard';
import { useKeyframeSelectionStore } from '@stores/keyframeSelectionStore';
import { useProjectStore } from '@stores/projectStore';
import { setupEngine, sec, docDiff, type Harness } from '../__testHelpers__/harness';
import { buildScene } from '../__testHelpers__/scene';

jest.useFakeTimers();

let h: Harness;
beforeEach(async () => { h = await setupEngine(); });
afterEach(async () => { await h.dispose(); });

describe('§2.5 #1 shy survives load and snapshot undo', () => {
  test('the node view stores shy on the engine node; a capture → restore round trip keeps it', async () => {
    const s = await buildScene(h);
    expect(toggleLayerFlag(s.A, 'shy', true)).toBe(true);
    const file = sceneProjectIO.capture();
    sceneProjectIO.restore(structuredClone(file));
    expect(defaultSceneGraph.getNode(s.A)!.shy).toBe(true);
  });
  test('through the API: switch → save → open keeps shy; undo clears it', async () => {
    const s = await buildScene(h);
    await h.run({ type: 'setLayerSwitches', layers: [s.A], patch: { shy: true } });
    await h.run({ type: 'saveProject', path: 'C:/p/shy.motion', copy: false });
    await h.run({ type: 'newProject' });
    await h.run({ type: 'openProject', path: 'C:/p/shy.motion' });
    const l = await h.query({ type: 'getLayers', layers: [s.A] });
    expect(l.layers[0]!.switches.shy).toBe(true);
    await h.run({ type: 'setLayerSwitches', layers: [s.A], patch: { shy: false } });
    await h.run({ type: 'undo' });
    expect((await h.query({ type: 'getLayers', layers: [s.A] })).layers[0]!.switches.shy).toBe(true);
  });
});

describe('§2.5 #2 stack order goes through setChildOrder', () => {
  test('a clone lands directly above its original, and a snapshot restore at its index', async () => {
    const s = await buildScene(h);
    expect(cloneLayerNode(s.B, 'b_copy')).toBe(true);
    const order = defaultSceneGraph.getChildOrder(s.comp);
    expect(order.indexOf('b_copy')).toBe(order.indexOf(s.B) + 1);
    const snap = captureLayerSnapshot(s.T);
    const at = order.indexOf(s.T);
    defaultSceneGraph.removeNode(s.T);
    restoreLayerSnapshot(snap);
    expect(defaultSceneGraph.getChildOrder(s.comp).indexOf(s.T)).toBe(at);
  });
  test('the switches of a restored layer come back too', async () => {
    const s = await buildScene(h);
    const n = defaultSceneGraph.getNode(s.A)!;
    n.solo = true;
    n.shy = true;
    n.color = '#5282b8';
    const snap = captureLayerSnapshot(s.A);
    defaultSceneGraph.removeNode(s.A);
    restoreLayerSnapshot(snap);
    const r = defaultSceneGraph.getNode(s.A)!;
    expect([r.solo, r.shy, r.color]).toEqual([true, true, '#5282b8']);
  });
});

describe('§2.5 #3 no silently lost writes', () => {
  test('a pasted layer is offset by +20/+20 with rotation and scale intact (written before insertion)', async () => {
    const s = await buildScene(h);
    const t = defaultSceneGraph.getNode(s.A)!.components.find((c) => c.type === 'Transform')!;
    defaultSceneGraph.writeProp(s.A, t.id, 'rotation', 33);
    defaultSceneGraph.writeProp(s.A, t.id, 'scaleX', 2);
    const x0 = t.props.x as number;
    const y0 = t.props.y as number;
    clearClipboard();
    useKeyframeSelectionStore.getState().set(new Set());
    useSelectionStore.getState().set([s.A]);
    const tab = useProjectStore.getState().tabs[useProjectStore.getState().activeTabId ?? ''];
    if (tab) expect(tab.compositionId).toBeTruthy();
    copySelection();
    const before = new Set(defaultSceneGraph.getChildOrder(s.comp));
    expect(await pasteSelection()).toBe('layers');
    const pasted = defaultSceneGraph.getChildOrder(s.comp).find((id) => !before.has(id))!;
    const pt = defaultSceneGraph.getNode(pasted)!.components.find((c) => c.type === 'Transform')!.props;
    expect([pt.x, pt.y, pt.rotation, pt.scaleX]).toEqual([x0 + 20, y0 + 20, 33, 2]);
  });
});

describe('§2.5 #4 keyframe ids are stable', () => {
  test('moving a key through the API keeps its id; undo restores the same id', async () => {
    const s = await buildScene(h);
    const id = s.posKeys[1]!;
    await h.run({ type: 'moveKeyframes', ids: [id], delta: sec(2) });
    const keys = (await h.query({ type: 'getKeyframes', props: [{ layer: s.B, path: 'transform/position' }] })).sets[0]!.keyframes;
    expect(keys.find((k) => k.id === id)!.time).toBe(sec(3));
    await h.run({ type: 'updateKeyframes', patches: [{ id, time: sec(4), spatialIn: [], spatialOut: [] }] });
    await h.run({ type: 'undo' });
    await h.run({ type: 'undo' });
    const back = (await h.query({ type: 'getKeyframes', props: [{ layer: s.B, path: 'transform/position' }] })).sets[0]!.keyframes;
    expect(back.map((k) => [k.id, k.time])).toEqual([[s.posKeys[0], 0], [id, sec(1)]]);
  });
  test('the TS engine carries ids through every retiming mutator', () => {
    const e = new AnimationEngine();
    e.setKeyframes('n', 'x', [{ id: 'k9', t: 1, value: 1 }]);
    e.moveKeyframe('n', 'x', 1, 2);
    e.updateKeyframe('n', 'x', 2, { t: 3, value: 5 });
    e.setKeyframe('n', 'x', 3, 7);
    e.setRoving('n', 'x', 3, false);
    expect(e.getTrackKeyframes('n', 'x')![0]!.id).toBe('k9');
  });
});

describe('§2.5 #5 kfEqual sees every keyframe field', () => {
  test.each([
    ['continuous', (e: AnimationEngine) => e.updateKeyframe('n', 'x', 0, { continuous: true })],
    ['roving', (e: AnimationEngine) => e.updateKeyframe('n', 'x', 0, { roving: true })],
    ['spatialInterp', (e: AnimationEngine) => e.setSpatialInterp('n', 'x', 0, 'linear')],
  ])('a %s-only edit records an undoable command', (_name, edit) => {
    const e = new AnimationEngine();
    e.setKeyframes('n', 'x', [{ t: 0, value: 0 }, { t: 1, value: 1 }]);
    const cmd = captureAnimEdit('Edit', () => edit(e), { engine: e });
    expect(cmd).not.toBeNull();
    cmd!.undo();
    expect(e.getTrackKeyframes('n', 'x')![0]).toEqual({ t: 0, value: 0 });
  });
});

describe('§2.5 #6 merged data-track drags redo to the LAST step', () => {
  test('mergeFrom adopts the newer dataAfter', () => {
    const e = new AnimationEngine();
    e.setDataKeyframe('n', 'text.source', 'text', 0, 'a');
    const c1 = captureAnimEdit('Type', () => e.setDataKeyframe('n', 'text.source', 'text', 0, 'ab'), { engine: e, mergeKey: 'k' })!;
    const c2 = captureAnimEdit('Type', () => e.setDataKeyframe('n', 'text.source', 'text', 0, 'abc'), { engine: e, mergeKey: 'k' })!;
    expect(c1).toBeInstanceOf(AnimEditCommand);
    c1.mergeFrom(c2);
    c1.undo();
    expect(e.sampleData('n', 'text.source', 0)).toBe('a');
    c1.execute();
    expect(e.sampleData('n', 'text.source', 0)).toBe('abc');
  });
});

describe('§2.5 #7 mask-shape keyframe edits are undoable', () => {
  test('through the API: keying and moving a mask shape undoes exactly', async () => {
    const s = await buildScene(h);
    const prop = { layer: s.A, path: `masks/${s.mask}/path` };
    const before = h.doc();
    await h.run({ type: 'setAnimated', prop, animated: true, time: 0 });
    const { keyframe } = await h.run({ type: 'setProperty', prop, time: sec(1), value: { kind: 'path', value: { vertices: [0, 0, 50, 0, 50, 50], inTangents: [], outTangents: [], closed: true, featherPoints: [] } } });
    await h.run({ type: 'moveKeyframes', ids: [keyframe!], delta: sec(1) });
    const keys = (await h.query({ type: 'getKeyframes', props: [prop] })).sets[0]!.keyframes;
    expect(keys.map((k) => k.time)).toEqual([0, sec(2)]);
    await h.run({ type: 'undo' });
    await h.run({ type: 'undo' });
    await h.run({ type: 'undo' });
    expect(docDiff(before, h.doc())).toEqual([]);
  });
});

describe('§2.5 #8 text animator tracks follow their animator, not an index', () => {
  test('removing animator 0 drops ITS keyframes; animator 1 keeps its own', async () => {
    const s = await buildScene(h);
    addTextAnimator(s.T);
    defaultAnimation.setKeyframes(s.T, 'ta.0.opacity', [{ t: 0, value: 10 }]);
    defaultAnimation.setKeyframes(s.T, 'ta.1.opacity', [{ t: 0, value: 90 }]);
    const second = readAnimatorData(defaultSceneGraph.getNode(s.T)!)[1]!.id;
    removeTextAnimator(s.T, 0);
    expect(readAnimatorData(defaultSceneGraph.getNode(s.T)!).map((a) => a.id)).toEqual([second]);
    expect(defaultAnimation.getTrackKeyframes(s.T, 'ta.0.opacity')![0]!.value).toBe(90);
    expect(defaultAnimation.getTrackKeyframes(s.T, 'ta.1.opacity')).toBeNull();
  });
  test('removing a selector shifts later selectors\' tracks down', async () => {
    const s = await buildScene(h);
    addSelector(s.T, 0, 'range');
    addSelector(s.T, 0, 'range');
    defaultAnimation.setKeyframes(s.T, 'ta.0.s1.amount', [{ t: 0, value: 1 }]);
    defaultAnimation.setKeyframes(s.T, 'ta.0.s2.amount', [{ t: 0, value: 2 }]);
    removeSelector(s.T, 0, 1);
    expect(defaultAnimation.getTrackKeyframes(s.T, 'ta.0.s1.amount')![0]!.value).toBe(2);
    expect(defaultAnimation.getTrackKeyframes(s.T, 'ta.0.s2.amount')).toBeNull();
  });
  test('through the API: animators are addressed by id across a remove', async () => {
    const s = await buildScene(h);
    const { groups: [p2] } = await h.run({ type: 'addPropertyGroup', layer: s.T, parent: 'text/animators', matchName: 'ADBE Text Animator', init: [] });
    const a2 = p2!.split('/')[2]!;
    await h.run({ type: 'setAnimated', prop: { layer: s.T, path: `text/animators/${a2}/props/opacity` }, animated: true, time: 0 });
    await h.run({ type: 'removePropertyGroups', groups: [{ layer: s.T, path: `text/animators/${s.animator}` }] });
    const k = await h.query({ type: 'getKeyframes', props: [{ layer: s.T, path: `text/animators/${a2}/props/opacity` }] });
    expect(k.sets[0]!.keyframes).toHaveLength(1);
  });
});

describe('§2.5 #9 / #13 composition settings and work area are undoable', () => {
  test('setCompositionSettings and setWorkArea each undo exactly', async () => {
    const s = await buildScene(h);
    const d0 = h.doc();
    await h.run({ type: 'setCompositionSettings', comp: s.comp, patch: { width: 640, frameRate: { num: 24, den: 1 } } });
    await h.run({ type: 'setWorkArea', comp: s.comp, range: { start: 0, duration: sec(2) } });
    await h.run({ type: 'undo' });
    await h.run({ type: 'undo' });
    expect(docDiff(d0, h.doc())).toEqual([]);
  });
});

describe('§2.5 #12 folders and interpretation live in the document', () => {
  test('captureDocument carries them; restoreDocument applies them over the machine cache', async () => {
    const s = await buildScene(h);
    await h.run({ type: 'moveItems', items: [s.footage], folder: s.folder });
    await h.run({ type: 'setInterpretation', items: [s.footage], patch: { pixelAspect: 2 } });
    const doc = captureDocument();
    expect(doc.projectItems!.folders.map((f) => f.id)).toEqual([s.folder]);
    expect(doc.projectItems!.footage[s.footage]).toMatchObject({ folderId: s.folder, interpret: { par: 2 } });
    // Another machine: same asset, no folder, different cached interpretation.
    useAssetStore.setState((st) => {
      st.folders = [];
      st.assets = st.assets.map((a) => (a.id === s.footage ? { ...a, folderId: null, interpret: { par: 1 } } : a));
    });
    restoreDocument(structuredClone(doc));
    const a = useAssetStore.getState().assets.find((x) => x.id === s.footage)!;
    expect(a.folderId).toBe(s.folder);
    expect(a.interpret?.par).toBe(2);
    expect(useAssetStore.getState().folders.map((f) => f.id)).toEqual([s.folder]);
  });
});
