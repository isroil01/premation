/**
 * Offline export throughput — `npm run bench`, not the default `jest` run.
 *
 * Renders the export benchmark's comp (the "solid + text + shapes" case of
 * `exportBenchFixture.test.ts` / `scripts/bench-export-pipeline.cjs`, rebuilt
 * here in memory) through the REAL export loop — `renderOffline`, the same
 * `buildSnapshot` → `renderFrame` → sink sequence a delivered MP4 goes
 * through — and reports frames per second.
 *
 * ## What is and is not in the number
 *
 * IN: the per-frame scene walk, the raster feed (text and shape layers are
 * rasterised through the Skia canvas jest.setup.ts installs), the renderer's
 * frame assembly, the exactness gates, and the loop's own yields.
 *
 * OUT, deliberately: the GPU (there is none under jsdom — the factory resolves
 * to the Null tier, which accepts every draw and paints nothing), the pixel
 * readback, and the encode. The sink is a no-op, standing in for the ffmpeg
 * pipe. So this is the CPU-side ceiling on export fps for this fixture, which
 * is the number the NATIVE_CORE_PLAN T2/T3 phases move; the end-to-end figure
 * with ffmpeg comes from `scripts/bench-export-pipeline.cjs` on a GPU machine.
 *
 * jsdom + ts-jest inflate tight loops (repo conventions), so compare A/B on
 * one machine or through `npm run bench:check`, never as production fps.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { node } from '../../../../packages/render-tests/harness/sceneKit';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { renderOffline } from '@core/export/offlineRenderer';
import { recordBench } from './benchRecord';

const W = 1920;
const H = 1080;
const FPS = 30;
const WARMUP_FRAMES = 5;
const FRAMES = 60;

/** The export benchmark's comp, in memory (mirrors exportBenchFixture.test.ts). */
function buildFixture(): void {
  defaultSceneGraph.clear();
  defaultAnimation.clear();
  const colours = ['#ffca3a', '#ff595e', '#8ac926', '#1982c4', '#6a4c93', '#f4f4f8'];
  for (let i = 0; i < 6; i++) {
    const id = `shape_${i}`;
    defaultSceneGraph.addNode(node(id, {
      kind: 'shape',
      position: { x: 160, y: 140 + i * 150 },
      transform: { width: 220, height: 120, shapeType: i % 2 ? 'ellipse' : 'rectangle' },
      style: { fill: colours[i] },
    }));
    defaultAnimation.setKeyframe(id, 'x', 0, 160 + i * 40);
    defaultAnimation.setKeyframe(id, 'x', 4, 1760 - i * 40);
    defaultAnimation.setKeyframe(id, 'rotation', 0, 0);
    defaultAnimation.setKeyframe(id, 'rotation', 4, 180 + i * 30);
  }
  const texts = ['Export benchmark', 'Streaming raw RGBA into ffmpeg', '1920 x 1080 / 30 fps'];
  texts.forEach((content, i) => {
    const id = `text_${i}`;
    defaultSceneGraph.addNode(node(id, {
      kind: 'text',
      position: { x: 960, y: 220 + i * 320 },
      components: [{
        id: `${id}_c`,
        type: 'Text',
        props: { content, fontSize: 96 - i * 16, opacity: 100, fontFamily: 'Arial', align: 'center', fill: '#f4f4f8' },
      }],
    }));
  });
  defaultAnimation.setKeyframe('text_1', 'x', 0, 700);
  defaultAnimation.setKeyframe('text_1', 'x', 4, 1220);
}

/** Frames in the best consecutive window the ratchet gates on. */
const WINDOW = 10;
/** Full renders of `FRAMES`; the window is the best across all of them. */
const PASSES = 3;

/**
 * Wall-clock over the whole run, plus the fastest `WINDOW`-frame stretch: the
 * gated fps is that window's, for the reason `Stat.min` gives in
 * benchScenes.ts — on a shared machine the run average moved 149 → 84 fps
 * between two runs of unchanged code (2026-09-22), the best window far less.
 */
async function renderFrames(start: number, count: number): Promise<{ ms: number; frames: number; bestWindowMs: number }> {
  let frames = 0;
  const t0 = performance.now();
  const stamps: number[] = [t0];
  await renderOffline(
    {
      width: W,
      height: H,
      fps: FPS,
      durationSec: 4,
      startFrame: start,
      endFrame: start + count - 1,
      comp: { width: W, height: H, background: '#10131c' },
      // What a delivered export sets (see offlineRenderer): yield on a budget,
      // not every frame, so the timer clamp is not the thing being measured.
      yieldBudgetMs: 48,
    },
    // The sink stands in for the encode: nothing but a timestamp, so the
    // render loop is the whole cost.
    () => { frames += 1; stamps.push(performance.now()); },
  );
  let bestWindowMs = Infinity;
  for (let i = WINDOW; i < stamps.length; i++) bestWindowMs = Math.min(bestWindowMs, stamps[i]! - stamps[i - WINDOW]!);
  return { ms: performance.now() - t0, frames, bestWindowMs: Number.isFinite(bestWindowMs) ? bestWindowMs : performance.now() - t0 };
}

describe('offline export fps @1920×1080 (Null GPU tier, encode stubbed)', () => {
  afterAll(() => {
    defaultSceneGraph.clear();
    defaultAnimation.clear();
  });

  it('renders the export bench fixture through renderOffline', async () => {
    buildFixture();
    // Warm-up: font load, first raster, JIT.
    await renderFrames(0, WARMUP_FRAMES);
    // Three passes; the gated window is the best across all of them. One pass
    // of 60 frames left the best window ±13 % between runs of unchanged code.
    let ms = 0;
    let frames = 0;
    let bestWindowMs = Infinity;
    for (let pass = 0; pass < PASSES; pass++) {
      const r = await renderFrames(WARMUP_FRAMES, FRAMES);
      expect(r.frames).toBe(FRAMES);
      ms += r.ms;
      frames += r.frames;
      bestWindowMs = Math.min(bestWindowMs, r.bestWindowMs);
    }
    const fps = frames / (ms / 1000);
    const msPerFrame = ms / frames;
    const bestFps = WINDOW / (bestWindowMs / 1000);
    const bestMsPerFrame = bestWindowMs / WINDOW;
    console.log(
      `export fps: ${fps.toFixed(2)} fps over ${frames} frames (${msPerFrame.toFixed(2)} ms/frame); `
      + `best ${WINDOW}-frame window ${bestFps.toFixed(2)} fps (${bestMsPerFrame.toFixed(2)} ms/frame) — Null tier, no encode`,
    );

    const dir = join(process.cwd(), '.artifacts', 'bench');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'exportFps.latest.json'),
      JSON.stringify({ at: new Date().toISOString(), w: W, h: H, frames, warmup: WARMUP_FRAMES, ms, fps, msPerFrame, window: WINDOW, bestFps, bestMsPerFrame }, null, 2),
    );
    recordBench([
      { name: 'export/solid-text-shapes-1080p', metric: 'fps.best10', unit: 'fps', value: bestFps, samples: frames },
      { name: 'export/solid-text-shapes-1080p', metric: 'frame.best10', unit: 'ms', value: bestMsPerFrame, samples: frames },
    ]);
  });
});
