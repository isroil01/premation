/**
 * @motion/native-bridge — the only module that may import the native core's
 * WASM or N-API build (docs/NATIVE_CORE_PLAN.md §3). Everything else calls
 * these typed functions and gets the TypeScript implementation when no native
 * module is installed. No React, no DOM, no editor state.
 */

export {
  NATIVE_ABI_VERSION_MAJOR,
  NATIVE_ABI_VERSION_MINOR,
  NATIVE_ABI_VERSION_PACKED,
  NATIVE_EASING,
  NATIVE_SPATIAL,
  NATIVE_STATUS,
  PACKED_DOUBLES,
  KF_HAS_BEZIER,
  KF_HAS_SI,
  KF_HAS_SO,
  KF_SPATIAL_SHIFT,
} from './abi';
export type { NativeStatusName } from './abi';

export { packKeyframes, packedFor, keyframeFlags } from './packed';

export {
  loadNative,
  setNativeModule,
  getNativeModule,
  isNativeActive,
  nativeSampleScalar,
  nativeSampleScalarBatch,
} from './bridge';
export type { NativeEvalModule, NativeKind, NativeLoadResult } from './bridge';
