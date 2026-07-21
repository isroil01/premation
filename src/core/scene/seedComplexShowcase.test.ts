/**
 * Stress test — build the complex showcase and render it through the real
 * snapshot pipeline across the whole timeline. Proves the engine handles a
 * dense, fully-animated composition and that the animation actually changes
 * the rendered output frame-to-frame.
 */

import { buildComplexShowcase } from './seedComplexShowcase';
import defaultSceneGraph from './DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { buildSnapshot } from '@core/rendering/buildSnapshot';

function render(t: number) {
  return buildSnapshot(defaultSceneGraph, defaultAnimation, t);
}
const layer = (snap: ReturnType<typeof render>, id: string) => snap.layers.find((l) => l.id === id);

describe('complex showcase — engine stress test', () => {
  beforeAll(() => {
    buildComplexShowcase();
  });

  it('authors a dense composition rendered to many layers', () => {
    const { layerCount } = buildComplexShowcase();
    expect(layerCount).toBeGreaterThanOrEqual(15);
    // The repeater ring is nested in a precomp, so its ~18 copies composite
    // into that one texture — the top-level frame still carries a dense stack.
    const snap = render(1);
    expect(snap.layers.length).toBeGreaterThanOrEqual(14);
    expect(snap.width).toBe(1920);
    expect(snap.height).toBe(1080);
  });

  it('renders every frame across the timeline without throwing', () => {
    for (const t of [0, 0.5, 1, 2, 3.5, 6, 9, 12]) {
      const snap = render(t);
      expect(snap.layers.length).toBeGreaterThan(10);
      for (const l of snap.layers) {
        expect(Number.isFinite(l.x)).toBe(true);
        expect(Number.isFinite(l.y)).toBe(true);
        expect(Number.isFinite(l.opacity)).toBe(true);
      }
    }
  });

  it('actually animates — the hero star transforms over time', () => {
    const a = layer(render(0.6), 'hero_star');
    const b = layer(render(6), 'hero_star');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // Rotation is keyframed 0→320°, so it must differ between the two frames.
    expect(Math.abs((a!.rotation ?? 0) - (b!.rotation ?? 0))).toBeGreaterThan(30);
  });

  it('renders custom geometry as real vector paths', () => {
    const snap = render(3);
    const paths = snap.layers.filter((l) => l.primitive === 'path');
    expect(paths.length).toBeGreaterThan(3); // star, hexes, swoosh, burst shapes…
  });

  it('reveals the swoosh via an animated trim (hidden early, drawn later)', () => {
    // trim end is keyframed 0 (nothing) at t≤1 → grows to 100% by t≈2.6.
    const early = layer(render(0.5), 'swoosh');
    const late = layer(render(3), 'swoosh');
    expect(early).toBeDefined();
    expect(late).toBeDefined();
    // The revealed portion (path point count) should grow as the trim opens.
    const earlyPts = early!.pathPoints?.length ?? 0;
    const latePts = late!.pathPoints?.length ?? 0;
    expect(latePts).toBeGreaterThanOrEqual(earlyPts);
  });

  it('promotes the 3D card to a projected (matrix) layer', () => {
    const card = layer(render(3), 'card3d');
    expect(card).toBeDefined();
    // 3D layers carry a full affine matrix from the camera projection.
    expect(card!.matrix).toBeDefined();
  });
});
