/**
 * Bevel cost at real resolutions — asserted as WORK DONE, not wall-clock.
 *
 * The audit measured the uncapped pass at 101 ms/frame at 1920×1080 and 386 ms at
 * 4K, against a sub-millisecond field for every other style. The point of the cap
 * is to make the per-pixel shading constant rather than resolution-proportional.
 *
 * ## Why this no longer times anything
 *
 * It used to assert `uhd < hd * 3` on elapsed milliseconds. That is a real claim
 * measured the wrong way: elapsed time depends on what else the machine is doing,
 * so the test went red under CPU contention while the code was perfectly correct.
 * An intermittently red test is worse than no test — it teaches everyone to
 * re-run rather than read, and the next genuine failure gets re-run too.
 *
 * The cap's actual guarantee is exact and countable: the shading runs on a buffer
 * capped at `BEVEL_MAX_WORK` on its long side, so the number of pixels it touches
 * is the SAME at 4K as at 1080p. Counting the pixels read is deterministic —
 * identical on a loaded laptop and an idle CI box — and it fails for the one
 * reason worth failing for: the downscale stopped happening.
 *
 * The timing table is still printed, because the absolute numbers are useful when
 * tuning. Nothing asserts on it.
 */

import { applyCanvas2dEffect, __setBevelMaxWorkForTests } from './canvas2dEffects';
import type { Effect } from './effects';
import { hasCanvas, hasFaithfulFilter } from './__testHelpers__/canvasFidelity';

const CASES: Array<[string, number, number]> = [
  ['512×512', 512, 512],
  ['1920×1080', 1920, 1080],
  ['3840×2160', 3840, 2160],
];

const CAP = 640;

const BEVEL: Effect = {
  id: 'b', type: 'bevel' as Effect['type'],
  params: {
    size: 12, depth: 100, direction: 'up', angle: 135, altitude: 45,
    highlightColor: '#ffffff', highlightOpacity: 75,
    shadowColor: '#000000', shadowOpacity: 75,
  },
} as Effect;

/** A grey block on a `w × h` canvas — something with an edge to bevel. */
function subject(w: number, h: number): CanvasRenderingContext2D {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = '#808080';
  g.fillRect(w * 0.1, h * 0.1, w * 0.8, h * 0.8);
  return g;
}

interface Measured {
  /** Every `getImageData` region the pass read, as [w, h]. */
  reads: Array<[number, number]>;
  /** Total pixels read — the per-pixel shading work. */
  pixels: number;
  ms: number;
}

/**
 * Run one bevel pass and record both the pixel work and the elapsed time.
 *
 * The pass is warmed first (the scratch buffers are cached), so the measured run
 * is the steady-state cost rather than allocation. `getImageData` is patched on
 * the shared 2D prototype because the buffers the shading reads are created
 * inside the effect — an instance spy never sees them.
 */
function measure(w: number, h: number, cap: number): Measured {
  const restore = __setBevelMaxWorkForTests(cap);
  try {
    const g = subject(w, h);
    applyCanvas2dEffect(g, w, h, BEVEL); // warm the scratch cache

    const proto = Object.getPrototypeOf(g) as CanvasRenderingContext2D;
    const original = proto.getImageData;
    const reads: Array<[number, number]> = [];
    proto.getImageData = function patched(this: CanvasRenderingContext2D, sx: number, sy: number, sw: number, sh: number) {
      reads.push([sw, sh]);
      return original.call(this, sx, sy, sw, sh);
    } as typeof proto.getImageData;

    let ms = 0;
    try {
      const t0 = performance.now();
      applyCanvas2dEffect(g, w, h, BEVEL);
      ms = performance.now() - t0;
    } finally {
      proto.getImageData = original;
    }
    return { reads, pixels: reads.reduce((n, [rw, rh]) => n + rw * rh, 0), ms };
  } finally {
    restore();
  }
}

const maybe = hasCanvas && hasFaithfulFilter ? describe : describe.skip;

maybe('bevel cost', () => {
  it('does its per-pixel work on a capped buffer, whatever the source resolution', () => {
    const rows: string[] = [];
    const capped: Measured[] = [];
    for (const [label, w, h] of CASES) {
      const full = measure(w, h, Infinity);
      const cap = measure(w, h, CAP);
      capped.push(cap);
      rows.push(
        `  ${label.padEnd(11)} uncapped ${full.ms.toFixed(1).padStart(7)} ms / ${String(full.pixels).padStart(9)} px` +
        `   capped ${cap.ms.toFixed(1).padStart(6)} ms / ${String(cap.pixels).padStart(7)} px`,
      );
    }
    console.log(`\nbevel cost (Skia backing; timings are informational, only the pixel counts are asserted)\n${rows.join('\n')}\n`);

    // Every buffer the shading reads is within the cap on its long side.
    for (const m of capped) {
      expect(m.reads.length).toBeGreaterThan(0);
      for (const [rw, rh] of m.reads) expect(Math.max(rw, rh)).toBeLessThanOrEqual(CAP);
    }

    // …and the work is CONSTANT, not merely bounded: 4K reads exactly as many
    // pixels as 1080p. This is the claim the old wall-clock ratio was reaching
    // for, and unlike elapsed time it does not move when the machine is busy.
    const [, hd, uhd] = capped;
    expect(uhd!.pixels).toBe(hd!.pixels);
  });

  it('reads the full frame when the cap is lifted — so the cap is what is doing it', () => {
    // The control. Without this, a downscale that silently stopped happening at
    // BOTH resolutions would still satisfy the equality above.
    const uhd = CASES[2]!;
    const w = uhd[1];
    const h = uhd[2];
    const full = measure(w, h, Infinity);
    expect(Math.max(...full.reads.map(([rw, rh]) => Math.max(rw, rh)))).toBeGreaterThan(CAP);
    expect(full.pixels).toBeGreaterThan(measure(w, h, CAP).pixels * 10);
  });
});
