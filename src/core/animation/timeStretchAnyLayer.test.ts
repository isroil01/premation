/**
 * Time Stretch on a layer with NO source — a solid here — which After Effects
 * stretches by scaling the bar and the keyframes about the Hold in Place frame.
 * Clip bars are frames (end exclusive); keyframe times are read back on the
 * comp axis through `keyframeToCompTime`, the map the timeline draws with.
 */




import {
  
  bakeStretchGeometry,
  clampSignedStretch,
  retimeKeys,
  
} from './layerTimeCommands';

describe('the bake maths', () => {
  it('a split layer keeps every bar showing the same key at the same frame', () => {
    // Two bars of one layer, the second continuing the first's keyframe time.
    const plan = bakeStretchGeometry(
      [{ start: 0, duration: 30, sourceIn: 0 }, { start: 40, duration: 30, sourceIn: 40 }],
      2, 0, 30,
    )!;
    expect(plan.bars).toEqual([{ start: 0, duration: 60, sourceIn: 0 }, { start: 80, duration: 60, sourceIn: 80 }]);
    expect(plan).toMatchObject({ keyScale: 2, keyOffset: 0 });
  });

  it('reversing mirrors bezier handles in time and swaps spatial tangents', () => {
    const out = retimeKeys(
      [
        { t: 0, value: 0, easing: 'bezier' as const, bezier: [0.2, 0.1, 0.6, 0.9] as [number, number, number, number], so: 5 },
        { t: 1, value: 1, si: 3 },
      ],
      -1,
      1,
    );
    expect(out.map((k) => k.t)).toEqual([0, 1]);
    expect(out[0]).toMatchObject({ value: 1, so: 3, easing: 'bezier' });
    expect(out[0]!.bezier![0]).toBeCloseTo(0.4);
    expect(out[0]!.bezier![1]).toBeCloseTo(0.1);
    expect(out[0]!.bezier![2]).toBeCloseTo(0.8);
    expect(out[0]!.bezier![3]).toBeCloseTo(0.9);
    expect(out[1]).toMatchObject({ value: 0, si: 5 });
  });

  it('a signed factor clamps its magnitude and keeps its sign', () => {
    expect(clampSignedStretch(-5000)).toBe(-1000);
    expect(clampSignedStretch(-0.2)).toBe(100);
    expect(clampSignedStretch(150.4)).toBe(150);
  });
});
