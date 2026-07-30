/**
 * Corner Pin — render integration (roadmap item 4).
 *
 * The pin is a SEPARATE render stage: `snapshotToFrameScene` composes the
 * projective homography onto the render `modelMatrix` while the app-level affine
 * `layer.matrix` stays untouched. These probes assert decomposed quantities —
 * the pinned model maps the unit corners onto the pinned quad, the affine path is
 * byte-identical when there is no pin, the shader hook is a no-op for affine mvps
 * (z=1), and a degenerate pin is refused rather than rendered as garbage.
 */

import { layerToRenderable } from './snapshotToFrameScene';
import type { RenderLayer } from './RenderBackend';
import { projectHomography } from '@motion/renderer';

function layer(over: Partial<RenderLayer> = {}): RenderLayer {
  return {
    id: 'n1', kind: 'image', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1,
    opacity: 1, width: 200, height: 100, fill: '#f00', visible: true, primitive: 'rect',
    ...over,
  };
}

type M = ArrayLike<number>;
/** Column-major projective apply WITH the perspective divide. */
const project = (m: M, x: number, y: number) => {
  const w = m[2]! * x + m[5]! * y + m[8]!;
  return { x: (m[0]! * x + m[3]! * y + m[6]!) / w, y: (m[1]! * x + m[4]! * y + m[7]!) / w, w };
};

// A keystone pin: top edge pulled inward (narrower), TL,TR,BR,BL.
const KEYSTONE: RenderLayer['cornerPin'] = [0.25, 0, 0.75, 0, 1, 1, 0, 1];

describe('no pin → the affine path is unchanged', () => {
  it('an unset pin leaves modelMatrix affine and byte-identical', () => {
    const r = layerToRenderable(layer());
    expect(r.modelMatrix[2]).toBe(0); // projective row untouched
    expect(r.modelMatrix[5]).toBe(0);
    expect(r.modelMatrix[8]).toBe(1);
    expect(r.cornerPin).toBeUndefined();
  });

  it('the shader hook is a no-op for an affine model: w=1 everywhere (z passed as w)', () => {
    const m = layerToRenderable(layer()).modelMatrix;
    for (const [u, v] of [[0, 0], [1, 0], [0.5, 0.5], [1, 1]] as const) {
      expect(project(m, u, v).w).toBeCloseTo(1, 9);
    }
  });
});

describe('with a pin → the render model warps the unit quad onto the pinned quad', () => {
  const affine = layerToRenderable(layer()).modelMatrix; // the un-pinned world mapping
  const r = layerToRenderable(layer({ cornerPin: KEYSTONE }));

  it('marks the layer as pinned and makes the model projective', () => {
    expect(r.cornerPin).toEqual(KEYSTONE);
    // At least one projective-row term is non-zero (a real perspective term).
    expect(Math.abs(r.modelMatrix[2]!) + Math.abs(r.modelMatrix[5]!)).toBeGreaterThan(1e-6);
  });

  it('each unit corner lands exactly where the affine model sends that pin point', () => {
    const corners = [[0, 0], [1, 0], [1, 1], [0, 1]] as const; // unit square TL,TR,BR,BL
    const pinPts = [[0.25, 0], [0.75, 0], [1, 1], [0, 1]] as const;
    for (let i = 0; i < 4; i++) {
      const got = projectHomography(r.modelMatrix as never, { x: corners[i]![0], y: corners[i]![1] })!;
      // The affine model applied to the pin POINT is the expected world corner.
      const want = { x: affine[0]! * pinPts[i]![0] + affine[3]! * pinPts[i]![1] + affine[6]!,
                     y: affine[1]! * pinPts[i]![0] + affine[4]! * pinPts[i]![1] + affine[7]! };
      expect(got.x).toBeCloseTo(want.x, 3);
      expect(got.y).toBeCloseTo(want.y, 3);
    }
  });

  it('interpolates with perspective, not linearly: the centre is displaced', () => {
    const centre = projectHomography(r.modelMatrix as never, { x: 0.5, y: 0.5 })!;
    // Under the keystone the sampled centre is not the average of the two edge
    // mids in the naive way — a linear (affine) map would put it at the quad
    // centroid; assert it differs, i.e. the divide is really happening.
    const topMid = projectHomography(r.modelMatrix as never, { x: 0.5, y: 0 })!;
    const botMid = projectHomography(r.modelMatrix as never, { x: 0.5, y: 1 })!;
    const linearMidY = (topMid.y + botMid.y) / 2;
    expect(Math.abs(centre.y - linearMidY)).toBeGreaterThan(1);
  });

  it('bounds cover the pinned world quad', () => {
    // The keystone narrows the top but keeps the full width at the bottom, so the
    // bounds width equals the un-pinned width (the bottom corners are unmoved).
    expect(r.bounds.width).toBeCloseTo(layerToRenderable(layer()).bounds.width, 3);
  });
});

describe('degenerate / identity pins fall back to the affine path', () => {
  it('the identity quad is treated as no pin', () => {
    const r = layerToRenderable(layer({ cornerPin: [0, 0, 1, 0, 1, 1, 0, 1] }));
    expect(r.cornerPin).toBeUndefined();
    expect(r.modelMatrix[2]).toBe(0);
  });

  it('a self-intersecting (bow-tie) pin is refused, not rendered as garbage', () => {
    // Swap the bottom corners → crossed edges. resolveCornerPin returns null.
    const r = layerToRenderable(layer({ cornerPin: [0, 0, 1, 0, 0, 1, 1, 1] }));
    expect(r.cornerPin).toBeUndefined();
    expect(r.modelMatrix[8]).toBe(1); // affine
  });

  it('a collapsed (zero-area) pin is refused', () => {
    const r = layerToRenderable(layer({ cornerPin: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5] }));
    expect(r.cornerPin).toBeUndefined();
  });
});
