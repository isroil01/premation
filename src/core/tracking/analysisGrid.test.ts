/**
 * Measuring on one grid and reporting on another.
 *
 * A tracker that decodes a 960px stand-in and reports positions in the 3840px
 * grid the UI speaks is correct. A tracker that decodes the stand-in and forgets
 * to convert ONE of the quantities it passes in is off by a constant factor, in
 * a way no test of the matcher would notice — the matcher is given wrong inputs
 * and does exactly what it was asked.
 *
 * That is not hypothetical. `points` were converted and `featureHalf` /
 * `searchHalf` were not, which was invisible for as long as the decoded grid and
 * the display grid were the same file, and becomes a four-times-too-large search
 * window the first time a stand-in is decoded. (It was also already wrong, in
 * one axis, for anamorphic footage.)
 *
 * So these tests are about the conversion itself: coordinates per axis, lengths
 * by the geometric mean, and a round trip that has to land where it started.
 */

const DISPLAY = { width: 3840, height: 2160 };

/** The conversion `openLayerFrames` installs, for a given decoded size. */
function gridFor(codedWidth: number, codedHeight: number) {
  const toCodedX = codedWidth / DISPLAY.width;
  const toCodedY = codedHeight / DISPLAY.height;
  return {
    toCodedX,
    toCodedY,
    /** display px → decoded px, per axis (a coordinate). */
    point: (p: { x: number; y: number }) => ({ x: p.x * toCodedX, y: p.y * toCodedY }),
    /** decoded px → display px, per axis (what a sample reports as). */
    unpoint: (p: { x: number; y: number }) => ({ x: p.x / toCodedX, y: p.y / toCodedY }),
    /** display px → decoded px, for a scalar LENGTH (geometric mean). */
    length: (n: number) => n * Math.sqrt(toCodedX * toCodedY),
    /** decoded px → display px, for a scalar length. */
    unlength: (n: number) => n / Math.sqrt(toCodedX * toCodedY),
  };
}

/** Every tier this walk can end up decoding, against a 4K source. */
const TIERS: Array<[string, number, number]> = [
  ['analysis 960x540', 960, 540],
  ['viewport 1920x1080', 1920, 1080],
  ['original 3840x2160', 3840, 2160],
  ['anamorphic 1920x1080 from 3840x2160 display', 1920, 1080],
];

describe('coordinates survive the round trip on every tier', () => {
  it.each(TIERS)('%s', (_label, cw, ch) => {
    const g = gridFor(cw, ch);
    for (const p of [
      { x: 0, y: 0 },
      { x: 1920, y: 1080 },
      { x: 3839, y: 2159 },
      { x: 137.5, y: 902.25 },
    ]) {
      const back = g.unpoint(g.point(p));
      expect(back.x).toBeCloseTo(p.x, 6);
      expect(back.y).toBeCloseTo(p.y, 6);
    }
  });

  it('a measurement made on the stand-in reports in DISPLAY pixels', () => {
    // The feature sits at the centre of the frame. Whatever we decode, the
    // number handed back to the UI is the centre of the 3840x2160 grid.
    const centre = { x: 1920, y: 1080 };
    for (const [, cw, ch] of TIERS) {
      const g = gridFor(cw, ch);
      const measuredOnStandIn = { x: cw / 2, y: ch / 2 };
      expect(g.unpoint(measuredOnStandIn).x).toBeCloseTo(centre.x, 6);
      expect(g.unpoint(measuredOnStandIn).y).toBeCloseTo(centre.y, 6);
    }
  });

  it('scales a track by the ratio, not by a constant', () => {
    // The failure the brief warns about: every sample off by one factor. If the
    // conversion were dropped, a 960px decode would report quarter coordinates.
    const g = gridFor(960, 540);
    const measured = { x: 240, y: 135 };          // a quarter in, on the stand-in
    expect(g.unpoint(measured)).toEqual({ x: 960, y: 540 });
    // and NOT the raw stand-in numbers
    expect(g.unpoint(measured)).not.toEqual(measured);
  });
});

describe('window sizes are lengths, and convert like lengths', () => {
  it('shrinks the search window with the decoded grid', () => {
    // 64 display px of search is 16 decoded px on a quarter-size stand-in.
    // Passing 64 straight through would search sixteen times the area, which
    // is both slower AND likelier to lock onto the wrong feature.
    const g = gridFor(960, 540);
    expect(g.length(64)).toBeCloseTo(16, 6);
    expect(g.length(24)).toBeCloseTo(6, 6);
  });

  it('is the identity on the original, so nothing moved for the common case', () => {
    const g = gridFor(3840, 2160);
    expect(g.length(64)).toBeCloseTo(64, 6);
  });

  it('round-trips a length back to what the user typed', () => {
    for (const [, cw, ch] of TIERS) {
      const g = gridFor(cw, ch);
      for (const n of [8, 24, 64, 250]) expect(g.unlength(g.length(n))).toBeCloseTo(n, 6);
    }
  });

  it('uses the geometric mean, so anamorphic footage gets one honest number', () => {
    // A 1440x1080 file displayed as 1920x1080: the axes scale differently and
    // no single number is right for both. The mean preserves AREA, which is the
    // convention `displayPlan` already set for exactly this reason.
    const toCodedX = 1440 / 1920;
    const toCodedY = 1080 / 1080;
    const mean = Math.sqrt(toCodedX * toCodedY);
    expect(mean).toBeGreaterThan(toCodedX);
    expect(mean).toBeLessThan(toCodedY);
    // A window of 100 covers 100*100 display px = 7500 decoded px of area;
    // the mean-scaled square covers the same.
    expect(mean * 100 * (mean * 100)).toBeCloseTo(100 * toCodedX * (100 * toCodedY), 6);
  });
});

describe('coasted samples', () => {
  it('keep their flag through the scaling', () => {
    // A coasted sample is an occlusion PREDICTION — honest data with a flag on
    // it, not a fabrication. Dropping it would leave a hole the interpolator
    // fills with a straight line anyway, and dropping the FLAG would present a
    // prediction as a measurement.
    const g = gridFor(960, 540);
    const samples = [
      { x: 100, y: 50, confidence: 0.9, coasted: false },
      { x: 120, y: 55, confidence: 0.2, coasted: true },
    ];
    const scaled = samples.map((s) => ({ ...s, ...g.unpoint(s) }));
    expect(scaled.map((s) => s.coasted)).toEqual([false, true]);
    expect(scaled.map((s) => s.confidence)).toEqual([0.9, 0.2]);
    expect(scaled[1]!.x).toBeCloseTo(480, 6);
  });
});
