/**
 * D4: cache-first playback of a heavy 1080p comp on the GPU engine.
 *
 * Fills every frame of a one-second range (the clock must not skip), then
 * plays that range. The fill pays for the draw; the play should be copies
 * out of the frame cache. Run with the bench jest config — the default
 * suite ignores `*.bench.test.ts`. Not a default-on flag.
 */

import { ProcessEngineClient, secondsToFlicks, unwrap } from '@motion/engine-api';
import type { EngineFrameMessage } from '../../../../electron/engineFraming';
import { nativeEngineExe, startNativeEngine } from '../__testHelpers__/nativeEngine';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function p50(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

describe('D4 cached playback', () => {
  it('stores a 1080p second, then plays it at full rate', async () => {
    if (!nativeEngineExe()) {
      console.log('[d4] premation-engine is not built');
      return;
    }
    const native = await startNativeEngine({
      extraArgs: ['--frame-cache-mb', '2048', '--log-level', 'warn'],
    });
    const client = new ProcessEngineClient(native.bridge);
    let phase = 'idle';
    const samples: { frame: number; ms: number; dropped: number; phase: string }[] = [];
    native.supervisor.on('frame', (m: EngineFrameMessage) => {
      if (m.type !== 'frameReady') return;
      native.supervisor.releaseSlot(m.generation, m.slot);
      samples.push({
        frame: m.frame,
        ms: (m.renderDoneUs - m.renderStartUs) / 1000,
        dropped: m.dropped,
        phase,
      });
    });
    client.subscribe((batch) => {
      for (const e of batch.events) {
        if (e.type === 'transportChanged') phase = e.state;
      }
    });
    try {
      await client.execute({ type: 'newProject' });
      const doc = unwrap(await client.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false }));
      const comp = doc.comps[0]!.id;
      await client.execute({
        type: 'setCompositionSettings',
        comp,
        patch: { frameRate: { num: 30, den: 1 }, duration: secondsToFlicks(2), width: 1920, height: 1080 },
      });
      await client.execute({ type: 'setActiveComposition', comp });
      const layer = unwrap(await client.execute({
        type: 'createLayer', comp, kind: 'solid', name: 'Heavy', init: [],
      })).layer;
      await client.execute({ type: 'addEffect', layers: [layer], effect: 'path-stroke', params: [] });
      await client.execute({
        type: 'addKeyframes',
        keys: [
          { prop: { layer, path: 'transform/position' }, time: 0, value: { kind: 'vec2', value: { x: -200, y: 0 } }, spatialIn: [], spatialOut: [], easing: 'linear' },
          { prop: { layer, path: 'transform/position' }, time: secondsToFlicks(1), value: { kind: 'vec2', value: { x: 200, y: 80 } }, spatialIn: [], spatialOut: [], easing: 'linear' },
        ],
      });
      await client.execute({
        type: 'setViewport',
        viewport: 1, width: 1920, height: 1080, devicePixelRatio: 1, zoom: 1,
        pan: { x: 0, y: 0 }, channel: 'rgb', exposure: 0, transparencyGrid: false,
        displayTransform: '', layerRenderEffects: true,
      });
      await client.execute({ type: 'setLoop', mode: 'once' });
      samples.length = 0;
      await client.execute({
        type: 'play', rate: 1, range: 'custom', custom: { start: 0, duration: secondsToFlicks(1) },
        audio: false, cacheFirst: true,
      });
      const until = Date.now() + 90_000;
      while (phase !== 'stopped' && Date.now() < until) await sleep(50);
      const fill = samples.filter((s) => s.phase === 'caching');
      const play = samples.filter((s) => s.phase === 'playing');
      const fillFrames = fill.map((s) => s.frame);
      const uniqueFill = new Set(fillFrames);
      const playDropped = play.reduce((n, s) => n + s.dropped, 0);
      const playSpan = play.length > 1 ? (play[play.length - 1]!.frame - play[0]!.frame) : 0;
      const line = {
        phaseEnd: phase,
        fillFrames: fill.length,
        fillUnique: uniqueFill.size,
        fillP50Ms: Number(p50(fill.map((s) => s.ms)).toFixed(2)),
        playFrames: play.length,
        playDropped,
        playP50Ms: Number(p50(play.map((s) => s.ms)).toFixed(2)),
        playSpan,
      };
      console.log('[d4] ' + JSON.stringify(line));
      expect(phase).toBe('stopped');
      expect(uniqueFill.size).toBeGreaterThanOrEqual(30);
      expect(playDropped).toBe(0);
      expect(play.length).toBeGreaterThanOrEqual(24);
      expect(line.playP50Ms).toBeLessThanOrEqual(1000 / 24);
    } finally {
      await native.stop();
    }
  }, 120_000);
});
