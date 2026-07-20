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

async function loadManifest() {
  const raw = await fs.readFile(MANIFEST_OUT, 'utf8');
  let scenes = JSON.parse(raw);
  if (sceneOnly) scenes = scenes.filter((s) => s.id === sceneOnly);
  return scenes;
}

async function bless(scenes) {
  const targets =
    updateTargets.length > 0 ? scenes.filter((s) => updateTargets.includes(s.id)) : scenes;
  for (const s of targets) {
    const oracleBackend = 'webgl2';
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

async function compareAll(scenes) {
  let parityFail = 0;
  let parityKnownGap = 0;
  let parityResolved = 0;
  const rows = [];

  for (const s of scenes) {
    const isExpectPass = s.oracle === 'gpu' || (s.gpuParity ?? 'expect-pass') === 'expect-pass';
    for (const frame of s.frames) {
      const ref = path.join(REFERENCES, s.id, `${frame}.png`);
      const actual = await readPngSafe(path.join(ACTUAL, 'webgl2', s.id, `${frame}.png`));

      let result;
      if (!actual) {
        result = { pass: false, ratio: 1, mismatchReason: 'webgl2 actual missing' };
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

  // Run the test harness on the single unified engine (WebGL2 by default).
  // HARNESS_BACKENDS=webgl2,webgpu additionally renders WebGPU actuals for
  // orientation/parity spot-checks (the gate itself still compares webgl2).
  const backends = (process.env.HARNESS_BACKENDS || 'webgl2').split(',').map((s) => s.trim()).filter(Boolean);
  process.stdout.write(dim(`· rendering [${backends.join(', ')}] in offscreen Electron…\n`));
  const code = await runElectron(backends);
  if (code !== 0) {
    process.stdout.write(red(`\n✗ render harness exited ${code} — no pixels produced.\n`));
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

  if (parityFail === 0) {
    process.stdout.write(green(`\n✓ gate green — unified engine output matches golden expectations.\n`));
    process.exit(0);
  }
  process.stdout.write(
    red(`\n✗ gate failed — visual regression failures: ${parityFail}.\n`) +
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
