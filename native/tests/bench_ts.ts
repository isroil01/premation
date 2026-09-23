/**
 * The TypeScript side of native/bench/bench_expr.cpp: the SAME expressions,
 * contexts and 2000-layer scene recipe, timed in Node on the real TypeScript
 * (expressions.ts, worldTransform.ts, nodeMatrix.ts). Prints ns per operation
 * so the C++ Google Benchmark numbers can be quoted beside them.
 *
 *     node native/tests/bench_ts.ts
 *
 * Timing only — nothing here is a golden. Warm-up runs first so V8's
 * optimising tier is measured, as in a long playback.
 */

import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const esbuild = createRequire(join(root, 'package.json'))('esbuild');
const out = join(tmpdir(), `motion-bench-ts-${process.pid}.mjs`);
await esbuild.build({
  stdin: {
    contents: `
      export { compileExpression } from './packages/animation/src/expressions';
      export { sampleTrack } from './packages/animation/src/interpolate';
      export { worldMatrixOf } from '@core/scene/worldTransform';
      export { composeNodeWorld3d } from '@core/scene/nodeMatrix';`,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true, platform: 'node', format: 'esm', outfile: out, tsconfig: join(root, 'tsconfig.json'), logLevel: 'error',
  loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty', '.wgsl': 'text', '.glsl': 'text' },
});
const { compileExpression, sampleTrack, worldMatrixOf, composeNodeWorld3d } = await import(pathToFileURL(out).href);

function time(label: string, iters: number, fn: () => void): void {
  for (let i = 0; i < Math.min(iters, 20000); i++) fn();  // warm-up
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn();
  const ns = Number(process.hrtime.bigint() - t0) / iters;
  console.log(`${label.padEnd(28)} ${ns >= 1e5 ? `${(ns / 1e6).toFixed(3)} ms` : `${ns.toFixed(1)} ns`}`);
}

// Keep in step with bench_expr.cpp.
const EXPRESSIONS: Array<[string, string]> = [
  ['BM_Expr_Arith', 'value + Math.sin(time * 2) * 40'],
  ['BM_Expr_Wiggle', 'wiggle(3, 40)'],
  ['BM_Expr_LoopOut', "loopOut('pingpong')"],
  ['BM_Expr_Linear', 'linear(time, 0, 1, 0, 100) + clamp(value, 0, 50)'],
  ['BM_Expr_Bounce', 'time <= key(numKeys).time ? value : value + velocityAtTime(key(numKeys).time - 0.001) * 0.05 * Math.sin((time - key(numKeys).time) * 12) / Math.exp((time - key(numKeys).time) * 4)'],
  ['BM_Expr_Vector', 'add([value, time * 10], mul([1, 2], 3))'],
];
const ramp = { nodeId: 'n', prop: 'x', keyframes: [{ t: 0, value: 0 }, { t: 1, value: 100 }] };
const ctx = {
  time: 0, value: 50, propSeed: 1234, selfSpan: { start: 0, end: 1 }, keyTimes: [0, 1],
  selfAt: (t: number) => sampleTrack(ramp, t),
};
for (const [name, src] of EXPRESSIONS) {
  const e = compileExpression(src);
  let t = 0;
  time(name, 400000, () => {
    ctx.time = t;
    t += 1 / 60;
    if (t > 3) t = 0;
    e.run(ctx);
  });
}
time('BM_Expr_Compile', 100000, () => compileExpression('wiggle(3, 40) + linear(time, 0, 1, 0, 100)'));

function scene(n: number, chain: boolean) {
  const locals = Array.from({ length: n }, (_, i) => ({ x: i * 1.5, y: -i * 0.25, rotation: i * 7.0, scaleX: 1 + i * 0.001, scaleY: 1 }));
  const parents = Array.from({ length: n }, (_, i) => {
    if (chain) return i - 1;
    const p = i - 1 - (i % 3);
    return i % 50 === 0 || p < 0 ? -1 : p;
  });
  return { locals, parents };
}
for (const [name, chain] of [['BM_World2D_2000', false], ['BM_World2D_Chain2000', true]] as const) {
  const { locals, parents } = scene(2000, chain);
  const localOf = (id: string) => locals[Number(id)]!;
  const parentOf = (id: string) => (parents[Number(id)]! >= 0 ? String(parents[Number(id)]) : null);
  time(name, 300, () => {
    const cache = new Map();  // per frame, as buildSnapshot does
    for (let i = 0; i < 2000; i++) worldMatrixOf(String(i), localOf, parentOf, cache);
  });
}
const v3 = Array.from({ length: 2000 }, (_, i) => ({
  x: i, y: -i, z: i * 2, rotationX: i * 3, rotationY: i * 5, rotationZ: i * 7, orientationX: 0, orientationY: 90,
  orientationZ: 0, scaleX: 1, scaleY: 2, scaleZ: 1, anchorX: 10, anchorY: 20, anchorZ: 0,
}));
time('BM_Compose3D_2000', 500, () => { for (const t of v3) composeNodeWorld3d(t); });
