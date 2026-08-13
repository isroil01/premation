/**
 * Size the GPU port of the CPU-baked effects.
 *
 *   node scripts/effectPortTriage.cjs [--list]
 *
 * ── What this measures, and what it refuses to ──────────────────────────────
 *
 * The question is whether porting 112 effects onto the GPU is a month or a
 * quarter. The tempting way to answer it is to classify every effect
 * "mechanical vs hard" from its source, and that was tried here first. It does
 * not work, and the failures are worth recording because the numbers looked
 * authoritative each time:
 *
 *   reading only the dispatch handler        94% mechanical — wrong, because
 *     the handlers are thin wrappers and the pixel work is one call deeper.
 *   `dx`/`dy` as a neighbourhood signal      Vignette, a per-pixel radial
 *     falloff, came back as neighbourhood sampling: `dx` is as often a distance
 *     from a centre as a tap offset.
 *   negative-init loops as the signal        Median got it right and Find Edges
 *     did not — a 3x3 Sobel indexes its neighbours directly, with no tap loop
 *     to find.
 *
 * Three plausible heuristics, three confidently wrong ratios. So this script
 * reports only what it can establish exactly, and leaves the split it cannot.
 *
 * ── What it does establish ──────────────────────────────────────────────────
 *
 *   1. The size of the population, from the predicate that defines it, not
 *      from a copy of the list.
 *   2. How much of it is already in PORTABLE FORM — a pure
 *      `(data, w, h, …) => void` kernel, separate from the Canvas2D plumbing.
 *      This is the real cost driver: translating a pure array kernel to a
 *      fragment shader is mechanical, untangling canvas draw calls is not.
 *   3. The effects that need MORE THAN A FRAGMENT SHADER, which is the only
 *      genuinely hard class and is small enough to name. A shader sees one
 *      pixel and its neighbours; it cannot see a histogram of the whole image
 *      without a separate reduction pass, so anything computing one is a
 *      different piece of work from the rest.
 *
 * Neighbourhood sampling is deliberately NOT counted as hard. A 3x3 Sobel or a
 * box blur is easier in a fragment shader than on the CPU — it is the case
 * shaders exist for.
 */

const fs = require('node:fs');
const path = require('node:path');

const EFFECTS_DIR = path.join(__dirname, '..', 'src', 'core', 'effects');

function sources() {
  const out = new Map();
  for (const f of fs.readdirSync(EFFECTS_DIR)) {
    if (!f.endsWith('.ts') || f.includes('.test.')) continue;
    out.set(f, fs.readFileSync(path.join(EFFECTS_DIR, f), 'utf8'));
  }
  return out;
}

/** `case 'mosaic': return applyMosaic(` → mosaic → applyMosaic */
function dispatchMap(src) {
  const map = new Map();
  for (const m of src.matchAll(/case\s+'([a-z0-9-]+)'\s*:\s*(?:\r?\n\s*)?return\s+([A-Za-z0-9_]+)\s*\(/g)) {
    map.set(m[1], m[2]);
  }
  return map;
}

/**
 * Function bodies, sliced at the NEXT function declaration rather than at the
 * first `\n}`.
 *
 * The naive slice overshoots into whatever follows, which is how an earlier
 * version of this script reported `embossData` as computing a histogram: the
 * word appeared in the next function down. Any signal read out of a body has
 * to be read out of that body alone.
 */
function bodies(all) {
  const out = new Map();
  for (const [file, src] of all) {
    // Boundaries include top-level `const NAME = …` as well as `function`.
    // With `function` alone the slice for `embossData` ran ~50 lines past its
    // own closing brace, over an arrow-function helper that mentions a
    // histogram — and Emboss was reported as needing a reduction pass, which it
    // does not. Every boundary a body can end at has to be a boundary here.
    const marks = [];
    const decl = /^(?:export\s+)?(?:function\s+([A-Za-z0-9_]+)\s*[(<]|const\s+([A-Za-z0-9_]+)\s*(?::[^=]+)?=)/gm;
    for (const m of src.matchAll(decl)) marks.push([m[1] ?? m[2], m.index]);
    for (let i = 0; i < marks.length; i++) {
      const [name, start] = marks[i];
      const end = i + 1 < marks.length ? marks[i + 1][1] : src.length;
      if (!out.has(name)) out.set(name, { file, body: src.slice(start, end) });
    }
  }
  return out;
}

const all = sources();
const fnBodies = bodies(all);
const dispatch = new Map();
for (const [, src] of all) for (const [k, v] of dispatchMap(src)) if (!dispatch.has(k)) dispatch.set(k, v);

// The population, from the predicate's own list.
const c2d = all.get('canvas2dEffects.ts');
const at = c2d.indexOf('const CANVAS2D_ONLY');
const CPU = [...c2d.slice(at, c2d.indexOf('])', at)).matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]);

/** The pure kernel a handler delegates to, if it has one. */
function kernelOf(type) {
  const fn = dispatch.get(type);
  const entry = fn && fnBodies.get(fn);
  if (!entry) return null;
  const m = entry.body.match(/\b([a-zA-Z][A-Za-z0-9_]*Data)\s*\(/);
  return m ? m[1] : null;
}

/** Code only. A signal read out of prose is not a signal. */
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * True when this kernel needs a statistic over the WHOLE image.
 *
 * Comments are stripped first, and that is not a nicety in this repo. Emboss
 * was reported as needing a reduction pass because the doc comment on the NEXT
 * kernel down says scatter "keeps its exact palette and histogram" — prose
 * about a different effect, matched as if it were code. The same trap the
 * document-drift guard hits: `docFeatureCounts.test.ts` strips comments before
 * reading the script for the same reason.
 */
function needsReduction(kernel) {
  const entry = kernel && fnBodies.get(kernel);
  return !!entry && /histogram|cumulative|percentile/i.test(stripComments(entry.body));
}

const rows = CPU.map((type) => {
  const kernel = kernelOf(type);
  return { type, kernel, reduction: needsReduction(kernel) };
});

const withKernel = rows.filter((r) => r.kernel);
const reduction = rows.filter((r) => r.reduction);

console.log(`CPU-baked effects (CANVAS2D_ONLY):        ${CPU.length}`);
console.log(`  already a pure (data, w, h, …) kernel:  ${withKernel.length}  (${((withKernel.length / CPU.length) * 100).toFixed(0)}%)`);
console.log(`  need a whole-image reduction:           ${reduction.length}  ${reduction.map((r) => r.type).join(' ')}`);
console.log(`\nNOT measured here: the split between per-pixel, neighbourhood and`);
console.log(`warp kernels. Three heuristics for it were tried and all three were`);
console.log(`confidently wrong — see the header.`);

if (process.argv.includes('--list')) {
  console.log('\n== effects and their kernels ==');
  for (const r of rows) {
    console.log(`  ${r.type.padEnd(24)} ${(r.kernel ?? '(canvas ops)').padEnd(28)}${r.reduction ? ' REDUCTION' : ''}`);
  }
}
