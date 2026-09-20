/**
 * AE's speed/influence easing → cubic bezier handles.
 *
 * The conversion is four lines of algebra and every one of them is a place a
 * plausible-looking mistake produces animation that plays but feels wrong. So
 * the cases here are the ones with a known right answer: no ease is linear, a
 * symmetric ease is symmetric, a hold holds, and a flat segment does not
 * produce a NaN.
 */

import { segmentBezier, toKeyframeTrack } from '../aepEase';
import type { AepKeyframe } from '../aepModel';

const kf = (o: Partial<AepKeyframe> & { time: number; value: number[] }): AepKeyframe => ({
  inInterpolation: 'bezier',
  outInterpolation: 'bezier',
  inSpeed: [0],
  inInfluence: [0],
  outSpeed: [0],
  outInfluence: [0],
  temporalAutoBezier: false,
  temporalContinuous: false,
  spatialAutoBezier: false,
  spatialContinuous: false,
  roving: false,
  ...o,
});

describe('segmentBezier', () => {
  it('reads zero influence as a straight ramp', () => {
    // A bezier keyframe with no ease applied: the handles sit on the
    // keyframes, which is a linear curve.
    const handles = segmentBezier(kf({ time: 0, value: [0] }), kf({ time: 1, value: [100] }), 0);
    expect(handles).toEqual([0, 0, 1, 1]);
  });

  it('converts a symmetric ease into symmetric handles', () => {
    // 75 % in and out with zero speed is AE's classic slow-in/slow-out, and its
    // curve is cubic-bezier(0.75, 0, 0.25, 1).
    const handles = segmentBezier(
      kf({ time: 0, value: [0], outInfluence: [0.75] }),
      kf({ time: 5, value: [100], inInfluence: [0.75] }),
      0,
    );
    expect(handles[0]).toBeCloseTo(0.75, 6);
    expect(handles[1]).toBeCloseTo(0, 6);
    expect(handles[2]).toBeCloseTo(0.25, 6);
    expect(handles[3]).toBeCloseTo(1, 6);
  });

  it('turns a real speed into a handle height, normalised by the segment', () => {
    // Leaving at 50 units/second over a 2 s, 100-unit segment is exactly the
    // segment's own average speed, so the handle lies on the straight line:
    // y = speed·dt/dv·influence = 50·2/100·0.5 = 0.5 at x = 0.5.
    const handles = segmentBezier(
      kf({ time: 0, value: [0], outSpeed: [50], outInfluence: [0.5] }),
      kf({ time: 2, value: [100] }),
      0,
    );
    expect(handles[0]).toBeCloseTo(0.5, 6);
    expect(handles[1]).toBeCloseTo(0.5, 6);
  });

  it('does not divide by a zero value change', () => {
    // A segment whose value does not change has no vertical scale to normalise
    // against. Dividing anyway yields Infinity and then NaN, and a NaN handle
    // propagates into the sampled value and blanks the layer.
    const handles = segmentBezier(
      kf({ time: 0, value: [50], outSpeed: [10], outInfluence: [0.3] }),
      kf({ time: 1, value: [50], inInfluence: [0.3] }),
      0,
    );
    expect(handles.every(Number.isFinite)).toBe(true);
    expect(handles).toEqual([0.3, 0.3, 0.7, 0.7]);
  });

  it('eases each dimension on its own', () => {
    const from = kf({ time: 0, value: [0, 0], outInfluence: [0.2, 0.8] });
    const to = kf({ time: 1, value: [10, 10] });
    expect(segmentBezier(from, to, 0)[0]).toBeCloseTo(0.2, 6);
    expect(segmentBezier(from, to, 1)[0]).toBeCloseTo(0.8, 6);
  });
});

describe('toKeyframeTrack', () => {
  it('keeps a linear pair linear rather than promoting it to a bezier', () => {
    const track = toKeyframeTrack(
      [
        kf({ time: 0, value: [0], inInterpolation: 'linear', outInterpolation: 'linear' }),
        kf({ time: 1, value: [10], inInterpolation: 'linear', outInterpolation: 'linear' }),
      ],
      0,
    );
    expect(track[0]!.easing).toBe('linear');
    expect(track[0]!.bezier).toBeUndefined();
  });

  it('holds on a hold keyframe whatever the next one says', () => {
    const track = toKeyframeTrack(
      [
        kf({ time: 0, value: [0], outInterpolation: 'hold' }),
        kf({ time: 1, value: [10], inInterpolation: 'bezier' }),
      ],
      0,
    );
    expect(track[0]!.easing).toBe('hold');
  });

  it('applies the scale to values, tangents and nothing else', () => {
    // A unit change scales the value and the tangent; an ORIGIN change is a
    // translation and must not move a tangent, which is a difference.
    const track = toKeyframeTrack(
      [
        kf({ time: 0, value: [10], outTangent: [4], inTangent: [2] }),
        kf({ time: 1, value: [20] }),
      ],
      0,
      { scale: 2, offset: -5 },
    );
    expect(track[0]!.value).toBe(15);
    expect(track[0]!.so).toBe(8);
    expect(track[0]!.si).toBe(4);
  });

  it('shifts every time by the offset', () => {
    const track = toKeyframeTrack([kf({ time: 1, value: [0] })], 0, { timeOffset: 2 });
    expect(track[0]!.t).toBe(3);
  });

  it('marks a corner vertex linear so its zero tangents are not used as real ones', () => {
    const track = toKeyframeTrack(
      [kf({ time: 0, value: [0], inTangent: [0], outTangent: [0] }), kf({ time: 1, value: [5] })],
      0,
    );
    expect(track[0]!.spatialInterp).toBe('linear');
  });

  it('never marks an end keyframe as roving', () => {
    // AE will not let you rove the first or last keyframe, and the engine's
    // rover would have no anchor on one side if it could.
    const track = toKeyframeTrack(
      [kf({ time: 0, value: [0], roving: true }), kf({ time: 1, value: [5], roving: true }), kf({ time: 2, value: [9], roving: true })],
      0,
    );
    expect(track[0]!.roving).toBeUndefined();
    expect(track[1]!.roving).toBe(true);
    expect(track[2]!.roving).toBeUndefined();
  });
});
