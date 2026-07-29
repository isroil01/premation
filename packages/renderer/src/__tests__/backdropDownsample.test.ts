/**
 * The backdrop-blur chain runs at half resolution.
 *
 * The blur is a fixed 61-tap kernel whose spacing widens with the radius, so
 * its cost is per-PIXEL and independent of how large the blur is. Running it at
 * full resolution therefore costs four times what it needs to, for output that
 * has no high-frequency content left to distinguish — and it runs per glass
 * layer, per frame, over the whole viewport. The render-tests goldens prove the
 * output is unchanged; this proves the saving is actually being taken.
 */

import { buildDefaultGraph } from '../rendergraph/passes';
import {
  BACKDROP_HALF1,
  BACKDROP_HALF2,
  BACKDROP_DOWNSCALE,
  BLUR_TARGET1,
} from '../rendergraph/passes';

interface TargetEntry {
  name: string;
  descriptor: (vp: { pixelSize: { width: number; height: number } }) => {
    width: number;
    height: number;
  };
}

/** Resolve a declared target's descriptor at a given viewport size. */
function sizeOf(name: string, width: number, height: number): { width: number; height: number } {
  const graph = buildDefaultGraph() as unknown as { targets: Map<string, TargetEntry> };
  const entry = graph.targets.get(name);
  if (!entry) throw new Error(`target "${name}" is not declared`);
  const d = entry.descriptor({ pixelSize: { width, height } });
  return { width: d.width, height: d.height };
}

describe('backdrop blur targets', () => {
  it('declares the backdrop chain at half the viewport size', () => {
    for (const name of [BACKDROP_HALF1, BACKDROP_HALF2]) {
      expect({ name, ...sizeOf(name, 1920, 1080) }).toEqual({
        name,
        width: 1920 / BACKDROP_DOWNSCALE,
        height: 1080 / BACKDROP_DOWNSCALE,
      });
    }
  });

  it('leaves the general-purpose blur targets at full size', () => {
    // Only the BACKDROP chain downsamples. BLUR_TARGET1/2 are shared with the
    // effect stack, where the blur is applied to a LAYER's own content —
    // softening that source would be plainly visible.
    expect(sizeOf(BLUR_TARGET1, 1920, 1080)).toEqual({ width: 1920, height: 1080 });
  });

  it('never declares a zero-sized target for a tiny viewport', () => {
    const tiny = sizeOf(BACKDROP_HALF1, 1, 1);
    expect(tiny.width).toBeGreaterThanOrEqual(1);
    expect(tiny.height).toBeGreaterThanOrEqual(1);
  });
});
