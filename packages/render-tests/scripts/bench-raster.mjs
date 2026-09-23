#!/usr/bin/env node
/**
 * E3 raster bench (docs/NATIVE_CORE_PLAN.md: "animated-text bench ≥ 3×"):
 * text / vector rasterisation time, TS vs C++, on the SAME raster sources.
 *
 *   TS   the harness renders the animated bench scenes (harness/benchScenes.ts:
 *        200 text layers with per-character animators; 1000 animated trimmed
 *        paths) on the webgpu backend and times Canvas2DVectorRasterizer per
 *        frame (every layer is a raster-cache miss every frame) — `draw` (the
 *        Canvas2D calls) and `total` (draw + the texture upload that flushes a
 *        GPU canvas).
 *   C++  premation-raster --bench draws the exported raster sources of the same
 *        scenes with the ported painters (native mode) — one thread, then all
 *        hardware threads.
 *
 *   node packages/render-tests/scripts/bench-raster.mjs [--cpu-canvas]
 *
 * --cpu-canvas runs the harness with --disable-accelerated-2d-canvas (a software
 * canvas, where `draw` is the whole cost). Writes .artifacts/bench-raster.json.
 */

import { build } from 'vite';
import electronPath from 'electron';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRasterExe } from './nativeBackend.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(here, '..');
const ROOT = path.resolve(PKG, '..', '..');
const ART = path.join(PKG, '.artifacts');
const SCENES = path.join(ART, 'raster-bench-scenes');
const cpuCanvas = process.argv.includes('--cpu-canvas');

function run(cmd, args, env) {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
    child.stdout.on('data', (d) => { out += d; });
    child.on('exit', (code) => resolve({ code: code ?? 1, out }));
  });
}

const exe = findRasterExe(ROOT);
if (!exe) {
  console.error('premation-raster not built — node scripts/native.mjs build --engine (or NATIVE_RASTER_EXE)');
  process.exit(1);
}
await fs.rm(SCENES, { recursive: true, force: true });
await build({ configFile: path.join(PKG, 'vite.harness.config.ts'), logLevel: 'warn' });
const ts = await run(electronPath, ['--no-sandbox', path.join(PKG, 'electron', 'main.cjs')], {
  HARNESS_OUT: path.join(ART, 'raster-bench-actual'),
  HARNESS_MANIFEST_OUT: path.join(ART, 'raster-bench-manifest.json'),
  HARNESS_BACKENDS: 'webgpu',
  HARNESS_HTML: path.join(PKG, 'dist-harness', 'harness', 'index.html'),
  HARNESS_RASTER_BENCH: '1',
  HARNESS_SCENE_OUT: SCENES,
  HARNESS_TIMEOUT_MS: '900000',
  ...(cpuCanvas ? { HARNESS_CHROMIUM_SWITCHES: 'disable-accelerated-2d-canvas' } : {}),
});
const tsRows = new Map();
for (const line of ts.out.split(/\r?\n/)) {
  const m = /\[harness\] raster-bench (\S+) frames=(\d+) rasters=(\d+) drawMsPerFrame=([\d.]+) totalMsPerFrame=([\d.]+) p50TotalMs=([\d.]+)/.exec(line);
  if (m) tsRows.set(m[1], { frames: +m[2], rasters: +m[3], drawMs: +m[4], totalMs: +m[5], p50TotalMs: +m[6] });
}
const cpp = await run(exe, ['--bench', SCENES, '--fonts', path.join(PKG, 'harness', 'fonts', 'fonts.json'), '--iterations', '5'], {});
let native = null;
try { native = JSON.parse(cpp.out.trim().split(/\r?\n/).pop()); } catch { /* reported below */ }
const results = [];
for (const s of native?.scenes ?? []) {
  const t = tsRows.get(s.scene);
  results.push({ scene: s.scene, ts: t ?? null, cpp: s });
}
await fs.writeFile(path.join(ART, 'bench-raster.json'), `${JSON.stringify({ cpuCanvas, results }, null, 2)}\n`);
for (const r of results) {
  console.log(`${r.scene} (${r.cpp.rastersPerFrame} rasters/frame)`);
  if (r.ts) {
    console.log(`  TS  ${cpuCanvas ? 'software' : 'GPU'} canvas  draw ${r.ts.drawMs.toFixed(2)} ms/frame, draw+upload ${r.ts.totalMs.toFixed(2)} ms/frame (p50 ${r.ts.p50TotalMs.toFixed(2)})`);
  }
  console.log(`  C++ 1 thread       ${r.cpp.seqMeanMs.toFixed(2)} ms/frame (p50 ${r.cpp.seqP50Ms.toFixed(2)})`);
  console.log(`  C++ ${r.cpp.threads} threads      ${r.cpp.parMeanMs.toFixed(2)} ms/frame (p50 ${r.cpp.parP50Ms.toFixed(2)})`);
  if (r.ts) {
    console.log(`  speed-up vs TS total: ${(r.ts.totalMs / r.cpp.seqMeanMs).toFixed(1)}× single-threaded, ${(r.ts.totalMs / r.cpp.parMeanMs).toFixed(1)}× threaded`);
  }
}
if (results.length === 0) {
  console.error('no raster bench result', ts.code, cpp.code);
  process.exit(1);
}
