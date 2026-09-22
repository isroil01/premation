/**
 * Reads native/tests/golden_bezier.inc (the X-macro table gen_golden.ts
 * emits) for the JavaScript-side smoke tests of both bindings, so the N-API
 * addon and the WASM module are checked against the SAME numbers the Catch2
 * suite uses. CommonJS so both `require` (napi/smoke.cjs) and `import`
 * (wasm/smoke.mjs) can load it.
 *
 * Returns { packed: Float64Array (10 doubles per keyframe), count, samples: [t, expected][] }.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PACKED_DOUBLES = 10;

function loadGolden() {
  const text = fs.readFileSync(path.join(__dirname, 'golden_bezier.inc'), 'utf8');
  const kfs = [];
  const samples = [];
  for (const line of text.split(/\r?\n/)) {
    let m = /^MOTION_GOLDEN_KF\((.*)\)\s*$/.exec(line);
    if (m) {
      const nums = m[1].split(',').map((s) => Number(s.trim()));
      if (nums.length !== PACKED_DOUBLES || nums.some(Number.isNaN)) {
        throw new Error(`golden_bezier.inc: bad keyframe line: ${line}`);
      }
      kfs.push(nums);
      continue;
    }
    m = /^MOTION_GOLDEN_SAMPLE\((.*)\)\s*$/.exec(line);
    if (m) {
      const [t, v] = m[1].split(',').map((s) => Number(s.trim()));
      if (Number.isNaN(t) || Number.isNaN(v)) throw new Error(`golden_bezier.inc: bad sample: ${line}`);
      samples.push([t, v]);
    }
  }
  if (kfs.length === 0 || samples.length === 0) throw new Error('golden_bezier.inc: empty table');
  const packed = new Float64Array(kfs.length * PACKED_DOUBLES);
  kfs.forEach((k, i) => packed.set(k, i * PACKED_DOUBLES));
  return { packed, count: kfs.length, samples };
}

module.exports = { loadGolden, PACKED_DOUBLES };
