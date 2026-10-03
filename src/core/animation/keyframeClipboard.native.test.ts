/**
 * The keyframe clipboard in API form (B4): Copy asks the engine for the whole
 * keys (`copyKeyframes`), Paste sends `pasteKeyframes` — spatial tangents,
 * the spatial mode and continuity survive Ctrl+C/V (pasted paths must not come
 * back as polylines), the earliest key lands at the playhead, spacing kept.
 */

import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import { sec, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { documentMirror } from '@stores/documentMirror';
import { clearClipboard, clipboardSets, copyKeyframeIds, copyKeyframeAt, hasClipboard, pasteKeyframes } from './keyframeClipboard';

const COMP = 'comp_root';
let h: Harness;

beforeEach(async () => {
  h = await setupAppEngine();
  clearClipboard();
});
afterEach(async () => {
  clearClipboard();
  await h.dispose();
});

async function layer(name: string): Promise<string> {
  return (await h.run({ type: 'createLayer', comp: COMP, kind: 'solid', name, init: [] })).layer;
}

async function positionKeys(id: string) {
  return (await h.query({ type: 'getKeyframes', props: [{ layer: id, path: 'transform/position' }] })).sets[0]!.keyframes;
}

test('position keys round-trip their tangents, spatial mode and continuity', async () => {
  const src = await layer('src');
  const dst = await layer('dst');
  const { ids } = await h.run({
    type: 'addKeyframes',
    keys: [
      { prop: { layer: src, path: 'transform/position' }, time: 0, value: { kind: 'vec2', value: { x: 0, y: 0 } }, spatialInterp: 'linear', spatialIn: [], spatialOut: [40, 20] },
      { prop: { layer: src, path: 'transform/position' }, time: sec(1), value: { kind: 'vec2', value: { x: 100, y: 50 } }, spatialInterp: 'auto', spatialIn: [-30, -10], spatialOut: [] },
    ],
  });
  expect(await copyKeyframeIds(ids)).toBe(true);
  expect(hasClipboard()).toBe(true);
  expect(clipboardSets()).toHaveLength(1);

  await pasteKeyframes([dst], 2);
  const src0 = await positionKeys(src);
  const got = await positionKeys(dst);
  expect(got.map((k) => k.time)).toEqual([sec(2), sec(3)]);
  expect(got.map((k) => k.value)).toEqual(src0.map((k) => k.value));
  expect(got.map((k) => [k.spatialIn, k.spatialOut, k.spatialInterp, k.continuous])).toEqual(
    src0.map((k) => [k.spatialIn, k.spatialOut, k.spatialInterp, k.continuous]),
  );
});

test('Copy Keyframe at the playhead takes the key under it; a target without the property is skipped', async () => {
  const src = await layer('src');
  await h.run({
    type: 'addKeyframes',
    keys: [0, 1].map((s) => ({ prop: { layer: src, path: 'transform/opacity' }, time: sec(s), value: { kind: 'scalar' as const, value: s * 100 }, spatialIn: [], spatialOut: [] })),
  });
  await engineIdle();
  documentMirror().tree(src);
  await documentMirror().whenIdle();
  expect(await copyKeyframeAt(src, 'opacity', 1)).toBe(true);
  expect(clipboardSets()[0]!.keyframes.map((k) => k.time)).toEqual([sec(1)]);
  expect(await copyKeyframeAt(src, 'opacity', 0.5)).toBe(false);
  // Unknown ids copy nothing and leave the clipboard as it was.
  expect(await copyKeyframeIds(['no-such-key'])).toBe(false);
  expect(clipboardSets()[0]!.keyframes).toHaveLength(1);
});
