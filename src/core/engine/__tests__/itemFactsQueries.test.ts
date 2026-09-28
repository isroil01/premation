/**
 * B4 round 5 (ENGINE_API.md §15.14): the item / layer facts the UI read around
 * the API — ItemInfo.mediaUrl, LayerInfo.caption / multicamAngle,
 * getDocumentColors, getCaptionCues, mapLayerTime, getSourceSize,
 * checkPrecompose, getMemberKeyframes{includeData} and the template slot
 * fields. native/engine/tests/test_b4_round5_items.cpp pins the same cases on
 * the C++ engine.
 */

import { unwrap, type DocumentFragment, type LayerKind, type Value } from '@motion/engine-api';
import { setupEngine, sec, type Harness } from '../__testHelpers__/harness';

jest.useFakeTimers();

let h: Harness;
beforeEach(async () => { h = await setupEngine(); });
afterEach(async () => { await h.dispose(); });

async function makeComp(name = 'Test', width = 1920, height = 1080): Promise<string> {
  const r = await h.run({ type: 'createComposition', settings: { name, width, height, frameRate: { num: 30, den: 1 }, duration: sec(10) }, fromItems: [] });
  return (r as { item: string }).item;
}

async function makeLayer(comp: string, kind: LayerKind, source?: string): Promise<string> {
  const r = await h.run({ type: 'createLayer', comp, kind, init: [], ...(source ? { source } : {}) });
  return (r as { layer: string }).layer;
}

async function importClip(path: string): Promise<string> {
  const r = await h.run({ type: 'importFiles', files: [{ path, asSequence: false, createComposition: false }] });
  return (r as { items: string[] }).items[0]!;
}

/** Copy `layer`, let `edit` change its stored node (JSON), paste the result into `comp`. */
async function pasteEdited(comp: string, layer: string, edit: (node: { components: Array<{ id: string; type: string; props: Record<string, unknown> }> }) => void): Promise<string> {
  const frag = await h.query({ type: 'copyLayers', layers: [layer] }) as DocumentFragment;
  const doc = JSON.parse(new TextDecoder().decode(frag.data)) as { layers: Array<{ row: { components: Array<{ id: string; type: string; props: Record<string, unknown> }> } }> };
  edit(doc.layers[0]!.row);
  const data = new TextEncoder().encode(JSON.stringify(doc));
  const r = await h.run({ type: 'pasteLayers', comp, fragment: { ...frag, data } });
  return (r as { layers: string[] }).layers[0]!;
}

async function layerInfo(id: string) {
  const r = await h.query({ type: 'getLayers', layers: [id] });
  return r.layers[0]!;
}

test('ItemInfo.mediaUrl: a footage item\'s stored source reference; none on a composition', async () => {
  const comp = await makeComp();
  const clip = await importClip('C:/m/clip.mp4');
  const items = (await h.query({ type: 'getItems', items: [clip, comp] })).items;
  expect(items[0]!.mediaUrl).toBe(`blob:fake/${clip}`);
  expect(items[1]!.mediaUrl).toBeUndefined();
});

test('LayerInfo.caption, getCaptionCues: tagged top-level text layers as cues, trimmed, by start', async () => {
  const comp = await makeComp();
  const text = await makeLayer(comp, 'text');
  const cap = await pasteEdited(comp, text, (n) => {
    n.components.unshift({ id: 'capc', type: 'captionTag', props: { __caption: true, content: '  Hello there  ' } });
  });
  await h.run({ type: 'setLayerTiming', items: [{ layer: cap, inPoint: sec(2), outPoint: sec(3) }] });
  expect((await layerInfo(cap)).caption).toBe(true);
  expect((await layerInfo(text)).caption).toBeUndefined();
  const cues = (await h.query({ type: 'getCaptionCues', comp })).cues;
  expect(cues).toEqual([{ layer: cap, start: sec(2), end: sec(3), text: 'Hello there' }]);
  const bad = await h.engine.query({ type: 'getCaptionCues', comp: 'nope' });
  expect(!bad.ok && bad.error.code).toBe('notFound');
});

test('LayerInfo.multicamAngle: the Transform tag of a video layer', async () => {
  const comp = await makeComp();
  const clip = await importClip('C:/m/clip.mp4');
  const video = await makeLayer(comp, 'video', clip);
  const angle = await pasteEdited(comp, video, (n) => {
    const t = n.components.find((c) => c.type === 'Transform')!;
    t.props.__multicamAngle = 2;
  });
  expect((await layerInfo(angle)).multicamAngle).toBe(2);
  expect((await layerInfo(video)).multicamAngle).toBeUndefined();
});

test('getSourceSize: footage (× pixel aspect), a placed composition, the per-kind default; none for a null', async () => {
  const comp = await makeComp();
  const inner = await makeComp('Inner', 800, 600);
  const clip = await importClip('C:/m/clip.mp4');
  const video = await makeLayer(comp, 'video', clip);
  const text = await makeLayer(comp, 'text');
  const nul = await makeLayer(comp, 'null');
  const pre = await makeLayer(comp, 'precomp', inner);
  const sizes = (await h.query({ type: 'getSourceSize', layers: [video, text, nul, pre, 'nope'] })).sizes;
  expect(sizes).toEqual([
    { layer: video, width: 640, height: 360 },
    { layer: text, width: 320, height: 80 },
    { layer: pre, width: 800, height: 600 },
  ]);
  await h.run({ type: 'setInterpretation', items: [clip], patch: { pixelAspect: 2 } });
  expect((await h.query({ type: 'getSourceSize', layers: [video] })).sizes).toEqual([{ layer: video, width: 1280, height: 360 }]);
});

test('mapLayerTime: through a placed composition\'s start time; one to one elsewhere; no outward answer once remapped', async () => {
  const comp = await makeComp();
  const inner = await makeComp('Inner', 800, 600);
  const pre = await makeLayer(comp, 'precomp', inner);
  const text = await makeLayer(comp, 'text');
  await h.run({ type: 'setLayerTiming', items: [{ layer: pre, startTime: sec(1) }] });
  expect(await h.query({ type: 'mapLayerTime', layer: pre, time: sec(3), outward: false })).toMatchObject({ time: sec(2) });
  expect(await h.query({ type: 'mapLayerTime', layer: pre, time: sec(2), outward: true })).toMatchObject({ time: sec(3) });
  expect(await h.query({ type: 'mapLayerTime', layer: text, time: sec(3), outward: false })).toMatchObject({ time: sec(3) });
  await h.run({ type: 'setTimeRemap', layer: pre, enabled: true });
  const out = await h.query({ type: 'mapLayerTime', layer: pre, time: sec(2), outward: true });
  expect(out.time).toBeUndefined();
  const bad = await h.engine.query({ type: 'mapLayerTime', layer: 'nope', time: 0, outward: false });
  expect(!bad.ok && bad.error.code).toBe('notFound');
});

test('checkPrecompose: the Leave All Attributes refusal, message for message', async () => {
  const comp = await makeComp();
  const clip = await importClip('C:/m/clip.mp4');
  const video = await makeLayer(comp, 'video', clip);
  const text = await makeLayer(comp, 'text');
  const ask = async (layers: string[]) => (await h.query({ type: 'checkPrecompose', comp, layers })).leaveAttributesReason;
  expect(await ask([text])).toBe('Not available for text layers — their content is not a separate source.');
  expect(await ask([text, video])).toBe('Only available when a single layer is selected.');
  expect(await ask([video])).toBe('');
});

test('getDocumentColors: fills then strokes per layer, canonical, first seen, limited', async () => {
  const comp = await makeComp();
  const solid = await makeLayer(comp, 'solid');
  const red: Value = { kind: 'color', value: { r: 1, g: 0, b: 0, a: 1 } };
  await h.run({ type: 'setProperty', prop: { layer: solid, path: 'layer/fill' }, value: red });
  const all = (await h.query({ type: 'getDocumentColors', limit: 0 })).colors;
  expect(all).toEqual(['#ff0000']);
  // A second solid in a colour already listed adds nothing; a third one is listed after it.
  const again = await makeLayer(comp, 'solid');
  await h.run({ type: 'setProperty', prop: { layer: again, path: 'layer/fill' }, value: red });
  const blue = await makeLayer(comp, 'solid');
  await h.run({ type: 'setProperty', prop: { layer: blue, path: 'layer/fill' }, value: { kind: 'color', value: { r: 0, g: 0, b: 1, a: 0.5 } } });
  const three = (await h.query({ type: 'getDocumentColors', limit: 0 })).colors;
  expect([...three].sort()).toEqual(['#0000ff80', '#ff0000']);
  expect((await h.query({ type: 'getDocumentColors', limit: 1 })).colors).toEqual(three.slice(0, 1));
});

test('getMemberKeyframes{includeData}: keyed data tracks after the scalar ones, flagged', async () => {
  const comp = await makeComp();
  const text = await makeLayer(comp, 'text');
  await h.run({ type: 'addKeyframes', keys: [0, sec(1)].map((time) => ({ prop: { layer: text, path: 'text/sourceText' }, time, spatialIn: [], spatialOut: [] })) });
  const plain = (await h.query({ type: 'getMemberKeyframes', layer: text, members: [] })).tracks;
  expect(plain.some((t) => t.data)).toBe(false);
  const withData = (await h.query({ type: 'getMemberKeyframes', layer: text, members: [], includeData: true })).tracks;
  const data = withData.filter((t) => t.data === true);
  expect(data).toHaveLength(1);
  expect(data[0]).toMatchObject({ path: 'text/sourceText', count: 2 });
  expect(JSON.parse(data[0]!.keyframes)).toHaveLength(2);
});

test('template slot fields: layer/slotFit, slotWidth, slotHeight on a layer that shows a source', async () => {
  const comp = await makeComp();
  const clip = await importClip('C:/m/clip.mp4');
  const video = await makeLayer(comp, 'video', clip);
  const text = await makeLayer(comp, 'text');
  const tree = async (layer: string, path: string) => (await h.query({ type: 'getPropertyTree', layer, path, depth: 1 })).nodes[0]!;
  expect((await tree(video, 'layer/slotFit')).value).toEqual({ kind: 'choice', value: 'none' });
  await h.batch('slot', [
    { type: 'setProperty', prop: { layer: video, path: 'layer/slotFit' }, value: { kind: 'choice', value: 'cover' } },
    { type: 'setProperty', prop: { layer: video, path: 'layer/slotWidth' }, value: { kind: 'scalar', value: 400 } },
    { type: 'setProperty', prop: { layer: video, path: 'layer/slotHeight' }, value: { kind: 'scalar', value: 300 } },
  ]);
  expect((await tree(video, 'layer/slotFit')).value).toEqual({ kind: 'choice', value: 'cover' });
  expect((await tree(video, 'layer/slotWidth')).value).toEqual({ kind: 'scalar', value: 400 });
  expect((await tree(video, 'layer/slotHeight')).value).toEqual({ kind: 'scalar', value: 300 });
  const none = await h.engine.execute({ type: 'setProperty', prop: { layer: text, path: 'layer/slotFit' }, value: { kind: 'choice', value: 'cover' } });
  expect(none.ok).toBe(false);
  void unwrap;
});
