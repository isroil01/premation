/**
 * Verify Stencil / Silhouette on their DEFINING PROPERTIES, independently of
 * any reference image.
 *
 * Run before blessing a Matte golden. A reference blessed over a defect
 * certifies the defect, and these four scenes were blocked on a determinism bug
 * (F10/F12) precisely so that no arbitrary sample of a moving output got frozen
 * into the reference set.
 *
 *   node packages/render-tests/scripts/run.mjs
 *   node packages/render-tests/scripts/verify-matte-modes.mjs \
 *     packages/render-tests/.artifacts/actual/webgl2
 *
 * The load-bearing checks are the COMPLEMENT pair and the luma value. A stencil
 * whose shader branch went missing falls through BLEND_COMBINE's `return cs` and
 * renders as an ordinary composite — opaque everywhere, plausible, and wrong.
 * "Outside is fully transparent" catches that. But it would still pass if Luma
 * were silently reading coverage instead of brightness, which is why the luma
 * modes are pinned to the matte fill's actual luminance rather than merely
 * "somewhere between 0 and 255".
 */
import { PNG } from 'pngjs';
import { readFileSync } from 'node:fs';

const DIR = process.argv[2];
if (!DIR) {
  console.error('usage: verify-matte-modes.mjs <actual-dir>');
  process.exit(2);
}
const read = (id) => PNG.sync.read(readFileSync(`${DIR}/${id}/0.png`));
const A = (p, i) => p.data[i + 3];

// Scene geometry: 320x220, ellipse centred (160,110), 200x160.
const inside = [];
const outside = [];
for (let y = 4; y < 216; y += 3) {
  for (let x = 4; x < 316; x += 3) {
    const dx = (x - 160) / 100;
    const dy = (y - 110) / 80;
    const r = dx * dx + dy * dy;
    // Skip the rim: it is anti-aliased, so it is legitimately partial in EVERY
    // mode and would blur the binary/partial distinction these checks rest on.
    if (r < 0.75) inside.push((y * 320 + x) * 4);
    else if (r > 1.35) outside.push((y * 320 + x) * 4);
  }
}

/** Luminance of the matte fill #6f8fa8 under the shader's own weights. */
const MATTE_LUMA = Math.round(0.3 * 0x6f + 0.59 * 0x8f + 0.11 * 0xa8);

const fail = [];
const note = [];
const ok = (cond, msg) => { if (!cond) fail.push(msg); else note.push(msg); };

const sa = read('blend-stencil-alpha');
const sl = read('blend-stencil-luma');
const qa = read('blend-silhouette-alpha');
const ql = read('blend-silhouette-luma');
const normal = read('blend-normal');

// 1. A stencil keeps the backdrop where the matte is and removes it elsewhere.
ok(outside.every((i) => A(sa, i) === 0), 'stencil-alpha: backdrop fully removed OUTSIDE the matte');
ok(inside.every((i) => A(sa, i) === 255), 'stencil-alpha: backdrop kept at full strength INSIDE the matte');

// 2. Silhouette is the exact complement, not merely "different".
ok(inside.every((i) => A(qa, i) === 0), 'silhouette-alpha: backdrop removed INSIDE the matte');
ok(outside.every((i) => A(qa, i) === 255), 'silhouette-alpha: backdrop kept OUTSIDE the matte');

// 3. THE complement invariant. Stencil and Silhouette are k and 1-k, so their
//    coverage must sum to exactly opaque at every pixel — a much sharper claim
//    than either one being "about right" on its own.
for (const [n, s, q] of [['alpha', sa, qa], ['luma', sl, ql]]) {
  const bad = [...inside, ...outside].filter((i) => A(s, i) + A(q, i) !== 255);
  ok(bad.length === 0, `${n}: stencil + silhouette coverage sums to exactly 255 (${bad.length} px off)`);
}

// 4. Luma reads BRIGHTNESS, not coverage. The matte is opaque everywhere, so a
//    luma mode that mistakenly read alpha would be indistinguishable from the
//    alpha mode — fully opaque inside. Pinning the actual luminance is what
//    separates them.
ok(inside.every((i) => A(sl, i) === MATTE_LUMA),
  `stencil-luma: coverage inside equals the matte's luminance (${MATTE_LUMA})`);
ok(inside.every((i) => A(ql, i) === 255 - MATTE_LUMA),
  `silhouette-luma: coverage inside equals 255 - luminance (${255 - MATTE_LUMA})`);
ok(outside.every((i) => A(sl, i) === 0), 'stencil-luma: nothing survives outside the matte');

// 5. Premultiplication, as the invariant rather than as a ratio.
//
//    The property that matters is that colour never outruns its own coverage:
//    under premultiplied alpha, every channel must satisfy rgb <= alpha. If a
//    matte scaled alpha alone and left rgb at full strength, this is what would
//    break, and it would show as a bright fringe wherever coverage is partial.
//
//    The +1 is 8-bit rounding, not slop for a wrong answer: the shader computes
//    in float and the surface stores 8-bit, so a channel exactly equal to alpha
//    can round one unit above it. Anything larger is colour genuinely exceeding
//    coverage.
//    The two backends read back under DIFFERENT conventions, so the invariant
//    has to be chosen from the data rather than assumed (F13). WebGL2 reads the
//    drawing buffer directly and yields premultiplied bytes; the WebGPU path
//    goes through drawImage into a 2D canvas and getImageData, which
//    UNPREMULTIPLIES. Same engine output, different encoding — asserting the
//    premultiplied form on WebGPU would fail on a correct render.
//
//    Detected, not hard-coded per backend: a premultiplied buffer cannot have a
//    channel far above its own alpha, so if many pixels do, this is straight
//    colour.
const straightish = inside.filter((i) => sl.data[i] > A(sl, i) + 8).length > inside.length / 10;

if (straightish) {
  // Straight colour: coverage changed, COLOUR did not. So the luma render's rgb
  // must match the full-strength render's rgb, unscaled.
  const bad = inside.filter((i) => {
    for (let c = 0; c < 3; c++) if (Math.abs(sl.data[i + c] - sa.data[i + c]) > 2.5) return true;
    return false;
  });
  ok(bad.length === 0, `stencil-luma: colour is unchanged by coverage (straight readback, ${bad.length} px off)`);
} else {
  // Premultiplied: colour must never outrun its own coverage. The +1 is 8-bit
  // rounding — the shader computes in float and the surface stores 8 bits, so a
  // channel exactly equal to alpha can round one unit above it.
  const overrun = [...inside, ...outside].filter((i) => {
    const a = A(sl, i);
    return sl.data[i] > a + 1 || sl.data[i + 1] > a + 1 || sl.data[i + 2] > a + 1;
  });
  ok(overrun.length === 0, `stencil-luma: no channel outruns its coverage (premultiplied, ${overrun.length} px off)`);

  // And as a ratio against the full-strength render. Tolerance 2.5 because BOTH
  // images are independently quantised to 8 bits, so the rounding errors
  // compose; a tighter bound measures the quantiser, not the blend.
  const ratioBad = inside.filter((i) => {
    const k = A(sl, i) / 255;
    for (let c = 0; c < 3; c++) if (Math.abs(sl.data[i + c] - sa.data[i + c] * k) > 2.5) return true;
    return false;
  });
  ok(ratioBad.length === 0, `stencil-luma: rgb tracks coverage x full strength (${ratioBad.length} px off)`);
}

// 6. None of them may render as an ordinary composite — that is what a missing
//    or misnumbered shader branch looks like.
for (const [id, p] of [['stencil-alpha', sa], ['stencil-luma', sl], ['silhouette-alpha', qa], ['silhouette-luma', ql]]) {
  const same = p.data.length === normal.data.length && p.data.every((v, i) => v === normal.data[i]);
  ok(!same, `${id}: differs from Normal (branch is reached)`);
}

// 7. Alpha Add's seam closure — the M-F10 acceptance criterion, and the other
//    scene F10 kept off the gate. Two 50% coverages can only reach full opacity
//    by ADDITION; standard alpha tops out at 191 (0.5 + 0.5 - 0.25). So the
//    value alone separates the two composite rules, with no control render.
const seam = read('blend-alpha-add-seam');
const alphaAt = (p, x, y) => p.data[(y * p.width + x) * 4 + 3];
// Overlap strip is x 140..150; sample inside it, clear of both anti-aliased rims.
const overlap = [];
const single = [];
for (let y = 60; y < 160; y += 5) {
  for (let x = 143; x <= 147; x++) overlap.push(alphaAt(seam, x, y));
  single.push(alphaAt(seam, 80, y), alphaAt(seam, 230, y));
}
ok(single.every((a) => Math.abs(a - 128) <= 2), 'alpha-add seam: a single 50% layer reads ~128');
ok(overlap.every((a) => a >= 250), `alpha-add seam: the overlap SUMS to full opacity, not 191 (min ${Math.min(...overlap)})`);

for (const n of note) console.log('  ok    ' + n);
if (fail.length) { for (const f of fail) console.log('  FAIL  ' + f); process.exit(1); }
console.log(`\n  OK — all 4 Matte modes verified on their defining properties`);
