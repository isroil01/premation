/**
 * Semantic checks for layer styles and depth of field ON 3D LAYERS.
 *
 *   node scripts/verify-3d-styles.mjs [backend]      # default: webgpu
 *
 * ## Why these are not golden-pixel checks
 *
 * All three paths rendered NOTHING before 1a32ab6. A reference blessed after
 * that fix would have gone green the same day and then said nothing ever again
 * — and would have gone green just as readily on a shadow thrown the wrong way,
 * a glow one pixel wide, or the depth-of-field radii that were ~14× too small
 * in layer space. "Something appeared" is the assertion that misses all three.
 *
 * So each scene is measured against its own STYLE-OFF TWIN, and the assertions
 * are about direction and extent:
 *
 *   drop shadow   darkens the background DOWN-RIGHT of the panel and nowhere
 *                 else — the up-left quadrant must be untouched
 *   outer glow    LIGHTENS the background on ALL sides, outside the silhouette
 *   depth of field spreads the panel's edge measurably WIDER than the sharp
 *                 control — reported as a ratio, so a 14× radius error cannot
 *                 pass
 *
 * Pairing also keeps 3D projection out of the verifier: whatever perspective
 * does to the panel it does identically to both frames, so the difference is
 * the style and nothing else.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPng } from './comparator.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACTUAL = path.resolve(__dirname, '..', '.artifacts', 'actual');
const BACKEND = process.argv[2] || 'webgpu';

const RESET = '\x1b[0m';
const red = (s) => `\x1b[31m${s}${RESET}`;
const green = (s) => `\x1b[32m${s}${RESET}`;
const dim = (s) => `\x1b[2m${s}${RESET}`;

const results = [];
const check = (name, ok, detail) => results.push({ name, ok, detail });

const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];

async function pair(id) {
  return [
    await readPng(path.join(ACTUAL, BACKEND, id, '0.png')),
    await readPng(path.join(ACTUAL, BACKEND, `${id}-off`, '0.png')),
  ];
}

/**
 * Where the style changed the frame, and in which direction, split by quadrant
 * about the panel's centroid.
 *
 * The centroid comes from the CONTROL frame's own drawn pixels rather than from
 * the scene's declared position: the panel is under a perspective camera, so
 * its projected centre is not its composition coordinate, and hard-coding the
 * latter would put the quadrant boundaries in the wrong place.
 */
function quadrantDelta(on, off) {
  // Panel pixels in the control = anything meaningfully brighter than the
  // near-black comp background.
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < off.height; y++) {
    for (let x = 0; x < off.width; x++) {
      const i = (y * off.width + x) * 4;
      if (lum(off.data, i) > 40) { sx += x; sy += y; n++; }
    }
  }
  const cx = sx / n, cy = sy / n;

  // Quadrants, counting only pixels OUTSIDE the silhouette — a style's effect
  // on the panel's own interior is a different claim from where it spreads.
  const q = { downRight: [], upLeft: [], downLeft: [], upRight: [] };
  for (let y = 0; y < on.height; y++) {
    for (let x = 0; x < on.width; x++) {
      const i = (y * on.width + x) * 4;
      if (lum(off.data, i) > 40) continue; // inside the panel in the control
      const d = lum(on.data, i) - lum(off.data, i);
      if (Math.abs(d) < 2) continue;
      const key = y > cy ? (x > cx ? 'downRight' : 'downLeft') : (x > cx ? 'upRight' : 'upLeft');
      q[key].push(d);
    }
  }
  const stat = (a) => ({ count: a.length, mean: a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0 });
  return { cx, cy, panelPx: n, q: Object.fromEntries(Object.entries(q).map(([k, v]) => [k, stat(v)])) };
}

// ── drop shadow: DARKER, down-right, and nowhere up-left ──────────────
try {
  const [on, off] = await pair('three-d-drop-shadow');
  const { q, panelPx } = quadrantDelta(on, off);
  check('drop shadow: the control actually drew a panel', panelPx > 2000, `${panelPx} panel px`);
  // angle 45 with distance 26 throws the shadow down and to the right.
  check('drop shadow falls DOWN-RIGHT of the panel',
    q.downRight.count > 300 && q.downRight.mean < -4,
    `down-right ${q.downRight.count} px, mean Δlum ${q.downRight.mean.toFixed(1)}`);
  // The opposite quadrant is the one that catches a shadow thrown the wrong
  // way, which a presence check cannot distinguish from a correct one.
  check('drop shadow adds nothing UP-LEFT of the panel',
    q.upLeft.count < q.downRight.count / 4,
    `up-left ${q.upLeft.count} px vs down-right ${q.downRight.count} px`);
  check('drop shadow only ever DARKENS the background',
    q.downRight.mean < 0 && q.downLeft.mean <= 0 && q.upRight.mean <= 0,
    `means dr ${q.downRight.mean.toFixed(1)} dl ${q.downLeft.mean.toFixed(1)} ur ${q.upRight.mean.toFixed(1)}`);
} catch (e) {
  check('drop shadow on a 3D layer', false, `not rendered — ${e.message}`);
}

// ── outer glow: BRIGHTER, on every side ───────────────────────────────
try {
  const [on, off] = await pair('three-d-outer-glow');
  const { q } = quadrantDelta(on, off);
  const sides = Object.entries(q);
  check('outer glow LIGHTENS the background outside the silhouette',
    sides.every(([, s]) => s.count > 100 && s.mean > 2),
    sides.map(([k, s]) => `${k} ${s.count}px ${s.mean.toFixed(1)}`).join(' · '));
  // A glow that only reaches one side would be a directional offset, i.e. a
  // drop shadow with the wrong colour — this is what separates the two.
  {
    const counts = sides.map(([, s]) => s.count);
    const spread = Math.max(...counts) / Math.max(1, Math.min(...counts));
    check('outer glow reaches all four sides comparably (it is not directional)',
      spread < 4, `widest/narrowest quadrant = ${spread.toFixed(2)}×`);
  }
} catch (e) {
  check('outer glow on a 3D layer', false, `not rendered — ${e.message}`);
}

// ── depth of field: measured by EXTENT ────────────────────────────────
//
// Width of the horizontal transition band at the panel's left edge: the run of
// columns strictly between background and full panel colour. Blur widens it in
// direct proportion to the radius, so the RATIO against the sharp control is a
// reading of the radius itself — which is what a 14×-too-small error breaks and
// a presence check does not.
try {
  const blurred = await readPng(path.join(ACTUAL, BACKEND, 'three-d-dof-extent', '0.png'));
  const sharp = await readPng(path.join(ACTUAL, BACKEND, 'three-d-dof-extent-off', '0.png'));
  const bandWidth = (png) => {
    const y = Math.round(png.height / 2);
    const row = [];
    for (let x = 0; x < png.width; x++) row.push(lum(png.data, (y * png.width + x) * 4));
    const lo = Math.min(...row);
    const hi = Math.max(...row);
    if (hi - lo < 20) return null; // nothing drew on this row
    // Count columns in the left half that sit between 10% and 90% of the step.
    const a = lo + (hi - lo) * 0.1;
    const b = lo + (hi - lo) * 0.9;
    let w = 0;
    for (let x = 0; x < Math.round(png.width / 2); x++) if (row[x] > a && row[x] < b) w++;
    return w;
  };
  const wb = bandWidth(blurred);
  const ws = bandWidth(sharp);
  if (wb === null || ws === null) {
    check('depth of field: both frames drew the panel', false, `blurred band ${wb}, sharp band ${ws}`);
  } else {
    check('depth of field: the sharp control has a genuinely hard edge', ws <= 4, `${ws} px transition`);
    // The threshold is a RATIO and a floor together: a blur that widens the
    // edge by only a pixel or two is what the ~14×-too-small radii produced,
    // and it would satisfy any "is it different?" test.
    check('depth of field spreads the edge measurably WIDER than sharp',
      wb >= ws + 6 && wb / Math.max(1, ws) >= 3,
      `blurred ${wb} px vs sharp ${ws} px = ${(wb / Math.max(1, ws)).toFixed(1)}× wider`);
  }
} catch (e) {
  check('depth of field extent on a 3D layer', false, `not rendered — ${e.message}`);
}

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  process.stdout.write(`${r.ok ? green('  ok  ') : red(' FAIL ')} [${BACKEND}] ${r.name}${r.detail ? `  ${dim(r.detail)}` : ''}\n`);
}
process.stdout.write(`\n${results.length - failed}/${results.length} 3D-style checks passed\n`);
process.exit(failed ? 1 : 0);
