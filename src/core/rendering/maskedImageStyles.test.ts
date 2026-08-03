/**
 * A masked image layer gets its interior styles, shaped by the MASK.
 *
 * This was a silent fallback: interior styles were skipped outright for any
 * masked image, so the control accepted a value and quietly did nothing —
 * the one shape of limitation this codebase keeps deleting, because unlike a
 * stated trade it is invisible to the person using it.
 *
 * The mask is now baked BEFORE the effect chain, exactly as the vector
 * rasterizer bakes it. That order is the whole point: an interior style is
 * generated from the layer's silhouette, and for a masked layer that
 * silhouette is the masked one — run the chain first and an inner shadow hangs
 * off the bitmap's rectangle instead of the mask's contour. Verified in the
 * harness against real pixels (the shadow follows a star-shaped mask's concave
 * curves); what is pinned here is the plumbing that decides it.
 */

import { imageNeedsCpuBake } from '@core/effects/effectBake';
import type { Effect } from '@core/effects/effects';
import { snapshotToFrameScene } from './snapshotToFrameScene';

const innerShadow = [{ id: 'layerstyle:innerShadow', type: 'inner-shadow', params: { size: 8 } }] as unknown as Effect[];
const gpuOnly = [{ id: 'e', type: 'blur', params: { amount: 4 } }] as unknown as Effect[];

describe('imageNeedsCpuBake', () => {
  it('bakes an image carrying a Canvas2D-only style — with or without a mask', () => {
    // The mask used to veto this outright. It no longer does, because the bake
    // applies the mask first rather than ignoring the layer.
    expect(imageNeedsCpuBake('image', innerShadow)).toBe(true);
  });

  it('does not bake for effects the GPU can already draw', () => {
    expect(imageNeedsCpuBake('image', gpuOnly)).toBe(false);
    expect(imageNeedsCpuBake('image', undefined)).toBe(false);
  });

  it('bakes VIDEO carrying Canvas2D-only styles (same contract as image)', () => {
    // Previously excluded for cost; that made interior styles a silent no-op on
    // footage. Bake is keyed by source time so scrubbing still caches.
    expect(imageNeedsCpuBake('video', innerShadow)).toBe(true);
  });

  it('leaves shapes and text alone — they rasterize themselves', () => {
    expect(imageNeedsCpuBake('shape', innerShadow)).toBe(false);
    expect(imageNeedsCpuBake('text', innerShadow)).toBe(false);
  });
});

describe('the mask is applied ONCE', () => {
  // The bake consumes the mask, so the GPU must not mask the result again.
  // Both sides read the same predicate precisely so they cannot disagree; this
  // asserts the adapter honours it.
  it('a baked image drops maskTextureKey, an unbaked one keeps it', () => {
    // Through the real adapter, not a test-only seam: the first draft of this
    // reached for a `layerToRenderableForTest` export that does not exist, so
    // the guard returned early and the test passed while asserting nothing.
    const layer = (effects: Effect[]) => ({
      id: 'im', kind: 'image', x: 50, y: 50, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
      width: 100, height: 100, visible: true, src: 'x', effects,
      mask: { paths: [{ id: 'm', mode: 'add', inverted: false, feather: 0, opacity: 100, expansion: 0, points: [] }] },
    });
    const sceneOf = (effects: Effect[]) => snapshotToFrameScene({
      width: 200, height: 200, background: '#000', time: 0,
      layers: [layer(effects)], overlays: [], view: undefined,
    } as never);

    const baked = sceneOf(innerShadow).renderables.find((r) => r.id === 'im')!;
    const plain = sceneOf(gpuOnly).renderables.find((r) => r.id === 'im')!;
    expect(baked.maskTextureKey).toBeUndefined();
    expect(plain.maskTextureKey).toBe('mask:im');
    // And the baked one hands the GPU no effects, since the chain consumed them.
    expect(baked.effects).toBeUndefined();
    expect(plain.effects?.length).toBeGreaterThan(0);
  });
});
