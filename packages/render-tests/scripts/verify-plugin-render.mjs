/**
 * Did the plugin effect actually run, and did it do the right thing?
 *
 *   node packages/render-tests/scripts/verify-plugin-render.mjs [backend]
 *
 * Reads the two plugin scenes out of `.artifacts/actual/<backend>/` and
 * compares the RIGHT square (effect applied) against the LEFT one (control) in
 * the same frame. Comparing halves of one frame rather than against a golden is
 * deliberate: a golden blessed while the feature was inert would have recorded
 * "the effect changes nothing" as the correct answer, which is the exact bug
 * this is here to catch. The control cannot be stale, because it is rendered by
 * the same pass, in the same frame, one square to the left.
 *
 * Two scenes, and the pair is the point:
 *
 *   plugin-identity  an exact identity shader — the squares must MATCH. Catches
 *                    a plugin effect that damages the layer.
 *   plugin-visible   a shader that removes red — the squares must DIFFER, in
 *                    red only. Catches a plugin effect that is skipped
 *                    entirely, which "matches" the identity test perfectly.
 *
 * Neither alone is worth much. Together they pin the effect to running AND to
 * running correctly.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ACTUAL = path.join(HERE, '..', '.artifacts', 'actual');
const backend = process.argv[2] ?? 'webgpu';

const RESET = '\x1b[0m';
const red = (s) => `\x1b[31m${s}${RESET}`;
const green = (s) => `\x1b[32m${s}${RESET}`;
const yellow = (s) => `\x1b[33m${s}${RESET}`;
const dim = (s) => `\x1b[2m${s}${RESET}`;

/** Must match PLUGIN_SUBJECT in harness/scenes/pluginEffects.ts. */
const SUBJECT = { size: 120, centre: { x: 160, y: 90 } };
/** Sampled well inside the square, so antialiased edges never enter the mean. */
const INSET = 30;

/* ── PNG decode (8-bit RGBA, non-interlaced — what the harness writes) ─────── */

function decodePng(buf) {
  let pos = 8; // skip signature
  const idat = [];
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8 || colorType !== 6) {
    throw new Error(`expected 8-bit RGBA, got depth ${bitDepth} colourType ${colorType}`);
  }
  const raw = inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(width * height * 4);
  const stride = width * 4;
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const row = raw.subarray(p, p + stride);
    p += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? cur[x - 4] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= 4 ? prev[x - 4] : 0;
      let v = row[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 0xff;
    }
  }
  return { width, height, data: out };
}

/** Mean RGB over a square centred on `at`, inset so no edge pixel is included. */
function meanAt(img, at) {
  const half = SUBJECT.size / 2 - INSET;
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = Math.round(at.y - half); y <= Math.round(at.y + half); y++) {
    for (let x = Math.round(at.x - half); x <= Math.round(at.x + half); x++) {
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      const i = (y * img.width + x) * 4;
      r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2];
      n += 1;
    }
  }
  return n ? { r: r / n, g: g / n, b: b / n, n } : { r: 0, g: 0, b: 0, n: 0 };
}

async function load(scene) {
  const file = path.join(ACTUAL, backend, scene, '0.png');
  return decodePng(await readFile(file));
}

/* ── checks ────────────────────────────────────────────────────────────────── */

const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });

let control, identity, visible;
try {
  control = await load('plugin-control');
  identity = await load('plugin-identity');
  visible = await load('plugin-visible');
} catch (err) {
  console.log(yellow(`SKIPPED — no ${backend} frames for the plugin scenes (${err.message}).`));
  process.exit(0);
}

const idL = meanAt(control, SUBJECT.centre);
const idR = meanAt(identity, SUBJECT.centre);
const viL = idL;
const viR = meanAt(visible, SUBJECT.centre);

/*
  Premise first. Both later checks are about a DIFFERENCE between two squares,
  and a difference between two empty regions is zero — which reads as "the
  identity effect is perfect". If the subject never drew, say so instead.
*/
check(
  'the control subject actually drew',
  idL.r > 40 && idL.n > 100,
  `left mean rgb ${idL.r.toFixed(1)},${idL.g.toFixed(1)},${idL.b.toFixed(1)} over ${idL.n}px`,
);

/*
  An identity shader must leave the layer alone. 2 levels of 255 is the
  headroom for rgba16float intermediates rounding back to 8-bit on readback;
  anything structural — a dropped pass, a bad uniform offset, a layer composited
  against the wrong target — moves this by tens of levels, not by one.
*/
const idDelta = Math.max(Math.abs(idL.r - idR.r), Math.abs(idL.g - idR.g), Math.abs(idL.b - idR.b));
check(
  'an identity plugin effect leaves the layer unchanged',
  idDelta <= 2,
  `max channel Δ ${idDelta.toFixed(2)} levels `
  + `(left ${idL.r.toFixed(1)},${idL.g.toFixed(1)},${idL.b.toFixed(1)} · `
  + `right ${idR.r.toFixed(1)},${idR.g.toFixed(1)},${idR.b.toFixed(1)})`,
);

/*
  ★ The check that makes the one above mean anything.

  A skipped effect passes the identity test perfectly. This one fails unless the
  shader ran: red must drop toward zero while green and blue stay put.
*/
check(
  'a plugin effect that removes red DOES remove red',
  viL.r - viR.r > 40,
  `red ${viL.r.toFixed(1)} → ${viR.r.toFixed(1)} (Δ ${(viL.r - viR.r).toFixed(1)})`,
);
check(
  'and leaves green and blue alone',
  Math.abs(viL.g - viR.g) <= 3 && Math.abs(viL.b - viR.b) <= 3,
  `green Δ ${(viL.g - viR.g).toFixed(2)}, blue Δ ${(viL.b - viR.b).toFixed(2)}`,
);

/* ── report ────────────────────────────────────────────────────────────────── */

for (const r of results) {
  console.log(`  ${r.pass ? green('ok  ') : red('FAIL')} [${backend}] ${r.name}  ${dim(r.detail)}`);
}
const failed = results.filter((r) => !r.pass).length;
console.log(`${results.length - failed}/${results.length} plugin-render checks passed`);
process.exit(failed ? 1 : 0);
