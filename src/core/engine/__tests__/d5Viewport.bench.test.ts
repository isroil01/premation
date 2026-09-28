/**
 * D5: the engine viewport's HUD frame time (build + render to GPU completion)
 * on animated 1080p comps. Same formula EngineSurface reports. The default
 * stays off; this does not open the Electron window.
 *
 *   npx jest --config jest.bench.config.cjs src/core/engine/__tests__/d5Viewport.bench.test.ts --runInBand
 */

import { resolve } from 'node:path';
import { ProcessEngineClient, secondsToFlicks, unwrap, type EngineClient, type RenderStats } from '@motion/engine-api';
import type { EngineFrameMessage } from '../../../../electron/engineFraming';
import { nativeEngineExe, startNativeEngine, type NativeEngine } from '../__testHelpers__/nativeEngine';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function p50(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

async function playComp(native: NativeEngine, client: EngineClient, layers: number, effect: string | null): Promise<{
  layers: number;
  effect: string | null;
  frames: number;
  dropped: number;
  renderP50Ms: number;
  cpuFrameMs: number;
  gpuFrameMs: number;
  fps: number;
  hudMs: number;
}> {
  const renders: number[] = [];
  let dropped = 0;
  const onFrame = (m: EngineFrameMessage): void => {
    if (m.type !== 'frameReady') return;
    native.supervisor.releaseSlot(m.generation, m.slot);
    renders.push((m.renderDoneUs - m.renderStartUs) / 1000);
    dropped += m.dropped;
  };
  const offFrame = native.supervisor.on('frame', onFrame);
  let phase = 'idle';
  const unsub = client.subscribe((batch) => {
    for (const e of batch.events) if (e.type === 'transportChanged') phase = e.state;
  });
  try {
    await client.execute({ type: 'newProject' });
    const doc = unwrap(await client.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false }));
    const comp = doc.comps[0]!.id;
    await client.execute({
      type: 'setCompositionSettings',
      comp,
      patch: { frameRate: { num: 30, den: 1 }, duration: secondsToFlicks(3), width: 1920, height: 1080 },
    });
    await client.execute({ type: 'setActiveComposition', comp });
    for (let i = 0; i < layers; i++) {
      const layer = unwrap(await client.execute({
        type: 'createLayer', comp, kind: 'solid', name: `L${i}`, init: [],
      })).layer;
      if (effect && i === 0) await client.execute({ type: 'addEffect', layers: [layer], effect, params: [] });
      await client.execute({
        type: 'addKeyframes',
        keys: [
          { prop: { layer, path: 'transform/position' }, time: 0, value: { kind: 'vec2', value: { x: -400 + i * 8, y: 0 } }, spatialIn: [], spatialOut: [], easing: 'linear' },
          { prop: { layer, path: 'transform/position' }, time: secondsToFlicks(2), value: { kind: 'vec2', value: { x: 400, y: 40 + i } }, spatialIn: [], spatialOut: [], easing: 'linear' },
        ],
      });
    }
    await client.execute({
      type: 'setViewport',
      viewport: 1, width: 1920, height: 1080, devicePixelRatio: 1, zoom: 1,
      pan: { x: 0, y: 0 }, channel: 'rgb', exposure: 0, transparencyGrid: false,
      displayTransform: '', layerRenderEffects: true,
    });
    await client.execute({ type: 'setLoop', mode: 'once' });
    renders.length = 0;
    dropped = 0;
    await client.execute({
      type: 'play', rate: 1, range: 'custom', custom: { start: 0, duration: secondsToFlicks(2) },
      audio: false, cacheFirst: false,
    });
    const until = Date.now() + 60_000;
    while (phase !== 'stopped' && Date.now() < until) await sleep(40);
    const stats = unwrap(await client.query({ type: 'getRenderStats' })) as RenderStats;
    const renderP50Ms = p50(renders);
    return {
      layers, effect, frames: renders.length, dropped,
      renderP50Ms: Number(renderP50Ms.toFixed(2)),
      cpuFrameMs: Number(stats.cpuFrameMs.toFixed(2)),
      gpuFrameMs: Number(stats.gpuFrameMs.toFixed(2)),
      fps: Number(stats.fps.toFixed(1)),
      hudMs: Number((renderP50Ms + stats.cpuFrameMs).toFixed(2)),
    };
  } finally {
    unsub();
    offFrame();
  }
}

describe('D5 engine viewport frame time', () => {
  it('reports HUD frame time for animated 1080p comps', async () => {
    if (!nativeEngineExe()) {
      console.log('[d5] premation-engine is not built');
      return;
    }
    const native = await startNativeEngine({
      extraArgs: ['--frame-cache-mb', '2048', '--log-level', 'warn'],
    });
    const client = new ProcessEngineClient(native.bridge);
    const rows = [];
    try {
      for (const spec of [
        { layers: 8, effect: null },
        { layers: 32, effect: null },
        { layers: 8, effect: 'gaussian-blur' },
      ] as const) {
        const row = await playComp(native, client, spec.layers, spec.effect);
        rows.push(row);
        console.log('[d5] ' + JSON.stringify(row));
      }
    } finally {
      await native.stop();
    }
    for (const row of rows) {
      expect(row.frames).toBeGreaterThanOrEqual(30);
      expect(row.hudMs).toBeLessThan(1000 / 24);
    }
  }, 180_000);

  it('reports HUD frame time for the same projects the TypeScript renderer exports', async () => {
    if (!nativeEngineExe()) {
      console.log('[d5] premation-engine is not built');
      return;
    }
    const native = await startNativeEngine({
      extraArgs: ['--frame-cache-mb', '2048', '--log-level', 'warn'],
    });
    const client = new ProcessEngineClient(native.bridge);
    const files = ['bench.json', 'shapes8.json', 'shapes32.json'].map((name) =>
      resolve('native/build/cmp', name));
    try {
      for (const file of files) {
        const renders: number[] = [];
        let dropped = 0;
        let phase = 'idle';
        const offFrame = native.supervisor.on('frame', (m: EngineFrameMessage) => {
          if (m.type !== 'frameReady') return;
          native.supervisor.releaseSlot(m.generation, m.slot);
          renders.push((m.renderDoneUs - m.renderStartUs) / 1000);
          dropped += m.dropped;
        });
        const unsub = client.subscribe((batch) => {
          for (const e of batch.events) if (e.type === 'transportChanged') phase = e.state;
        });
        try {
          await client.execute({ type: 'openProject', path: file });
          const doc = unwrap(await client.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false }));
          const comp = doc.comps[0]!.id;
          await client.execute({ type: 'setActiveComposition', comp });
          await client.execute({
            type: 'setViewport',
            viewport: 1, width: 1920, height: 1080, devicePixelRatio: 1, zoom: 1,
            pan: { x: 0, y: 0 }, channel: 'rgb', exposure: 0, transparencyGrid: false,
            displayTransform: '', layerRenderEffects: true,
          });
          await client.execute({ type: 'setLoop', mode: 'once' });
          renders.length = 0;
          dropped = 0;
          await client.execute({
            type: 'play', rate: 1, range: 'custom', custom: { start: 0, duration: secondsToFlicks(2) },
            audio: false, cacheFirst: false,
          });
          const until = Date.now() + 60_000;
          while (phase !== 'stopped' && Date.now() < until) await sleep(40);
          const stats = unwrap(await client.query({ type: 'getRenderStats' })) as RenderStats;
          const renderP50Ms = p50(renders);
          console.log('[d5-file] ' + JSON.stringify({
            file, frames: renders.length, dropped,
            renderP50Ms: Number(renderP50Ms.toFixed(2)),
            cpuFrameMs: Number(stats.cpuFrameMs.toFixed(2)),
            gpuFrameMs: Number(stats.gpuFrameMs.toFixed(2)),
            fps: Number(stats.fps.toFixed(1)),
            hudMs: Number((renderP50Ms + stats.cpuFrameMs).toFixed(2)),
          }));
          expect(renders.length).toBeGreaterThanOrEqual(30);
        } finally {
          unsub();
          offFrame();
        }
      }
    } finally {
      await native.stop();
    }
  }, 180_000);
});
