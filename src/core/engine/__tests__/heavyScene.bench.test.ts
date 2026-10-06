/**
 * Uncached playback of a "real" busy comp on the GPU engine: a footage layer
 * filling a 1080p frame and 40 animated rectangles with effects (Drop Shadow +
 * Gaussian Blur on half, Glow on the rest) — what an editor feels when there
 * is "video and a lot of objects with effects". Every frame is drawn (no frame
 * cache), so each line printed (one per preview resolution) is the engine's
 * own cost per frame: the CPU build (document → frame scene, textures), the
 * GPU render and the decode.
 *
 * PREMATION_BENCH_VIDEO=<file> plays that footage; without it, the repo's
 * 640×360 render-test clip, scaled to fill. Run with the bench jest config —
 * the default suite ignores `*.bench.test.ts`.
 */
import path from 'node:path';
import { ProcessEngineClient, secondsToFlicks, unwrap } from '@motion/engine-api';
import type { EngineFrameMessage } from '../../../../electron/engineFraming';
import { nativeEngineExe, startNativeEngine } from '../__testHelpers__/nativeEngine';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function pct(xs: number[], q: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))]!;
}

const LAYERS = 40;

describe('heavy comp: video + 40 animated layers with effects', () => {
  it('plays two seconds uncached and reports the engine cost per frame', async () => {
    if (!nativeEngineExe()) {
      console.log('[heavy] premation-engine is not built');
      return;
    }
    const native = await startNativeEngine({ extraArgs: ['--frame-cache-mb', '0', '--log-level', 'warn'] });
    const client = new ProcessEngineClient(native.bridge);
    let phase = 'idle';
    const frames: { frame: number; ms: number; dropped: number; at: number }[] = [];
    native.supervisor.on('frame', (m: EngineFrameMessage) => {
      if (m.type !== 'frameReady') return;
      native.supervisor.releaseSlot(m.generation, m.slot);
      if (phase === 'playing') frames.push({ frame: m.frame, ms: (m.renderDoneUs - m.renderStartUs) / 1000, dropped: m.dropped, at: performance.now() });
    });
    client.subscribe((batch) => {
      for (const e of batch.events) if (e.type === 'transportChanged') phase = e.state;
    });
    try {
      await client.execute({ type: 'newProject' });
      const doc = unwrap(await client.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false }));
      const comp = doc.comps[0]!.id;
      await client.execute({ type: 'setCompositionSettings', comp, patch: { frameRate: { num: 30, den: 1 }, duration: secondsToFlicks(3), width: 1920, height: 1080 } });
      await client.execute({ type: 'setActiveComposition', comp });

      const video = process.env.PREMATION_BENCH_VIDEO ?? path.resolve(__dirname, '../../../../packages/render-tests/scenes/video-decoded-frame.media/media-0.mp4');
      const item = unwrap(await client.execute({ type: 'importFiles', files: [{ path: video, asSequence: false, createComposition: false }] })).items[0]!;
      const footage = unwrap(await client.execute({ type: 'createLayer', comp, kind: 'video', source: item, init: [] })).layer;
      const info = unwrap(await client.query({ type: 'getItems', items: [item] })).items[0]!;
      const fill = Math.max(1920 / Math.max(1, info.width ?? 1920), 1080 / Math.max(1, info.height ?? 1080)) * 100;
      await client.execute({ type: 'setProperty', prop: { layer: footage, path: 'transform/scale' }, value: { kind: 'vec2', value: { x: fill, y: fill } } });

      for (let i = 0; i < LAYERS; i++) {
        const layer = unwrap(await client.execute({ type: 'createLayer', comp, kind: 'rectangle', name: `R${i}`, init: [] })).layer;
        const x = 120 + (i % 10) * 180;
        const y = 160 + Math.floor(i / 10) * 220;
        await client.execute({
          type: 'addKeyframes',
          keys: [
            { prop: { layer, path: 'transform/position' }, time: 0, value: { kind: 'vec2', value: { x, y } }, spatialIn: [], spatialOut: [], easing: 'linear' },
            { prop: { layer, path: 'transform/position' }, time: secondsToFlicks(2), value: { kind: 'vec2', value: { x: x + 90, y: y + 60 } }, spatialIn: [], spatialOut: [], easing: 'linear' },
          ],
        });
        if (i % 2 === 0) {
          await client.execute({ type: 'addEffect', layers: [layer], effect: 'drop-shadow', params: [] });
          await client.execute({ type: 'addEffect', layers: [layer], effect: 'gaussian-blur', params: [] });
        } else {
          await client.execute({ type: 'addEffect', layers: [layer], effect: 'glow', params: [] });
        }
      }
      await client.execute({
        type: 'setViewport',
        viewport: 1, width: 1920, height: 1080, devicePixelRatio: 1, zoom: 1,
        pan: { x: 0, y: 0 }, channel: 'rgb', exposure: 0, transparencyGrid: false,
        displayTransform: '', layerRenderEffects: true,
      });
      await client.execute({ type: 'setLoop', mode: 'once' });
      // The same two seconds at each preview resolution (the viewer's Resolution menu): the
      // engine renders at that fraction of the viewport, so the cost should fall with it.
      for (const resolution of ['full', 'half', 'quarter'] as const) {
        await client.execute({ type: 'setPreviewQuality', resolution, fastPreview: 'off', draft3d: false, motionBlur: true, adaptiveFloor: 'half' });
        frames.length = 0;
        phase = 'starting';
        await client.execute({
          type: 'play', rate: 1, range: 'custom', custom: { start: 0, duration: secondsToFlicks(2) },
          audio: false, cacheFirst: false, cacheOnly: false,
        });
        const until = Date.now() + 120_000;
        while (phase !== 'stopped' && Date.now() < until) await sleep(50);
        const stats = unwrap(await client.query({ type: 'getRenderStats' }));
        const gaps = frames.slice(1).map((f, i) => f.at - frames[i]!.at);
        const line = {
          resolution,
          frames: frames.length,
          dropped: frames.reduce((n, f) => n + f.dropped, 0),
          renderP50Ms: Number(pct(frames.map((f) => f.ms), 0.5).toFixed(2)),
          renderP95Ms: Number(pct(frames.map((f) => f.ms), 0.95).toFixed(2)),
          intervalP50Ms: Number(pct(gaps, 0.5).toFixed(1)),
          intervalP95Ms: Number(pct(gaps, 0.95).toFixed(1)),
          cpuFrameMs: Number(stats.cpuFrameMs.toFixed(2)),
          gpuFrameMs: Number(stats.gpuFrameMs.toFixed(2)),
          decodeMs: Number(stats.decodeMs.toFixed(2)),
          fps: Number(stats.fps.toFixed(1)),
        };
        console.log('[heavy] ' + JSON.stringify(line));
        expect(phase).toBe('stopped');
        expect(frames.length).toBeGreaterThan(0);
      }
    } finally {
      await native.stop();
    }
  }, 240_000);
});
