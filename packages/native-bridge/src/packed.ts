/**
 * Keyframe[] → the packed Float64Array both native bindings read
 * (MOTION_KEYFRAME_PACKED_DOUBLES per keyframe, see motion_eval.h).
 *
 * Packed arrays are cached per keyframe ARRAY in a WeakMap — the same
 * reasoning as `segmentCursor` in interpolate.ts: every mutation path builds a
 * fresh array, so a cached packing can never outlive the data it encodes.
 */

import type { Keyframe } from '@motion/animation';

import {
  KF_HAS_BEZIER,
  KF_HAS_SI,
  KF_HAS_SO,
  KF_SPATIAL_SHIFT,
  NATIVE_EASING,
  NATIVE_SPATIAL,
  PACKED_DOUBLES,
} from './abi';

/** flags for one keyframe (presence bits + spatial mode). */
export function keyframeFlags(k: Keyframe): number {
  let f = 0;
  if (k.bezier !== undefined) f |= KF_HAS_BEZIER;
  if (k.si !== undefined) f |= KF_HAS_SI;
  if (k.so !== undefined) f |= KF_HAS_SO;
  if (k.spatialInterp !== undefined) f |= NATIVE_SPATIAL[k.spatialInterp] << KF_SPATIAL_SHIFT;
  return f;
}

/** Pack into a new Float64Array. Absent handles/tangents are written as 0 and unflagged. */
export function packKeyframes(kfs: readonly Keyframe[]): Float64Array {
  const out = new Float64Array(kfs.length * PACKED_DOUBLES);
  for (let i = 0; i < kfs.length; i++) {
    const k = kfs[i]!;
    const o = i * PACKED_DOUBLES;
    const [c0, c1, c2, c3] = k.bezier ?? [0, 0, 0, 0];
    out[o] = k.t;
    out[o + 1] = k.value;
    out[o + 2] = NATIVE_EASING[k.easing ?? 'linear'];
    out[o + 3] = keyframeFlags(k);
    out[o + 4] = c0;
    out[o + 5] = c1;
    out[o + 6] = c2;
    out[o + 7] = c3;
    out[o + 8] = k.si ?? 0;
    out[o + 9] = k.so ?? 0;
  }
  return out;
}

const packedCache = new WeakMap<readonly Keyframe[], Float64Array>();

/** The packed form of `kfs`, cached per array identity. */
export function packedFor(kfs: readonly Keyframe[]): Float64Array {
  let packed = packedCache.get(kfs);
  if (packed === undefined) {
    packed = packKeyframes(kfs);
    packedCache.set(kfs, packed);
  }
  return packed;
}
