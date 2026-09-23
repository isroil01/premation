/**
 * Inspector + timeline with 2,000 layers — `npm run bench` (B4, NATIVE_CORE_PLAN §5).
 *
 * NOT part of the default `jest` run. Renders the Properties panel and the
 * bottom timeline over a 2,000-layer composition built through the engine,
 * and times what a user does, from the event to the committed DOM (React
 * `act`, so every render the change caused is inside the number):
 *
 *   mount        both panels, first render
 *   select       change the selected layer (Properties redraws its sections;
 *                the timeline re-highlights)
 *   scrub        move the paused playhead (value readouts follow)
 *   drag         one move of a Position drag on the selected layer — an engine
 *                gesture message, its events, and every panel update
 *
 * The timeline model is built the way the editor builds it (`TimelineHost`
 * below mirrors App.tsx: before B4 the revision counters + `deriveTimelineTracks`
 * over the scene graph; after it, the document mirror).
 *
 * jsdom + ts-jest inflate everything; compare runs on one machine only.
 */

import { Profiler, useEffect, useMemo, useState } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { unwrap, type Command } from '@motion/engine-api';
import { CommandSystem, setCommandSystem } from '@core/commands/CommandSystem';
import type { CommandServices } from '@core/commands/Command';
import { setUnifiedHistory } from '@core/config/flags';
import { getEventBus } from '@core/events/EventBus';
import { getTimelineController } from '@core/timeline/TimelineController';
import { attachHistoryRecording } from '@stores/historyStore';
import { bootEngine, engineIdle, shutdownEngine } from '@core/engine/engineInstance';
import { GestureSession } from '@core/engine/uiEdits';
import { fakePorts } from '@core/engine/__testHelpers__/harness';
import { useSelectionStore } from '@stores/selectionStore';
import { useProjectStore } from '@stores/projectStore';
import { useCompositionStore } from '@stores/compositionStore';
import { useSceneRevision } from '@stores/sceneStore';
import { setTime } from '@stores/playbackClockStore';
import { isMediaDecodeRepaint } from '@core/rendering/mediaRepaint';
import { BottomTimeline } from '@layout/BottomTimeline/BottomTimeline';
import { PropertiesPanel } from '@layout/EditorLayout/PropertiesPanel';
import { deriveTimelineTracks } from '@layout/Timeline/deriveTimelineTracks';
import type { TimelineModel, TimelineTrack } from '@layout/Timeline';
import type { EditorDocument } from '@core/api/cloudDocument';
import { gitCommit, recordBench, type BenchMetricInput } from '@core/perf/bench/benchRecord';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const N = Number(process.env.BENCH_PANEL_LAYERS ?? 2000);
const REPS = 20;

class NoopResizeObserver {
  observe(): void { /* no layout in jsdom */ }
  unobserve(): void { /* no layout in jsdom */ }
  disconnect(): void { /* no layout in jsdom */ }
}

/** App.tsx's timeline model, as it is built today (see the header). */
function TimelineHost({ onRender }: { onRender: () => void }): JSX.Element {
  // App re-renders on every scene revision (App.tsx `useSceneRevision`).
  const sceneRev = useSceneRevision((s) => s.rev);
  const activeCompId = useProjectStore((s) => (s.activeTabId ? s.tabs[s.activeTabId]?.compositionId : undefined));
  const compFps = useCompositionStore((s) => s.fps);
  const compDuration = useCompositionStore((s) => s.durationSeconds);
  const [graphRev, setGraphRev] = useState(0);
  const [animRev, setAnimRev] = useState(0);
  const [expandedIds] = useState<ReadonlyArray<string>>([]);
  useEffect(() => {
    const bus = getEventBus();
    const a = bus.on('SceneGraphChanged', () => { getTimelineController().syncFromScene(); setGraphRev((v) => v + 1); });
    const b = bus.on('AnimationChanged', (p) => { if (!isMediaDecodeRepaint(p)) setAnimRev((v) => v + 1); });
    return () => { a.dispose(); b.dispose(); };
  }, []);
  const valueRev = expandedIds.length > 0 ? sceneRev : 0;
  const tracks = useMemo<TimelineTrack[]>(() => {
    void graphRev; void animRev; void valueRev;
    return deriveTimelineTracks({ activeCompId, compFps, expandedIds, revs: { anim: animRev, clip: 0, marker: 0 } });
  }, [graphRev, animRev, valueRev, compFps, expandedIds, activeCompId]);
  const model = useMemo<TimelineModel>(() => ({
    duration: compDuration, frameRate: compFps, currentTime: 0, pixelsPerSecond: 100, markers: [], tracks,
  }), [tracks, compDuration, compFps]);
  return <Profiler id="timeline" onRender={onRender}><BottomTimeline model={model} /></Profiler>;
}

interface Timing { mean: number; min: number; p50: number; n: number }
const stat = (xs: number[]): Timing => {
  const s = [...xs].sort((a, b) => a - b);
  return { mean: xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length), min: s[0] ?? 0, p50: s[Math.floor(s.length / 2)] ?? 0, n: xs.length };
};

let layers: string[] = [];
const results: Record<string, Timing | number> = {};

beforeAll(async () => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoopResizeObserver;
  await shutdownEngine();
  setUnifiedHistory(true);
  setCommandSystem(new CommandSystem({ services: {} as CommandServices, getState: () => ({}) }));
  getEventBus().on('SceneGraphChanged', () => getTimelineController().syncFromScene());
  attachHistoryRecording();
  const files = new Map<string, EditorDocument>();
  const e = bootEngine({ ports: fakePorts(files), engineOptions: { verifyScopes: false, recordLog: false } });
  unwrap(await e.execute({ type: 'newProject' }));
  const comp = 'comp_root';
  const t0 = performance.now();
  const cmds: Command[] = [];
  for (let i = 0; i < N; i++) {
    cmds.push({ type: 'createLayer', comp, kind: i % 4 === 0 ? 'text' : i % 4 === 1 ? 'shape' : 'solid', name: `Layer ${i}`, init: [] } as Command);
  }
  const res = unwrap(await e.batch('Build', cmds));
  layers = res.map((r) => (r as unknown as { layer: string }).layer);
  // Every 10th layer animated, so the rows have keyframes to draw.
  const keys: Command[] = [];
  for (let i = 0; i < layers.length; i += 10) {
    keys.push({
      type: 'addKeyframes',
      keys: [0, 1, 2].map((s) => ({ prop: { layer: layers[i]!, path: 'transform/position' }, time: s * 705_600_000, value: { kind: 'vec2', value: { x: 100 * s, y: 50 } }, spatialIn: [], spatialOut: [] })),
    } as Command);
  }
  unwrap(await e.batch('Keys', keys));
  await engineIdle();
  results.buildMs = performance.now() - t0;
}, 900_000);

afterAll(async () => {
  cleanup();
  const metrics: BenchMetricInput[] = [];
  for (const [k, v] of Object.entries(results)) {
    if (typeof v === 'number') continue;
    metrics.push({ name: `panels/${N}-layers`, metric: `${k}.mean`, unit: 'ms', value: Number(v.mean.toFixed(3)), samples: v.n });
    metrics.push({ name: `panels/${N}-layers`, metric: `${k}.min`, unit: 'ms', value: Number(v.min.toFixed(3)), samples: v.n });
  }
  recordBench(metrics);
  const dir = join(process.cwd(), '.artifacts', 'bench');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'panels.latest.json'), JSON.stringify({ commit: gitCommit(), layers: N, results }, null, 2));
  // eslint-disable-next-line no-console
  console.log(`[panels ${N}] ${JSON.stringify(results, (_k, v) => (typeof v === 'number' ? Number(v.toFixed(2)) : v))}`);
  await shutdownEngine();
});

test(`inspector + timeline with ${N} layers`, async () => {
  const counts = { timeline: 0, inspector: 0 };
  useSelectionStore.getState().set([layers[0]!]);
  const t0 = performance.now();
  await act(async () => {
    render(
      <>
        <TimelineHost onRender={() => { counts.timeline += 1; }} />
        <Profiler id="inspector" onRender={() => { counts.inspector += 1; }}><PropertiesPanel /></Profiler>
      </>,
    );
  });
  results.mount = stat([performance.now() - t0]);

  // Selection change.
  const sel: number[] = [];
  for (let i = 0; i < REPS; i++) {
    const id = layers[(i * 97 + 13) % layers.length]!;
    const a = performance.now();
    await act(async () => { useSelectionStore.getState().set([id]); });
    sel.push(performance.now() - a);
  }
  results.select = stat(sel);

  // Scrub (paused): the playhead moves, readouts follow.
  const animatedLayer = layers[0]!;
  await act(async () => { useSelectionStore.getState().set([animatedLayer]); });
  const tab = useProjectStore.getState().activeTabId!;
  const scrub: number[] = [];
  for (let i = 0; i < REPS; i++) {
    const t = (i + 1) / 30;
    const a = performance.now();
    await act(async () => { setTime(tab, t, i + 1); });
    scrub.push(performance.now() - a);
  }
  results.scrub = stat(scrub);

  // A Position drag on the selected layer: one gesture, one message per move.
  const drag: number[] = [];
  const g = new GestureSession('Move');
  const before = { ...counts };
  for (let i = 0; i < REPS; i++) {
    const a = performance.now();
    await act(async () => {
      g.send({ type: 'setProperty', prop: { layer: animatedLayer, path: 'transform/position' }, value: { kind: 'vec2', value: { x: 200 + i, y: 80 } }, time: 0 } as Command);
      await engineIdle();
    });
    drag.push(performance.now() - a);
  }
  await act(async () => { await g.end(); await engineIdle(); });
  results.drag = stat(drag);
  results.dragTimelineCommits = counts.timeline - before.timeline;
  results.dragInspectorCommits = counts.inspector - before.inspector;
}, 900_000);
