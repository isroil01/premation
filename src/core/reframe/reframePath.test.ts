/**
 * The camera move, which is where auto-reframe is won or lost.
 *
 * Finding the subject is the easy half; what separates a usable result from a
 * seasick one is the dead zone, the lag, and the refusal to smooth across a
 * cut. All three are pure functions of a number series, so all three are
 * checkable here — and none of them is checkable by looking at a still.
 */

import {
  buildReframePath,
  coverScale,
  panRange,
  pathToKeyframes,
  type AttentionSample,
  type ReframeGeometry,
} from './reframePath';

/** 1920×1080 retargeted to 1080×1920 — the case this feature exists for. */
const WIDE_TO_TALL: ReframeGeometry = {
  sourceWidth: 1920,
  sourceHeight: 1080,
  targetWidth: 1080,
  targetHeight: 1920,
};

const at = (x: number, confidence = 1): AttentionSample => ({ x, y: 0.5, confidence });

describe('coverScale', () => {
  it('fills a tall target from a wide source', () => {
    // 1920 tall needed from 1080 → 1.777…, which also more than covers width.
    expect(coverScale(WIDE_TO_TALL)).toBeCloseTo(1920 / 1080, 6);
  });

  it('never scales below 1, which would shrink the picture inside its own crop', () => {
    expect(coverScale({ sourceWidth: 1920, sourceHeight: 1080, targetWidth: 640, targetHeight: 360 })).toBeGreaterThanOrEqual(
      640 / 1920,
    );
  });

  it('is 1 for a same-aspect retarget', () => {
    expect(coverScale({ sourceWidth: 1920, sourceHeight: 1080, targetWidth: 1920, targetHeight: 1080 })).toBe(1);
  });
});

describe('panRange', () => {
  it('gives horizontal freedom and no vertical freedom for wide → tall', () => {
    const range = panRange(WIDE_TO_TALL);
    expect(range.x).toBeGreaterThan(500);
    expect(range.y).toBeCloseTo(0, 6);
  });

  it('gives neither for a same-aspect retarget', () => {
    const range = panRange({ sourceWidth: 1920, sourceHeight: 1080, targetWidth: 960, targetHeight: 540 });
    expect(range.x).toBeCloseTo(0, 6);
    expect(range.y).toBeCloseTo(0, 6);
  });
});

describe('buildReframePath', () => {
  const opts = { sampleRate: 12, lagSeconds: 0.5, deadZone: 0.12 };

  it('holds still for a subject that stays centred', () => {
    const samples = Array.from({ length: 24 }, () => at(0.5));
    const path = buildReframePath(samples, [], WIDE_TO_TALL, opts);
    for (const x of path.x) expect(Math.abs(x)).toBeLessThan(1);
  });

  it('moves the source LEFT when the subject is on the right', () => {
    // Framing the right of the picture means pushing the source left under the
    // crop. Getting this sign backwards frames the empty half.
    const samples = Array.from({ length: 60 }, () => at(0.8));
    const path = buildReframePath(samples, [], WIDE_TO_TALL, opts);
    expect(path.x[path.x.length - 1]).toBeLessThan(0);
  });

  it('never pans past the edge of the source', () => {
    const range = panRange(WIDE_TO_TALL);
    const samples = Array.from({ length: 60 }, () => at(1));
    const path = buildReframePath(samples, [], WIDE_TO_TALL, opts);
    for (const x of path.x) expect(Math.abs(x)).toBeLessThanOrEqual(range.x + 1e-6);
  });

  it('ignores jitter inside the dead zone, so a locked-off shot stays locked', () => {
    // ±2% of frame is a centroid wobble, not a subject moving. The first sample
    // legitimately sets the framing — a shot start is a cut — so what "locked"
    // means is that the frame does not TRAVEL afterwards.
    const samples = Array.from({ length: 60 }, (_, i) => at(0.5 + (i % 2 === 0 ? 0.02 : -0.02)));
    const path = buildReframePath(samples, [], WIDE_TO_TALL, opts);
    const spread = Math.max(...path.x) - Math.min(...path.x);
    expect(spread).toBeLessThan(1);
  });

  it('does follow a subject that really leaves the dead zone', () => {
    // The other half of the same rule: slop must not become paralysis.
    const samples = Array.from({ length: 60 }, (_, i) => at(i < 30 ? 0.5 : 0.85));
    const path = buildReframePath(samples, [], WIDE_TO_TALL, opts);
    expect(Math.abs(path.x[59] as number)).toBeGreaterThan(400);
  });

  it('lags rather than snapping when the subject moves mid-shot', () => {
    // Observable only WITHIN a shot: the first sample of a shot snaps, by
    // design, so a series that starts off-centre has nothing to lag toward.
    const samples = Array.from({ length: 60 }, (_, i) => at(i < 12 ? 0.5 : 0.9));
    const path = buildReframePath(samples, [], WIDE_TO_TALL, opts);
    const settled = path.x[59] as number;
    // One sample after the subject jumps, the frame has barely started to move.
    expect(Math.abs(path.x[13] as number)).toBeLessThan(Math.abs(settled) * 0.5);
    // And it does get there.
    expect(Math.abs(settled)).toBeGreaterThan(400);
  });

  it('snaps with no lag when asked', () => {
    const samples = Array.from({ length: 20 }, (_, i) => at(i < 5 ? 0.5 : 0.9));
    const path = buildReframePath(samples, [], WIDE_TO_TALL, { ...opts, lagSeconds: 0 });
    expect(path.x[5]).toBeCloseTo(path.x[19] as number, 6);
  });

  it('JUMPS at a cut instead of sliding into the new shot', () => {
    // The worst artefact this feature can have: the crop visibly catching up
    // during the first half-second of every shot.
    const samples = [...Array.from({ length: 12 }, () => at(0.15)), ...Array.from({ length: 12 }, () => at(0.85))];
    const path = buildReframePath(samples, [12], WIDE_TO_TALL, opts);
    const before = path.x[11] as number;
    const after = path.x[12] as number;
    expect(Math.sign(before)).toBe(1);
    expect(Math.sign(after)).toBe(-1);
    // And it is THERE, not on its way there.
    expect(after).toBeCloseTo(path.x[13] as number, 6);
  });

  it('starts on the first shot framing rather than easing in from centre', () => {
    const samples = Array.from({ length: 12 }, () => at(0.9));
    const path = buildReframePath(samples, [], WIDE_TO_TALL, opts);
    expect(path.x[0]).toBeCloseTo(path.x[1] as number, 6);
  });

  it('holds through a low-confidence stretch, such as a dip to black', () => {
    const samples = [
      ...Array.from({ length: 12 }, () => at(0.85)),
      // Nothing to see: a centroid here is the average of noise.
      ...Array.from({ length: 12 }, () => ({ x: 0.1, y: 0.5, confidence: 0 })),
    ];
    const path = buildReframePath(samples, [], WIDE_TO_TALL, opts);
    expect(path.x[23]).toBeCloseTo(path.x[11] as number, 1);
  });

  it('pins the axis that has no freedom', () => {
    const samples = Array.from({ length: 24 }, () => ({ x: 0.5, y: 0.9, confidence: 1 }));
    const path = buildReframePath(samples, [], WIDE_TO_TALL, opts);
    for (const y of path.y) expect(y).toBeCloseTo(0, 6);
  });

  it('returns nothing for no samples', () => {
    expect(buildReframePath([], [], WIDE_TO_TALL, opts).x).toEqual([]);
  });
});

describe('pathToKeyframes', () => {
  it('reduces a flat path to its two endpoints', () => {
    const flat = new Array(360).fill(0);
    expect(pathToKeyframes(flat, [], 12)).toHaveLength(2);
  });

  it('keeps the shape of a curve within tolerance', () => {
    const curve = Array.from({ length: 120 }, (_, i) => 200 * Math.sin(i / 20));
    const keys = pathToKeyframes(curve, [], 12, 0.75);
    // Far fewer than every sample, but enough to be a curve rather than a line.
    expect(keys.length).toBeGreaterThan(4);
    expect(keys.length).toBeLessThan(curve.length);
  });

  it('holds the frame before a cut, so nothing ramps through it', () => {
    const path = [...new Array(12).fill(100), ...new Array(12).fill(-100)];
    const keys = pathToKeyframes(path, [12], 12);
    const held = keys.find((k) => k.easing === 'step');
    expect(held).toBeDefined();
    expect(held?.value).toBe(100);
  });

  it('keeps a keyframe on both sides of a cut', () => {
    const path = [...new Array(12).fill(100), ...new Array(12).fill(-100)];
    const times = pathToKeyframes(path, [12], 12).map((k) => k.t);
    expect(times).toContain(11 / 12);
    expect(times).toContain(12 / 12);
  });

  it('puts times on the sample-rate axis', () => {
    const keys = pathToKeyframes([0, 0, 0], [], 24);
    expect(keys[keys.length - 1]?.t).toBeCloseTo(2 / 24, 6);
  });

  it('handles a single sample and none at all', () => {
    expect(pathToKeyframes([], [], 12)).toEqual([]);
    expect(pathToKeyframes([5], [], 12)).toEqual([{ t: 0, value: 5, easing: 'linear' }]);
  });
});
