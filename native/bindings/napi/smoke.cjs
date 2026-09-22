/**
 * N-API smoke test, run by CI after `npx cmake-js compile` in this directory:
 *
 *     node native/bindings/napi/smoke.cjs
 *
 * Same contract as the WASM smoke and the Catch2 "[golden][bits]" case: every
 * golden sample must be bit-identical to the TypeScript-generated table, and
 * bad input must arrive as a thrown Error carrying the status name.
 */
'use strict';

const assert = require('node:assert/strict');
const native = require('./index.cjs');
const { loadGolden, PACKED_DOUBLES } = require('../../tests/golden_table.cjs');

const version = native.abiVersion();
const major = version >>> 16;
const minor = version & 0xffff;
console.log(`motion_napi: abi ${major}.${minor}`);
assert.equal(major, 0);
assert.equal(minor, 1);
assert.equal(native.packedDoubles, PACKED_DOUBLES);

const { packed, samples } = loadGolden();

let failures = 0;
for (const [t, expected] of samples) {
  const actual = native.sampleScalar(packed, t);
  if (!Object.is(actual, expected)) {
    failures += 1;
    console.error(`t=${t}: expected ${expected}, got ${actual}`);
  }
}
assert.equal(failures, 0, `${failures}/${samples.length} golden samples differ`);

const times = new Float64Array(samples.map(([t]) => t));
const out = native.sampleScalarBatch(packed, times);
assert.ok(out instanceof Float64Array);
assert.equal(out.length, times.length);
samples.forEach(([t, expected], i) => {
  assert.ok(Object.is(out[i], expected), `batch t=${t}: expected ${expected}, got ${out[i]}`);
});

// Errors are JavaScript errors named by status, never a crash.
assert.throws(() => native.sampleScalar(new Float64Array(0), 0.5), /RangeError|multiple of 10/);
assert.throws(() => native.sampleScalar(packed, NaN), /INVALID_ARG/);
assert.throws(() => native.sampleScalar(new Float64Array([0, 0, 99, 0, 0, 0, 0, 0, 0, 0]), 0.5), /INVALID_ARG/);
assert.throws(() => native.sampleScalar([1, 2, 3], 0.5), /TypeError|Float64Array/);
assert.equal(native.sampleScalarBatch(packed, new Float64Array(0)).length, 0);

console.log(`motion_napi: ${samples.length} golden samples bit-identical, errors are Errors — OK`);
