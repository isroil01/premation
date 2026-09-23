#!/usr/bin/env node
/**
 * D2 bench: one heavy 1080p comp (harness/benchScenes.ts), frame time on the TS
 * WebGPU backend vs the C++ render graph rendering the SAME exported FrameScene
 * on the SAME adapter. Both are measured as render + submit + wait-for-GPU-idle
 * per frame (100 frames after 10 warm-up).
 *
 *   node packages/render-tests/scripts/bench-native.mjs
 *
 * Writes .artifacts/bench-native.json. Needs premation-render
 * (node scripts/native.mjs build --engine).
 */

import { build } from 'vite';
import electronPath from 'electron';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRenderExe } from './nativeBackend.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(here, '..');
const ROOT = path.resolve(PKG, '..', '..');
const ART = path.join(PKG, '.artifacts');
const SCENES = path.join(ART, 'bench-scenes');

function run(cmd, args, env) {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
    child.stdout.on('data', (d) => { out += d; });
    child.on('exit', (code) => resolve({ code: code ?? 1, out }));
  });
}

const exe = findRenderExe(ROOT);
if (!exe) {
  console.error('premation-render not built — node scripts/native.mjs build --engine');
  process.exit(1);
}
await fs.rm(SCENES, { recursive: true, force: true });
await build({ configFile: path.join(PKG, 'vite.harness.config.ts'), logLevel: 'warn' });
const ts = await run(electronPath, ['--no-sandbox', path.join(PKG, 'electron', 'main.cjs')], {
  HARNESS_OUT: path.join(ART, 'bench-actual'),
  HARNESS_MANIFEST_OUT: path.join(ART, 'bench-manifest.json'),
  HARNESS_BACKENDS: 'webgpu',
  HARNESS_HTML: path.join(PKG, 'dist-harness', 'harness', 'index.html'),
  HARNESS_BENCH: '1',
  HARNESS_SCENE_OUT: SCENES,
  HARNESS_TIMEOUT_MS: '600000',
});
const results = [];
const vendorArg = process.env.NATIVE_GPU_VENDOR ? ['--gpu-vendor', process.env.NATIVE_GPU_VENDOR] : [];
for (const line of ts.out.split(/\r?\n/)) {
  const m = /\[harness\] bench (\S+) webgpu frames=(\d+) meanMs=([\d.]+) p50Ms=([\d.]+) p95Ms=([\d.]+)/.exec(line);
  if (!m) continue;
  const [, id, , mean, p50, p95] = m;
  const file = path.join(SCENES, id, '0.pfs');
  const cpp = await run(exe, ['--bench', file, '--frames', '100', ...vendorArg], {});
  let native = null;
  try { native = JSON.parse(cpp.out.trim().split(/\r?\n/).pop()); } catch { /* reported below */ }
  results.push({ scene: id, webgpu: { meanMs: +mean, p50Ms: +p50, p95Ms: +p95 }, native });
}
const adapter = /\[harness\] webgpu adapter: (.*)/.exec(ts.out)?.[1] ?? '?';
await fs.writeFile(path.join(ART, 'bench-native.json'), `${JSON.stringify({ adapter, results }, null, 2)}\n`);
for (const r of results) {
  console.log(`${r.scene} on ${adapter}`);
  console.log(`  TS WebGPU     mean ${r.webgpu.meanMs.toFixed(2)} ms  p50 ${r.webgpu.p50Ms.toFixed(2)}  p95 ${r.webgpu.p95Ms.toFixed(2)}`);
  if (r.native) {
    console.log(`  C++ (Dawn)    mean ${r.native.meanMs.toFixed(2)} ms (CPU encode ${r.native.meanEncodeMs.toFixed(2)})  p50 ${r.native.p50Ms.toFixed(2)}  p95 ${r.native.p95Ms.toFixed(2)}  on ${r.native.adapter}`);
    console.log(`  C++ bind groups: ${r.native.bindGroupHits} hits / ${r.native.bindGroupMisses} misses; ${r.native.pipelines} pipelines; targets ${r.native.targetHits} hits / ${r.native.targetMisses} misses`);
  } else {
    console.log('  C++ bench failed');
  }
}
if (results.length === 0) {
  console.error('no bench result from the harness');
  process.exit(1);
}
