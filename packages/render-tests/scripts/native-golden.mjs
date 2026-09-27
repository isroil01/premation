#!/usr/bin/env node
/**
 * The native golden gate — docs/TS_ENGINE_REMOVAL.md, "Golden gate → native vs
 * the reference folders".
 *
 * No TypeScript engine, no Electron, no WebGPU pass: every harness scene was
 * exported ONCE as a project document (packages/render-tests/scenes/<id>.json,
 * harness/sceneProject.ts `sceneToProject`, plus decoded media in
 * scenes/<id>.media/). This script stages each document the way
 * `premation-scene --batch` reads a scene (<batch>/<id>/project.json + its
 * media), lets the C++ engine open it, build its own FrameScene per frame and
 * render it, and compares every rendered frame with the committed reference
 * (references/<id>/<frame>.png) under the scene's own tolerance.
 *
 *   node packages/render-tests/scripts/native-golden.mjs [--only a,b] [--exe premation-scene]
 *        [--update-baseline]
 *
 * Gate rules (the same shape as the webgpu / native ratchets in run.mjs):
 *   - a frame the engine reports `not-ported` (features the scene builder has
 *     not ported, by name) is counted, never failed;
 *   - a scene marked fidelityOnly has no reference: rendered, reported, not gated;
 *   - a ported frame must match its reference within the scene's tolerance,
 *     unless native-golden-baseline.json lists a ceiling for it (a debt: it may
 *     not get worse, and the listing is removed when it is paid);
 *   - an error (the document did not open, the frame did not build or render)
 *     fails the gate.
 *
 * Differences from the Electron harness a reader should know: there is no TS
 * FrameScene beside the document, so the structural half of the native-scene
 * gate does not run and viewer state (overlay grids, the viewer LUT — viewport
 * chrome, never part of a document) is absent; the scenes that exercise it are
 * the fidelityOnly native-parity scenes. The readback table
 * (--readback-table) was measured by the webgpu pass per machine; without it
 * the engine's frames are compared as rendered.
 *
 * Exit code: 0 = gate green, 1 = regressions / errors / missing references,
 * 2 = the engine is not built or did not run.
 */

import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareFrames, readPng } from './comparator.mjs';
import { findSceneExe, familyOf } from './nativeBackend.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(PKG, '..', '..');
const SCENES_DIR = path.join(PKG, 'scenes');
const REFERENCES = path.join(PKG, 'references');
const ARTIFACTS = path.join(PKG, '.artifacts', 'native-golden');
const BASELINE = path.join(PKG, 'native-golden-baseline.json');
const FONTS = path.join(PKG, 'harness', 'fonts', 'fonts.json');
/** A listed ceiling may be exceeded by this much before it counts as a regression. */
const SLACK = 0.002;
/** A frame this far under its ceiling is reported as improved (tighten the baseline). */
const TIGHTEN = 0.005;

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const pct = (r) => `${(r * 100).toFixed(3)}%`;

function parseArgs(argv) {
  const o = { only: [], exe: null, updateBaseline: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--only') o.only = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--exe') o.exe = argv[++i] ?? null;
    else if (a === '--update-baseline') o.updateBaseline = true;
    else {
      process.stderr.write(`native-golden: unknown argument ${a}\n`);
      process.exit(2);
    }
  }
  return o;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function readPngSafe(file) {
  if (!existsSync(file)) return null;
  try {
    return await readPng(file);
  } catch {
    return null;
  }
}

/** Every exported scene: { id, file, doc }. */
async function loadScenes(only) {
  const names = (await fs.readdir(SCENES_DIR)).filter((f) => f.endsWith('.json')).sort();
  const scenes = [];
  for (const name of names) {
    const id = name.slice(0, -'.json'.length);
    if (only.length && !only.includes(id)) continue;
    const file = path.join(SCENES_DIR, name);
    const doc = JSON.parse(await fs.readFile(file, 'utf8'));
    scenes.push({ id, file, doc });
  }
  return scenes;
}

/** <batch>/<id>/project.json + the scene's media, the layout premation-scene --batch reads. */
async function stage(scenes, batchDir) {
  await fs.rm(batchDir, { recursive: true, force: true });
  for (const s of scenes) {
    const dir = path.join(batchDir, s.id);
    await fs.mkdir(dir, { recursive: true });
    await fs.copyFile(s.file, path.join(dir, 'project.json'));
    const mediaDir = path.join(SCENES_DIR, `${s.id}.media`);
    for (const m of s.doc.harness?.media ?? []) {
      await fs.copyFile(path.join(mediaDir, m), path.join(dir, m));
    }
  }
}

function runScene(exe, batchDir, outDir, reportFile) {
  const profile = process.platform === 'win32' ? 'chromium' : 'portable';
  const args = ['--batch', batchDir, '--fonts', FONTS, '--profile', profile, '--out', outDir, '--report', reportFile];
  return new Promise((resolve) => {
    const child = spawn(exe, args, { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const exe = opts.exe ?? findSceneExe(REPO_ROOT);
  if (!exe || !existsSync(exe)) {
    process.stderr.write(red('native-golden: premation-scene is not built (node scripts/native.mjs build --engine, or --exe / NATIVE_SCENE_EXE).\n'));
    process.exit(2);
  }
  const scenes = await loadScenes(opts.only);
  if (scenes.length === 0) {
    process.stderr.write(red(`native-golden: no scene documents in ${path.relative(REPO_ROOT, SCENES_DIR)}.\n`));
    process.exit(1);
  }
  const batchDir = path.join(os.tmpdir(), `premation-native-golden-${process.pid}`);
  const outDir = path.join(ARTIFACTS, 'actual');
  const reportFile = path.join(ARTIFACTS, 'report.json');
  await fs.rm(ARTIFACTS, { recursive: true, force: true });
  await fs.mkdir(ARTIFACTS, { recursive: true });
  await stage(scenes, batchDir);
  process.stdout.write(dim(`· rendering ${scenes.length} scene document(s) with ${path.relative(REPO_ROOT, exe)}…\n`));
  const code = await runScene(exe, batchDir, outDir, reportFile);
  await fs.rm(batchDir, { recursive: true, force: true });
  const report = await readJson(reportFile, null);
  if (code !== 0 || !report) {
    process.stderr.write(red(`native-golden: premation-scene exited ${code}${report ? '' : ' without a report'}.\n`));
    process.exit(2);
  }

  const byFrame = new Map((report.frames ?? []).map((f) => [`${f.scene}#${f.frame}`, f]));
  const baseline = (await readJson(BASELINE, {})).frames ?? {};
  const newBaseline = {};
  const fam = new Map();
  const famRow = (name) => {
    if (!fam.has(name)) fam.set(name, { total: 0, ported: 0, passing: 0 });
    return fam.get(name);
  };
  const reasons = new Map();
  const regressed = [];
  const unlisted = [];
  const improved = [];
  const errors = [];
  const missingRefs = [];
  let total = 0;
  let ported = 0;
  let passing = 0;
  let ungated = 0;

  for (const s of scenes) {
    const h = s.doc.harness ?? {};
    const frames = Array.isArray(h.frames) ? h.frames : [0];
    const tolerance = typeof h.tolerance === 'number' ? h.tolerance : undefined;
    for (const frame of frames) {
      const id = `${s.id}#${frame}`;
      const row = famRow(familyOf(s.id));
      total++;
      row.total++;
      const rep = byFrame.get(id);
      if (!rep) {
        errors.push({ id, why: 'not in the engine report' });
        continue;
      }
      if (rep.status === 'not-ported') {
        for (const r of rep.reasons ?? []) reasons.set(r, (reasons.get(r) ?? 0) + 1);
        continue;
      }
      if (rep.status !== 'rendered') {
        errors.push({ id, why: rep.error ?? rep.status });
        continue;
      }
      const actual = await readPngSafe(path.join(outDir, s.id, `${frame}.png`));
      if (!actual) {
        errors.push({ id, why: 'reported rendered but no PNG' });
        continue;
      }
      ported++;
      row.ported++;
      if (h.fidelityOnly) {
        ungated++;
        continue;
      }
      const ref = await readPngSafe(path.join(REFERENCES, s.id, `${frame}.png`));
      if (!ref) {
        missingRefs.push(id);
        continue;
      }
      const { pass, ratio, mismatchReason } = compareFrames(actual, ref, { tolerance });
      if (pass) {
        passing++;
        row.passing++;
      } else {
        newBaseline[id] = Number(ratio.toFixed(5));
      }
      const ceiling = baseline[id];
      if (ceiling === undefined) {
        if (!pass) unlisted.push({ id, ratio, why: mismatchReason });
      } else if (ratio > ceiling + SLACK) {
        regressed.push({ id, ratio, ceiling });
      } else if (ratio < ceiling - TIGHTEN) {
        improved.push({ id, ratio, ceiling });
      }
    }
  }

  process.stdout.write('\n' + dim('  native golden gate (the C++ engine rendering each frozen scene document vs its reference):\n'));
  process.stdout.write(`  ${passing}/${ported - ungated} gated frame(s) match; ${ported}/${total} frame(s) fully ported; ${ungated} rendered ungated (fidelityOnly)\n`);
  for (const [name, r] of [...fam.entries()].sort()) {
    process.stdout.write(dim(`    ${name.padEnd(28)} ${String(r.passing).padStart(4)} pass / ${String(r.ported).padStart(4)} ported / ${String(r.total).padStart(4)} frames\n`));
  }
  if (reasons.size) {
    process.stdout.write(dim('  not ported yet (frames per reason):\n'));
    for (const [r, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) process.stdout.write(dim(`    ${String(n).padStart(4)}  ${r}\n`));
  }
  for (const w of improved) process.stdout.write(green(`  · ${w.id} ${pct(w.ratio)} — under its ${pct(w.ceiling)} ceiling; tighten native-golden-baseline.json\n`));
  for (const w of regressed) process.stdout.write(red(`  x ${w.id} ${pct(w.ratio)} — over its ${pct(w.ceiling)} ceiling\n`));
  for (const w of unlisted) process.stdout.write(red(`  x ${w.id} ${w.why ?? pct(w.ratio)} — differs from its reference and has no ceiling\n`));
  for (const e of errors) process.stdout.write(red(`  x ${e.id}: ${e.why}\n`));
  for (const id of missingRefs) process.stdout.write(red(`  x ${id}: no reference PNG\n`));

  if (opts.updateBaseline) {
    const text = JSON.stringify({
      _comment: 'Ceilings (differing-pixel ratio) for frames where the C++ engine rendering the frozen scene document (scenes/<id>.json) differs from the reference. A LIST OF DEBTS: a frame may not get worse, and its entry goes when it matches. Written by scripts/native-golden.mjs --update-baseline; review the diff.',
      frames: Object.fromEntries(Object.entries(newBaseline).sort(([a], [b]) => a.localeCompare(b))),
    }, null, 2);
    await fs.writeFile(BASELINE, `${text}\n`);
    process.stdout.write(yellow(`  wrote ${path.relative(REPO_ROOT, BASELINE)} (${Object.keys(newBaseline).length} ceiling(s))\n`));
    process.exit(errors.length ? 1 : 0);
  }
  const fail = regressed.length + unlisted.length + errors.length + missingRefs.length;
  process.stdout.write(fail ? red(`\n✗ native golden gate: ${fail} failure(s)\n`) : green('\n✓ native golden gate green\n'));
  process.exit(fail ? 1 : 0);
}

await main();
