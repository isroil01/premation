/**
 * Alpha-interpretation verification — the measurement the alpha scenes exist for.
 *
 *   node scripts/verify-alpha.mjs            # WebGPU (the product's backend)
 *   node scripts/verify-alpha.mjs webgl2     # the fallback, same assertions
 *   node scripts/verify-alpha.mjs both       # both, reported side by side
 *
 * ## Why this is not a golden-PNG diff
 *
 * A blessed reference can only say "these pixels are what someone approved".
 * That is exactly the check that let a straight-alpha double multiply survive
 * two sessions: the pixels were stable, and stably wrong. So this asserts the
 * SHAPE of the composite instead.
 *
 * Every alpha scene draws a white square whose alpha ramps linearly across x
 * over a flat background. Alpha is the only thing that varies along x, so
 * averaging whole columns beats 8-bit quantisation, and the two hypotheses
 * predict curves that cannot be mistaken for one another:
 *
 *     read correctly      out = 255·a + bg·(1−a)     LINEAR in alpha
 *     multiplied twice    out = 255·a² + bg·(1−a)    QUADRATIC in alpha
 *
 * The quadratic sags below the line everywhere strictly between a = 0 and
 * a = 1 and meets it exactly at both ends. That sag IS the dark fringe. Fitting
 * both models and reporting which one the pixels follow says not merely "wrong"
 * but WHICH WAY wrong — the property that identified the double multiply by
 * mechanism rather than by symptom.
 *
 * ## What each scene pins
 *
 * The `alpha-control-straight-src*` pair is the UPLOAD probe, and the reason
 * this file can make a claim about texture upload at all. Its source has
 * constant white RGB with ramping alpha, so "the file is premultiplied" and
 * "the upload premultiplied it" predict different curves — which the
 * premultiplied ramp (where rgb == alpha by construction) cannot separate.
 * A straight source read as straight MUST be linear; if it is quadratic, the
 * texture was premultiplied before the shader sampled it, and the alpha
 * invariant on `TextureSource` (packages/renderer/src/gpu/types.ts) is broken
 * at the upload boundary.
 *
 * The remaining scenes carry that same check through the paths where flat-quad
 * assumptions have leaked in this renderer before: mid and dark backgrounds,
 * the near-zero-alpha end where the un-premultiply divide is most dangerous,
 * 3D, and extrusion (whose back cap is the one synthesized surface that is
 * textured).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPng } from './comparator.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACTUAL = path.resolve(__dirname, '..', '.artifacts', 'actual');

const arg = process.argv[2] || 'webgpu';
const BACKENDS = arg === 'both' ? ['webgpu', 'webgl2'] : [arg];

const RESET = '\x1b[0m';
const red = (s) => `\x1b[31m${s}${RESET}`;
const green = (s) => `\x1b[32m${s}${RESET}`;
const dim = (s) => `\x1b[2m${s}${RESET}`;

// Scene geometry, mirroring harness/scenes/alphaInterp.ts. The subject is a
// 240×240 square centred in a 320×240 comp, so it spans x 40..280 — and its
// alpha ramps 0→1 across exactly that span.
const SUB_X0 = 40;
const SUB_X1 = 280;
const SUB_W = SUB_X1 - SUB_X0;
/**
 * Sample band, as a fraction of the ramp.
 *
 * Both ends are excluded on purpose. At a = 0 and a = 1 the linear and
 * quadratic predictions are IDENTICAL — they meet at the endpoints — so
 * including them adds rows that cannot discriminate and dilutes the fit. The
 * interior is where the two models separate.
 */
const T_LO = 0.15;
const T_HI = 0.85;

const BG = { light: 0xe8, mid: 0x80, dark: 0x10 };

/** Mean RGB of column x, over the vertical middle of the subject. */
function columnMean(png, x, y0, y1) {
  const { width, data } = png;
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    const i = (y * width + x) * 4;
    r += data[i]; g += data[i + 1]; b += data[i + 2];
    n++;
  }
  return (r / n + g / n + b / n) / 3;
}

/**
 * Fit the measured ramp against both predictions and report which one it is.
 *
 * Returns RMS error in 8-bit levels for each model. The two are far apart by
 * construction — at a = 0.5 over #e8e8e8 they differ by ~64 levels — so this is
 * not a close call that a tolerance has to arbitrate.
 */
function fitRamp(png, bgLevel) {
  const y0 = Math.round(png.height * 0.35);
  const y1 = Math.round(png.height * 0.65);
  let linSq = 0, quadSq = 0, n = 0;
  const samples = [];
  for (let x = SUB_X0; x < SUB_X1; x++) {
    const t = (x - SUB_X0) / (SUB_W - 1);
    if (t < T_LO || t > T_HI) continue;
    // The source ramp is quantised to 8 bits before it is drawn, so the alpha
    // actually stored at this column is the rounded value, not the exact
    // fraction. Using the exact fraction would charge that rounding to the fit.
    const a = Math.round(t * 255) / 255;
    const measured = columnMean(png, x, y0, y1);
    const linear = 255 * a + bgLevel * (1 - a);
    const quadratic = 255 * a * a + bgLevel * (1 - a);
    linSq += (measured - linear) ** 2;
    quadSq += (measured - quadratic) ** 2;
    n++;
    if (Math.abs(t - 0.25) < 0.002 || Math.abs(t - 0.5) < 0.002 || Math.abs(t - 0.75) < 0.002) {
      samples.push({ a: +a.toFixed(3), measured: +measured.toFixed(1), linear: +linear.toFixed(1), quadratic: +quadratic.toFixed(1) });
    }
  }
  return {
    linearRms: Math.sqrt(linSq / n),
    quadraticRms: Math.sqrt(quadSq / n),
    samples,
  };
}

const results = [];
const check = (name, ok, detail) => results.push({ name, ok, detail });

/**
 * Geometry-free form of the same claim, for scenes the ramp fit cannot reach.
 *
 * The double multiply squares an alpha in 0..1, so it can only pull a composite
 * toward the background — never away from it. Comparing a scene against its
 * misread twin therefore needs no model of where each alpha landed on screen:
 * the correct read must be strictly further from the background, at a
 * meaningful number of pixels, and never on the wrong side of it.
 */
async function assertBrighterThanDoubleMultiplied(backend, correctId, misreadId) {
  let ok, bad;
  try {
    ok = await readPng(path.join(ACTUAL, backend, correctId, '0.png'));
    bad = await readPng(path.join(ACTUAL, backend, misreadId, '0.png'));
  } catch {
    check(`[${backend}] ${correctId}`, false, 'frame not rendered — run the harness first');
    return;
  }
  // Background is the light comp; "further from background" means brighter here,
  // and the subject is white, so a plain luminance comparison is enough.
  let differing = 0, wrongWay = 0, maxGain = 0;
  for (let i = 0; i < ok.data.length; i += 4) {
    const a = (ok.data[i] + ok.data[i + 1] + ok.data[i + 2]) / 3;
    const b = (bad.data[i] + bad.data[i + 1] + bad.data[i + 2]) / 3;
    if (Math.abs(a - b) < 1) continue;
    differing++;
    if (a < b) wrongWay++;
    if (a - b > maxGain) maxGain = a - b;
  }
  check(
    `[${backend}] ${correctId} — the double multiply only ever darkens (extruded, front + back cap)`,
    differing > 1000 && wrongWay === 0 && maxGain > 20,
    `${differing} px differ, ${wrongWay} in the wrong direction, peak gain ${maxGain.toFixed(1)} levels`,
  );
}

/**
 * Assert that a scene's ramp follows `model`.
 *
 * The threshold is a RATIO, not an absolute error: the claim is "these pixels
 * follow this curve and not the other one", and the two curves are ~64 levels
 * apart mid-ramp. Requiring the wrong model to fit 4× worse states that
 * directly and does not need re-tuning when a background changes.
 */
async function assertShape(backend, sceneId, bgLevel, model, why) {
  let png;
  try {
    png = await readPng(path.join(ACTUAL, backend, sceneId, '0.png'));
  } catch {
    check(`[${backend}] ${sceneId}`, false, 'frame not rendered — run the harness first');
    return;
  }
  const { linearRms, quadraticRms, samples } = fitRamp(png, bgLevel);
  const wanted = model === 'linear' ? linearRms : quadraticRms;
  const other = model === 'linear' ? quadraticRms : linearRms;
  const detail =
    `${model} rms ${wanted.toFixed(2)} vs ${model === 'linear' ? 'quadratic' : 'linear'} rms ${other.toFixed(2)}` +
    (samples.length ? ` · ${samples.map((s) => `a=${s.a}→${s.measured}`).join(' ')}` : '');
  check(`[${backend}] ${sceneId} — ${why}`, wanted * 4 < other && wanted < 12, detail);
  return { linearRms, quadraticRms };
}

for (const backend of BACKENDS) {
  // ── the upload probe ───────────────────────────────────────────────
  //
  // This is the one that can fail because of the TEXTURE UPLOAD rather than
  // because of the interpretation setting, and the only reason the invariant on
  // TextureSource is checkable at all.
  await assertShape(
    backend, 'alpha-control-straight-src', BG.light, 'linear',
    'a straight source composites LINEARLY in alpha (THE UPLOAD PROBE)',
  );
  // The same file declared premultiplied. This is LINEAR TOO, and that is the
  // correct answer rather than a missed defect:
  //
  //   unpremul clamps at min(rgb/a, 1). The source is constant WHITE, so
  //   rgb/a = 1/a ≥ 1 for every a, and the clamp returns 1 at every column.
  //   The shader then re-multiplies: out = 255·a + bg·(1−a). Linear.
  //
  // So this scene cannot discriminate the two interpretations — a white source
  // is a fixed point of the un-premultiply. What it DOES pin is the clamp
  // itself: without `min(…, 1.0)` the divide would push RGB far above 1 and the
  // colour matrix downstream would return bright specks instead of white, which
  // is not linear and not subtle. Asserting linearity here is asserting that
  // invalid premultiplied data is repaired rather than amplified.
  await assertShape(
    backend, 'alpha-control-straight-src-premul', BG.light, 'linear',
    'un-premultiplying a white source clamps to white instead of amplifying',
  );

  // ── the interpretation, on a genuinely premultiplied file ──────────
  for (const [scene, bg, label] of [
    ['alpha-light-premul', BG.light, 'light background'],
    ['alpha-grey-premul', BG.mid, 'mid-grey background'],
    ['alpha-softedge-premul', BG.dark, 'dark background, near-zero alpha'],
    ['alpha-3d-premul', BG.light, '3D layer'],
  ]) {
    await assertShape(backend, scene, bg, 'linear', `premultiplied read correctly — ${label}`);
  }

  // ── extrusion, checked WITHOUT the ramp fit ────────────────────────
  //
  // The extruded scenes are rotated 28° about Y, so a screen column no longer
  // corresponds to a fixed source alpha and the linear/quadratic fit above does
  // not apply to them — fitting anyway produced ~50 rms for BOTH models, which
  // is the verifier's geometry being wrong, not the renderer's.
  //
  // The claim that survives the rotation is comparative: the correctly-read
  // extrusion must be strictly BRIGHTER than the same file misread, everywhere
  // the two differ, because the double multiply can only ever darken (a² ≤ a).
  // That is the same sag, measured without needing to know where each alpha
  // landed on screen.
  await assertBrighterThanDoubleMultiplied(backend, 'alpha-extruded-premul', 'alpha-extruded-straight');

  // ── and the same file misread, which must sag ──────────────────────
  for (const [scene, bg, label] of [
    ['alpha-light-straight', BG.light, 'light background'],
    ['alpha-grey-straight', BG.mid, 'mid-grey background'],
    ['alpha-softedge-straight', BG.dark, 'dark background'],
  ]) {
    await assertShape(backend, scene, bg, 'quadratic', `premultiplied misread as straight double-multiplies — ${label}`);
  }
}

// ── what the straight invariant COSTS at a filtered edge ───────────────
//
// Reported as a NUMBER rather than asserted as a pass/fail, because it prices a
// deliberate design choice instead of guarding a defect. See the alpha
// invariant on TextureSource: straight is the space every textured shader
// assumes, and it is the wrong space to filter in.
//
// The scene magnifies a hard alpha edge 30×, opaque red against (0,0,0,0). At
// the half-covered column the two spaces predict:
//
//   filtered premultiplied  rgb stays red     → R = 255·a + bg·(1−a)
//   filtered straight       rgb averages to   → R = (255·a)·a + bg·(1−a)
//                           red·a first
//
// which is the same linear-vs-quadratic split as the ramp, arrived at through
// the sampler rather than through the interpretation flag.
for (const backend of BACKENDS) {
  try {
    const png = await readPng(path.join(ACTUAL, backend, 'alpha-filter-hard-edge', '0.png'));
    const y = Math.round(png.height / 2);
    const bg = 0xe8;
    // Walk the edge band and find the column whose ALPHA coverage is closest to
    // half, using the green channel: green is 0 in the source, so composited
    // green is bg·(1−a) and inverts to a directly, whichever space we filtered
    // in. That makes coverage measurable without assuming the answer.
    let best = null;
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      const a = 1 - png.data[i + 1] / bg;
      if (a <= 0.02 || a >= 0.98) continue;
      const d = Math.abs(a - 0.5);
      if (!best || d < best.d) best = { d, a, r: png.data[i], x };
    }
    if (!best) {
      check(`[${backend}] filtering cost measured at a half-covered edge column`, false,
        'no partially-covered column found — the edge did not filter');
    } else {
      const premultiplied = 255 * best.a + bg * (1 - best.a);
      const straight = 255 * best.a * best.a + bg * (1 - best.a);
      const cost = premultiplied - best.r;
      process.stdout.write(
        dim(`  cost  [${backend}] filtered edge at a=${best.a.toFixed(3)} (x=${best.x}): ` +
          `red ${best.r} · premultiplied-space predicts ${premultiplied.toFixed(1)}, ` +
          `straight-space predicts ${straight.toFixed(1)} · ` +
          `straight costs ${cost.toFixed(1)} levels\n`),
      );
    }
  } catch {
    process.stdout.write(dim(`  cost  [${backend}] alpha-filter-hard-edge not rendered\n`));
  }
}

// ── the two backends must agree ────────────────────────────────────────
//
// Not a pixel diff: WebGL2 is a best-effort fallback and is not held to pixel
// parity (see EDITOR_FEATURES §21). What it IS held to is landing on the same
// side of the invariant — a project must not change alpha space depending on
// which backend the machine happened to give the user.
if (BACKENDS.length === 2) {
  for (const [scene, bg] of [['alpha-control-straight-src', BG.light], ['alpha-light-premul', BG.light]]) {
    try {
      const a = fitRamp(await readPng(path.join(ACTUAL, 'webgpu', scene, '0.png')), bg);
      const b = fitRamp(await readPng(path.join(ACTUAL, 'webgl2', scene, '0.png')), bg);
      const sameSide = (a.linearRms < a.quadraticRms) === (b.linearRms < b.quadraticRms);
      check(`both backends read ${scene} in the same alpha space`, sameSide,
        `webgpu lin/quad ${a.linearRms.toFixed(1)}/${a.quadraticRms.toFixed(1)} · webgl2 ${b.linearRms.toFixed(1)}/${b.quadraticRms.toFixed(1)}`);
    } catch {
      check(`both backends read ${scene} in the same alpha space`, false, 'a backend did not render it');
    }
  }
}

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  process.stdout.write(`${r.ok ? green('  ok  ') : red(' FAIL ')} ${r.name}${r.detail ? `  ${dim(r.detail)}` : ''}\n`);
}
process.stdout.write(`\n${results.length - failed}/${results.length} alpha checks passed\n`);
process.exit(failed ? 1 : 0);
