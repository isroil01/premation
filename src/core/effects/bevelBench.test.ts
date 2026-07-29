/**
 * Bevel cost at real resolutions. Not a gate — it prints a table and asserts only
 * that the capped path is bounded, so it cannot go red on a slow CI box.
 *
 * The audit measured the uncapped pass at 101 ms/frame at 1920×1080 and 386 ms at
 * 4K, against a sub-millisecond field for every other style. The point of the cap
 * is to make that constant rather than resolution-proportional.
 */

import { applyCanvas2dEffect, __setBevelMaxWorkForTests } from './canvas2dEffects';
import type { Effect } from './effects';
import { hasCanvas, hasFaithfulFilter } from './__testHelpers__/canvasFidelity';

const CASES: Array<[string, number, number]> = [
  ['512×512', 512, 512],
  ['1920×1080', 1920, 1080],
  ['3840×2160', 3840, 2160],
];

function run(w: number, h: number, cap: number): number {
  const restore = __setBevelMaxWorkForTests(cap);
  try {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d')!;
    g.fillStyle = '#808080';
    g.fillRect(w * 0.1, h * 0.1, w * 0.8, h * 0.8);
    const fx = {
      id: 'b', type: 'bevel' as Effect['type'],
      params: {
        size: 12, depth: 100, direction: 'up', angle: 135, altitude: 45,
        highlightColor: '#ffffff', highlightOpacity: 75,
        shadowColor: '#000000', shadowOpacity: 75,
      },
    } as Effect;
    applyCanvas2dEffect(g, w, h, fx); // warm the scratch cache
    const t0 = performance.now();
    applyCanvas2dEffect(g, w, h, fx);
    return performance.now() - t0;
  } finally {
    restore();
  }
}

const maybe = hasCanvas && hasFaithfulFilter ? describe : describe.skip;

maybe('bevel cost', () => {
  it('is bounded rather than resolution-proportional', () => {
    const rows: string[] = [];
    const capped: number[] = [];
    for (const [label, w, h] of CASES) {
      const full = run(w, h, Infinity);
      const cap = run(w, h, 640);
      capped.push(cap);
      rows.push(`  ${label.padEnd(11)} uncapped ${full.toFixed(1).padStart(7)} ms   capped ${cap.toFixed(1).padStart(6)} ms   ${(full / cap).toFixed(1)}×`);
    }
    // eslint-disable-next-line no-console
    console.log(`\nbevel cost (Skia backing; absolute numbers differ from Chromium)\n${rows.join('\n')}\n`);

    // The claim is bounded cost: 4K must not cost dramatically more than 1080p.
    const [, hd, uhd] = capped;
    expect(uhd!).toBeLessThan(hd! * 3);
  });
});
