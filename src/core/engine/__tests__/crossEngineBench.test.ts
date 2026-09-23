/**
 * D1b perf check: a 2,000-layer composition with keyframes and expressions,
 * built and evaluated by BOTH engines — the TypeScript LocalEngine in-process
 * (scope verification and the wire codec off, as the app runs it) and the C++
 * engine process through the same ProcessEngineClient the app uses (so every
 * C++ number includes the pipe round trip and the codec).
 *
 *   PREMATION_BENCH=1 npx jest src/core/engine/__tests__/crossEngineBench.test.ts
 *
 * Skipped unless PREMATION_BENCH is set (and the engine is built).
 */

import { execSync } from 'node:child_process';
import { ProcessEngineClient, type Command, type EngineClient, type PropRef } from '@motion/engine-api';
import { setupEngine, sec } from '../__testHelpers__/harness';
import { nativeEngineExe, startNativeEngine } from '../__testHelpers__/nativeEngine';
import { installAppExpressionProviders } from './crossEngineProviders.test';

// Fake timers for the harness's 700 ms recorder, but a REAL clock for the measurements.
jest.useFakeTimers({ doNotFake: ['hrtime', 'performance', 'Date'] });

const LAYERS = 2000;
const run = process.env.PREMATION_BENCH && nativeEngineExe() ? test : test.skip;

const now = (): number => Number(process.hrtime.bigint()) / 1e6;
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

/** Working set of a Windows/Linux process, MB. */
function processMemoryMb(pid: number): number {
  if (process.platform === 'win32') {
    const out = execSync(`powershell -NoProfile -Command "(Get-Process -Id ${pid}).WorkingSet64"`).toString().trim();
    return Number(out) / (1024 * 1024);
  }
  const out = execSync(`ps -o rss= -p ${pid}`).toString().trim();
  return Number(out) / 1024;
}

async function ok<T>(p: Promise<{ ok: true; value: T } | { ok: false; error: { code: string; message: string } }>): Promise<T> {
  const r = await p;
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}

interface Numbers { build: number; keys: number; exprs: number; evalAll: number; evalAllRaw: number; transforms: number; roundTrip: number; values: number[] }

async function scenario(e: EngineClient): Promise<Numbers> {
  const comp = 'comp_root';
  let t0 = now();
  const creates: Command[] = Array.from({ length: LAYERS }, (_, i) => ({ type: 'createLayer', comp, kind: i % 2 ? 'solid' : 'shape', name: `L${i}`, init: [] }));
  const results = await ok(e.batch('Build', creates));
  const build = now() - t0;
  const layers = results.map((r) => (r as { layer: string }).layer);

  // Two position keys and two rotation keys on every layer.
  t0 = now();
  for (let at = 0; at < LAYERS; at += 250) {
    const keys = layers.slice(at, at + 250).flatMap((layer, j) => [
      { prop: { layer, path: 'transform/position' }, time: 0, value: { kind: 'vec2' as const, value: { x: j, y: 0 } }, spatialIn: [], spatialOut: [] },
      { prop: { layer, path: 'transform/position' }, time: sec(2), value: { kind: 'vec2' as const, value: { x: j + 500, y: 300 } }, spatialIn: [], spatialOut: [] },
      { prop: { layer, path: 'transform/rotation' }, time: 0, value: { kind: 'scalar' as const, value: 0 }, easing: 'easeInOut' as const, spatialIn: [], spatialOut: [] },
      { prop: { layer, path: 'transform/rotation' }, time: sec(3), value: { kind: 'scalar' as const, value: 360 }, spatialIn: [], spatialOut: [] },
    ]);
    await ok(e.execute({ type: 'addKeyframes', keys }));
  }
  const keys = now() - t0;

  // An expression on every other layer's opacity; a wiggle on every fourth layer's scale.
  t0 = now();
  const exprs: Command[] = [];
  layers.forEach((layer, i) => {
    if (i % 2 === 0) exprs.push({ type: 'setExpression', prop: { layer, path: 'transform/opacity' }, source: 'Math.sin(time * 2 + index) * 50 + 50', enabled: true });
    if (i % 4 === 0) exprs.push({ type: 'setExpression', prop: { layer, path: 'transform/scale' }, source: 'wiggle(3, 20)', enabled: true });
  });
  await ok(e.batch('Expressions', exprs));
  const exprTime = now() - t0;

  // Evaluate every transform property of every layer (10,000 values) at 10 times.
  const props: PropRef[] = layers.flatMap((layer) => ['transform/anchorPoint', 'transform/position', 'transform/scale', 'transform/rotation', 'transform/opacity'].map((path) => ({ layer, path })));
  const evalTimes: number[] = [];
  let values: number[] = [];
  for (let i = 0; i < 10; i++) {
    t0 = now();
    const r = await ok(e.query({ type: 'getPropertyValues', props, time: sec(0.25 * i), evaluated: true }));
    evalTimes.push(now() - t0);
    if (i === 5) values = r.values.flatMap((v) => (v.value.kind === 'scalar' ? [v.value.value] : v.value.kind === 'vec2' ? [v.value.value.x, v.value.value.y] : v.value.kind === 'vec3' ? [v.value.value.x, v.value.value.y, v.value.value.z] : []));
  }
  const rawTimes: number[] = [];
  for (let i = 0; i < 5; i++) {
    t0 = now();
    await ok(e.query({ type: 'getPropertyValues', props, time: sec(0.3 * i), evaluated: false }));
    rawTimes.push(now() - t0);
  }
  const trTimes: number[] = [];
  for (let i = 0; i < 5; i++) {
    t0 = now();
    await ok(e.query({ type: 'getLayerTransforms', layers, time: sec(0.4 * i) }));
    trTimes.push(now() - t0);
  }
  // Command round trip: one static write at a time on a big document.
  const rt: number[] = [];
  for (let i = 0; i < 60; i++) {
    t0 = now();
    await ok(e.execute({ type: 'setProperty', prop: { layer: layers[1 + 2 * (i % 100)]!, path: 'transform/anchorPoint' }, value: { kind: 'vec2', value: { x: i, y: i } } }));
    rt.push(now() - t0);
  }
  return { build, keys, exprs: exprTime, evalAll: median(evalTimes), evalAllRaw: median(rawTimes), transforms: median(trTimes), roundTrip: median(rt), values };
}

run('2,000 layers with keyframes and expressions: C++ vs TypeScript', async () => {
  // TypeScript, in-process.
  global.gc?.();
  const heap0 = process.memoryUsage().heapUsed;
  const ts = await setupEngine({ verifyScopes: false, wire: false });
  installAppExpressionProviders();
  const tsN = await scenario(ts.engine);
  global.gc?.();
  const tsHeapMb = (process.memoryUsage().heapUsed - heap0) / (1024 * 1024);
  await ts.dispose();

  // C++, out of process.
  const native = await startNativeEngine({ extraArgs: ['--no-gpu'] });
  const cxx = new ProcessEngineClient(native.bridge);
  await cxx.whenReady();
  const memBefore = processMemoryMb(native.pid()!);
  const cxxN = await scenario(cxx);
  const memAfter = processMemoryMb(native.pid()!);
  await cxx.close();
  await native.stop();

  const diffs = tsN.values.filter((v, i) => Math.abs(v - (cxxN.values[i] ?? NaN)) > 1e-9 * Math.max(1, Math.abs(v))).length;
  const row = (name: string, a: number, b: number): string => `${name.padEnd(46)} ts ${a.toFixed(1).padStart(9)} ms   c++ ${b.toFixed(1).padStart(9)} ms   (${(a / b).toFixed(1)}×)`;
  console.log([
    `[D1b bench] ${LAYERS} layers, ${LAYERS * 4} keyframes, ${LAYERS / 2 + LAYERS / 4} expressions`,
    row('build (one batch of createLayer)', tsN.build, cxxN.build),
    row('add keyframes (8 × addKeyframes)', tsN.keys, cxxN.keys),
    row('set expressions (one batch)', tsN.exprs, cxxN.exprs),
    row('evaluate 10,000 values (evaluated, median)', tsN.evalAll, cxxN.evalAll),
    row('read 10,000 values (pre-expression, median)', tsN.evalAllRaw, cxxN.evalAllRaw),
    row('getLayerTransforms, 2,000 layers (median)', tsN.transforms, cxxN.transforms),
    row('setProperty round trip (median of 60)', tsN.roundTrip, cxxN.roundTrip),
    `memory: ts heap +${tsHeapMb.toFixed(0)} MB${global.gc ? '' : ' (no --expose-gc: noisy)'}; c++ process working set ${memBefore.toFixed(0)} → ${memAfter.toFixed(0)} MB`,
    `evaluated values compared: ${tsN.values.length}, differing: ${diffs}`,
  ].join('\n'));
  expect(diffs).toBe(0);
}, 600_000);
