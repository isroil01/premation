/**
 * Bless-time semantic check for the interior-style / fill-opacity references.
 *
 * A golden PNG blessed from our own output can only ever say "unchanged since
 * blessing" — if the pixels were wrong on the day they were blessed, the suite
 * guards the wrong thing forever. These scenes were ported from unit tests that
 * asserted MEANING (the inside edge darkens, the glow lightens, nothing is added
 * outside the silhouette), so this re-asserts that meaning against the blessed
 * frames once. Run it before committing a re-bless.
 *
 *   node scripts/verify-interior.mjs
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPng } from './comparator.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REFS = path.resolve(__dirname, '..', 'references');

const load = async (id) => {
  const png = await readPng(path.join(REFS, id, '0.png'));
  const { width, height, data } = png;
  return {
    width,
    height,
    px: (x, y) => {
      const i = (y * width + x) * 4;
      return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] };
    },
  };
};

// Comp is 320×220; the subject is a 170×130 rect centred at (160,110), so it
// spans x 75..245, y 45..175. These probes are in that frame of reference.
const INSIDE_EDGE = [82, 52];   // just inside the top-left corner of the subject
const CENTRE = [160, 110];      // middle of the subject
const OUTSIDE = [[8, 8], [312, 8], [8, 212], [312, 212], [40, 110]];
const MARKER = [40, 40];        // the unstyled corner marker
const RING = [160, 41];         // 4px above the subject's top edge — stroke territory

const results = [];
const check = (name, ok, detail) => results.push({ name, ok, detail });

const lum = (p) => 0.2126 * p.r + 0.7152 * p.g + 0.0722 * p.b;

const unstyled = await load('interior-inner-shadow-zero-opacity');
const innerShadow = await load('interior-inner-shadow');
const innerGlow = await load('interior-inner-glow');
const bevel = await load('interior-bevel');
const satin = await load('interior-satin');
const foHalf = await load('fill-opacity-half');
const foZero = await load('fill-opacity-zero');
const foStroke = await load('fill-opacity-zero-stroke');
const foFull = await load('fill-opacity-full');

// The subject must actually be present in the baseline, or every comparison
// below is vacuous. This is the check that catches "texture feed failed".
const base = unstyled.px(...CENTRE);
check('baseline: subject rendered at all', base.a > 250 && lum(base) > 20,
  `centre rgba=${base.r},${base.g},${base.b},${base.a}`);

// ── interior styles ────────────────────────────────────────────────
{
  const before = unstyled.px(...INSIDE_EDGE);
  const after = innerShadow.px(...INSIDE_EDGE);
  check('inner shadow darkens the inside edge', lum(after) < lum(before) - 2,
    `lum ${lum(before).toFixed(1)} → ${lum(after).toFixed(1)}`);

  const c0 = unstyled.px(...CENTRE);
  const c1 = innerShadow.px(...CENTRE);
  check('inner shadow leaves the centre essentially untouched', Math.abs(lum(c1) - lum(c0)) < 12,
    `Δlum ${Math.abs(lum(c1) - lum(c0)).toFixed(1)}`);

  const bg = unstyled.px(...OUTSIDE[0]);
  const outsideSame = OUTSIDE.every(([x, y]) => {
    const p = innerShadow.px(x, y);
    const q = unstyled.px(x, y);
    return Math.abs(lum(p) - lum(q)) < 2;
  });
  check('inner shadow adds nothing outside the silhouette', outsideSame,
    `bg lum ${lum(bg).toFixed(1)}`);
}
{
  const before = unstyled.px(...INSIDE_EDGE);
  const after = innerGlow.px(...INSIDE_EDGE);
  check('inner glow LIGHTENS the inside edge', lum(after) > lum(before) + 2,
    `lum ${lum(before).toFixed(1)} → ${lum(after).toFixed(1)}`);
  const outsideSame = OUTSIDE.every(([x, y]) =>
    Math.abs(lum(innerGlow.px(x, y)) - lum(unstyled.px(x, y))) < 2);
  check('inner glow adds nothing outside the silhouette', outsideSame, '');
}
{
  // Bevel SHADES rather than composites, so the claim is directional: one edge
  // of each opposing pair catches the light and the other falls into shadow,
  // about an unshaded interior. Probing single corners is not enough — the
  // ramps are symmetric, so two corners at equal inset can coincide by accident
  // and read as "no bevel" when the effect is working perfectly.
  const centre = lum(bevel.px(160, 110));
  const top = lum(bevel.px(160, 49));
  const bottom = lum(bevel.px(160, 171));
  const left = lum(bevel.px(79, 110));
  const right = lum(bevel.px(241, 110));
  const opposed = (a, b) => (a - centre) * (b - centre) < 0 && Math.abs(a - b) > 8;
  check('bevel shades top vs bottom in opposite directions', opposed(top, bottom),
    `lum top ${top.toFixed(1)} / centre ${centre.toFixed(1)} / bottom ${bottom.toFixed(1)}`);
  check('bevel shades left vs right in opposite directions', opposed(left, right),
    `lum left ${left.toFixed(1)} / centre ${centre.toFixed(1)} / right ${right.toFixed(1)}`);
  check('bevel leaves the interior unshaded', Math.abs(centre - lum(unstyled.px(160, 110))) < 2,
    `Δlum ${Math.abs(centre - lum(unstyled.px(160, 110))).toFixed(1)}`);
}
{
  const differs = lum(satin.px(...INSIDE_EDGE)) !== lum(unstyled.px(...INSIDE_EDGE))
    || lum(satin.px(...CENTRE)) !== lum(unstyled.px(...CENTRE));
  check('satin changes the interior', differs, '');
}

// ── fill opacity ───────────────────────────────────────────────────
{
  const full = foFull.px(...CENTRE);
  const half = foHalf.px(...CENTRE);
  const zero = foZero.px(...CENTRE);
  // Against a dark comp, fading the layer pulls the composited pixel toward the
  // background — so luminance strictly decreases as fill opacity drops.
  check('fill opacity fades the layer’s own pixels', lum(half) < lum(full) - 10 && lum(half) > lum(zero) + 10,
    `lum full ${lum(full).toFixed(1)} → half ${lum(half).toFixed(1)} → zero ${lum(zero).toFixed(1)}`);
  check('fill opacity 0 erases the contents', Math.abs(lum(zero) - lum(foZero.px(...OUTSIDE[0]))) < 2,
    `centre lum ${lum(zero).toFixed(1)} vs bg ${lum(foZero.px(...OUTSIDE[0])).toFixed(1)}`);
  const mk = foZero.px(...MARKER);
  check('fill opacity 0 frame is not simply blank (marker drew)', lum(mk) > 40,
    `marker lum ${lum(mk).toFixed(1)}`);
}
{
  const centre = foStroke.px(...CENTRE);
  const ring = foStroke.px(...RING);
  check('stroke survives fill opacity 0 — contents gone', Math.abs(lum(centre) - lum(foStroke.px(...OUTSIDE[0]))) < 2,
    `centre lum ${lum(centre).toFixed(1)}`);
  check('stroke survives fill opacity 0 — ring remains', ring.a > 40 && lum(ring) > 20,
    `ring rgba=${ring.r},${ring.g},${ring.b},${ring.a}`);
}

// ── interior styles under fill opacity (Photoshop's rule) ──────────
{
  const s = await load('fill-opacity-zero-inner-shadow');
  const bg = lum(s.px(...OUTSIDE[0]));

  // The fill is gone. Not testable as "centre equals background" here: this
  // shadow is soft enough to reach the middle from all four edges, so the centre
  // is legitimately covered by the STYLE. What must be true is that nothing left
  // is the fill — the fill is blue (#3080ff, blue-dominant), the shadow is red
  // (#ff2d55, red-dominant), so a blue-dominant pixel anywhere is leftover fill.
  const c = s.px(...CENTRE);
  check('fill opacity 0 still erases the fill when a style is present',
    c.b <= c.r,
    `centre rgb ${c.r},${c.g},${c.b} — blue-dominant would mean surviving fill`);

  // The style is still drawn, at full strength, inside the old silhouette. Under
  // the previous implementation it was subtracted away with the contents and this
  // frame held nothing but the marker.
  //
  // This also depended on a second, unrelated fix: applyInterior built its inverse
  // at layer size, so a shape filling its own texture cast from nothing and drew
  // no interior style at all. The inverse is now built in a padded buffer — see
  // src/core/effects/interiorPadding.test.ts.
  let peak = { d: 0, px: null };
  for (let y = 45; y <= 174; y++) {
    for (let x = 75; x <= 244; x++) {
      const p = s.px(x, y);
      const d = Math.abs(lum(p) - bg);
      if (d > peak.d) peak = { d, px: p };
    }
  }
  check('inner shadow survives fill opacity 0 at full strength',
    peak.d > 20 && peak.px.r > peak.px.b,
    `peak Δlum ${peak.d.toFixed(1)}, rgb ${peak.px.r},${peak.px.g},${peak.px.b} (shadow is #ff2d55)`);

  // And it is still INTERIOR — it must not have leaked past the silhouette.
  check('the surviving style stays inside the original silhouette',
    OUTSIDE.every(([x, y]) => Math.abs(lum(s.px(x, y)) - bg) < 2), '');
}

// ── bevel working-buffer parity ────────────────────────────────────
//
// The claim: capping the shading buffer changes the COST, not the look. Sampled
// at relative coordinates so the two resolutions are directly comparable. This is
// the comparison whose absence caused the previous downscale attempt to be
// reverted — a flattened profile is invisible in either reference on its own.
{
  const lo = await load('bevel-below-cap');
  const hi = await load('bevel-above-cap');

  /** Luminance at a relative (0..1) position within the frame. */
  const at = (img, u, v) => lum(img.px(Math.round(u * img.width), Math.round(v * img.height)));

  // Down the inside of the top edge, from the rim toward the interior.
  const profile = (img) => Array.from({ length: 9 }, (_, i) => at(img, 0.5, 0.085 + i * 0.006));
  const pLo = profile(lo);
  const pHi = profile(hi);

  // NOTE ON WHAT THIS CAN AND CANNOT CHECK.
  //
  // These two scenes are NOT interchangeable renders of one image. The bevel
  // derives its normal from a per-pixel slope, so doubling the geometry and the
  // blur radius together genuinely halves the shading — the 2× scene is a weaker
  // bevel by construction, not by defect. Comparing their profiles directly would
  // therefore be measuring the algorithm's scale-dependence, not the working
  // buffer. The cap itself is gated properly in
  // src/core/effects/bevelWorkingBuffer.test.ts, which runs the SAME input
  // through both paths.
  //
  // What these scenes are still good for: each is a committed reference, so a
  // regression in either resolution's output goes red, and the checks below pin
  // the two invariants that must hold at ANY resolution.
  check('bevel shades at both resolutions', pLo[0] < at(lo, 0.5, 0.5) && pHi[0] < at(hi, 0.5, 0.5),
    `edge lo ${pLo[0].toFixed(1)} vs interior ${at(lo, 0.5, 0.5).toFixed(1)}; edge hi ${pHi[0].toFixed(1)} vs interior ${at(hi, 0.5, 0.5).toFixed(1)}`);

  // The interior must stay unshaded at both resolutions, and the upsampled bands
  // must not leak outside the silhouette (`lighter` would show that as a rim).
  check('bevel keeps the interior unshaded at both resolutions',
    Math.abs(at(lo, 0.5, 0.5) - at(hi, 0.5, 0.5)) < 3,
    `lum lo ${at(lo, 0.5, 0.5).toFixed(1)} vs hi ${at(hi, 0.5, 0.5).toFixed(1)}`);
  check('bevel adds nothing outside the silhouette when upsampled',
    Math.abs(at(hi, 0.02, 0.02) - at(lo, 0.02, 0.02)) < 2,
    `corner lum lo ${at(lo, 0.02, 0.02).toFixed(1)} vs hi ${at(hi, 0.02, 0.02).toFixed(1)}`);
}

// ── report ─────────────────────────────────────────────────────────
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  const tag = r.ok ? '\x1b[32m  ok  \x1b[0m' : '\x1b[31m FAIL \x1b[0m';
  console.log(`${tag} ${r.name}${r.detail ? `  \x1b[2m${r.detail}\x1b[0m` : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} semantic checks passed`);
process.exit(failed ? 1 : 0);
