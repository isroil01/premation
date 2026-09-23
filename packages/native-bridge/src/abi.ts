/**
 * The C ABI's numbers, mirrored — not shared — from native/include/motion/
 * (motion_abi.h, motion_eval.h). The C headers cannot be imported here, so
 * `abiPinned.test.ts` parses them and fails if anything below drifts.
 * `native/tests/gen_golden.ts` carries the same table for the generator.
 */

import type { EasingKind, SpatialInterp } from '@motion/animation';

export const NATIVE_ABI_VERSION_MAJOR = 0;
export const NATIVE_ABI_VERSION_MINOR = 2;
/** (MAJOR << 16) | MINOR — what `motion_abi_version()` returns. */
export const NATIVE_ABI_VERSION_PACKED =
  (NATIVE_ABI_VERSION_MAJOR << 16) | NATIVE_ABI_VERSION_MINOR;

/** MOTION_KEYFRAME_PACKED_DOUBLES: [t, value, easing, flags, c0, c1, c2, c3, si, so]. */
export const PACKED_DOUBLES = 10;

/** motion_easing. `step` and `hold` sample identically; both round-trip. */
export const NATIVE_EASING: Readonly<Record<EasingKind, number>> = {
  linear: 0,
  hold: 1,
  bezier: 2,
  easeIn: 3,
  easeOut: 4,
  easeInOut: 5,
  ease: 6,
  autoBezier: 7,
  continuousBezier: 8,
  step: 9,
};

/** motion_keyframe.flags bits. */
export const KF_HAS_BEZIER = 0x1;
export const KF_HAS_SI = 0x2;
export const KF_HAS_SO = 0x4;
export const KF_SPATIAL_SHIFT = 4;

/** motion_spatial, stored in flags bits 4..7; absent `spatialInterp` = 0 (unset). */
export const NATIVE_SPATIAL: Readonly<Record<SpatialInterp, number>> = {
  linear: 1,
  bezier: 2,
  continuous: 3,
  auto: 4,
};

/** motion_status, by value. */
export const NATIVE_STATUS = ['OK', 'INVALID_ARG', 'OUT_OF_RANGE', 'INTERNAL'] as const;
export type NativeStatusName = (typeof NATIVE_STATUS)[number];
