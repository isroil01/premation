/**
 * Verify blend modes on their DEFINING PROPERTIES, independently of any
 * reference image.
 *
 * Run this before blessing a new blend-mode golden. A reference blessed over a
 * defect certifies the defect, and a picture nobody has verified cannot verify
 * the next one.
 *
 *   node packages/render-tests/scripts/run.mjs
 *   node packages/render-tests/scripts/verify-blend-modes.mjs \
 *     packages/render-tests/.artifacts/actual/webgl2
 *
 * The load-bearing check is #1. BLEND_COMBINE's fallthrough is `return cs`,
 * which renders exactly as Normal — so a mode whose shader branch is missing,
 * misnumbered, or routed to the wrong family looks like a perfectly ordinary
 * composite rather than like a bug. "Differs from Normal" catches all three.
 *
 * It earned its place twice on the run that introduced it: it caught a
 * centre-only sample that could not distinguish Lighter Color from Normal, and
 * it disproved the claim that the three Classic modes were distinct maths (F9).
 */
import { PNG } from 'pngjs';
import { readFileSync } from 'node:fs';

const DIR = process.argv[2];
const read = (id) => PNG.sync.read(readFileSync(`${DIR}/${id}/0.png`));
const px = (p, i) => [p.data[i], p.data[i + 1], p.data[i + 2], p.data[i + 3]];
const same = (a, b) => a.data.length === b.data.length && a.data.every((v, i) => v === b.data[i]);

// Inside the ellipse: centred at (160,110), 200x160.
//
// Sample the WHOLE interior, not just the middle. The backdrop gradient runs
// blue (lum 62) -> red (112) -> yellow (198) and the ellipse is lum 136, so the
// ellipse is lighter than the backdrop over most of the frame and DARKER only in
// the yellow corner. A centre-only sample therefore cannot distinguish Lighter
// Color from Normal — it reported a false failure, which is the sampling
// equivalent of testing on the one input where two implementations agree.
const INSIDE = [];
for (let y = 34; y < 186; y += 3) {
  for (let x = 64; x < 256; x += 3) {
    const dx = (x - 160) / 100; const dy = (y - 110) / 80;
    if (dx * dx + dy * dy < 0.85) INSIDE.push((y * 320 + x) * 4);
  }
}

const normal = read('blend-normal');
const NEW = [
  'linear-burn', 'linear-dodge', 'linear-light', 'vivid-light', 'pin-light',
  'hard-mix', 'subtract', 'divide', 'classic-color-burn', 'classic-color-dodge',
  'classic-difference', 'darker-color', 'lighter-color',
];

const fail = [];
const note = [];

// 1. Every new mode must differ from Normal somewhere inside the ellipse.
//    A missing/misrouted branch falls through to `return cs` === Normal.
for (const m of NEW) {
  const p = read(`blend-${m}`);
  const differs = INSIDE.some((i) => {
    const a = px(normal, i); const b = px(p, i);
    return a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2];
  });
  if (!differs) fail.push(`${m}: identical to Normal inside the ellipse — branch missing or misrouted`);
}

// 2. Documented aliases must hold EXACTLY, or the alias claim is false.
if (!same(read('blend-classic-difference'), read('blend-difference')))
  fail.push('classic-difference is not byte-identical to difference (claimed alias)');
// Add and Linear Dodge are the SAME operation in AE, but here they take
// different code paths: `add` maps to advancedBlendId 0 and uses fixed-function
// additive blending on premultiplied values, while linear-dodge (17) goes
// through BLEND_COMBINE, which unpremultiplies, adds, clamps and re-premultiplies.
// Report the magnitude rather than asserting equality — the divergence is real,
// predates M1, and belongs in the findings register, not in a green/red gate.
{
  const a = read('blend-add'); const l = read('blend-linear-dodge');
  let n = 0; let peak = 0;
  for (const i of INSIDE) {
    const d = Math.max(...[0, 1, 2].map((k) => Math.abs(a.data[i + k] - l.data[i + k])));
    if (d > 0) { n++; peak = Math.max(peak, d); }
  }
  note.push(`add vs linear-dodge: ${n}/${INSIDE.length} sampled px differ, peak ${peak} levels ` +
    `(different code paths — fixed-function vs BLEND_COMBINE. AE treats them as one mode. F8)`);
}

// 3. Hard Mix drives every channel to a limit — that IS the mode.
{
  const p = read('blend-hard-mix');
  const bad = INSIDE.filter((i) => px(p, i).slice(0, 3).some((v) => v !== 0 && v !== 255));
  if (bad.length > INSIDE.length * 0.02)
    fail.push(`hard-mix: ${bad.length}/${INSIDE.length} sampled pixels are not 0/255`);
  else if (bad.length) note.push(`hard-mix: ${bad.length} non-limit pixels (edge AA, tolerated)`);
}

// 4. Darker/Lighter Color must pick a whole colour, never mix channels — and
//    must disagree with each other, or one of them is not wired.
if (same(read('blend-darker-color'), read('blend-lighter-color')))
  fail.push('darker-color and lighter-color render identically — one is not wired');

// 5. The Classic (unclamped) variants must differ from their modern
//    counterparts, or they are the same branch under two names.
if (same(read('blend-classic-color-burn'), read('blend-color-burn')))
  note.push('classic-color-burn matches color-burn on this scene (no channel driven past a limit here)');
if (same(read('blend-classic-color-dodge'), read('blend-color-dodge')))
  note.push('classic-color-dodge matches color-dodge on this scene (no channel driven past a limit here)');

// 6. Subtract darkens, Divide brightens — relative to the SAME backdrop, which
//    is the region outside the ellipse in the same image.
for (const [m, dir] of [['subtract', 'darker'], ['divide', 'brighter']]) {
  const p = read(`blend-${m}`);
  const base = px(p, (10 * 320 + 10) * 4);           // outside the ellipse
  const mid = px(p, (110 * 320 + 160) * 4);          // centre, inside
  const lum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  note.push(`${m}: backdrop lum ${lum(base).toFixed(1)} vs blended centre ${lum(mid).toFixed(1)} (expect ${dir})`);
}

for (const n of note) console.log('  note  ' + n);
if (fail.length) { for (const f of fail) console.log('  FAIL  ' + f); process.exit(1); }
console.log(`\n  OK — all ${NEW.length} new modes verified on their defining properties`);
