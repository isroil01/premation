/**
 * The bridge: typed functions that use the native core when a module is
 * loaded and the TypeScript implementation otherwise.
 *
 * N0 status: `loadNative()` is a stub that reports "not available" — locating
 * and instantiating the WASM / N-API binaries (per environment, per process)
 * is N1 work. `setNativeModule()` exists so tests and the N1 loader can
 * install a module; it checks the ABI version first, because calling a binary
 * whose struct layout the headers do not agree about is the one failure mode
 * that cannot be caught afterwards.
 */

import type { PropertyTrack } from '@motion/animation';
import { sampleTrack } from '@motion/animation';

import { NATIVE_ABI_VERSION_MAJOR, NATIVE_ABI_VERSION_MINOR, NATIVE_ABI_VERSION_PACKED } from './abi';
import { packedFor } from './packed';

/** What both bindings expose (bindings/napi/motion_napi.cpp; the WASM wrapper builds the same shape). */
export interface NativeEvalModule {
  /** (MAJOR << 16) | MINOR. */
  abiVersion(): number;
  /** `packed`: PACKED_DOUBLES doubles per keyframe. Throws on a non-OK status. */
  sampleScalar(packed: Float64Array, t: number): number;
  sampleScalarBatch(packed: Float64Array, times: Float64Array): Float64Array;
}

export type NativeKind = 'wasm' | 'napi';

export type NativeLoadResult =
  | { available: true; kind: NativeKind; module: NativeEvalModule }
  | { available: false; reason: string };

let active: { kind: NativeKind; module: NativeEvalModule } | null = null;

/**
 * Load the native core for this environment. N0: always unavailable — the
 * binaries exist (CI builds them) but nothing ships or locates them yet.
 */
export async function loadNative(): Promise<NativeLoadResult> {
  if (active) return { available: true, kind: active.kind, module: active.module };
  return {
    available: false,
    reason: 'N0: native binaries are not shipped or located yet (docs/NATIVE_CORE_PLAN.md §4 N1)',
  };
}

/**
 * Install (or with `null`, remove) the module the bridge routes to. Refuses a
 * module whose ABI version differs from the pinned one.
 */
export function setNativeModule(module: NativeEvalModule | null, kind: NativeKind = 'napi'): void {
  if (module === null) {
    active = null;
    return;
  }
  const v = module.abiVersion();
  if (v !== NATIVE_ABI_VERSION_PACKED) {
    const major = v >>> 16;
    const minor = v & 0xffff;
    throw new Error(
      `native core ABI ${major}.${minor} does not match the bridge's ${NATIVE_ABI_VERSION_MAJOR}.${NATIVE_ABI_VERSION_MINOR}`,
    );
  }
  active = { kind, module };
}

export function getNativeModule(): NativeEvalModule | null {
  return active?.module ?? null;
}

export function isNativeActive(): boolean {
  return active !== null;
}

/**
 * `sampleTrack(track, t)` — through the native core when one is installed,
 * otherwise the TypeScript sampler. Same result either way (the golden gate
 * holds the two to bit-identity); `undefined` for an empty track, like
 * `sampleTrack`.
 */
export function nativeSampleScalar(track: PropertyTrack, t: number): number | undefined {
  const kfs = track.keyframes;
  if (kfs.length === 0) return undefined;
  if (active !== null) return active.module.sampleScalar(packedFor(kfs), t);
  return sampleTrack(track, t);
}

/** Batch form; one validation of the track natively, a loop over `sampleTrack` in fallback. */
export function nativeSampleScalarBatch(track: PropertyTrack, times: Float64Array): Float64Array | undefined {
  const kfs = track.keyframes;
  if (kfs.length === 0) return undefined;
  if (active !== null) return active.module.sampleScalarBatch(packedFor(kfs), times);
  const out = new Float64Array(times.length);
  for (let i = 0; i < times.length; i++) out[i] = sampleTrack(track, times[i]!)!;
  return out;
}
