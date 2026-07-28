/**
 * Golden-frame render-tests runner (Phase 5: unified GPU engine).
 *
 * Pipeline:
 *   1. Build the harness bundle (Vite) that imports the app's real render path.
 *   2. Launch offscreen Electron (SwiftShader) — the pixel factory — which
 *      renders frames using the unified GPU engine (WebGL2).
 *   3. Compare / bless:
 *        - Compare the actual GPU (WebGL2) output against committed reference PNGs.
 *        - Scenes marked gpuParity: 'expect-pass' (or oracle: 'gpu') MUST match.
 *        - Scenes marked gpuParity: 'known-divergent' are allowed to differ.
 *
 * Usage:
 *   node scripts/run.mjs                 # render + compare (the gate)
 *   node scripts/run.mjs --update        # re-bless ALL references from the GPU engine
 *   node scripts/run.mjs --update solid-fill linear-gradient-fill   # bless some
 *   node scripts/run.mjs --scene solid-fill                          # one scene
 */

import { build } from 'vite';
import electronPath from 'electron';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareAgainstReference, readPng, compareFrames } from './comparator.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(__dirname, '..');
const HARNESS_CONFIG = path.join(PKG, 'vite.harness.config.ts');
const HARNESS_HTML = path.join(PKG, 'dist-harness', 'harness', 'index.html');
const REFERENCES = path.join(PKG, 'references');
const ARTIFACTS = path.join(PKG, '.artifacts');
const ACTUAL = path.join(ARTIFACTS, 'actual');
const MANIFEST_OUT = path.join(ARTIFACTS, 'manifest.json');

/**
 * The backend the references are blessed from and the gate compares against.
 *
 * NOT the product's primary engine — that is WebGPU. The references were blessed
 * from WebGL2 and WebGPU does not yet reproduce them in the offscreen harness
 * (see reportSecondaryBackend), so gating on WebGPU today would fail 80 of 93
 * scenes for reasons nobody has isolated to the renderer. Moving this to
 * 'webgpu' is the goal; it needs the divergence diagnosed on real hardware and
 * the references re-blessed first.
 */
const GATE_BACKEND = process.env.HARNESS_GATE_BACKEND || 'webgl2';

/** Rendered every run. The gate backend is forced in regardless. */
const DEFAULT_BACKENDS = ['webgl2', 'webgpu'];

// ── args ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const updateMode = argv.includes('--update');
const sceneFilterFlag = argv.indexOf('--scene');
const sceneOnly = sceneFilterFlag >= 0 ? argv[sceneFilterFlag + 1] : null;
const updateTargets = updateMode
  ? argv.slice(argv.indexOf('--update') + 1).filter((a) => !a.startsWith('--'))
  : [];

const RESET = '\x1b[0m';
const c = (code, s) => `\x1b[${code}m${s}${RESET}`;
const green = (s) => c(32, s);
const red = (s) => c(31, s);
const yellow = (s) => c(33, s);
const dim = (s) => c(2, s);

async function rmrf(p) {
  await fs.rm(p, { recursive: true, force: true });
}

async function buildHarness() {
  process.stdout.write(dim('· building harness bundle (vite)…\n'));
  await build({ configFile: HARNESS_CONFIG, logLevel: 'warn' });
}

function runElectron(backends) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      HARNESS_OUT: ACTUAL,
      HARNESS_MANIFEST_OUT: MANIFEST_OUT,
      HARNESS_BACKENDS: backends.join(','),
      HARNESS_HTML: HARNESS_HTML,
      HARNESS_TIMEOUT_MS: process.env.HARNESS_TIMEOUT_MS || '180000',
    };
    const child = spawn(electronPath, [path.join(PKG, 'electron', 'main.cjs')], {
      env,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

/**
 * Render each backend in its OWN Electron process.
 *
 * Never batch them into one run. WebGPU's Vulkan/SwiftShader adapter and the
 * ANGLE/SwiftShader GL context poison each other inside a single page: measured
 * on this suite, `HARNESS_BACKENDS=webgpu,webgl2` reported 52 failures where
 * webgl2 alone reported 3, with scenes like paint-strokes and
 * hires-4x-stroke-text flipping pass↔fail purely on whether WebGPU had run
 * first. Process isolation is what makes a per-backend comparison mean anything.
 */
async function renderBackendsIsolated(backends) {
  for (const backend of backends) {
    process.stdout.write(dim(`· rendering [${backend}] in its own offscreen Electron…\n`));
    const code = await runElectron([backend]);
    if (code !== 0) return { ok: false, backend, code };
  }
  return { ok: true };
}

async function loadManifest() {
  const raw = await fs.readFile(MANIFEST_OUT, 'utf8');
  let scenes = JSON.parse(raw);
  if (sceneOnly) {
    // A scene's fidelity twin comes with it — filtering it out would report the
    // oracle as "missing" rather than running the gate the flag exists to run.
    const picked = scenes.filter((s) => s.id === sceneOnly);
    const twins = new Set(picked.map((s) => s.fidelityTwin).filter(Boolean));
    scenes = scenes.filter((s) => s.id === sceneOnly || twins.has(s.id));
  }
  return scenes;
}

async function bless(scenes) {
  // Oracle-only scenes are never blessed — they ARE the oracle.
  const blessable = scenes.filter((s) => !s.fidelityOnly);
  const targets =
    updateTargets.length > 0 ? blessable.filter((s) => updateTargets.includes(s.id)) : blessable;
  for (const s of targets) {
    const oracleBackend = GATE_BACKEND;
    for (const frame of s.frames) {
      const from = path.join(ACTUAL, oracleBackend, s.id, `${frame}.png`);
      const toDir = path.join(REFERENCES, s.id);
      await fs.mkdir(toDir, { recursive: true });
      await fs.copyFile(from, path.join(toDir, `${frame}.png`));
    }
    process.stdout.write(green(`  blessed `) + `${s.id} (${s.frames.length} frame(s), oracle=${oracleBackend})\n`);
  }
  process.stdout.write(
    '\n' +
      yellow('⚠  References were re-blessed from the GPU (WebGL2) engine.\n') +
      yellow('   A HUMAN must eyeball references/<scene>/*.png before committing.\n'),
  );
}

/**
 * Non-gating parity report for a secondary backend.
 *
 * WebGPU is the product's PRIMARY engine, but its references cannot be gated
 * yet: rendered in the offscreen harness it diverges from the WebGL2-blessed
 * PNGs on 80 of 93 scenes, and spot-checking the pixels shows whole layers
 * missing (blend-add comes back as flat background where the reference has
 * content) rather than a sub-pixel parity gap. That is either a WebGPU-backend
 * bug or a SwiftShader-Vulkan limitation, and telling those apart needs real
 * hardware — neither conclusion should be reached by turning the build red.
 *
 * So: measure it, print it every run, gate nothing on it. The number moving is
 * the signal; when it reaches parity, promote this to the gate.
 */
async function reportSecondaryBackend(scenes, backend) {
  let compared = 0;
  let matched = 0;
  let missing = 0;
  const worst = [];
  for (const s of scenes) {
    if (s.fidelityOnly) continue; // no reference by design
    for (const frame of s.frames) {
      const actual = await readPngSafe(path.join(ACTUAL, backend, s.id, `${frame}.png`));
      const reference = await readPngSafe(path.join(REFERENCES, s.id, `${frame}.png`));
      if (!actual || !reference) {
        missing++;
        continue;
      }
      compared++;
      const { pass, ratio } = compareFrames(actual, reference, { tolerance: s.tolerance });
      if (pass) matched++;
      else worst.push({ id: `${s.id}#${frame}`, ratio });
    }
  }
  if (compared === 0 && missing === 0) return;
  worst.sort((a, b) => b.ratio - a.ratio);
  process.stdout.write('\n' + dim(`  ${backend} parity report (measured, NOT gated):\n`));
  process.stdout.write(dim(`  · ${matched}/${compared} frame(s) match the committed reference`));
  process.stdout.write(missing > 0 ? dim(` · ${missing} not rendered\n`) : '\n');
  for (const w of worst.slice(0, 5)) {
    process.stdout.write(dim(`  · ${w.id} ${pct(w.ratio)}\n`));
  }
  if (worst.length > 5) process.stdout.write(dim(`  · …and ${worst.length - 5} more\n`));
}

/**
 * Fidelity gate: a scene against its `fidelityTwin`, not against a blessed PNG.
 *
 * References are blessed from our own output, so they can only ever prove "the
 * pixels did not change since someone approved them". A twin renders the same
 * content by an INDEPENDENT route — for SVG layers, the untouched source file
 * beside the sanitized, id-scoped copy we store — so the diff proves the
 * pipeline itself is lossless, on the first run, with nothing to eyeball.
 *
 * Gated at 1% by default (§10). A per-scene `fidelityTolerance` is an explicit
 * statement that we change that file's pixels on purpose, so its
 * `fidelityException` is printed every run rather than buried in a config.
 */
async function gateFidelityTwins(scenes) {
  const byId = new Map(scenes.map((s) => [s.id, s]));
  const pairs = scenes.filter((s) => s.fidelityTwin);
  if (pairs.length === 0) return { fidelityFail: 0, fidelityChecked: 0 };

  let fidelityFail = 0;
  let fidelityChecked = 0;
  const failures = [];
  const exceptions = [];

  for (const s of pairs) {
    const twin = byId.get(s.fidelityTwin);
    if (!twin) {
      failures.push({ id: s.id, ratio: 1, reason: `twin "${s.fidelityTwin}" not in manifest` });
      fidelityFail++;
      continue;
    }
    for (const frame of s.frames) {
      const actual = await readPngSafe(path.join(ACTUAL, GATE_BACKEND, s.id, `${frame}.png`));
      const oracle = await readPngSafe(path.join(ACTUAL, GATE_BACKEND, twin.id, `${frame}.png`));
      if (!actual || !oracle) {
        failures.push({ id: `${s.id}#${frame}`, ratio: 1, reason: 'frame not rendered' });
        fidelityFail++;
        continue;
      }
      fidelityChecked++;
      // A twin comparison passes trivially if BOTH sides drew nothing — a
      // corpus file that silently fails to render would look like perfect
      // fidelity. Require the oracle to actually contain content.
      if (isUniform(oracle)) {
        fidelityFail++;
        failures.push({ id: `${s.id}#${frame}`, ratio: 0, reason: 'oracle frame is blank — the corpus file rendered nothing' });
        continue;
      }
      const tolerance = s.fidelityTolerance ?? 0.01;
      const { pass, ratio } = compareFrames(actual, oracle, { tolerance });
      if (!pass) {
        fidelityFail++;
        failures.push({ id: `${s.id}#${frame}`, ratio, reason: `differs from untouched source` });
      } else if (s.fidelityException) {
        exceptions.push({ id: s.id, tolerance, why: s.fidelityException });
      }
    }
  }

  process.stdout.write('\n' + dim(`  fidelity gate (stored document vs untouched source):\n`));
  process.stdout.write(
    (fidelityFail === 0 ? green : red)(`  · ${fidelityChecked - failures.length}/${fidelityChecked} scene(s) render identically to their source\n`),
  );
  for (const f of failures) {
    process.stdout.write(red(`  · ${f.id} ${pct(f.ratio)} — ${f.reason}\n`));
  }
  for (const e of exceptions) {
    process.stdout.write(dim(`  · ${e.id} passes at a raised ${pct(e.tolerance)}: ${e.why}\n`));
  }
  return { fidelityFail, fidelityChecked };
}

async function compareAll(scenes) {
  let parityFail = 0;
  let parityKnownGap = 0;
  let parityResolved = 0;
  const rows = [];

  for (const s of scenes) {
    // Oracle-only scenes exist to be some other scene's twin; they have no
    // reference of their own by design.
    if (s.fidelityOnly) continue;
    const isExpectPass = s.oracle === 'gpu' || (s.gpuParity ?? 'expect-pass') === 'expect-pass';
    for (const frame of s.frames) {
      const ref = path.join(REFERENCES, s.id, `${frame}.png`);
      const actual = await readPngSafe(path.join(ACTUAL, GATE_BACKEND, s.id, `${frame}.png`));

      let result;
      if (!actual) {
        result = { pass: false, ratio: 1, mismatchReason: `${GATE_BACKEND} actual missing` };
      } else {
        result = await compareAgainstReference({
          actual,
          referenceFile: ref,
          artifactDir: path.join(ARTIFACTS, 'diff'),
          sceneId: s.id,
          frame,
          tolerance: s.tolerance,
        });
      }

      if (isExpectPass) {
        if (!result.pass) {
          parityFail++;
        }
      } else {
        if (!result.pass) {
          parityKnownGap++;
        } else {
          parityResolved++;
        }
      }

      rows.push({
        scene: s.id,
        frame,
        pass: result.pass,
        ratio: result.ratio,
        gpuParity: s.gpuParity ?? 'expect-pass',
        mismatchReason: result.mismatchReason,
        isGpuOracle: s.oracle === 'gpu',
      });
    }
  }

  printReport(rows);
  return { parityFail, parityKnownGap, parityResolved };
}

/** True when every pixel in an RGBA frame is identical (blank / flat fill). */
function isUniform({ data }) {
  for (let i = 4; i < data.length; i += 4) {
    if (data[i] !== data[0] || data[i + 1] !== data[1] || data[i + 2] !== data[2] || data[i + 3] !== data[3]) {
      return false;
    }
  }
  return true;
}

async function readPngSafe(file) {
  try {
    return await readPng(file);
  } catch {
    return null;
  }
}

function pct(r) {
  return `${(r * 100).toFixed(3)}%`;
}

function printReport(rows) {
  process.stdout.write('\n' + dim('scene / frame                      result\n'));
  for (const r of rows) {
    const name = `${r.scene}#${r.frame}`.padEnd(34);
    let p;
    if (r.isGpuOracle) {
      p = r.pass ? green('gpu-oracle ✓') : red('gpu-oracle FAIL ' + pct(r.ratio ?? 1));
    } else if (r.gpuParity === 'known-divergent') {
      p = r.pass
        ? green('parity ✓')
        : dim(`known-gap ${pct(r.ratio ?? 1)}`);
    } else {
      p = r.pass ? green('PASS') : red('FAIL ' + pct(r.ratio ?? 1));
    }
    process.stdout.write(`${name} ${p}\n`);
    if (r.mismatchReason) process.stdout.write(dim(`    ${r.mismatchReason}\n`));
  }
}

async function main() {
  await rmrf(ACTUAL);
  await fs.mkdir(ARTIFACTS, { recursive: true });

  await buildHarness();

  // Every backend renders in its own process (see renderBackendsIsolated).
  // GATE_BACKEND is the one whose output must match the references; any others
  // are measured and printed but never fail the build.
  const backends = (process.env.HARNESS_BACKENDS || DEFAULT_BACKENDS.join(','))
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (!backends.includes(GATE_BACKEND)) backends.unshift(GATE_BACKEND);
  const run = await renderBackendsIsolated(backends);
  if (!run.ok) {
    process.stdout.write(red(`\n✗ render harness exited ${run.code} on [${run.backend}] — no pixels produced.\n`));
    process.exit(1);
  }

  const scenes = await loadManifest();
  if (scenes.length === 0) {
    process.stdout.write(red('✗ no scenes in manifest.\n'));
    process.exit(1);
  }

  if (updateMode) {
    await bless(scenes);
    process.exit(0);
  }

  const { parityFail, parityKnownGap, parityResolved } = await compareAll(scenes);
  const { fidelityFail } = await gateFidelityTwins(scenes);

  process.stdout.write('\n');
  process.stdout.write(dim('  GPU-parity dashboard (unified engine comparison against committed reference):\n'));
  if (parityResolved > 0) {
    process.stdout.write(green(`  · ${parityResolved} scene(s) previously divergent now match exactly!\n`));
  }
  if (parityFail > 0) {
    process.stdout.write(red(`  · ${parityFail} scene(s) failed the target visual expectations.\n`));
  }
  if (parityKnownGap > 0) {
    process.stdout.write(dim(`  · ${parityKnownGap} scene(s) have accepted visual gaps against baseline Canvas2D.\n`));
  }

  // Every non-gating backend that rendered gets a measured parity line, so the
  // primary engine's standing is visible on every run instead of unknown.
  for (const backend of backends) {
    if (backend !== GATE_BACKEND) await reportSecondaryBackend(scenes, backend);
  }

  if (parityFail === 0 && fidelityFail === 0) {
    process.stdout.write(green(`\n✓ gate green — unified engine output matches golden expectations.\n`));
    process.exit(0);
  }
  process.stdout.write(
    red(`\n✗ gate failed — visual regressions: ${parityFail}, fidelity losses: ${fidelityFail}.\n`) +
      dim(`  artifacts: ${path.join(ARTIFACTS, 'diff')}\n`),
  );
  process.exit(1);
}

// Exposed for the comparator self-test.
export { compareFrames };

main().catch((err) => {
  process.stderr.write(red(`\nrunner crashed: ${err?.stack ?? err}\n`));
  process.exit(1);
});
