/**
 * The replay corpus (ENGINE_API.md §12): scripted editing sessions covering
 * every command family — gestures, undo/redo interleaving, precompose, split,
 * ripple, effects, masks, text, 3D, markers, comps, items. Each is recorded,
 * serialized as JSON lines, and replayed into a FRESH engine; the replay must
 * reproduce every revision and document hash, the final saved project JSON
 * byte for byte, and the undo stack.
 */

import { LocalEngine } from '../LocalEngine';
import { replayLog, logToJsonl, logFromJsonl } from '../replay';
import { setupEngine, sec, fakePorts, docDiff, type Harness } from '../__testHelpers__/harness';
import { buildScene } from '../__testHelpers__/scene';

jest.useFakeTimers();

type Session = (h: Harness) => Promise<void>;

const v2 = (x: number, y: number) => ({ kind: 'vec2' as const, value: { x, y } });
const v3 = (x: number, y: number, z: number) => ({ kind: 'vec3' as const, value: { x, y, z } });
const scalar = (value: number) => ({ kind: 'scalar' as const, value });

export const CORPUS: Record<string, Session> = {
  'layers, parenting, groups, reorder, undo/redo interleaved': async (h) => {
    const s = await buildScene(h);
    await h.run({ type: 'renameLayer', layer: s.A, name: 'Hero' });
    await h.run({ type: 'setParent', layers: [s.B], parent: s.P, keepWorldTransform: true });
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
    const { layer: g } = await h.run({ type: 'groupLayers', layers: [s.A, s.T], name: 'Titles' });
    await h.run({ type: 'duplicateLayers', layers: [s.V] });
    await h.run({ type: 'reorderLayers', comp: s.comp, layers: [s.P], toIndex: 0 });
    await h.run({ type: 'undo' });
    await h.run({ type: 'ungroupLayer', group: g });
    await h.run({ type: 'setLayerSwitches', layers: [s.A, s.V], patch: { shy: true, solo: true, label: 4, locked: false } });
    await h.run({ type: 'setBlendMode', layers: [s.A], mode: 'multiply' });
    await h.run({ type: 'setTrackMatte', layer: s.A, matte: { layer: s.B, mode: 'alpha' } });
    await h.run({ type: 'deleteLayers', layers: [s.T] });
    await h.run({ type: 'undo' });
    await h.run({ type: 'setLayerComment', layer: s.A, comment: 'approved' });
  },

  'keyframes and gestures: drags, Esc, retime, easing': async (h) => {
    const s = await buildScene(h);
    const { gesture } = await h.run({ type: 'beginGesture', label: 'Drag Position' });
    for (let i = 0; i < 20; i++) await h.run({ type: 'setProperty', prop: { layer: s.B, path: 'transform/position' }, value: v2(100 + i * 5, 100), time: 0 });
    await h.run({ type: 'endGesture', gesture, commit: true });
    const g2 = (await h.run({ type: 'beginGesture', label: 'Nudge (cancelled)' })).gesture;
    await h.run({ type: 'moveKeyframes', ids: [s.posKeys[1]!], delta: sec(0.5) });
    await h.run({ type: 'endGesture', gesture: g2, commit: false });
    await h.run({ type: 'moveKeyframes', ids: [s.posKeys[1]!], delta: sec(1) });
    await h.run({ type: 'updateKeyframes', patches: [{ id: s.posKeys[0]!, easing: 'easeInOut', roving: false, label: 2, spatialIn: [], spatialOut: [] }] });
    const { ids } = await h.run({ type: 'addKeyframes', keys: [0, 1, 2, 3].map((i) => ({ prop: { layer: s.A, path: 'transform/rotation' }, time: sec(i), value: scalar(i * 45), spatialIn: [], spatialOut: [] })) });
    await h.run({ type: 'scaleKeyframes', ids, pivot: 0, factor: 0.5 });
    await h.run({ type: 'reverseKeyframes', ids });
    await h.run({ type: 'undo' });
    await h.run({ type: 'deleteKeyframes', ids: [ids[3]!] });
    const got = await h.query({ type: 'getKeyframes', props: [{ layer: s.B, path: 'transform/position' }] });
    await h.run({ type: 'pasteKeyframes', prop: { layer: s.T, path: 'transform/position' }, time: sec(2), keys: got.sets[0]!.keyframes });
    await h.run({ type: 'setAnimated', prop: { layer: s.A, path: 'transform/opacity' }, animated: true, time: sec(1) });
    await h.run({ type: 'setExpression', prop: { layer: s.P, path: 'transform/rotation' }, source: 'time * 30', enabled: true });
    await h.run({ type: 'convertExpressionToKeyframes', prop: { layer: s.P, path: 'transform/rotation' }, range: { start: 0, duration: sec(0.5) }, step: 0 });
    await h.run({ type: 'linkProperty', prop: { layer: s.V, path: 'transform/position' }, target: { layer: s.B, path: 'transform/position' } });
    await h.run({ type: 'setDimensionsSeparated', layer: s.B, path: 'transform/position', separated: true });
  },

  'precompose, split, ripple, work area, sequence, retime': async (h) => {
    const s = await buildScene(h);
    await h.run({ type: 'setLayerTiming', items: [{ layer: s.A, inPoint: 0, outPoint: sec(2) }, { layer: s.B, inPoint: sec(2), outPoint: sec(4) }, { layer: s.T, inPoint: sec(4), outPoint: sec(6) }] });
    await h.run({ type: 'splitLayers', layers: [s.B], time: sec(3) });
    await h.run({ type: 'rippleDeleteLayers', layers: [s.A] });
    await h.run({ type: 'undo' });
    await h.run({ type: 'slideLayer', layer: s.B, delta: sec(0.25) });
    await h.run({ type: 'rollEdit', left: s.A, right: s.B, delta: sec(0.5) });
    await h.run({ type: 'editWorkArea', comp: s.comp, edit: 'lift', layers: [s.V] });
    await h.run({ type: 'insertGap', comp: s.comp, time: sec(5), duration: sec(1) });
    await h.run({ type: 'sequenceLayers', layers: [s.A, s.B, s.T], overlap: sec(0.5), crossfade: true });
    await h.run({ type: 'precompose', comp: s.comp, layers: [s.A, s.B], name: 'Pre-comp 1', mode: 'moveAll', adjustDuration: true });
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
    await h.run({ type: 'setRetime', layer: s.V, mode: 'speed', speed: 200 });
    await h.run({ type: 'setTimeRemap', layer: s.P, enabled: true });
    await h.run({ type: 'freezeFrame', layer: s.V, lastFrame: true });
    await h.run({ type: 'timeReverseLayers', layers: [s.T] });
    await h.run({ type: 'trimCompToWorkArea', comp: s.comp });
  },

  'effects, masks, layer styles, shape contents, presets': async (h) => {
    const s = await buildScene(h);
    const { groups: [fx2] } = await h.run({ type: 'addEffect', layers: [s.A], effect: 'drop-shadow', params: [] });
    await h.run({ type: 'movePropertyGroup', group: { layer: s.A, path: fx2! }, toIndex: 0 });
    await h.run({ type: 'addKeyframes', keys: [{ prop: { layer: s.A, path: `effects/${s.fx}/radius` }, time: sec(1), spatialIn: [], spatialOut: [] }] }).catch(() => undefined);
    await h.run({ type: 'duplicatePropertyGroups', groups: [{ layer: s.A, path: `masks/${s.mask}` }] });
    await h.run({ type: 'setProperty', prop: { layer: s.A, path: `masks/${s.mask}/feather` }, value: scalar(12) });
    await h.run({ type: 'setAnimated', prop: { layer: s.A, path: `masks/${s.mask}/path` }, animated: true, time: 0 });
    await h.run({ type: 'setProperty', prop: { layer: s.A, path: `masks/${s.mask}/path` }, time: sec(1), value: { kind: 'path', value: { vertices: [0, 0, 200, 0, 200, 200, 0, 200], inTangents: [], outTangents: [], closed: true, featherPoints: [] } } });
    await h.run({ type: 'renamePropertyGroup', group: { layer: s.A, path: `masks/${s.mask}` }, name: 'Window' });
    await h.run({ type: 'setGroupEnabled', groups: [{ layer: s.A, path: `effects/${s.fx}` }], enabled: false });
    await h.run({ type: 'copyPropertyGroups', groups: [{ layer: s.A, path: `effects/${s.fx}` }], toLayers: [s.B] });
    await h.run({ type: 'addPropertyGroup', layer: s.B, parent: 'styles', matchName: 'style:dropShadow', init: [] });
    const { groups: [op] } = await h.run({ type: 'addPropertyGroup', layer: s.B, parent: 'contents', matchName: 'pathop:trim', init: [] });
    await h.run({ type: 'removePropertyGroups', groups: [{ layer: s.B, path: op! }] });
    await h.run({ type: 'undo' });
    await h.run({ type: 'applyPreset', layers: [s.T], preset: 'Fade In', time: sec(1) });
    await h.run({ type: 'setPluginData', layer: s.A, group: `effects/${s.fx}`, key: 'k', data: new Uint8Array([9, 8, 7]) });
  },

  'text: source text, animators, selectors': async (h) => {
    const s = await buildScene(h);
    const doc = (text: string) => ({ kind: 'textDocument' as const, value: { text, runs: [], paragraphs: [], orientation: 'horizontal' as const, kerning: 'metrics' } });
    await h.run({ type: 'setProperty', prop: { layer: s.T, path: 'text/sourceText' }, value: doc('Hello') });
    await h.run({ type: 'setAnimated', prop: { layer: s.T, path: 'text/sourceText' }, animated: true, time: 0 });
    await h.run({ type: 'setProperty', prop: { layer: s.T, path: 'text/sourceText' }, value: doc('World'), time: sec(2) });
    const { groups: [a2] } = await h.run({ type: 'addPropertyGroup', layer: s.T, parent: 'text/animators', matchName: 'ADBE Text Animator', init: [], name: 'Second' });
    const a2id = a2!.split('/')[2]!;
    await h.run({ type: 'setAnimated', prop: { layer: s.T, path: `text/animators/${a2id}/props/opacity` }, animated: true, time: 0 });
    await h.run({ type: 'addPropertyGroup', layer: s.T, parent: `text/animators/${a2id}/selectors`, matchName: 'ADBE Text Wiggly Selector', init: [] });
    await h.run({ type: 'movePropertyGroup', group: { layer: s.T, path: a2! }, toIndex: 0 });
    await h.run({ type: 'removePropertyGroups', groups: [{ layer: s.T, path: `text/animators/${s.animator}` }] });
    await h.run({ type: 'undo' });
    await h.run({ type: 'duplicatePropertyGroups', groups: [{ layer: s.T, path: a2! }] });
  },

  '3D: switches, cameras, lights, vector properties': async (h) => {
    const s = await buildScene(h);
    await h.run({ type: 'setLayerSwitches', layers: [s.A, s.B], patch: { threeD: true } });
    const { layer: cam } = await h.run({ type: 'createLayer', comp: s.comp, kind: 'camera', name: 'Cam', init: [] });
    const { layer: light } = await h.run({ type: 'createLayer', comp: s.comp, kind: 'light', init: [] });
    await h.run({ type: 'setProperty', prop: { layer: s.A, path: 'transform/position' }, value: v3(10, 20, -300) });
    await h.run({ type: 'setAnimated', prop: { layer: s.A, path: 'transform/orientation' }, animated: true, time: 0 }).catch(() => undefined);
    await h.run({ type: 'setProperty', prop: { layer: cam, path: 'transform/position' }, value: v3(960, 540, -1200) });
    const tree = await h.query({ type: 'getPropertyTree', layer: light, path: '', depth: 0 });
    const intensity = tree.nodes.find((n) => n.path.endsWith('/intensity'));
    if (intensity) await h.run({ type: 'setProperty', prop: { layer: light, path: intensity.path }, value: scalar(150) });
    await h.run({ type: 'setParent', layers: [s.A], parent: cam, keepWorldTransform: true });
    await h.run({ type: 'undo' });
    await h.run({ type: 'createLayer', comp: s.comp, kind: 'model3d', init: [] });
  },

  'markers, compositions, items, render queue, project settings': async (h) => {
    const s = await buildScene(h);
    const { ids } = await h.run({ type: 'addMarkers', markers: [{ owner: { comp: s.comp, layer: s.A }, time: sec(1), duration: 0, name: 'beat', comment: '', label: 1 }] });
    await h.run({ type: 'updateMarkers', patches: [{ id: ids[0]!, name: 'drop', cuePoint: 'cue1' }, { id: s.marker, chapter: 'Act 1' }] });
    await h.run({ type: 'moveMarkers', ids: [s.marker], delta: sec(1) });
    await h.run({ type: 'deleteMarkers', ids: [ids[0]!] });
    await h.run({ type: 'setCompositionSettings', comp: s.comp, patch: { name: 'Main', frameRate: { num: 24, den: 1 }, duration: sec(12) } });
    await h.run({ type: 'setWorkArea', comp: s.comp, range: { start: 0, duration: sec(6) } });
    const { item: dup } = await h.run({ type: 'duplicateComposition', comp: s.comp2, deep: false });
    await h.run({ type: 'createLayer', comp: s.comp, kind: 'precomp', source: dup, init: [] });
    await h.run({ type: 'cropComposition', comp: s.comp2, region: { x: 0, y: 0, width: 400, height: 300 } });
    await h.run({ type: 'createComposition', settings: { name: 'From clip' }, fromItems: [s.footage] });
    await h.run({ type: 'assembleComposition', items: [s.footage, s.footage2], name: 'Cut', overlap: 0 });
    await h.run({ type: 'importFiles', files: [{ path: 'C:/m/logo.png', asSequence: false, createComposition: false }] });
    await h.run({ type: 'moveItems', items: [s.footage2], folder: s.folder });
    await h.run({ type: 'setInterpretation', items: [s.footage], patch: { conformFrameRate: { num: 24, den: 1 } } });
    await h.run({ type: 'setItemLabel', items: [s.footage], label: 5 });
    await h.run({ type: 'setItemTags', item: s.footage, tags: ['a'] });
    await h.run({ type: 'setItemComment', item: s.footage, comment: 'x' });
    await h.run({ type: 'relinkItem', item: s.footage2, path: 'D:/new/clip2.mp4', keepInterpretation: false });
    await h.run({ type: 'replaceLayerSource', layer: s.V, source: s.footage2, keepSize: true });
    await h.run({ type: 'removeUnusedItems' });
    await h.run({ type: 'undo' });
    const { items: rq } = await h.run({ type: 'addRenderItems', comps: [s.comp, s.comp2], settings: { format: 'png-seq' } });
    await h.run({ type: 'setRenderItem', item: rq[0]!, patch: { quality: 90 } });
    await h.run({ type: 'reorderRenderItems', items: [rq[1]!], toIndex: 0 });
    await h.run({ type: 'removeRenderItems', items: [rq[0]!] });
    await h.run({ type: 'setProjectSettings', patch: { bitDepth: 'f32', timeDisplay: 'frames' } });
    await h.run({ type: 'removeItems', items: [s.comp2], removeUsingLayers: true });
    await h.run({ type: 'undo' });
    const frag = await h.query({ type: 'copyLayers', layers: [s.A] });
    await h.run({ type: 'pasteLayers', comp: s.comp2, fragment: { version: frag.version, data: frag.data } });
    await h.run({ type: 'saveProject', path: 'C:/p/x.motion', copy: true });
    await h.run({ type: 'importProject', path: 'C:/p/x.motion' });
  },

  'transport and batches between edits': async (h) => {
    const s = await buildScene(h);
    await h.run({ type: 'setActiveComposition', comp: s.comp });
    await h.run({ type: 'seek', time: sec(1.5), mode: 'exact' });
    // keepWorldTransform decisions read the playhead the log carries.
    await h.run({ type: 'setParent', layers: [s.B], parent: s.P, keepWorldTransform: true });
    await h.batch('Align Left', [
      { type: 'setProperty', prop: { layer: s.A, path: 'transform/position' }, value: v2(0, 0) },
      { type: 'setProperty', prop: { layer: s.T, path: 'transform/position' }, value: v2(0, 50) },
    ]);
    await h.run({ type: 'step', frames: 10 });
    await h.run({ type: 'undo' });
    await h.run({ type: 'jumpToHistory', position: 3 });
    await h.run({ type: 'redo' });
  },
};

test.each(Object.keys(CORPUS))('replay reproduces: %s', async (name) => {
  const h = await setupEngine({ hashes: true });
  try {
    await CORPUS[name]!(h);
    const finalDoc = h.doc();
    const finalHistory = await h.query({ type: 'getHistory' });
    const log = logFromJsonl(logToJsonl(h.engine.commandLog()));
    expect(log.records.length).toBeGreaterThan(5);
    await h.engine.close();

    // A FRESH engine: new instance, document reset to the log's header.
    const files = h.files;
    const fresh = new LocalEngine({ verifyScopes: true, wire: true, ports: fakePorts(files) });
    const result = await replayLog(log, fresh, { checkHashes: true });
    expect(result.mismatches).toEqual([]);
    expect(result.applied).toBe(log.records.length);
    expect(docDiff(finalDoc, h.doc())).toEqual([]);
    expect(h.doc()).toBe(finalDoc);
    const hist = await fresh.query({ type: 'getHistory' });
    expect(hist.ok && { labels: hist.value.entries.map((e) => e.label), position: hist.value.position })
      .toEqual({ labels: finalHistory.entries.map((e) => e.label), position: finalHistory.position });
    await fresh.close();
  } finally {
    await h.dispose();
  }
});
