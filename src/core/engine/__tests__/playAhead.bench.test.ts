/**
 * Uncached playback of a comp whose cost is the FRAME BUILD, not the GPU: many
 * small animated rectangles (the shape of the 657-layer film, ~64 ms of build
 * per frame on one core). Before play-ahead the main build worker built every
 * shown frame on one core; now the prefetch workers build the frames after it
 * and the core thread presents them in clock order (Session::schedule_ahead).
 * No frame cache (--frame-cache-mb 0): every frame is built.
 *
 * Printed, one `[ahead] {json}` line: the frames presented in the play, the
 * play's wall time, fps, the build time per frame (cpuFrameMs) and the
 * engine's `playback_summary` (`builtAhead`: frames presented from a
 * play-ahead build). Compare with PREMATION_PREFETCH_WORKERS=0 (no prefetch
 * workers, so no play-ahead: the one-core build).
 *
 *   PREMATION_BENCH_LAYERS=<n>   layer count (default 1500)
 *
 * Recorded for the ratchet as `playAhead/<n>layers`.
 */
import { ProcessEngineClient, secondsToFlicks, unwrap, type Command, type KeyframeInsert } from '@motion/engine-api';
import type { EngineFrameMessage } from '../../../../electron/engineFraming';
import { recordBench } from '../../perf/bench/benchRecord';
import { nativeEngineExe, startNativeEngine } from '../__testHelpers__/nativeEngine';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const LAYERS = Number(process.env.PREMATION_BENCH_LAYERS ?? '1500');
const SECONDS = 3;
const SCENARIO = `playAhead/${LAYERS}layers`;

describe('play-ahead: uncached playback of a build-bound comp', () => {
  it('plays three seconds and reports the frames presented', async () => {
    if (!nativeEngineExe()) {
      console.log('[ahead] premation-engine is not built');
      return;
    }
    const native = await startNativeEngine({ extraArgs: ['--frame-cache-mb', '0', '--log-level', 'info'] });
    const client = new ProcessEngineClient(native.bridge);
    const summaries: Record<string, unknown>[] = [];
    native.supervisor.on('log', (line: string) => {
      if (!line.includes('"playback_summary"')) return;
      try {
        summaries.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        /* not JSON */
      }
    });
    let phase = 'idle';
    let shown = 0;
    let backwards = 0;
    let lastFrame = -1;
    native.supervisor.on('frame', (m: EngineFrameMessage) => {
      if (m.type !== 'frameReady') return;
      native.supervisor.releaseSlot(m.generation, m.slot);
      if (phase !== 'playing') return;
      ++shown;
      if (m.frame < lastFrame) ++backwards;
      lastFrame = m.frame;
    });
    client.subscribe((batch) => {
      for (const e of batch.events) if (e.type === 'transportChanged') phase = e.state;
    });
    try {
      await client.execute({ type: 'newProject' });
      const doc = unwrap(await client.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false }));
      const comp = doc.comps[0]!.id;
      await client.execute({
        type: 'setCompositionSettings',
        comp,
        patch: { frameRate: { num: 30, den: 1 }, duration: secondsToFlicks(SECONDS + 1), width: 1920, height: 1080 },
      });
      await client.execute({ type: 'setActiveComposition', comp });
      // One batch of layers, one command of keys: the document in seconds, not minutes.
      const creates: Command[] = [];
      for (let i = 0; i < LAYERS; i++) {
        creates.push({
          type: 'createLayer', comp, kind: 'rectangle', name: `R${i}`,
          init: [{ path: 'transform/position', value: { kind: 'vec2', value: { x: 40 + (i % 46) * 40, y: 30 + (Math.floor(i / 46) % 34) * 30 } } }],
        });
      }
      const created = unwrap(await client.batch('layers', creates));
      const layers = created.map((r) => (r as { layer: string }).layer);
      const keys: KeyframeInsert[] = [];
      for (const layer of layers) {
        for (const [time, deg] of [[0, 0], [secondsToFlicks(SECONDS), 360]] as const) {
          keys.push({ prop: { layer, path: 'transform/rotation' }, time, value: { kind: 'scalar', value: deg }, spatialIn: [], spatialOut: [], easing: 'linear' });
        }
      }
      await client.execute({ type: 'addKeyframes', keys });
      await client.execute({
        type: 'setViewport',
        viewport: 1, width: 1920, height: 1080, devicePixelRatio: 1, zoom: 1,
        pan: { x: 0, y: 0 }, channel: 'rgb', exposure: 0, transparencyGrid: false,
        displayTransform: '', layerRenderEffects: true,
      });
      await client.execute({ type: 'setLoop', mode: 'once' });
      await sleep(500);
      phase = 'starting';
      const t0 = performance.now();
      await client.execute({
        type: 'play', rate: 1, range: 'custom', custom: { start: 0, duration: secondsToFlicks(SECONDS) },
        audio: false, cacheFirst: false, cacheOnly: false,
      });
      const until = Date.now() + 120_000;
      while (phase !== 'stopped' && Date.now() < until) await sleep(20);
      const wallS = (performance.now() - t0) / 1000;
      await sleep(300);
      const stats = unwrap(await client.query({ type: 'getRenderStats' }));
      const summary = summaries[summaries.length - 1];
      const line = {
        layers: LAYERS,
        shown,
        backwards,
        wallS: Number(wallS.toFixed(2)),
        fps: Number((shown / Math.max(0.001, wallS)).toFixed(1)),
        cpuFrameMs: Number(stats.cpuFrameMs.toFixed(1)),
        gpuFrameMs: Number(stats.gpuFrameMs.toFixed(1)),
        builtAhead: summary?.builtAhead ?? null,
        workers: process.env.PREMATION_PREFETCH_WORKERS ?? 'default',
      };
      console.log('[ahead] ' + JSON.stringify(line));
      expect(phase).toBe('stopped');
      expect(backwards).toBe(0);
      recordBench([
        { name: SCENARIO, metric: 'play.fps', unit: 'fps', value: line.fps, samples: shown },
        { name: SCENARIO, metric: 'play.shown', unit: 'count', value: shown, samples: 0 },
      ]);
    } finally {
      await native.stop();
    }
  }, 300_000);
});
