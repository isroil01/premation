/**
 * History record + autosave tick benchmark — `npm run bench`.
 *
 * NOT part of the default `jest` run (jest.config.cjs ignores `*.bench.test.ts`).
 * Run with `--expose-gc` so the retained-memory figure is a measurement rather
 * than an allocation-timing accident:
 *
 *   node --expose-gc node_modules/jest/bin/jest.js --config jest.bench.config.cjs \
 *     src/core/commands/historySnapshot.bench.test.ts
 *
 * The document is the large one the engine audit (rec #8) worried about: 2000
 * layers cycling through shapes with bezier paths, text with style runs, paint
 * layers with brush strokes and masked layers, every one keyframed. Each history
 * record moves ONE layer — the common case, and the one where a full-document
 * copy per entry is pure waste.
 *
 * What is timed is the real booted-app path: `record()` pushes, the push emits
 * `UndoStackChanged`, and the baseline sync re-captures inside the same call.
 *
 * jsdom + ts-jest inflate absolute numbers; read them as A/B on one machine.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { EventBus, setEventBus } from '@core/events/EventBus';
import { CommandSystem, getCommandSystem, setCommandSystem } from '@core/commands/CommandSystem';
import { attachHistoryRecording, baselineHistory, performUndo, useHistoryStore } from '@stores/historyStore';
import { setCoreServiceRefs } from '@core/services/coreServices';
import { SettingsManager } from '@core/settings/SettingsManager';
import { captureRecovery, configureRecoveryForTests } from '@core/persistence/recovery';
import { RecoverySerializer } from '@core/persistence/recoverySerializer';
import { appendRecoverySnapshot, type RecoveryKV } from '@core/persistence/recoveryStore';
import type { SceneNode } from '@core/types';
import { setUnifiedHistory } from '@core/config/flags';
import { getTimelineController } from '@core/timeline/TimelineController';
import { useProjectStore } from '@stores/projectStore';
import { recordBench } from '@core/perf/bench/benchRecord';

const LAYERS = 2000;
// The pre-sharing history ran a 4 GB heap out of memory before 500 entries on
// this document, so the count is overridable and memory is also reported per
// entry (× 500 for the headline figure).
const ENTRIES = Number(process.env.BENCH_ENTRIES ?? 500);

const gc = (globalThis as { gc?: () => void }).gc;
function heapMB(): number {
  if (gc) { gc(); gc(); }
  return process.memoryUsage().heapUsed / (1024 * 1024);
}

function stats(ms: number[]): { mean: number; p50: number; p95: number } {
  const s = [...ms].sort((a, b) => a - b);
  const at = (q: number): number => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
  const mean = ms.reduce((a, b) => a + b, 0) / Math.max(1, ms.length);
  return { mean: +mean.toFixed(2), p50: +at(0.5).toFixed(2), p95: +at(0.95).toFixed(2) };
}

function pathPoints(n: number, r: number): Array<Record<string, number>> {
  const out: Array<Record<string, number>> = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push({ x: Math.cos(a) * r, y: Math.sin(a) * r, inX: -3, inY: 2, outX: 3, outY: -2 });
  }
  return out;
}

function layer(i: number): SceneNode {
  const id = `L${i}`;
  const kind = ['shape', 'text', 'shape', 'image'][i % 4]!;
  const components: SceneNode['components'] = [
    { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: kind, x: i % 1920, y: (i * 7) % 1080, rotation: 0, width: 200, height: 120, opacity: 100 } },
    { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#2b7eff', stroke: '#000000', strokeWidth: 2 } },
  ];
  if (i % 4 === 0) {
    components.push({ id: `${id}_g`, type: 'Geometry', props: { points: pathPoints(24, 60), open: false } });
  } else if (i % 4 === 1) {
    components.push({
      id: `${id}_x`, type: 'Text',
      props: {
        content: `Title ${i} — the quick brown fox jumps over the lazy dog`, fontSize: 32, fontFamily: 'Inter',
        runs: [{ start: 0, end: 5, fontWeight: 700 }, { start: 6, end: 20, color: '#ff0000' }],
      },
    });
  } else if (i % 4 === 2) {
    components.push({
      id: `${id}_fx`, type: 'fx',
      props: {
        paint: { strokes: Array.from({ length: 4 }, (_, s) => ({ id: `st${s}`, color: '#fff', size: 8, points: pathPoints(40, 30 + s) })) },
        pathOps: [{ kind: 'offset', amount: 4 }],
      },
    });
  } else {
    components.push({
      id: `${id}_fx`, type: 'fx',
      props: { mask: { mode: 'add', feather: 2, path: pathPoints(16, 80) }, effects: [{ type: 'gaussianBlur', radius: 4 }] },
    });
  }
  return {
    id, name: `Layer ${i}`, parent: 'comp_root', children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components,
  } as unknown as SceneNode;
}

function buildDocument(): void {
  const ids: string[] = [];
  defaultSceneGraph.traverse((n) => ids.push(n.id));
  for (const id of ids) defaultSceneGraph.removeNode(id);
  defaultAnimation.clear();
  defaultSceneGraph.addNode({
    id: 'comp_root', name: 'Composition 1', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 'comp_root_meta', type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode);
  for (let i = 0; i < LAYERS; i++) {
    defaultSceneGraph.addChild('comp_root', layer(i));
    defaultAnimation.setKeyframes(`L${i}`, 'x', Array.from({ length: 6 }, (_, k) => ({ t: k, value: k * 10 + i, easing: 'bezier', bezier: [0.3, 0, 0.7, 1] })) as never);
    defaultAnimation.setKeyframes(`L${i}`, 'opacity', Array.from({ length: 4 }, (_, k) => ({ t: k, value: 100 - k * 20 })) as never);
  }
  // T1: every snapshot carries clip geometry, so the document needs its bars.
  // Register the comp the way the app does and let the timeline mirror seed
  // one bar per layer — 2000 bars in the capture, the realistic worst case.
  // `BENCH_UNIFIED=0` measures the legacy path (no clips) for comparison.
  setUnifiedHistory(process.env.BENCH_UNIFIED !== '0');
  const proj = useProjectStore.getState();
  proj.actions.resetTabs();
  proj.actions.replaceComps({
    comp_root: {
      id: 'comp_root', name: 'Composition 1', width: 1920, height: 1080, fps: 30,
      durationSeconds: 10, background: '#101014', transparent: false, startFrame: 0,
    },
  });
  proj.actions.setActiveTab(proj.actions.openTab('comp_root', ['comp_root'], 'Composition 1'));
  getTimelineController().reset();
  getTimelineController().syncFromScene();
}

function write(result: unknown): void {
  const dir = join(process.cwd(), '.artifacts', 'bench');
  mkdirSync(dir, { recursive: true });
  const body = JSON.stringify(result, null, 2);
  writeFileSync(join(dir, 'historySnapshot.latest.json'), body);
  writeFileSync(join(dir, `historySnapshot.${Date.now()}.json`), body);
  console.log(body);
}

describe('history + autosave on a 2000-layer document', () => {
  it('measures record, undo, retained memory and the autosave tick', () => {
    let settingsBytes = 0;
    const settings = new SettingsManager({
      read: () => null,
      // Serialise exactly as the localStorage backend does, so the cost is real.
      write: (all) => { settingsBytes = JSON.stringify(all).length; },
    });
    setCoreServiceRefs({ settings } as never);
    window.location.hash = '#/editor/proj_bench';

    buildDocument();
    setEventBus(new EventBus());
    setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
    const rec = attachHistoryRecording();

    const docJsonMB = JSON.stringify({ s: defaultSceneGraph.size, a: defaultAnimation.snapshot() }).length / 1e6;

    // ── History ──────────────────────────────────────────────────────
    const t0 = performance.now();
    baselineHistory('Open');
    const openMs = performance.now() - t0;

    const heap0 = heapMB();
    const recordMs: number[] = [];
    for (let i = 0; i < ENTRIES; i++) {
      const id = `L${(i * 7919) % LAYERS}`;
      if (i % 5 === 4) {
        defaultAnimation.setKeyframes(id, 'x', [{ t: 0, value: i }, { t: 2, value: i + 50 }] as never);
      } else {
        defaultSceneGraph.setLocalTransform(id, { x: 5000 + i, y: 10, rotation: 0 });
      }
      const s = performance.now();
      useHistoryStore.getState().record();
      recordMs.push(performance.now() - s);
    }
    const heap1 = heapMB();
    const entries = getCommandSystem().getHistory().getEntries().length;

    const undoMs: number[] = [];
    for (let i = 0; i < 20; i++) {
      const s = performance.now();
      performUndo();
      undoMs.push(performance.now() - s);
    }

    // ── Autosave tick ────────────────────────────────────────────────
    // Timed stage by stage, because the stages now run on different threads:
    //   main   capture → hand-off copy (what postMessage costs) → store append
    //   worker stringify + compare + gzip
    const kvMap = new Map<string, string>();
    const kv: RecoveryKV = {
      getItem: (k) => kvMap.get(k) ?? null,
      setItem: (k, v) => { kvMap.set(k, v); },
      removeItem: (k) => { kvMap.delete(k); },
      keys: () => [...kvMap.keys()],
    };
    configureRecoveryForTests({ storage: kv, workerFactory: null });
    const serializer = new RecoverySerializer();
    const captureMs: number[] = [];
    const handoffMs: number[] = [];
    const workerMs: number[] = [];
    const storeMs: number[] = [];
    const flushMs: number[] = [];
    let bodyKB = 0;
    for (let i = 0; i < 6; i++) {
      defaultSceneGraph.setLocalTransform(`L${i}`, { x: 9000 + i, y: 0, rotation: 0 });
      let s = performance.now();
      const snap = captureRecovery(0)!;
      snap.savedAt = 1000 + i;
      captureMs.push(performance.now() - s);
      s = performance.now();
      structuredClone(snap);
      handoffMs.push(performance.now() - s);
      s = performance.now();
      const res = serializer.run({ seq: i + 1, snap, force: false, folder: false });
      workerMs.push(performance.now() - s);
      s = performance.now();
      if (res.status === 'write') {
        bodyKB = res.body.length / 1024;
        appendRecoverySnapshot(kv, { id: `b${i}`, projectId: 'proj_bench', savedAt: snap.savedAt, time: 0 }, res.body, 5);
      }
      storeMs.push(performance.now() - s);
      // A settings write no longer carries any snapshot; kept to show it.
      s = performance.now();
      settings.set('bench.tick', i);
      settings.flush();
      flushMs.push(performance.now() - s);
    }
    // An unchanged tick: capture, then the worker's exact compare says so.
    const unchanged = captureRecovery(0)!;
    unchanged.savedAt = 5000;
    const u = performance.now();
    const unchangedResult = serializer.run({ seq: 99, snap: unchanged, force: false, folder: false });
    const unchangedWorkerMs = performance.now() - u;

    rec.dispose();
    write({
      when: new Date().toISOString(),
      layers: LAYERS,
      docAnimJsonMB: +docJsonMB.toFixed(2),
      gcExposed: !!gc,
      history: {
        openMs: +openMs.toFixed(1),
        entries,
        recordMs: stats(recordMs),
        retainedMB: +(heap1 - heap0).toFixed(1),
        retainedMBPer500: +(((heap1 - heap0) / ENTRIES) * 500).toFixed(1),
        undoMs: stats(undoMs),
      },
      autosave: {
        mainCaptureMs: stats(captureMs),
        mainHandoffCopyMs: stats(handoffMs),
        mainStoreAppendMs: stats(storeMs),
        workerSerializeGzipMs: stats(workerMs),
        workerUnchangedCompareMs: +unchangedWorkerMs.toFixed(1),
        unchangedDetected: unchangedResult.status === 'unchanged',
        bodyKB: +bodyKB.toFixed(0),
        settingsFlushMs: stats(flushMs),
        settingsPayloadMB: +(settingsBytes / 1e6).toFixed(3),
      },
    });
    // The ratchet (scripts/bench-check.mjs) reads these; the JSON above is the
    // detailed report. p50 rather than min: a record is one sample per edit,
    // and the interesting regression is the typical entry, not the best one.
    const bars = getTimelineController().getLayersForNode('L0').length;
    expect(bars).toBe(1);
    recordBench([
      { name: 'history/record-2000-with-clips', metric: 'record.p50', unit: 'ms', value: stats(recordMs).p50, samples: recordMs.length },
      { name: 'history/record-2000-with-clips', metric: 'undo.p50', unit: 'ms', value: stats(undoMs).p50, samples: undoMs.length },
      { name: 'history/record-2000-with-clips', metric: 'retainedMBPer500', unit: 'count', value: +(((heap1 - heap0) / ENTRIES) * 500).toFixed(1), samples: 0 },
    ]);
    expect(entries).toBeGreaterThan(ENTRIES * 0.8);
  });
});
