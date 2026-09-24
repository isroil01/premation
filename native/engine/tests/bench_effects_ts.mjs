/**
 * The TypeScript side of `premation-effects --bench`: the SAME kernel cases
 * (tests/data/effect_kernel_bench.json) on the same synthetic 1920×1080 input,
 * timed in Node on the real TS kernels (src/core/effects, via
 * src/core/effects/__testHelpers__/nativeKernels.ts). Prints ms per frame,
 * best of N after a warm-up run, so V8's optimising tier is what is measured.
 *
 *     node native/engine/tests/bench_effects_ts.mjs [--iterations N] [--only <effect>]
 *
 * Timing only — parity is engine_effects_tests.
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const esbuild = createRequire(join(root, 'package.json'))('esbuild');
const out = join(tmpdir(), `premation-bench-effects-${process.pid}.mjs`);
await esbuild.build({
  stdin: {
    contents: `export { runKernel, makeImage } from './src/core/effects/__testHelpers__/nativeKernels';`,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true, platform: 'node', format: 'esm', outfile: out, tsconfig: join(root, 'tsconfig.json'), logLevel: 'error',
  loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty', '.wgsl': 'text', '.glsl': 'text' },
});
const { runKernel, makeImage } = await import(pathToFileURL(out).href);

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
};
const iterations = Math.max(1, Number(opt('--iterations', '3')));
const only = opt('--only', '');

const cfg = JSON.parse(readFileSync(join(here, 'data', 'effect_kernel_bench.json'), 'utf8'));
const { width: w, height: h } = cfg;
const input = makeImage(w, h, 1);
console.log(`${w}x${h}, best of ${iterations}, TypeScript (Node ${process.version})`);
console.log(`${'effect'.padEnd(18)} ${'TS ms'.padStart(10)}`);
for (const c of cfg.cases) {
  if (only && c.effect !== only) continue;
  let best = Infinity;
  for (let i = 0; i < iterations + 1; i++) {
    const buf = new Uint8ClampedArray(input);
    const t0 = process.hrtime.bigint();
    runKernel(c.effect, c.args, buf, w, h);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (i > 0) best = Math.min(best, ms);
  }
  console.log(`${c.effect.padEnd(18)} ${best.toFixed(2).padStart(10)}`);
}
