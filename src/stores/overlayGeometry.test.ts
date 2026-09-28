/**
 * The overlay geometry mirror's request registry (B4): each overlay asks for
 * its own layers and kinds; the viewport is subscribed to the union, and a
 * withdrawn request leaves the others in place.
 */

import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { overlayGeometryAt } from '@core/engine/overlayGeometry';
import { overlayScreenPlacement, overlayView, requestOverlayLayers } from './overlayGeometry';

let h: Harness & { engine: LocalEngine };
beforeEach(async () => { h = await setupAppEngine(); });
afterEach(async () => {
  requestOverlayLayers(7, 'a', [], []);
  requestOverlayLayers(7, 'b', [], []);
  await h.dispose();
});

test('each owner’s layers get that owner’s kinds (B4 round 5: one group per owner)', async () => {
  const A = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name: 'A', init: [] })).layer;
  const B = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name: 'B', init: [] })).layer;
  requestOverlayLayers(7, 'a', [A], ['transform']);
  requestOverlayLayers(7, 'b', [B, A], ['bounds']);
  await engineIdle();
  const both = overlayGeometryAt(7, 0);
  expect(both.map((g) => g.layer)).toEqual([A, B]);
  // A is named by both owners: both kinds. B only by 'b': its box, no matrix (before round 5 every
  // requested layer got every requested kind).
  expect(both[0]!.matrix).toHaveLength(16);
  expect(both[0]!.box).toHaveLength(4);
  expect(both[1]!.matrix).toEqual([]);
  expect(both[1]!.box).toHaveLength(4);
  requestOverlayLayers(7, 'b', [], []);
  await engineIdle();
  const one = overlayGeometryAt(7, 0);
  expect(one.map((g) => g.layer)).toEqual([A]);
  expect(one[0]!.box).toEqual([]);
});

test('an owner may ask for view cameras alone; the frame set answers them by mode', async () => {
  await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'camera', name: 'Cam', init: [] });
  requestOverlayLayers(7, 'a', [], [], ['active', 'front']);
  await engineIdle();
  const v = overlayView(7, 'active', 0);
  expect(v?.lens).toHaveLength(9);
  expect(v?.camera).not.toBe('');
  expect(overlayView(7, 'front', 0)?.camera).toBe(v?.camera);
  expect(overlayView(7, 'left', 0)).toBeUndefined();
});

test('overlayScreenPlacement reads origin, angle and axis scales off the pushed matrix', () => {
  const c = Math.cos(Math.PI / 6);
  const s = Math.sin(Math.PI / 6);
  // Column-major 4×4: rotation 30°, scale (2, 3), origin (10, 20).
  const matrix = [2 * c, 2 * s, 0, 0, -3 * s, 3 * c, 0, 0, 0, 0, 1, 0, 10, 20, 0, 1];
  const p = overlayScreenPlacement({ layer: 'x', matrix, box: [], corners: [], path: [], pathKeys: [], pins: [], bones: [], textBox: [], pathFrames: [], pathNow: [] }, (q) => ({ x: q.x * 2, y: q.y * 2 }));
  expect(p).not.toBeNull();
  expect(p!.x).toBeCloseTo(20);
  expect(p!.y).toBeCloseTo(40);
  expect(p!.rotationDeg).toBeCloseTo(30);
  expect(p!.scaleX).toBeCloseTo(2);
  expect(p!.scaleY).toBeCloseTo(3);
  expect(overlayScreenPlacement(undefined, (q) => q)).toBeNull();
});
