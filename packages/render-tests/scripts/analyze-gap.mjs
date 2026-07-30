/**
 * Classify WHERE a scene diverges from its reference, not just how much.
 *
 * A percentage tells you a scene disagrees; it cannot tell you whether that is
 * an antialiasing difference along a contour or a wrong colour across a face,
 * and those need opposite responses. This exists because "known divergent" with
 * only a number attached is indistinguishable from "nobody looked" — which is
 * how `effect-gradient-ramp` hid an effect that rendered SOLID BLACK.
 *
 * For every pixel over the perceptual threshold it asks whether the actual
 * value still lies inside the range the REFERENCE takes nearby. If it does,
 * the two rasterizers drew the same contour and disagreed only about sub-pixel
 * coverage. If it escapes that range, they disagree about the COLOUR — which is
 * a defect until a mechanical cause is given.
 *
 *   node scripts/analyze-gap.mjs <scene> [...scenes]
 *   node scripts/analyze-gap.mjs --all
 */

import { PNG } from 'pngjs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(__dirname, '..');
const REFERENCES = path.join(PKG, 'references');
const ACTUAL = path.join(PKG, '.artifacts', 'actual', 'webgl2');

/** Channel delta above which two pixels are "different" (matches the gate). */
const DELTA = 4;
/** Neighbourhood radius for the coverage test below. */
const RADIUS = 1;

/**
 * Is this disagreement explainable as SUB-PIXEL COVERAGE?
 *
 * True when the actual pixel's value lies inside the range the reference
 * already takes across its immediate neighbourhood, per channel. Along a
 * contour the reference sweeps the whole way from one side's colour to the
 * other's, so any coverage the two rasterizers resolve differently still lands
 * somewhere in that range — the engines drew the same edge and disagreed only
 * about how much of the pixel it covers. In a flat region the range collapses
 * to a point, so a different colour cannot hide in it.
 *
 * This replaces a local-gradient threshold, which got the blend family WRONG:
 * a mid-grey ellipse over a gradient has an antialiased rim whose luma step is
 * small, so a threshold tuned to catch obvious edges classified 705 rim pixels
 * as flat-region colour errors. Decomposing by geometry disproved it — every
 * one of those pixels was on the rim. A range test needs no threshold to tune
 * and cannot make that mistake.
 */
function withinNeighbourhood(ref, act, w, h, x, y) {
  const ai = (w * y + x) << 2;
  for (let c = 0; c < 3; c++) {
    let lo = 255, hi = 0;
    for (let dy = -RADIUS; dy <= RADIUS; dy++) {
      for (let dx = -RADIUS; dx <= RADIUS; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const v = ref[((w * ny + nx) << 2) + c];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    if (act[ai + c] < lo - DELTA || act[ai + c] > hi + DELTA) return false;
  }
  return true;
}

export async function analyze(scene, frame = '0') {
  const refPath = path.join(REFERENCES, scene, `${frame}.png`);
  const actPath = path.join(ACTUAL, scene, `${frame}.png`);
  let ref, act;
  try {
    ref = PNG.sync.read(await fs.readFile(refPath));
    act = PNG.sync.read(await fs.readFile(actPath));
  } catch (e) {
    return { scene, error: e.code === 'ENOENT' ? 'missing png' : String(e) };
  }
  if (ref.width !== act.width || ref.height !== act.height) {
    return { scene, error: `size ${ref.width}x${ref.height} vs ${act.width}x${act.height}` };
  }
  const { width: w, height: h } = ref;
  let differing = 0, onContour = 0, inFlat = 0, maxDelta = 0;
  let flatSumDelta = 0;
  // Alpha-only disagreements are tracked apart: they mean one engine kept
  // coverage the other dropped, which is a different fault from a wrong colour.
  let alphaOnly = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (w * y + x) << 2;
      const dr = Math.abs(ref.data[i] - act.data[i]);
      const dg = Math.abs(ref.data[i + 1] - act.data[i + 1]);
      const db = Math.abs(ref.data[i + 2] - act.data[i + 2]);
      const da = Math.abs(ref.data[i + 3] - act.data[i + 3]);
      const d = Math.max(dr, dg, db);
      if (d <= DELTA && da <= DELTA) continue;
      differing++;
      maxDelta = Math.max(maxDelta, d, da);
      if (d <= DELTA) { alphaOnly++; continue; }
      if (withinNeighbourhood(ref.data, act.data, w, h, x, y)) onContour++;
      else { inFlat++; flatSumDelta += d; }
    }
  }
  const total = (w - 2) * (h - 2);
  return {
    scene,
    pct: (differing / total) * 100,
    differing,
    onContour,
    inFlat,
    alphaOnly,
    maxDelta,
    meanFlatDelta: inFlat ? flatSumDelta / inFlat : 0,
    // A gap that is entirely coverage is the two rasterizers resolving the same
    // shape. Anything that escapes the reference's own local range is a
    // different COLOUR, and needs a mechanical cause before it may be accepted.
    verdict: inFlat > 0 ? 'COLOUR DIFFERENCE — needs a cause' : 'coverage-only',
  };
}

const args = process.argv.slice(2);
const scenes = args.includes('--all')
  ? (await fs.readdir(REFERENCES, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
  : args;

const rows = [];
for (const s of scenes) rows.push(await analyze(s));
rows.sort((a, b) => (b.inFlat ?? 0) - (a.inFlat ?? 0));
console.log(
  'scene'.padEnd(34) + 'pct'.padStart(8) + 'diff'.padStart(8) +
  'contour'.padStart(9) + 'flat'.padStart(8) + 'alphaOnly'.padStart(10) +
  'maxD'.padStart(6) + 'meanFlatD'.padStart(11) + '  verdict',
);
for (const r of rows) {
  if (r.error) { console.log(r.scene.padEnd(34) + '  ' + r.error); continue; }
  console.log(
    r.scene.padEnd(34) +
    r.pct.toFixed(3).padStart(8) +
    String(r.differing).padStart(8) +
    String(r.onContour).padStart(9) +
    String(r.inFlat).padStart(8) +
    String(r.alphaOnly).padStart(10) +
    String(r.maxDelta).padStart(6) +
    r.meanFlatDelta.toFixed(1).padStart(11) +
    '  ' + r.verdict,
  );
}
