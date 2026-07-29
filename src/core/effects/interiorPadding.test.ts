/**
 * Interior styles must work on a layer whose alpha reaches its own texture edge.
 *
 * They did not. `applyInterior` casts its band from the layer's INVERSE, and the
 * inverse was built at layer size with an oversized `fillRect(-w, -h, w*3, h*3)`
 * that the canvas simply clipped. A shape filling its texture — which every plain
 * rect layer does — therefore punched the inverse out to nothing, blurred nothing,
 * and drew no inner shadow, inner glow or satin AT ALL.
 *
 * The failure was silent and easy to misread as "the style is just subtle": the
 * distinguishing symptom is that increasing `size` makes it WEAKER rather than
 * stronger, because a wider blur reaches further into a region that does not
 * exist. That monotonicity is what this pins.
 *
 * Only `filter: blur` and globalAlpha-1 compositing are involved, both faithful
 * on the Skia backing — see __testHelpers__/canvasFidelity.ts.
 */

import { applyCanvas2dEffect } from './canvas2dEffects';
import type { Effect } from './effects';
import { hasCanvas, hasFaithfulFilter } from './__testHelpers__/canvasFidelity';

const W = 170;
const H = 130;

// NOTE the param name: inner shadow's blur radius is `softness`, and only inner
// GLOW calls it `size` (see applyInnerShadow / applyInnerGlow). Passing `size`
// here silently falls back to the registry default, so every case renders
// identically and a size sweep looks flat for entirely the wrong reason.
function innerShadow(softness: number, distance = 0): Effect {
  return {
    id: 'is', type: 'inner-shadow' as Effect['type'],
    params: { color: '#ff2d55', opacity: 100, distance, angle: 135, softness },
  } as Effect;
}

/** Render `fx` over a subject and report how much band landed. */
function bandOf(fx: Effect, inset: number): { covered: number; peak: number; outside: number } {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, W, H);
  g.fillStyle = '#3080ff';
  g.fillRect(inset, inset, W - inset * 2, H - inset * 2);

  const before = g.getImageData(0, 0, W, H).data.slice();
  applyCanvas2dEffect(g, W, H, fx);
  const after = g.getImageData(0, 0, W, H).data;

  let covered = 0;
  let peak = 0;
  let outside = 0;
  for (let i = 0; i < after.length; i += 4) {
    // How far this pixel moved toward the shadow colour.
    const d = Math.abs(after[i]! - before[i]!) + Math.abs(after[i + 1]! - before[i + 1]!);
    if (d > 8) covered++;
    if (d > peak) peak = d;
    // Anything drawn where the subject had no alpha is a leak.
    if (before[i + 3] === 0 && after[i + 3]! > 0) outside++;
  }
  return { covered, peak, outside };
}

const maybe = hasCanvas && hasFaithfulFilter ? describe : describe.skip;

maybe('interior styles on an edge-to-edge layer', () => {
  it('draws a band when the layer fills its whole texture', () => {
    // The regression: this was 0.
    expect(bandOf(innerShadow(14), 0).covered).toBeGreaterThan(0);
  });

  it('gets STRONGER with size, not weaker — the tell for the missing padding', () => {
    const small = bandOf(innerShadow(8), 0);
    const large = bandOf(innerShadow(30), 0);
    expect(large.covered).toBeGreaterThan(small.covered);
  });

  it('still works for an inset layer — the case that always worked', () => {
    expect(bandOf(innerShadow(14), 20).covered).toBeGreaterThan(0);
  });

  it('stays interior: nothing is drawn outside the silhouette', () => {
    expect(bandOf(innerShadow(20), 20).outside).toBe(0);
  });

  it('an offset inner shadow also survives the edge case', () => {
    // `distance` slides the inverse, which needs even more margin than the blur.
    expect(bandOf(innerShadow(12, 10), 0).covered).toBeGreaterThan(0);
  });

  it('inner glow — the same generator, no offset', () => {
    const glow = {
      id: 'ig', type: 'inner-glow' as Effect['type'],
      params: { color: '#ffffff', opacity: 100, size: 16 },
    } as Effect;
    expect(bandOf(glow, 0).covered).toBeGreaterThan(0);
  });
});
