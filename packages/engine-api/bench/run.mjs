#!/usr/bin/env node
/**
 * `npm run engine-api:bench` — bundle bench.ts with esbuild (already a dev
 * dependency through Vite) and run it in plain Node. Bundling rather than a
 * TS loader keeps it working on CI's Node 20 with no extra tooling.
 */

import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'engine-api-bench-'));
const outfile = join(out, 'bench.mjs');

try {
  await build({
    entryPoints: [join(here, 'bench.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile,
    logLevel: 'warning',
  });
  const r = spawnSync(process.execPath, [outfile], { stdio: 'inherit' });
  process.exitCode = r.status ?? 1;
} finally {
  rmSync(out, { recursive: true, force: true });
}
