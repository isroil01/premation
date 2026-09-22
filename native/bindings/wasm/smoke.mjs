/**
 * WASM smoke test, run by CI after `cmake --build --preset wasm`:
 *
 *     node native/bindings/wasm/smoke.mjs [path/to/motion_wasm.mjs]
 *
 * Instantiates the module in Node, checks the ABI version, then samples the
 * golden track through the packed protocol and compares every value with the
 * TypeScript-generated table — exact equality, the same contract as the C++
 * suite's "[golden][bits]" case.
 */

import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { loadGolden, PACKED_DOUBLES } = require('../../tests/golden_table.cjs');

const here = dirname(fileURLToPath(import.meta.url));
const modulePath = resolve(process.argv[2] ?? resolve(here, '../../build/wasm/bindings/wasm/motion_wasm.mjs'));

const { default: createMotionWasm } = await import(pathToFileURL(modulePath).href);
const m = await createMotionWasm();

const version = m._motion_wasm_abi_version();
const major = version >>> 16;
const minor = version & 0xffff;
console.log(`motion_wasm: abi ${major}.${minor}`);
if (major !== 0 || minor !== 1) throw new Error(`unexpected ABI version ${major}.${minor}`);

const { packed, count, samples } = loadGolden();
if (packed.length !== count * PACKED_DOUBLES) throw new Error('golden table stride mismatch');

const packedPtr = m._malloc(packed.byteLength);
const outPtr = m._malloc(8);
try {
  // HEAPF64 is re-created on growth: index it fresh after the mallocs.
  m.HEAPF64.set(packed, packedPtr / 8);
  let failures = 0;
  for (const [t, expected] of samples) {
    const status = m._motion_wasm_sample_scalar(packedPtr, count, t, outPtr);
    if (status !== 0) throw new Error(`status ${m.UTF8ToString(m._motion_wasm_status_name(status))} at t=${t}`);
    const actual = m.HEAPF64[outPtr / 8];
    if (!Object.is(actual, expected)) {
      failures += 1;
      console.error(`t=${t}: expected ${expected}, got ${actual}`);
    }
  }
  if (failures > 0) throw new Error(`${failures}/${samples.length} golden samples differ`);

  // Batch path, same numbers.
  const times = new Float64Array(samples.map(([t]) => t));
  const timesPtr = m._malloc(times.byteLength);
  const batchOutPtr = m._malloc(times.byteLength);
  try {
    m.HEAPF64.set(times, timesPtr / 8);
    const status = m._motion_wasm_sample_scalar_batch(packedPtr, count, timesPtr, times.length, batchOutPtr);
    if (status !== 0) throw new Error(`batch status ${status}`);
    const out = m.HEAPF64.subarray(batchOutPtr / 8, batchOutPtr / 8 + times.length);
    samples.forEach(([t, expected], i) => {
      if (!Object.is(out[i], expected)) throw new Error(`batch t=${t}: expected ${expected}, got ${out[i]}`);
    });
  } finally {
    m._free(timesPtr);
    m._free(batchOutPtr);
  }

  // Errors come back as statuses, not traps.
  if (m._motion_wasm_sample_scalar(packedPtr, 0, 0.5, outPtr) !== 1) throw new Error('count=0 should be INVALID_ARG');
  if (m._motion_wasm_sample_scalar(packedPtr, count, NaN, outPtr) !== 1) throw new Error('NaN t should be INVALID_ARG');
} finally {
  m._free(packedPtr);
  m._free(outPtr);
}
console.log(`motion_wasm: ${samples.length} golden samples bit-identical, errors are statuses — OK`);
