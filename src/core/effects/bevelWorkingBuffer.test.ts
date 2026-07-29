/**
 * The bevel's working-buffer cap must change the COST, not the look.
 *
 * The bevel was the only effect with a resolution-proportional cost — 101 ms/frame
 * at 1080p and 386 ms at 4K, against a sub-millisecond field for every other
 * style. Capping the shading buffer fixes that, and an earlier attempt at exactly
 * this was reverted because the shading came out flat and there was no gate to
 * catch it before it shipped. This is that gate.
 *
 * It runs the SAME input through both paths. That matters: the algorithm is not
 * scale-invariant — the surface normal comes from a per-pixel slope, so rendering
 * a 2× scene with a 2× blur radius genuinely halves the shading — and two
 * different scenes therefore cannot be compared to each other. Only "identical
 * pixels in, cap on vs cap off" isolates the working buffer.
 *
 * Uses `filter: blur` (faithful on the Skia backing, unlike node-canvas) and
 * composites only at globalAlpha 1, avoiding the alpha-algebra deviation
 * documented in __testHelpers__/canvasFidelity.ts.
 */

import { applyCanvas2dEffect, __setBevelMaxWorkForTests } from './canvas2dEffects';
import type { Effect } from './effects';
import { hasCanvas, hasFaithfulFilter } from './__testHelpers__/canvasFidelity';

const SIZE = 1200;      // comfortably over the 640 cap
const INSET = 240;      // subject margin, so there is a wide flat interior
const BLUR = 12;        // bevel width in px — kept tight, since a wide blur
                        // yields a shallow gradient and therefore a weak, hard-to-
                        // measure ramp (60px here spans only ~3 levels of luminance).

function bevelEffect(): Effect {
  return {
    id: 'b', type: 'bevel' as Effect['type'],
    params: {
      size: BLUR, depth: 100, direction: 'up', angle: 135, altitude: 45,
      highlightColor: '#ffffff', highlightOpacity: 75,
      shadowColor: '#000000', shadowOpacity: 75,
    },
  } as Effect;
}

/** An opaque mid-grey square on transparent — a clean alpha edge to bevel. */
function subject(): CanvasRenderingContext2D {
  const c = document.createElement('canvas');
  c.width = SIZE;
  c.height = SIZE;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, SIZE, SIZE);
  g.fillStyle = '#808080';
  g.fillRect(INSET, INSET, SIZE - INSET * 2, SIZE - INSET * 2);
  return g;
}

/** Render the bevel at a given cap and read the luminance ramp inward from the top edge. */
function profileAtCap(cap: number): { profile: number[]; ms: number; outside: number } {
  const restore = __setBevelMaxWorkForTests(cap);
  try {
    const g = subject();
    const t0 = performance.now();
    applyCanvas2dEffect(g, SIZE, SIZE, bevelEffect());
    const ms = performance.now() - t0;
    const px = g.getImageData(0, 0, SIZE, SIZE).data;
    const lum = (x: number, y: number): number => {
      const i = (y * SIZE + x) * 4;
      return 0.2126 * px[i]! + 0.7152 * px[i + 1]! + 0.0722 * px[i + 2]!;
    };
    // Straight down the middle, from the top edge into the interior — this
    // crosses the whole bevel ramp.
    const profile = Array.from({ length: 12 }, (_, i) => lum(SIZE / 2, INSET + 1 + i * 3));
    return { profile, ms, outside: px[(20 * SIZE + 20) * 4 + 3]! };
  } finally {
    restore();
  }
}

const maybe = hasCanvas && hasFaithfulFilter ? describe : describe.skip;

maybe('bevel working-buffer cap', () => {
  let full: ReturnType<typeof profileAtCap>;
  let capped: ReturnType<typeof profileAtCap>;

  beforeAll(() => {
    full = profileAtCap(Infinity);
    capped = profileAtCap(640);
  });

  const spread = (p: number[]): number => Math.max(...p) - Math.min(...p);

  it('the full-resolution path shades at all — the control', () => {
    expect(spread(full.profile)).toBeGreaterThan(8);
  });

  it('the capped path does NOT flatten — the failure the last attempt shipped', () => {
    // The reverted attempt produced a flat profile here while the control varied.
    expect(spread(capped.profile)).toBeGreaterThan(8);
  });

  it('the capped profile tracks the full-resolution one', () => {
    const maxDelta = Math.max(...full.profile.map((v, i) => Math.abs(v - capped.profile[i]!)));
    // Upsampling the bands softens the ramp slightly; the shape must survive.
    expect(maxDelta).toBeLessThan(14);
  });

  it('shading keeps its direction and magnitude, not just its variance', () => {
    // Both must ramp the same way — a sign flip would pass a spread check.
    const slope = (p: number[]): number => p[p.length - 1]! - p[0]!;
    expect(Math.sign(slope(capped.profile))).toBe(Math.sign(slope(full.profile)));
    expect(Math.abs(slope(capped.profile))).toBeGreaterThan(Math.abs(slope(full.profile)) * 0.6);
  });

  it('adds nothing outside the silhouette even when the bands are upsampled', () => {
    // `lighter` composites additively, so a band that bleeds past the alpha edge
    // during upsampling would light up transparent background.
    expect(capped.outside).toBe(0);
    expect(full.outside).toBe(0);
  });

  it('is materially cheaper than the full-resolution path', () => {
    expect(capped.ms).toBeLessThan(full.ms);
  });
});
