/**
 * Export frame delivery — `npm run bench`, not the default `jest` run.
 *
 * What a rendered 1080p frame costs to HAND OVER, per frame, on the two
 * desktop paths, with the render itself and the encoder both stubbed out:
 *
 *  - raw pipe (`export/raw-pipe-1080p`): `readCanvasPixels` (the 2D readback)
 *    → `streamFrameChunked` over a fake bridge that does what Electron's IPC
 *    does to a Uint8Array — one copy — and acks each chunk on the next macro
 *    task, the way a real `invoke` resolves. The sink is a no-op.
 *  - JPEG stage (`export/jpeg-stage-1080p`): `CanvasPool.snapshot` (the
 *    drawImage copy) → JPEG at the staged path's quality 0.95 → one copy
 *    for the IPC. `canvas.toBlob` does not exist under jsdom, so the encode
 *    is the Skia canvas's async `encode('jpeg', 95)` — the same encoder
 *    family Chromium's is, run through the same thread-pool shape.
 *
 * The number is the CPU-side handover ceiling per path on this machine, the
 * quantity T2 moved. Compare A/B on one machine (jsdom + ts-jest inflate
 * everything); the end-to-end figure with a real ffmpeg is
 * `scripts/bench-export-pipeline.cjs` on a GPU machine.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createCanvas } from '@napi-rs/canvas';
import { readCanvasPixels } from '@core/export/videoSink';
import { CanvasPool } from '@core/export/framePipeline';
import { streamFrameChunked, RAW_PIPE_CHUNK_BYTES, type RawPipeBridge } from '@core/export/rawPipe';
import { recordBench } from './benchRecord';

const W = 1920;
const H = 1080;
const WARMUP = 5;
const FRAMES = 60;
const PASSES = 3;
const WINDOW = 10;

/** A busy frame: gradient, a hundred translucent shapes, a hard-edged block. */
function paint(ctx: CanvasRenderingContext2D, t: number): void {
  ctx.clearRect(0, 0, W, H);
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#10131c');
  g.addColorStop(1, '#3a2a6a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 100; i++) {
    ctx.fillStyle = `rgba(${(i * 37) % 255}, ${(i * 91) % 255}, ${(i * 53) % 255}, 0.6)`;
    ctx.beginPath();
    ctx.arc(((i * 197 + t * 13) % W), ((i * 131) % H), 40 + (i % 7) * 12, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#f4f4f8';
  ctx.fillRect(200 + t, 200, 600, 300);
}

function domFixture(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  paint(c.getContext('2d')!, 0);
  return c;
}

/**
 * The IPC stand-in: one copy per chunk, acked asynchronously. A microtask,
 * not a timer: jsdom has no setImmediate and setTimeout(0) clamps to ≥ 1 ms,
 * which would be the measurement rather than a stand-in for a ~0.2 ms
 * `invoke` round trip. The copy is the real cost being measured.
 */
function fakeBridge(): { bridge: RawPipeBridge; chunks: number; bytes: number } {
  const stats = { chunks: 0, bytes: 0 };
  const bridge: RawPipeBridge = {
    streamChunk: (_j, _i, _o, bytes) => new Promise<void>((resolve) => {
      const copy = bytes.slice(); // structured clone
      stats.chunks += 1;
      stats.bytes += copy.byteLength;
      queueMicrotask(resolve);
    }),
  };
  return { bridge, get chunks() { return stats.chunks; }, get bytes() { return stats.bytes; } };
}

interface Run { ms: number; frames: number; bestWindowMs: number }

async function timeFrames(count: number, frame: () => Promise<void>): Promise<Run> {
  const t0 = performance.now();
  const stamps: number[] = [t0];
  for (let i = 0; i < count; i++) {
    await frame();
    stamps.push(performance.now());
  }
  let bestWindowMs = Infinity;
  for (let i = WINDOW; i < stamps.length; i++) bestWindowMs = Math.min(bestWindowMs, stamps[i]! - stamps[i - WINDOW]!);
  const ms = performance.now() - t0;
  return { ms, frames: count, bestWindowMs: Number.isFinite(bestWindowMs) ? bestWindowMs : ms };
}

async function bench(label: string, frame: () => Promise<void>): Promise<{ fps: number; bestFps: number; msPerFrame: number; bestMsPerFrame: number; frames: number }> {
  await timeFrames(WARMUP, frame);
  let ms = 0;
  let frames = 0;
  let bestWindowMs = Infinity;
  for (let pass = 0; pass < PASSES; pass++) {
    const r = await timeFrames(FRAMES, frame);
    ms += r.ms;
    frames += r.frames;
    bestWindowMs = Math.min(bestWindowMs, r.bestWindowMs);
  }
  const out = { fps: frames / (ms / 1000), bestFps: WINDOW / (bestWindowMs / 1000), msPerFrame: ms / frames, bestMsPerFrame: bestWindowMs / WINDOW, frames };
  console.log(
    `${label}: ${out.fps.toFixed(2)} fps over ${frames} frames (${out.msPerFrame.toFixed(2)} ms/frame); `
    + `best ${WINDOW}-frame window ${out.bestFps.toFixed(2)} fps (${out.bestMsPerFrame.toFixed(2)} ms/frame)`,
  );
  return out;
}

describe('export frame handover @1920×1080 (render and encoder stubbed)', () => {
  it('raw pipe vs JPEG stage', async () => {
    // ── raw pipe ──────────────────────────────────────────────────────────
    const frameCanvas = domFixture();
    const ipc = fakeBridge();
    let index = 0;
    const raw = await bench('raw pipe', async () => {
      const data = readCanvasPixels(frameCanvas)!;
      const bytes = new Uint8Array(data.data.buffer, data.data.byteOffset, data.data.byteLength);
      await streamFrameChunked(ipc.bridge, 'job', index++, bytes, RAW_PIPE_CHUNK_BYTES);
    });
    const chunksPerFrame = ipc.chunks / (WARMUP + PASSES * FRAMES);
    expect(chunksPerFrame).toBe(2);
    expect(ipc.bytes / ipc.chunks).toBeLessThanOrEqual(RAW_PIPE_CHUNK_BYTES);

    // ── JPEG stage ────────────────────────────────────────────────────────
    const pool = new CanvasPool(W, H, 2);
    const skiaSnap = createCanvas(W, H);
    const skiaCtx = skiaSnap.getContext('2d');
    // The pooled snapshot (drawImage copy) is real; its Skia backing is
    // private to jest.setup, so the encode reads a Skia twin painted with
    // the same ops — the encode cost is the same either way.
    const skiaFrame = createCanvas(W, H);
    paint(skiaFrame.getContext('2d') as unknown as CanvasRenderingContext2D, 0);
    let jpegBytes = 0;
    const jpeg = await bench('JPEG stage', async () => {
      const snap = pool.snapshot(frameCanvas);
      try {
        skiaCtx.drawImage(skiaFrame, 0, 0);
        const encoded = await skiaSnap.encode('jpeg', 95);
        const copy = new Uint8Array(encoded).slice(); // the IPC copy
        jpegBytes += copy.byteLength;
        await new Promise<void>((resolve) => queueMicrotask(resolve));
      } finally {
        pool.release(snap);
      }
    });
    console.log(
      `raw pipe / JPEG stage: ${(raw.bestFps / jpeg.bestFps).toFixed(2)}× on the best window; `
      + `${chunksPerFrame} chunks of ≤ ${RAW_PIPE_CHUNK_BYTES / 1048576} MiB per frame vs ${(jpegBytes / jpeg.frames / 1024).toFixed(0)} KB of JPEG`,
    );

    const dir = join(process.cwd(), '.artifacts', 'bench');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'exportPipe.latest.json'),
      JSON.stringify({ at: new Date().toISOString(), w: W, h: H, window: WINDOW, chunkBytes: RAW_PIPE_CHUNK_BYTES, chunksPerFrame, raw, jpeg }, null, 2),
    );
    recordBench([
      { name: 'export/raw-pipe-1080p', metric: 'fps.best10', unit: 'fps', value: raw.bestFps, samples: raw.frames },
      { name: 'export/raw-pipe-1080p', metric: 'frame.best10', unit: 'ms', value: raw.bestMsPerFrame, samples: raw.frames },
      { name: 'export/jpeg-stage-1080p', metric: 'fps.best10', unit: 'fps', value: jpeg.bestFps, samples: jpeg.frames },
      { name: 'export/jpeg-stage-1080p', metric: 'frame.best10', unit: 'ms', value: jpeg.bestMsPerFrame, samples: jpeg.frames },
    ]);
  });
});
