/**
 * Type surface of the Emscripten module built from bindings/wasm
 * (`build/wasm/bindings/wasm/motion_wasm.mjs`). Hand-written; it names the
 * EMSCRIPTEN_KEEPALIVE exports in motion_wasm.cpp plus the runtime pieces the
 * link line exports (`_malloc`, `_free`, `HEAPF64`, `UTF8ToString`).
 *
 * Memory protocol: allocate with `_malloc(bytes)` (8-byte aligned), write the
 * packed keyframes into `HEAPF64` at `ptr / 8`, call, read the result, `_free`.
 * With ALLOW_MEMORY_GROWTH the `HEAPF64` view is REPLACED when memory grows, so
 * always read `module.HEAPF64` fresh after any `_malloc` — never cache it.
 */

export interface MotionWasmModule {
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  /** Live view of linear memory as doubles. Re-read after every _malloc. */
  HEAPF64: Float64Array;
  UTF8ToString(ptr: number): string;

  /** (MAJOR << 16) | MINOR — compare with the bridge's pinned constants. */
  _motion_wasm_abi_version(): number;
  /** Pointer to a static NUL-terminated name; decode with UTF8ToString. */
  _motion_wasm_status_name(status: number): number;
  /**
   * `packedPtr`: byte offset of `count * 10` doubles (see
   * MOTION_KEYFRAME_PACKED_DOUBLES). Writes one double at `outPtr` on status 0.
   */
  _motion_wasm_sample_scalar(packedPtr: number, count: number, t: number, outPtr: number): number;
  _motion_wasm_sample_scalar_batch(
    packedPtr: number,
    count: number,
    timesPtr: number,
    n: number,
    outPtr: number,
  ): number;
}

export interface MotionWasmModuleOptions {
  /** Where to find motion_wasm.wasm when the default (next to the .mjs) is wrong. */
  locateFile?: (path: string, prefix: string) => string;
}

/** The MODULARIZE factory; resolves once the .wasm is instantiated. */
export default function createMotionWasm(options?: MotionWasmModuleOptions): Promise<MotionWasmModule>;
