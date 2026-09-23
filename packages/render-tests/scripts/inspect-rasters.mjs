#!/usr/bin/env node
/**
 * Summarise the text / vector raster sources (RenderRasterSource, E3) in the
 * exported RenderFrameFiles: which Canvas2D calls the TS painters issue, which
 * recordings are incomplete and why, and (--dump) one scene's ops + spec.
 *
 *   node packages/render-tests/scripts/inspect-rasters.mjs [dir] [--scene id] [--dump]
 */

import { build } from 'esbuild';
import { promises as fs, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--scene') ?? path.join(here, '..', '.artifacts', 'scenes');
const only = args.includes('--scene') ? args[args.indexOf('--scene') + 1] : null;
const dump = args.includes('--dump');

const tmp = mkdtempSync(path.join(tmpdir(), 'pfs-'));
try {
  const out = path.join(tmp, 'codec.mjs');
  await build({ entryPoints: [path.join(root, 'packages/engine-api/src/generated/codec.ts')], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error' });
  const { codecs } = await import(pathToFileURL(out).href);
  const ops = new Map();
  const incomplete = new Map();
  let rasters = 0;
  const scenes = (await fs.readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory() && (!only || d.name === only));
  const perScene = [];
  for (const d of scenes) {
    for (const f of await fs.readdir(path.join(dir, d.name))) {
      if (!f.endsWith('.pfs')) continue;
      const file = codecs.RenderFrameFile.decode(new Uint8Array(await fs.readFile(path.join(dir, d.name, f))));
      if (file.rasters.length) perScene.push(`${d.name}/${f}: ${file.rasters.map((r) => `${r.kind} ${r.width}x${r.height}${r.incomplete ? ' [incomplete]' : ''}`).join(', ')}`);
      for (const r of file.rasters) {
        rasters++;
        if (r.incomplete) incomplete.set(r.incomplete, (incomplete.get(r.incomplete) ?? 0) + 1);
        for (const op of JSON.parse(r.opsJson || '[]')) {
          const k = op[1] === 'call' || op[1] === 'set' ? `${op[1]} ${op[2]}` : op[1];
          ops.set(k, (ops.get(k) ?? 0) + 1);
        }
        if (dump) {
          console.log(`── ${d.name}/${f} key=${r.key} kind=${r.kind} ${r.width}x${r.height} scale=${r.resolutionScale} pad=${r.padding}`);
          console.log('spec:', r.specJson.slice(0, 4000));
          for (const op of JSON.parse(r.opsJson || '[]')) console.log('  ', JSON.stringify(op).slice(0, 300));
        }
      }
    }
  }
  console.log(`${rasters} raster source(s)`);
  for (const l of perScene) console.log('  ', l);
  console.log('ops:');
  for (const [k, n] of [...ops.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(7)}  ${k}`);
  if (incomplete.size) {
    console.log('incomplete:');
    for (const [k, n] of incomplete) console.log(`  ${String(n).padStart(5)}  ${k}`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
