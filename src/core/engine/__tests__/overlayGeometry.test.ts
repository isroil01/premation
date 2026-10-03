/**
 * The overlay geometry push, the TypeScript engine's side (B4 round 2,
 * ENGINE_API.md §15.12): `setOverlayGeometry` stores the viewport's
 * subscription; `overlayGeometryAt` answers the records a frame at that time
 * carries — the twin of native/engine/src/core/overlay_geometry.cpp
 * (tests/test_b4_round2.cpp pins the same case on the C++ engine).
 */

import { setupEngine, type Harness } from '../__testHelpers__/harness';
import { buildScene, type Scene } from '../__testHelpers__/scene';
import { overlayGeometryAt, overlaySubscription } from '../overlayGeometry';

jest.useFakeTimers();

let h: Harness;
let s: Scene;
beforeEach(async () => {
  h = await setupEngine();
  s = await buildScene(h);
});
afterEach(async () => {
  await h.run({ type: 'setOverlayGeometry', viewport: 7, layers: [], kinds: [], groups: [], views: [] });
  await h.dispose();
});

test('a subscribed layer carries its matrix, box and motion path at the asked time; unknown layers are skipped', async () => {
  // B's Position is keyed 100,100 → 300,200 over the first second.
  await h.run({ type: 'setOverlayGeometry', viewport: 7, layers: [s.B, 'nope'], kinds: ['transform', 'bounds', 'motionPath'], groups: [], views: [] });
  expect(overlaySubscription(7)?.layers).toEqual([s.B, 'nope']);
  const [g, ...rest] = overlayGeometryAt(7, 0.5);
  expect(rest).toEqual([]);
  expect(g!.layer).toBe(s.B);
  expect(g!.matrix).toHaveLength(16);
  expect(g!.matrix[12]).toBeCloseTo(200, 6);
  expect(g!.box).toHaveLength(4);
  expect(g!.corners).toHaveLength(8);
  // Two keys × (t, x, y, z, inX, inY, outX, outY); the ends have no outer handle.
  expect(g!.pathKeys).toHaveLength(16);
  expect(g!.pathKeys[1]).toBeCloseTo(100, 6);
  expect(Number.isNaN(g!.pathKeys[4]!)).toBe(true);
  expect(Number.isNaN(g!.pathKeys[14]!)).toBe(true);
  expect(g!.path.length % 4).toBe(0);
  expect(g!.path.length / 4).toBeLessThanOrEqual(128);
  expect(g!.pathFrames.length).toBeGreaterThan(0);
  expect(g!.pathNow[0]).toBeCloseTo(200, 6);
  // The frame's time on the keyframe axis (the layer starts at 0: the comp time).
  expect(g!.pathNow[3]).toBeCloseTo(0.5, 9);
  // Kinds not subscribed stay empty.
  expect(g!.textBox).toEqual([]);
  expect(g!.pins).toEqual([]);
});

test('no layers or no kinds unsubscribes', async () => {
  await h.run({ type: 'setOverlayGeometry', viewport: 7, layers: [s.B], kinds: ['transform'], groups: [], views: [] });
  expect(overlayGeometryAt(7, 0)).toHaveLength(1);
  await h.run({ type: 'setOverlayGeometry', viewport: 7, layers: [s.B], kinds: [], groups: [], views: [] });
  expect(overlaySubscription(7)).toBeUndefined();
  expect(overlayGeometryAt(7, 0)).toEqual([]);
});
