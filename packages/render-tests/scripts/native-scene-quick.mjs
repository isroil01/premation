#!/usr/bin/env node
/**
 * The D2w iteration loop: rebuild nothing, re-run only `premation-scene` over the
 * FrameScenes + project documents a previous `npm run render-tests` exported
 * (.artifacts/scenes), and gate its frames against that run's webgpu frames with
 * the native-scene rules (scripts/nativeBackend.mjs gateNative, BACKEND_TOLERANCE,
 * native-scene-baseline.json). Seconds instead of the full harness.
 *
 *   node packages/render-tests/scripts/native-scene-quick.mjs [--only a,b] [--all] [--no-run]
 *
 *   --only a,b   build + render only these scenes (and gate only them)
 *   --all        also print the pixel ratio of every NOT-ported (fallback) frame,
 *                i.e. how far the port is from covering it
 *   --no-run     re-gate the frames already in .artifacts/actual/native-scene
 *   --tag NAME   write to actual/native-scene-NAME + native-scene-report-NAME.json, so
 *                several people (or agents) can iterate on the same exported scenes at once
 *   NATIVE_SCENE_EXE=path   run that premation-scene (e.g. a copy, so a rebuild can relink the original)
 *
 * It never replaces the full run: the webgpu frames it compares against are the
 * last full run's (re-run the harness after any change to snapshot / shaders / passes).
 */

import path from 'node:path';
import { existsSync, promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compareFrames, readPng } from './comparator.mjs';
import { findSceneExe, runNativeScene, reportNativeSceneStructure, gateNative } from './nativeBackend.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RT_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(RT_ROOT, '..', '..');
const ARTIFACTS = path.join(RT_ROOT, '.artifacts');
const SCENES = path.join(ARTIFACTS, 'scenes');
const ACTUAL = path.join(ARTIFACTS, 'actual');

const FONTS = path.join(RT_ROOT, 'harness', 'fonts', 'fonts.json');
const BASELINE = path.join(RT_ROOT, 'native-scene-baseline.json');

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const only = (arg('--only') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const showAll = argv.includes('--all');
const noRun = argv.includes('--no-run');
const tag = arg('--tag');
const BACKEND_DIR = tag ? `native-scene-${tag}` : 'native-scene';
const REPORT = path.join(ARTIFACTS, tag ? `native-scene-report-${tag}.json` : 'native-scene-report.json');

async function readPngSafe(file) {
  try { return await readPng(file); } catch { return null; }
}

async function main() {
  if (!existsSync(path.join(ARTIFACTS, 'manifest.json'))) {
    process.stderr.write('no .artifacts/manifest.json — run `npm run render-tests` (webgpu + native-scene) once first\n');
    process.exit(2);
  }
  let scenes = JSON.parse(await fs.readFile(path.join(ARTIFACTS, 'manifest.json'), 'utf8'));
  if (only.length) scenes = scenes.filter((s) => only.includes(s.id));

  if (!noRun) {
    const exe = findSceneExe(REPO_ROOT);
    if (!exe) {
      process.stderr.write('premation-scene not built (node scripts/native.mjs build --engine)\n');
      process.exit(2);
    }
    const code = await runNativeScene({
      exe, scenesDir: SCENES, outDir: path.join(ACTUAL, BACKEND_DIR), fontsFile: FONTS, reportFile: REPORT, only,
    });
    if (code !== 0) process.stdout.write(`premation-scene exited ${code}\n`);
  }

  const { structFail } = await reportNativeSceneStructure(REPORT);
  const fail = await gateNative(scenes, {
    actualDir: ACTUAL,
    referencesDir: path.join(RT_ROOT, 'references'),
    reportFile: REPORT,
    baselineFile: BASELINE,
    updateBaseline: false,
    compareFrames,
    readPngSafe,
    tolerance: 0.01,
    slack: 0.002,
    tighten: 0.01,
    backendDir: BACKEND_DIR,
    title: 'native-scene parity (quick loop)',
  });

  if (showAll || only.length) {
    const report = JSON.parse(await fs.readFile(REPORT, 'utf8'));
    process.stdout.write('\n  per frame (native-scene vs webgpu, ratio of differing pixels):\n');
    for (const f of report.frames ?? []) {
      if (only.length && !only.includes(f.scene)) continue;
      if (!only.length && f.port === 'ported') continue;
      const a = await readPngSafe(path.join(ACTUAL, BACKEND_DIR, f.scene, `${f.frame}.png`));
      const b = await readPngSafe(path.join(ACTUAL, 'webgpu', f.scene, `${f.frame}.png`));
      const r = a && b ? compareFrames(a, b, {}).ratio : null;
      const struct = f.struct?.ok ? 'struct=' : `struct≠ ${(f.struct?.mismatches ?? []).slice(0, 2).join(' | ')}`;
      process.stdout.write(`    ${`${f.scene}#${f.frame}`.padEnd(42)} ${String(f.port).padEnd(9)} `
        + `${r === null ? '   n/a ' : `${(r * 100).toFixed(3)}%`}  ${struct}`
        + `${f.reasons?.length ? `  [${f.reasons.join('; ')}]` : ''}${f.error ? `  error: ${f.error}` : ''}\n`);
    }
  }
  process.exit(fail + structFail > 0 ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(`${e?.stack ?? e}\n`);
  process.exit(1);
});
