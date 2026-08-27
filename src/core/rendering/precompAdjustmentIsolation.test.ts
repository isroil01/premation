/**
 * Isolation must keep an adjustment grade inside its precomp. Collapsing the
 * group inline would emit the adjustment into the parent paint order and grade
 * siblings that sit outside the precomp.
 */
import { precompNeedsIsolation } from './snapshotToFrameScene';
import type { RenderLayer } from './RenderBackend';

function layer(partial: Partial<RenderLayer> & { id: string }): RenderLayer {
  return {
    kind: 'shape',
    x: 0, y: 0, width: 100, height: 100, opacity: 1, visible: true,
    ...partial,
  } as RenderLayer;
}

describe('precompNeedsIsolation — adjustment subtree', () => {
  it('is false for a plain multi-child precomp (fast path)', () => {
    const g = layer({
      id: 'G',
      precompLayers: [
        layer({ id: 'a' }),
        layer({ id: 'b' }),
      ],
    });
    expect(precompNeedsIsolation(g)).toBe(false);
  });

  it('is true when a direct child is an adjustment', () => {
    const g = layer({
      id: 'G',
      precompLayers: [
        layer({ id: 'inside' }),
        layer({ id: 'adj', isAdjustment: true }),
      ],
    });
    expect(precompNeedsIsolation(g)).toBe(true);
  });

  it('is true when a NESTED precomp carries an adjustment', () => {
    const g = layer({
      id: 'outer',
      precompLayers: [
        layer({
          id: 'inner',
          precompLayers: [
            layer({ id: 'content' }),
            layer({ id: 'adj', isAdjustment: true }),
          ],
        }),
      ],
    });
    expect(precompNeedsIsolation(g)).toBe(true);
  });
});
