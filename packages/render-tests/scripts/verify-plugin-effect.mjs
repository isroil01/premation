/**
 * Does a plugin's shader actually RUN, with its parameters at the right offsets?
 *
 *   node scripts/verify-plugin-effect.mjs
 *
 * ── Why this is not a golden-PNG scene ───────────────────────────────────────
 *
 * The pixel gate renders on WebGL2 / ANGLE-SwiftShader, deliberately: golden
 * diffing needs a software rasterizer so any machine reproduces the bytes, and
 * there is no software WebGPU (see `run.mjs`). But a plugin effect ships WGSL
 * only — on WebGL2 it draws the host-generated GLSL **passthrough**.
 *
 * So a golden-frame test for one would render the input unchanged and PASS,
 * proving nothing whatsoever about the shader. It would be a scene that is
 * green because the feature is absent, which is the exact failure mode this
 * project has already been bitten by twice.
 *
 * This follows `verify-alpha.mjs` instead: run on a REAL WebGPU adapter and
 * assert a SHAPE rather than bytes, which is immune to the driver differences
 * that pin the pixel gate to WebGL2.
 *
 * ── The shape, and what it discriminates ─────────────────────────────────────
 *
 * The probe effect is deliberately the simplest thing that can be wrong in an
 * interesting way:
 *
 *     fs() { return textureSample(src, samp, uv) * params.amount; }
 *
 * Render the same scene at several values of `amount` and measure mean output.
 * Three hypotheses predict three different curves and cannot be confused:
 *
 *     shader ran, parameter bound      out ∝ amount          SLOPED
 *     shader ran, parameter at the
 *       wrong offset                   out ∝ some constant   FLAT, wrong value
 *     shader never ran (passthrough)   out = input           FLAT, input value
 *
 * The second row is the one worth the whole file. It is the bug that was
 * actually shipped and then found by reading — the generated struct omitted the
 * renderer's 64-byte `mvp`/`uvRect` header, so `amount` landed on the transform.
 * A pass/fail on "did anything change" cannot see it. A slope can.
 *
 * `uniformLayoutOracle.test.ts` checks the same property statically and runs
 * everywhere; this is the version that asks a GPU. Both are worth having: the
 * oracle derives the layout independently, and this observes what the device
 * actually read.
 */

import electronPath from 'electron';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESET = '\x1b[0m';
const red = (s) => `\x1b[31m${s}${RESET}`;
const green = (s) => `\x1b[32m${s}${RESET}`;
const yellow = (s) => `\x1b[33m${s}${RESET}`;
const dim = (s) => `\x1b[2m${s}${RESET}`;

/** The values of `amount` to sample. Spread wide so a slope is unmistakable. */
const AMOUNTS = [0.0, 0.25, 0.5, 0.75, 1.0];

/**
 * How straight the line has to be.
 *
 * Generous. The claim is "output tracks the parameter", not "output tracks it
 * to four decimal places" — 8-bit quantisation and any driver's rounding both
 * live well inside this, and a tighter bound would make the probe fail for
 * reasons that are not the thing it is asking about.
 */
const MIN_R2 = 0.98;
/** Below this the line is flat, whatever its fit. */
const MIN_SLOPE = 0.2;

/**
 * Ask the renderer, in a real Electron window, for mean output at each amount.
 *
 * Returns null when there is no WebGPU adapter — which is a SKIP, not a pass
 * and not a failure. Reporting "verified" on a machine that never ran the
 * shader would be the same lie this file exists to prevent.
 */
async function measure() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      electronPath,
      [path.join(__dirname, '..', 'electron', 'pluginEffectProbe.cjs'), JSON.stringify(AMOUNTS)],
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
        try {
          return resolve({ kind: 'measured', values: JSON.parse(result.slice('RESULT:'.length)) });
        } catch (err) {
          return resolve({ kind: 'error', message: `unreadable RESULT line: ${err.message}` });
        }
      }

      const skip = find('SKIP:');
      if (skip) return resolve({ kind: 'skipped', message: skip.slice('SKIP:'.length) });

      const error = find('ERROR:');
      if (error) return resolve({ kind: 'error', message: error.slice('ERROR:'.length) });

      // No marker at all: the probe died before it could say anything. That is
      // a failure, not a skip — treating silence as "no adapter here" is how a
      // broken probe passes CI on every machine forever.
      resolve({ kind: 'error', message: `probe exited (code ${code}) without reporting an outcome` });
    });
  });
}

/** Least-squares fit of `y = m·x + c`, with the R² that says how well it fits. */
function fitLine(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  const m = den === 0 ? 0 : num / den;
  const c = my - m * mx;

  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    ssRes += (ys[i] - (m * xs[i] + c)) ** 2;
    ssTot += (ys[i] - my) ** 2;
  }
  return { slope: m, intercept: c, r2: ssTot === 0 ? 0 : 1 - ssRes / ssTot };
}

const outcome = await measure();

if (outcome.kind === 'skipped') {
  console.log(yellow('SKIPPED — no WebGPU adapter on this machine.'));
  console.log(dim(`  ${outcome.message}`));
  console.log(dim('  This probe needs a real adapter: there is no software WebGPU, which is'));
  console.log(dim('  also why the golden-pixel gate runs on WebGL2. Nothing was verified.'));
  // Exit 0. A machine that cannot run the probe has not failed it, and a red
  // CI on every developer laptop without a GPU teaches people to ignore it.
  process.exit(0);
}

if (outcome.kind === 'error') {
  // Distinct from a skip on purpose. The probe spent months reporting "no
  // adapter" while the real cause was its own `data:` URL — a non-secure
  // origin, where `navigator.gpu` does not exist at any hardware.
  console.log(red('FAILED — the probe could not complete.'));
  console.log(`  ${outcome.message}`);
  console.log(dim('  This is the probe failing, not the machine lacking a GPU. If it were'));
  console.log(dim('  the latter it would have said SKIP.'));
  process.exit(1);
}

const measured = outcome.values.map((v) => v.amount);
const passBlock = outcome.values.map((v) => v.passBlock);
const { slope, intercept, r2 } = fitLine(AMOUNTS, measured);

console.log('  amount   mean output   pass block');
AMOUNTS.forEach((a, i) => console.log(
  `   ${a.toFixed(2)}     ${measured[i].toFixed(2).padStart(7)}         ${passBlock[i].toFixed(0).padStart(3)}`,
));
console.log(`\n  fit: out = ${slope.toFixed(2)}·amount + ${intercept.toFixed(2)}   R² = ${r2.toFixed(4)}\n`);

/*
  ★ The pass block, checked BEFORE the slope, because it catches a failure the
  slope cannot.

  Parameters moved from offset 64 to 96 to make room for the host's 32-byte pass
  block. If that block were omitted or misplaced, `amount` would sit back at 64
  — and the CPU side, packing to the same wrong idea, would put it there too.
  The two would agree, the slope would be perfect, and `texelSize` would be
  garbage in every shader that read it. A separable blur written against it
  would be wrong on every machine, and this probe would print PASSED.

  So the shader answers a second question in the same draw: green is 1.0 only if
  `texelSize`, `passScale` and `passIndex` all arrived carrying the distinctive
  values packed for them.
*/
if (!passBlock.every((v) => v > 250)) {
  console.log(red('FAILED — the host pass block did not arrive intact.'));
  console.log('  `texelSize`, `passScale` or `passIndex` read back as something other than');
  console.log('  what was packed at offset 64. Every parameter offset is measured from the');
  console.log('  end of that block, so this also says `amount` is not at 96 — however good');
  console.log(`  the fit above looks. Green channel: ${passBlock.map((v) => v.toFixed(0)).join(', ')}`);
  process.exit(1);
}

if (Math.abs(slope) < MIN_SLOPE) {
  console.log(red('FAILED — output does not track the parameter at all.'));
  console.log('  The shader either never ran (passthrough) or read `amount` from the wrong');
  console.log('  offset. Both draw a frame; neither is the effect the author wrote.');
  process.exit(1);
}

if (r2 < MIN_R2) {
  console.log(red(`FAILED — output changes with the parameter, but not linearly (R² ${r2.toFixed(4)}).`));
  console.log('  Something is reaching the shader; it is not the value that was packed.');
  process.exit(1);
}

console.log(green('PASSED — the shader ran, the host pass block arrived, and the parameter'));
console.log(green('         was read from offset 96.'));
