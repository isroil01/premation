/**
 * Skew (#19) — a shear folded into the layer's model matrix.
 *
 * The composition is T · R(rotation) · Skew · Scale, so a skewed layer still
 * rotates and scales about the same pivot as an unskewed one; the shear only
 * changes the shape between them.
 */

import { layerToRenderable } from './snapshotToFrameScene';
import type { RenderLayer } from './RenderBackend';

function layer(over: Partial<RenderLayer> = {}): RenderLayer {
  return {
    id: 'n1', kind: 'shape', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1,
    opacity: 1, width: 100, height: 100, fill: '#f00', visible: true, primitive: 'rect',
    ...over,
  };
}
/** Apply a column-major Mat3 to a point. (Mat3 is a Float32Array.) */
type M = ArrayLike<number>;
const apply = (m: M, x: number, y: number) => ({
  x: m[0]! * x + m[3]! * y + m[6]!,
  y: m[1]! * x + m[4]! * y + m[7]!,
});

describe('skew', () => {
  it('is a no-op when zero — unskewed layers are byte-identical', () => {
    expect(layerToRenderable(layer({ skew: 0 })).modelMatrix)
      .toEqual(layerToRenderable(layer()).modelMatrix);
    expect(layerToRenderable(layer({ skew: undefined })).modelMatrix)
      .toEqual(layerToRenderable(layer()).modelMatrix);
  });

  it('shears horizontally by default — x shifts with y, y is untouched', () => {
    const m = layerToRenderable(layer({ skew: 30 })).modelMatrix;
    const top = apply(m, 0.5, 0);
    const bottom = apply(m, 0.5, 1);
    // The two edges of the quad slide apart horizontally...
    expect(Math.abs(bottom.x - top.x)).toBeGreaterThan(1);
    //...and the vertical extent is unchanged.
    expect(bottom.y - top.y).toBeCloseTo(100, 6);
  });

  it('a 90° skew axis shears VERTICALLY instead', () => {
    const m = layerToRenderable(layer({ skew: 30, skewAxis: 90 })).modelMatrix;
    const left = apply(m, 0, 0.5);
    const right = apply(m, 1, 0.5);
    expect(Math.abs(right.y - left.y)).toBeGreaterThan(1);
    expect(right.x - left.x).toBeCloseTo(100, 6);
  });

  it('preserves area — a shear does not add or remove pixels', () => {
    const det = (m: M) => m[0]! * m[4]! - m[1]! * m[3]!;
    expect(Math.abs(det(layerToRenderable(layer({ skew: 40 })).modelMatrix)))
      .toBeCloseTo(Math.abs(det(layerToRenderable(layer()).modelMatrix)), 4);
  });

  it('clamps near 90° instead of collapsing the layer to a streak', () => {
    // tan(90°) is infinite; an unclamped shear would produce a non-finite matrix.
    for (const skew of [89.9, 90, 120, -90, -400]) {
      const m = layerToRenderable(layer({ skew })).modelMatrix;
      expect([...m].every(Number.isFinite)).toBe(true);
    }
  });

  it('composes with rotation rather than replacing it', () => {
    const plain = layerToRenderable(layer({ rotation: 45 })).modelMatrix;
    const skewed = layerToRenderable(layer({ rotation: 45, skew: 20 })).modelMatrix;
    expect([...skewed]).not.toEqual([...plain]);
    expect([...skewed].every(Number.isFinite)).toBe(true);
  });

  it('composes with scale', () => {
    const m = layerToRenderable(layer({ skew: 20, scaleX: 2 })).modelMatrix;
    const a = apply(m, 0, 0);
    const b = apply(m, 1, 0);
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(200, 4);
  });
});
