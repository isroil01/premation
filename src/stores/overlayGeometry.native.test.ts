/**
 * The overlay geometry mirror's request registry (B4): each overlay asks for
 * its own layers and kinds; the viewport is subscribed to the union, and a
 * withdrawn request leaves the others in place.
 */

import { setupAppEngine, settleEdits, waitForFrame } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import {
  MAIN_VIEWPORT,
  overlayLayer,
  overlayScreenPlacement,
  overlayView,
  requestOverlayLayers,
  subscribeOverlayGeometry,
} from './overlayGeometry';

let h: Harness;
beforeEach(async () => { h = await setupAppEngine(); });
afterEach(async () => {
  requestOverlayLayers(VP, 'a', [], []);
  requestOverlayLayers(VP, 'b', [], []);
  await h.dispose();
});

/** The main viewport: the engine draws it, and each frame carries the subscribed geometry. */
const VP = MAIN_VIEWPORT;
/** The records of the frame the viewport shows now. */
const at = (id: string) => overlayLayer(VP, id, 0);

/** Let the subscription land and a frame carry it. */
async function nextFrame(): Promise<void> {
  await settleEdits();
  await waitForFrame();
}

test('each owner’s layers get that owner’s kinds (B4 round 5: one group per owner)', async () => {
  const A = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name: 'A', init: [] })).layer;
  const B = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name: 'B', init: [] })).layer;
  requestOverlayLayers(VP, 'a', [A], ['transform']);
  requestOverlayLayers(VP, 'b', [B, A], ['bounds']);
  await nextFrame();
  // A is named by both owners: both kinds. B only by 'b': its box, no matrix (before round 5 every
  // requested layer got every requested kind).
  expect(at(A)?.matrix).toHaveLength(16);
  expect(at(A)?.box).toHaveLength(4);
  expect(at(B)?.matrix ?? []).toEqual([]);
  expect(at(B)?.box).toHaveLength(4);
  requestOverlayLayers(VP, 'b', [], []);
  await nextFrame();
  expect(at(B)).toBeUndefined();
  expect(at(A)?.box ?? []).toEqual([]);
});

test('an owner may ask for view cameras alone; the frame set answers them by mode', async () => {
  await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'camera', name: 'Cam', init: [] });
  requestOverlayLayers(VP, 'a', [], [], ['active', 'front']);
  await nextFrame();
  const v = overlayView(VP, 'active', 0);
  expect(v?.lens).toHaveLength(9);
  expect(v?.camera).not.toBe('');
  expect(overlayView(VP, 'front', 0)?.camera).toBe(v?.camera);
  expect(overlayView(VP, 'left', 0)).toBeUndefined();
});

describe('a deleted layer leaves the pushed geometry (no stale selection chrome)', () => {
  test('the engine deleting a layer drops its record and tells the listeners, before any new frame lands', async () => {
    const A = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name: 'A', init: [] })).layer;
    const B = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name: 'B', init: [] })).layer;
    requestOverlayLayers(VP, 'a', [A, B], ['transform', 'bounds']);
    await nextFrame();
    expect(at(A)?.box).toHaveLength(4);
    expect(at(B)?.box).toHaveLength(4);

    let told = 0;
    const off = subscribeOverlayGeometry(VP, () => { told += 1; });
    await h.run({ type: 'deleteLayers', layers: [A] });
    await settleEdits();
    off();

    expect(at(A)).toBeUndefined();
    expect(at(B)?.box).toHaveLength(4);
    expect(told).toBeGreaterThan(0);
  });

  test('undo brings the layer back with the frame that carries it', async () => {
    const A = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name: 'A', init: [] })).layer;
    requestOverlayLayers(VP, 'a', [A], ['transform', 'bounds']);
    await nextFrame();
    await h.run({ type: 'deleteLayers', layers: [A] });
    await settleEdits();
    expect(at(A)).toBeUndefined();
    await h.run({ type: 'undo' });
    // The engine's next frame carries it again (the subscription still names it).
    await nextFrame();
    expect(at(A)?.box).toHaveLength(4);
  });
});

test('overlayScreenPlacement reads origin, angle and axis scales off the pushed matrix', async () => {
  const c = Math.cos(Math.PI / 6);
  const s = Math.sin(Math.PI / 6);
  // Column-major 4×4: rotation 30°, scale (2, 3), origin (10, 20).
  const matrix = [2 * c, 2 * s, 0, 0, -3 * s, 3 * c, 0, 0, 0, 0, 1, 0, 10, 20, 0, 1];
  const p = overlayScreenPlacement({ layer: 'x', matrix, box: [], corners: [], path: [], pathKeys: [], pins: [], bones: [], textBox: [], pathFrames: [], pathNow: [], local: [] }, (q) => ({ x: q.x * 2, y: q.y * 2 }));
  expect(p).not.toBeNull();
  expect(p!.x).toBeCloseTo(20);
  expect(p!.y).toBeCloseTo(40);
  expect(p!.rotationDeg).toBeCloseTo(30);
  expect(p!.scaleX).toBeCloseTo(2);
  expect(p!.scaleY).toBeCloseTo(3);
  expect(overlayScreenPlacement(undefined, (q) => q)).toBeNull();
});
