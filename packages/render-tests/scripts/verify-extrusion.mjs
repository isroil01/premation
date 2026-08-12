/**
 * Semantic checks for EFFECT REACH across the faces of an extruded solid.
 *
 *   node packages/render-tests/scripts/verify-extrusion.mjs [backend]   # default: webgpu
 *
 * ## Why these are not golden-pixel checks
 *
 * `buildSnapshot` synthesized every extra face with `effects: undefined`, so a
 * layer's whole effect stack applied to the front face alone. Both symptoms of
 * that pass a presence check with room to spare — the front face is most of
 * what a head-on solid shows, so "the object changed" and "the object blurred"
 * are both true while thirteen of fourteen renderables are untouched. A golden
 * blessed in that state certifies front-face-only forever.
 *
 * So each check measures WHICH pixels moved:
 *
 *   invert   the fraction of the solid's own covered pixels the effect changed.
 *            Front-face-only cannot exceed the front face's share of the
 *            silhouette; every-face lands at essentially all of it.
 *   DOF      the width of the transition band at the WALL's outer silhouette
 *            edge, on a scanline chosen to cross the wall and miss the front
 *            face. A front-face-only blur cannot move this number at all.
 *
 * Each subject is measured against a twin differing in exactly one property, so
 * the perspective projection cancels and the difference is the effect.
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
 * Pixels the CONTROL frame shows as the solid — anything meaningfully above the
 * near-black comp background.
 *
 * Taken from the control, not the effect frame: an effect that darkens a face
 * toward the background would shrink its own silhouette and flatter itself.
 */
function silhouette(off) {
  const px = [];
  for (let y = 0; y < off.height; y++) {
    for (let x = 0; x < off.width; x++) {
      const i = (y * off.width + x) * 4;
      if (lum(off.data, i) > 24) px.push(i);
    }
  }
  return px;
}

// ── invert: what fraction of the solid actually inverted? ─────────────
//
// The threshold is the crux. The front face is a 160×120 quad and the visible
// wall a 120-deep strip at 35° yaw, so front-face-only lands somewhere near
// two thirds of the silhouette — well clear of both 100% and of zero. The gate
// is set at 95%: high enough that no arrangement of "the front face and
// nothing else" can reach it, low enough to tolerate the antialiased fringe
// where a face's edge blends into the background and the delta is small.
try {
  const [on, off] = await pair('ext-fx-invert');
  const px = silhouette(off);
  let moved = 0;
  for (const i of px) {
    // A per-channel test, not luminance: inverting a mid-grey moves luminance
    // very little while moving every channel a lot.
    const d = Math.max(
      Math.abs(on.data[i] - off.data[i]),
      Math.abs(on.data[i + 1] - off.data[i + 1]),
      Math.abs(on.data[i + 2] - off.data[i + 2]),
    );
    if (d > 24) moved++;
  }
  const frac = px.length ? moved / px.length : 0;
  check('invert: the control actually drew a solid', px.length > 4000, `${px.length} solid px`);
  check('invert reaches EVERY face of the solid, not just the front',
    frac > 0.95,
    `${(frac * 100).toFixed(1)}% of the solid's ${px.length} px changed (${moved} px)`);
} catch (e) {
  check('invert on an extruded solid', false, `not rendered — ${e.message}`);
}

/**
 * Wall pixels of the control frame that are FAR from the front face.
 *
 * With no lights in the scene an extruded face takes a flat gain — 1.0 for the
 * front face (it is the layer itself), `EXTRUSION_WALL_GAIN` 0.72 for a wall,
 * `EXTRUSION_BACK_GAIN` 0.55 for the back cap — over one solid fill. So the
 * faces separate cleanly by luminance alone, with no model of the projection:
 * the brightest plateau is the front face and the band around 0.72 of it is
 * the wall.
 *
 * The distance term is what makes the DOF check honest. A blur on the front
 * face ALONE still bleeds sideways into the wall region, so "wall pixels
 * changed" would be satisfied by the very defect being tested. Requiring
 * `minGap` px of wall between a sampled pixel and the nearest front-face pixel
 * on its row puts the sample outside the reach of any front-face blur in these
 * scenes (the DOF extent here measures ~36 px; the gap is 45).
 */
function farWallPixels(off, minGap) {
  const { width: w, height: h, data } = off;
  let plateau = 0;
  for (let i = 0; i < data.length; i += 4) {
    const v = lum(data, i);
    if (v > plateau) plateau = v;
  }
  const isFront = (i) => lum(data, i) > plateau * 0.88;
  const isWall = (i) => {
    const v = lum(data, i);
    return v > plateau * 0.55 && v < plateau * 0.85;
  };
  const out = [];
  for (let y = 0; y < h; y++) {
    // Front-face extent on this row, so the gap is a real distance through the
    // wall rather than a distance to an arbitrary pixel elsewhere in the frame.
    let fl = Infinity, fr = -Infinity;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (isFront(i)) { if (x < fl) fl = x; if (x > fr) fr = x; }
    }
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (!isWall(i)) continue;
      const gap = fr < 0 ? Infinity : (x > fr ? x - fr : (x < fl ? fl - x : 0));
      if (gap >= minGap) out.push(i);
    }
  }
  return out;
}

/**
 * Width, in px, of the transition at the solid's RIGHTMOST silhouette edge —
 * which at this subject's +45° yaw is the outer edge of the side WALL.
 *
 * ── Why the plateau is measured LOCALLY ─────────────────────────────────────
 *
 * The obvious version takes the row's brightest pixel as the "fully covered"
 * level and finds the 10%/90% crossings against it. That is wrong here, and
 * wrong in a way that reports a passing number: the brightest thing on the row
 * is the FRONT face, and an unlit wall renders at `EXTRUSION_WALL_GAIN` (0.72)
 * of it, so the 90% level sits above anything the wall can reach. The crossing
 * search then runs straight through the wall and lands on the front face, and
 * the "transition width" it returns is the width of the whole wall — 41 px on
 * a sharp frame, which looks like a blurred edge and is not one.
 *
 * So the plateau comes from the wall itself: the median level of a band 20–70
 * px inside the outermost drawn pixel. Median, not max, so a few pixels of a
 * neighbouring face leaking into the window cannot lift it.
 */
function outerEdgeWidth(img) {
  const w = img.width;
  const row = Math.round(img.height / 2);
  const at = (x) => lum(img.data, (row * w + x) * 4);
  const bg = at(w - 3);
  let outer = null;
  for (let x = w - 1; x >= 0; x--) if (at(x) > bg + 8) { outer = x; break; }
  if (outer === null || outer < 80) return null;
  const band = [];
  for (let x = Math.max(0, outer - 70); x <= outer - 20; x++) band.push(at(x));
  if (band.length === 0) return null;
  band.sort((a, b) => a - b);
  const plateau = band[Math.floor(band.length / 2)];
  if (plateau - bg < 12) return null;
  const lo = bg + (plateau - bg) * 0.1;
  const hi = bg + (plateau - bg) * 0.9;
  let xLo = null, xHi = null;
  for (let x = w - 1; x >= 0; x--) {
    const v = at(x);
    if (xLo === null && v > lo) xLo = x;
    if (v > hi) { xHi = x; break; }
  }
  return xLo !== null && xHi !== null ? xLo - xHi + 1 : null;
}

/**
 * Bounding box of the drawn solid in the CONTROL frame — the body's TRUE
 * extent, before any blur widens it.
 *
 * Taken from the control on purpose: measured on the blurred frame the box
 * would include the outer falloff, where a smooth ramp would dilute the very
 * steps the seam check is looking for.
 */
function bodyBox(off) {
  let x0 = off.width, y0 = off.height, x1 = -1, y1 = -1;
  for (let y = 0; y < off.height; y++) {
    for (let x = 0; x < off.width; x++) {
      if (lum(off.data, (y * off.width + x) * 4) > 24) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  return { x0: x0 + 4, y0: y0 + 4, x1: x1 - 4, y1: y1 - 4 };
}

/** Largest luminance step between VERTICALLY adjacent pixels inside `box`. */
function maxVerticalStep(img, box) {
  let max = 0;
  for (let x = box.x0; x <= box.x1; x++) {
    for (let y = box.y0 + 1; y <= box.y1; y++) {
      const d = Math.abs(
        lum(img.data, (y * img.width + x) * 4) - lum(img.data, ((y - 1) * img.width + x) * 4),
      );
      if (d > max) max = d;
    }
  }
  return max;
}

/** Fraction of the given pixels that differ between the two frames. */
function movedFraction(on, off, px, threshold = 6) {
  let moved = 0;
  for (const i of px) {
    const d = Math.max(
      Math.abs(on.data[i] - off.data[i]),
      Math.abs(on.data[i + 1] - off.data[i + 1]),
      Math.abs(on.data[i + 2] - off.data[i + 2]),
    );
    if (d > threshold) moved++;
  }
  return px.length ? moved / px.length : 0;
}

// ── DOF: does the blur reach wall pixels the front face cannot touch? ──
//
// The diagnostic this replaces reported `diag-b-dof` and `diag-b-dof-off` as
// byte-identical across all 172,800 pixels. That is the strongest possible form
// of this failure, and it is what the DOF-off comparison here would show for a
// subject with no front face in view. With one in view the frames DO differ, so
// the check has to be about the wall specifically.
try {
  const [on, off] = await pair('ext-dof-wall');
  const far = farWallPixels(off, 45);
  check('DOF: the control exposes wall out of reach of a front-face blur',
    far.length > 1500, `${far.length} wall px at least 45 px from the front face`);
  // Deliberately NOT gated near 100%. A wall is one flat colour, and blurring
  // the interior of a uniform region returns that region unchanged — only the
  // pixels within a radius of an edge can move. So the reachable ceiling here
  // is "the outer part of the band", not "all of it", and a check written at
  // 0.9 would be unsatisfiable by a correct renderer. What this number has to
  // separate is 0 (the scrub: the walls were byte-identical with DOF on and
  // off) from anything at all.
  const frac = movedFraction(on, off, far);
  check('DOF alters wall pixels no front-face blur could reach',
    frac > 0.25,
    `${(frac * 100).toFixed(1)}% of those wall px changed when DOF was enabled`);
  // The acceptance criterion is "every face blurs, with NO HARD DISCONTINUITY
  // at seams" — so the seams get measured, not eyeballed. Each face is its own
  // quad and its own resolve, so the join between two blurred faces is where a
  // per-face approximation would show itself.
  //
  // What this does NOT claim: that the join is invisible. Two adjacent blurred
  // quads each fade across it and composite to a soft ridge of a few levels,
  // which is real and is the documented limit of resolving faces separately
  // (faceEffects.ts, "Spatial effects that are allowed, and the seam"). What it
  // gates is that the ridge is a gradient and not a step.
  const seamOn = maxVerticalStep(on, bodyBox(off));
  const seamOff = maxVerticalStep(off, bodyBox(off));
  check('the metric can see a hard edge at all (the sharp control has several)',
    seamOff > 50, `sharp control steps ${seamOff.toFixed(1)} levels in one row`);
  check('no hard discontinuity where two blurred faces meet',
    seamOn < 25, `blurred body steps at most ${seamOn.toFixed(1)} levels in one row`);
  const sharp = outerEdgeWidth(off);
  const blurred = outerEdgeWidth(on);
  check('DOF: the control has a genuinely hard wall edge',
    sharp !== null && sharp <= 4, `${sharp} px transition at the wall's outer edge`);
  check('DOF spreads the WALL’s own outer edge, in proportion to its depth',
    sharp !== null && blurred !== null && blurred >= sharp * 4,
    `wall edge ${blurred} px vs sharp ${sharp} px = ${sharp ? (blurred / sharp).toFixed(1) : '—'}× wider`);
} catch (e) {
  check('depth of field on an extruded solid', false, `not rendered — ${e.message}`);
}

/**
 * Roughness of the body's TOP silhouette edge, in px.
 *
 * For each column, the topmost drawn row; then the mean absolute SECOND
 * difference of that profile across columns. A straight edge — at any angle —
 * has a constant slope and therefore a second difference of ~0. A sawtooth
 * does not. That is exactly the difference between a solid extruded body and a
 * stack of plates whose gaps have opened up, and it needs no model of the
 * projection, the yaw, or the glyph shape.
 *
 * Second difference rather than first, precisely so the subject can be yawed:
 * a first-difference measure would report the body's own slant as roughness.
 */
function topEdgeRoughness(img) {
  const { width: w, height: h, data } = img;
  const top = [];
  for (let x = 0; x < w; x++) {
    let y0 = -1;
    for (let y = 0; y < h; y++) {
      if (lum(data, (y * w + x) * 4) > 24) { y0 = y; break; }
    }
    top.push(y0);
  }
  const run = top.filter((v) => v >= 0);
  if (run.length < 40) return null;
  // Only the contiguous drawn span, so the frame's empty margins do not enter.
  const first = top.findIndex((v) => v >= 0);
  const last = top.length - 1 - [...top].reverse().findIndex((v) => v >= 0);
  let sum = 0, n = 0;
  for (let x = first + 1; x < last; x++) {
    if (top[x - 1] < 0 || top[x] < 0 || top[x + 1] < 0) continue;
    sum += Math.abs(top[x + 1] - 2 * top[x] + top[x - 1]);
    n++;
  }
  return n > 0 ? sum / n : null;
}

// ── deep extruded text stays solid rather than combing ────────────────
try {
  const deep = await readPng(path.join(ACTUAL, BACKEND, 'ext-text-depth-300', '0.png'));
  const shallow = await readPng(path.join(ACTUAL, BACKEND, 'ext-text-depth-40', '0.png'));
  const rDeep = topEdgeRoughness(deep);
  const rShallow = topEdgeRoughness(shallow);
  check('slice density: both subjects actually drew a body to measure',
    rShallow !== null && rDeep !== null,
    `shallow ${rShallow?.toFixed(3)} px · deep ${rDeep?.toFixed(3)} px`);
  /*
    Comparative, and deliberately tight.

    Absolute is not available: the top silhouette of TEXT steps at every letter
    boundary, so the shallow control's own roughness is 0.835 px with a
    perfectly solid body — an absolute threshold would be measuring the
    typeface. What IS claimable is that depth must not degrade the body, so the
    deep subject is held against the shallow one at the same yaw.

    Calibrated against both states rather than guessed. Measured here:

        depth 300, 45-slice cap   1.193 px   ← combed
        depth 300, 400-slice cap  0.700 px
        depth  40 (control)       0.835 px

    So the bound is the control plus 10%. A looser rule — the `× 2 + 0.2` this
    replaces — admitted 1.87 px and would have passed the defect unchanged,
    which is the failure mode a comparative check is most prone to.
  */
  check('a deep extrusion is as solid as a shallow one (no stair-stepping)',
    rDeep !== null && rShallow !== null && rDeep < rShallow * 1.1,
    `deep ${rDeep?.toFixed(3)} px vs shallow ${rShallow?.toFixed(3)} px`);
} catch (e) {
  check('deep extruded text', false, `not rendered — ${e.message}`);
}

// ── report ───────────────────────────────────────────────────────────
console.log(dim(`\n  extrusion effect-reach checks (${BACKEND}) — measured against each scene's own control:\n`));
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`  ${r.ok ? green('ok  ') : red('FAIL')} ${r.name}  ${dim(r.detail)}`);
}
console.log(`\n${failed === 0 ? green(`${results.length}/${results.length} extrusion checks passed`) : red(`${failed}/${results.length} extrusion checks FAILED`)}\n`);
process.exit(failed === 0 ? 0 : 1);
