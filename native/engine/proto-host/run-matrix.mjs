#!/usr/bin/env node
/**
 * Run the whole C1 measurement matrix and print the table for
 * docs/VIEWPORT_ROUTE.md.
 *
 *   node native/engine/proto-host/run-matrix.mjs --out=DIR [--electron40=path/to/electron.exe]
 *        [--seconds=8] [--only=A,B,C] [--display=external|internal]
 *        [--chromium-gpu=low|high] [--fps=0] [--tests=0]   (fps 0 = engine unpaced: throughput ceiling)
 *
 * Routes A and B run on the repo's Electron (32); route C needs Electron >= 40
 * (sharedTexture) — pass its electron.exe. Every run is a fresh host + engine;
 * each host kills its engine on exit.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const out = resolve(args.out || join(here, '.results'));
const seconds = args.seconds || '8';
const only = (args.only || 'A,B,C').split(',');
const electron32 = join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const electron40 = args.electron40;
mkdirSync(out, { recursive: true });

const sizes = [
  { res: 1080, scale: 1, label: '1080p' },
  { res: 1080, scale: 0.5, label: '1080p half (960×540)' },
  { res: 2160, scale: 1, label: '4K' },
  { res: 2160, scale: 0.5, label: '4K half (1920×1080)' },
];
const runs = [];
for (const route of only) {
  const exe = route === 'C' ? electron40 : electron32;
  if (!exe || !existsSync(exe)) {
    console.warn(`skip route ${route}: no electron (${exe})`);
    continue;
  }
  for (const s of sizes) runs.push({ route, exe, ...s, tests: args.tests !== '0' && s.res === 1080 && s.scale === 1 });
  if (route === 'A' && electron40 && existsSync(electron40)) runs.push({ route, exe: electron40, res: 1080, scale: 1, label: '1080p (Electron 40)', tests: false, tag: 'e40' });
}

const rows = [];
for (const r of runs) {
  const name = `${r.route}-${r.res}-${r.scale}${r.tag ? `-${r.tag}` : ''}`;
  const file = join(out, `${name}.json`);
  const cli = [join(here), `--route=${r.route}`, `--res=${r.res}`, `--scale=${r.scale}`, `--seconds=${seconds}`,
    `--tests=${r.tests ? 1 : 0}`, `--out=${file}`, `--shots=${join(out, 'shots')}`];
  for (const pass of ['display', 'chromium-gpu', 'fps']) if (args[pass]) cli.push(`--${pass}=${args[pass]}`);
  console.log(`\n== ${name}`);
  const res = spawnSync(r.exe, cli, { stdio: ['ignore', 'inherit', 'inherit'], timeout: 180_000 });
  if (res.status !== 0) console.warn(`host exited ${res.status}`);
  if (!existsSync(file)) continue;
  const j = JSON.parse(readFileSync(file, 'utf8'));
  rows.push({ name, r, j });
}

const f = (v, d = 1) => (v === null || v === undefined ? '—' : Number(v).toFixed(d));
let md = '| Route | Comp | Electron | Engine fps | Presented fps | Frame latency p50 / p95 (ms) | Cmd latency p50 / p95 (ms) | CPU % (engine / main / renderer / GPU proc) | Total CPU % |\n';
md += '|---|---|---|---|---|---|---|---|---|\n';
for (const { r, j } of rows) {
  const s = j.steady;
  const c = s.cpuPctOfOneCore;
  md += `| ${r.route} | ${r.label} | ${j.config.electron} | ${f(s.engine.renderedFps)} | ${f(s.presentedFps)} | ${f(s.latencyFrameMs?.p50)} / ${f(s.latencyFrameMs?.p95)} | ${f(s.latencyCmdMs?.p50)} / ${f(s.latencyCmdMs?.p95)} | ${f(c.engine)} / ${f(c.main)} / ${f(c.renderer)} / ${f(c.gpuProcess)} | ${f(c.total)} |\n`;
}
writeFileSync(join(out, 'table.md'), md);
writeFileSync(join(out, 'all.json'), JSON.stringify(rows.map(({ name, j }) => ({ name, ...j })), null, 2));
console.log(`\n${md}`);
