/**
 * Clip baking — the conversions that silently ruin animation if wrong:
 * coordinate flips on translation, slerp-arc densification, and euler
 * unwrapping across the ±180° seam (without it a spinning node snaps back a
 * full turn between two keyframes).
 */

import { bakeChannelTracks, bakeClip } from './modelAnimation';
import type { GltfChannel } from '@core/media/gltf';

const chan = (partial: Partial<GltfChannel> & Pick<GltfChannel, 'path' | 'times' | 'values'>): GltfChannel => ({
  node: 0,
  interpolation: 'LINEAR',
  ...partial,
});

/** Quaternion for a rotation about z by `deg` (glTF x,y,z,w order). */
const qz = (deg: number): number[] => {
  const h = (deg * Math.PI) / 360;
  return [0, 0, Math.sin(h), Math.cos(h)];
};

describe('bakeChannelTracks', () => {
  it('translation bakes to x/y/z with the compositor flip and linear easing', () => {
    const tracks = bakeChannelTracks(chan({
      path: 'translation',
      times: new Float32Array([0, 1]),
      values: new Float32Array([0, 0, 0, 1, 2, 3]),
    }));
    expect(tracks.map((t) => t.prop)).toEqual(['x', 'y', 'z']);
    expect(tracks[0]!.keyframes[1]).toMatchObject({ t: 1, value: 1, easing: 'linear' });
    expect(tracks[1]!.keyframes[1]!.value).toBe(-2);
    expect(tracks[2]!.keyframes[1]!.value).toBe(-3);
  });

  it('STEP interpolation becomes hold keyframes, never densified', () => {
    const tracks = bakeChannelTracks(chan({
      path: 'rotation',
      interpolation: 'STEP',
      times: new Float32Array([0, 2]),
      values: new Float32Array([...qz(0), ...qz(90)]),
    }));
    const rz = tracks.find((t) => t.prop === 'rotation')!;
    expect(rz.keyframes).toHaveLength(2);
    expect(rz.keyframes.every((k) => k.easing === 'step')).toBe(true);
  });

  it('sparse rotation spans densify along the slerp arc', () => {
    const tracks = bakeChannelTracks(chan({
      path: 'rotation',
      times: new Float32Array([0, 1]),
      values: new Float32Array([...qz(0), ...qz(90)]),
    }));
    const rz = tracks.find((t) => t.prop === 'rotation')!;
    // 1s at 15 samples/s → well over the two file keys.
    expect(rz.keyframes.length).toBeGreaterThan(10);
    // Monotonic sweep 0→90 (glTF z-rotation converts to a NEGATIVE compositor
    // sweep or positive — direction is pinned by the euler round-trip suite;
    // here we require monotonicity and the right total magnitude).
    const values = rz.keyframes.map((k) => k.value);
    const deltas = values.slice(1).map((v, i) => v - values[i]!);
    expect(deltas.every((d) => d >= -1e-6) || deltas.every((d) => d <= 1e-6)).toBe(true);
    expect(Math.abs(values[values.length - 1]! - values[0]!)).toBeCloseTo(90, 0);
  });

  it('unwraps across the ±180° seam instead of snapping back', () => {
    // 0° → 120° → 240° about z: the naive conversion of 240° is −120°.
    const tracks = bakeChannelTracks(chan({
      path: 'rotation',
      times: new Float32Array([0, 0.1, 0.2]), // tight spacing: no densify
      values: new Float32Array([...qz(0), ...qz(120), ...qz(240)]),
    }));
    const rz = tracks.find((t) => t.prop === 'rotation')!;
    // Densification may insert midpoints; the CONTRACT is the endpoint: the
    // full 240° swept continuously, not snapped to its wrapped twin at 120°.
    const values = rz.keyframes.map((k) => Math.abs(k.value));
    expect(values[values.length - 1]!).toBeCloseTo(240, 0);
    const raw = rz.keyframes.map((k) => k.value);
    const deltas = raw.slice(1).map((v, i) => v - raw[i]!);
    expect(deltas.every((d) => Math.abs(d) < 180)).toBe(true); // no 360° snap anywhere
  });

  it('CUBICSPLINE reads the value element out of the tangent triples', () => {
    // Per key: inTangent(3) value(3) outTangent(3).
    const tracks = bakeChannelTracks(chan({
      path: 'translation',
      interpolation: 'CUBICSPLINE',
      times: new Float32Array([0, 1]),
      values: new Float32Array([
        9, 9, 9, /*value*/ 1, 2, 3, 9, 9, 9,
        9, 9, 9, /*value*/ 4, 5, 6, 9, 9, 9,
      ]),
    }));
    expect(tracks[0]!.keyframes.map((k) => k.value)).toEqual([1, 4]);
    expect(tracks[1]!.keyframes.map((k) => k.value)).toEqual([-2, -5]);
  });
});

describe('bakeClip', () => {
  it('groups tracks by node and reports the clip duration', () => {
    const clip = bakeClip({
      name: 'walk',
      channels: [
        chan({ node: 3, path: 'translation', times: new Float32Array([0, 2]), values: new Float32Array([0, 0, 0, 1, 0, 0]) }),
        chan({ node: 5, path: 'scale', times: new Float32Array([0, 1.5]), values: new Float32Array([1, 1, 1, 2, 2, 2]) }),
      ],
    });
    expect([...clip.byNode.keys()].sort()).toEqual([3, 5]);
    expect(clip.byNode.get(3)!.map((t) => t.prop)).toEqual(['x', 'y', 'z']);
    expect(clip.byNode.get(5)!.map((t) => t.prop)).toEqual(['scaleX', 'scaleY', 'scaleZ']);
    expect(clip.duration).toBe(2);
  });
});
