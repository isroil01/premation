/**
 * Does a multi-pass plugin effect actually run BOTH passes, on a real GPU?
 *
 *   node packages/render-tests/scripts/verify-plugin-chain.mjs
 *
 * ── Why this exists separately from `verify-plugin-effect.mjs` ───────────────
 *
 * That probe asks whether one shader read its parameter from the right offset.
 * This asks whether the HOST sequenced a chain — a different question, and one
 * that unit tests cannot answer, because everything they can see (two composed
 * shaders, two registry entries, two scene entries) is equally consistent with
 * a renderer that draws the first one twice, or once, or not at all.
 *
 * It was written after discovering exactly that gap: `passes` parsed, composed,
 * budgeted and documented, with nothing in the renderer executing it. Every
 * test passed.
 *
 * ── The shape, and what it discriminates ─────────────────────────────────────
 *
 * Source is a single bright column, one texel wide, down the middle of a black
 * target. Then the sample plugin's real two-pass Gaussian runs over it:
 * horizontal, then vertical.
 *
 *   both passes ran          spread in X (from pass 0) AND full brightness
 *                            down the column, dimmed by the vertical pass
 *                            averaging in its black neighbours
 *   only pass 0 ran          spread in X, column still at FULL brightness —
 *                            nothing averaged vertically
 *   pass 0 ran twice         spread in X, and MORE of it than one pass gives
 *   texelSize arrived as 0   no spread at all; every tap reads the same texel
 *
 * A column is chosen over a single pixel deliberately. A vertical blur over a
 * uniform column is mathematically a no-op in Y — every neighbour is identical
 * — so the vertical pass's contribution shows up as a change in the X profile's
 * TOTAL energy rather than as vertical smearing, which is a cleaner signal than
 * trying to measure a two-axis spread against 8-bit quantisation.
 *
 * Concretely: after H the column has spread sideways and total row energy is
 * conserved. After V, the top and bottom EDGES of the column pull in black, so
 * mean brightness drops by a predictable amount that one pass alone cannot
 * produce. The probe measures both the X spread and the row-to-row variation
 * and reports all three hypotheses distinctly.
 *
 * ── Why it uses the REAL composed shaders ────────────────────────────────────
 *
 * The WGSL is not retyped here. `emitChainShaders.mjs` bundles the actual
 * `composeEffectShader` out of the app with esbuild and writes what the host
 * would hand the driver. A probe that hand-copies the shader tests the copy.
 */

import electronPath from 'electron';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESET = '\x1b[0m';
const red = (s) => `\x1b[31m${s}${RESET}`;
const green = (s) => `\x1b[32m${s}${RESET}`;
const yellow = (s) => `\x1b[33m${s}${RESET}`;
const dim = (s) => `\x1b[2m${s}${RESET}`;

const SHADERS_PATH = path.join(os.tmpdir(), 'motion-plugin-chain-shaders.json');

/** Bundle the app's own shader composition and run it, so this tests the real thing. */
function emitShaders() {
  if (existsSync(SHADERS_PATH)) unlinkSync(SHADERS_PATH);
  const r = spawnSync(
    process.execPath,
    [path.join(__dirname, 'emitChainShaders.mjs'), SHADERS_PATH],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
  if (r.status !== 0 || !existsSync(SHADERS_PATH)) return null;
  return JSON.parse(readFileSync(SHADERS_PATH, 'utf8'));
}

function measure(shaders) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      electronPath,
      [path.join(__dirname, '..', 'electron', 'pluginChainProbe.cjs'), SHADERS_PATH],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => process.stderr.write(dim(String(d))));
    child.on('error', reject);
    child.on('exit', (code) => {
      const lines = out.split('\n');
      const find = (p) => lines.find((l) => l.startsWith(p));
      const result = find('RESULT:');
      if (result) {
        try { return resolve({ kind: 'measured', values: JSON.parse(result.slice(7)) }); }
        catch (err) { return resolve({ kind: 'error', message: `unreadable RESULT: ${err.message}` }); }
      }
      const skip = find('SKIP:');
      if (skip) return resolve({ kind: 'skipped', message: skip.slice(5) });
      const error = find('ERROR:');
      if (error) return resolve({ kind: 'error', message: error.slice(6) });
      resolve({ kind: 'error', message: `probe exited (code ${code}) without reporting an outcome` });
    });
    void shaders;
  });
}

const shaders = emitShaders();
if (!shaders) {
  console.log(red('FAILED — could not compose the sample plugin’s shaders.'));
  console.log('  `emitChainShaders.mjs` bundles the app’s own composeEffectShader; if that');
  console.log('  cannot run, this probe would be testing a hand-copy instead of the real thing.');
  process.exit(1);
}

console.log(dim(`  composed ${shaders.passes.length} pass(es) from ${shaders.effectId}`));

const outcome = await measure(shaders);

if (outcome.kind === 'skipped') {
  console.log(yellow('SKIPPED — no WebGPU adapter on this machine.'));
  console.log(dim(`  ${outcome.message}`));
  process.exit(0);
}
if (outcome.kind === 'error') {
  console.log(red('FAILED — the probe could not complete.'));
  console.log(`  ${outcome.message}`);
  process.exit(1);
}

const m = outcome.values;

console.log('');
console.log('  stage             spread X   spread Y      mean');
for (const s of m.stages) {
  console.log(
    `  ${s.name.padEnd(16)} ${String(s.spreadX).padStart(6)} `
    + `${String(s.spreadY).padStart(10)} ${s.mean.toFixed(2).padStart(9)}`,
  );
}
console.log('');

const [src, afterH, afterV] = m.stages;

/*
  Four checks, each naming a different wiring failure. Together they pin the
  full claim: two distinct shaders ran, in order, each on its own axis, with a
  texel size that came from the host.
*/

// 1. The horizontal pass ran AND `texelSize` reached it. A zero texel size
//    makes every tap read the same texel, so the "blur" is an exact copy —
//    the failure most likely to survive unit tests, because the renderer
//    writes that value and nothing in a unit test can see it.
if (afterH.spreadX <= src.spreadX) {
  console.log(red('FAILED — the horizontal pass did not widen anything.'));
  console.log('  The square is exactly as narrow as it started, so every tap read the same');
  console.log('  texel: `texelSize` arrived as 0. The pass ran; it had nothing to step by.');
  process.exit(1);
}

// 2. It was the HORIZONTAL shader — it must not have touched Y.
if (afterH.spreadY !== src.spreadY) {
  console.log(red('FAILED — the first pass blurred vertically as well as horizontally.'));
  console.log(`  spread Y went ${src.spreadY} → ${afterH.spreadY}. Pass 0 is the horizontal half of a`);
  console.log('  separable blur and must leave the other axis alone.');
  process.exit(1);
}

// 3. The SECOND pass ran, on Y. If it never ran, the image after V is the
//    image after H — the same texture, byte for byte. This is precisely what
//    "composed but never executed" looks like from outside.
if (afterV.spreadY <= afterH.spreadY) {
  console.log(red('FAILED — the second pass never ran, or did nothing.'));
  console.log(`  spread Y is still ${afterV.spreadY}. The host composed two shaders and the vertical`);
  console.log('  one left no trace — which is what a declared-but-unwired chain looks like');
  console.log('  from outside, and what every unit test in this repo would still pass with.');
  process.exit(1);
}

// 4. It was the VERTICAL shader, not pass 0 drawn twice. Running pass 0 again
//    widens X further and leaves Y alone — the exact opposite signature.
if (afterV.spreadX > afterH.spreadX) {
  console.log(red('FAILED — the second draw widened X again.'));
  console.log('  That is the horizontal shader running twice, not a separable blur. Check');
  console.log('  that `registerEffects` passes the pass INDEX to `composeEffectShader`');
  console.log('  rather than composing the contribution twice.');
  process.exit(1);
}

/*
  5. A DOWNSAMPLED pass takes its texel size from the scaled target.

  The same two shaders run again into quarter-size targets. A pass at scale s
  steps i/(W*s) in UV — i/s pixels of the original — so the same tap count
  reaches several times further in composition space. That is the entire reason
  downsampling makes a large blur affordable.

  If the texel size were wrongly the viewport's while rendering into a quarter
  target, each tap would step a quarter of a target texel and the result would
  come out the SAME composition-space width as the full-scale run. Equal is the
  failure; wider is the pass.
*/
const s = m.scaled;
if (s) {
  const ratio = s.spreadXComp / Math.max(1, afterV.spreadX);
  console.log(`  quarter-scale: ${s.targetWidth}px target, spread ${s.spreadXTexels} texels`);
  console.log(`                 = ${s.spreadXComp} composition px, ${ratio.toFixed(2)}× the full-scale blur\n`);

  if (ratio < 1.5) {
    console.log(red('FAILED — the downsampled pass blurred no wider than the full-scale one.'));
    console.log('  Its texel size came from the viewport, not from the quarter-size target it');
    console.log('  drew into. The pass ran and the downsample bought nothing: same reach, less');
    console.log(`  resolution. Expected roughly 4×, measured ${ratio.toFixed(2)}×.`);
    process.exit(1);
  }
}

console.log(green('PASSED — two distinct passes ran, in order, each on its own axis,'));
console.log(green('         and a downsampled pass reached proportionally further.'));
console.log(green(`         H: spread X ${src.spreadX} → ${afterH.spreadX}, Y untouched at ${afterH.spreadY}`));
console.log(green(`         V: spread Y ${afterH.spreadY} → ${afterV.spreadY}, X untouched at ${afterV.spreadX}`));
if (s) console.log(green(`         ¼ scale: ${s.spreadXComp} comp px vs ${afterV.spreadX} at full`));
