/**
 * The raw pipe and the staged path hand ffmpeg the SAME pixels.
 *
 * Staged: `CanvasPool.snapshot(frame)` → `canvas.toBlob('image/png')` → a
 * file → ffmpeg's PNG decoder. Raw: `readCanvasPixels(frame)` → chunks over
 * IPC → ffmpeg's rawvideo demuxer as `rgba`. Both start from a 2D `drawImage`
 * of the frame canvas and a `getImageData` on the result, so the bytes the
 * PNG encoder is given and the bytes the pipe sends are one and the same
 * readback — and PNG is lossless, so what ffmpeg decodes from the staged
 * file is that readback too. This test holds the three side by side on a
 * fixture with straight-alpha, semi-transparent and saturated pixels.
 *
 * `toBlob` does not exist under jsdom, so the PNG leg runs on the Skia canvas
 * jest.setup.ts backs every <canvas> with (@napi-rs/canvas): the same encoder
 * family Chromium uses, and the lossless property is the codec's, not the
 * vendor's. The JPEG leg at the staged path's quality is included to show
 * what the raw pipe removes — it is the one that DOES differ.
 *
 * This is the testable half of T2's "bit-identical at the same CRF" exit:
 * identical encoder input plus the identical command line
 * (`ffmpegEncodeArgs.test.ts`) is what makes identical output follow.
 */

import { createCanvas, loadImage, ImageData as SkiaImageData } from '@napi-rs/canvas';
import { CanvasPool } from './framePipeline';
import { FfmpegStreamSink, readCanvasPixels } from './videoSink';

const W = 96;
const H = 64;

/** The fixture: gradient, translucent overlaps, a hard edge, a fully clear region. */
function paint(ctx: CanvasRenderingContext2D): void {
  ctx.clearRect(0, 0, W, H);
  const g = ctx.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, '#ff2a00');
  g.addColorStop(1, '#0044ff');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H / 2);
  ctx.fillStyle = 'rgba(0, 255, 0, 0.5)';
  ctx.fillRect(20, 10, 40, 40);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
  ctx.beginPath();
  ctx.arc(70, 40, 18, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#000';
  ctx.fillRect(4, 50, 30, 10);
}

function fixture(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  paint(c.getContext('2d')!);
  return c;
}

/** What the raw pipe sends for `frame`: every chunk main receives, reassembled. */
async function rawPipeBytes(frame: HTMLCanvasElement): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  (window as unknown as { motionEditor: unknown }).motionEditor = {
    render: {
      beginJob: async () => 'job',
      streamPreference: async () => 'stream',
      openStream: async () => ({ videoEncoder: 'libx264' }),
      streamChunk: async (_j: string, _i: number, _o: number, bytes: Uint8Array) => { parts.push(bytes.slice()); },
      finishStream: async () => ({ path: '/job/out.mp4', frames: 1 }),
      cancel: async () => undefined,
      cleanJob: async () => undefined,
    },
  };
  const sink = new FfmpegStreamSink({ format: 'mp4', width: W, height: H, fps: 30 });
  await sink.addFrame(frame, 0);
  await sink.dispose();
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
}

/** What the staged path hands its PNG encoder: the pooled snapshot's pixels. */
function stagedInputBytes(frame: HTMLCanvasElement): Uint8Array {
  const snap = new CanvasPool(W, H, 1).snapshot(frame);
  return new Uint8Array(snap.getContext('2d')!.getImageData(0, 0, W, H).data);
}

/** Those pixels through a PNG encode and decode — what ffmpeg reads off disk. */
async function throughPng(rgba: Uint8Array): Promise<Uint8Array> {
  const c = createCanvas(W, H);
  c.getContext('2d').putImageData(new SkiaImageData(new Uint8ClampedArray(rgba), W, H), 0, 0);
  const img = await loadImage(c.toBuffer('image/png'));
  const d = createCanvas(W, H);
  const ctx = d.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return new Uint8Array(ctx.getImageData(0, 0, W, H).data);
}

async function throughJpeg(rgba: Uint8Array): Promise<Uint8Array> {
  const c = createCanvas(W, H);
  c.getContext('2d').putImageData(new SkiaImageData(new Uint8ClampedArray(rgba), W, H), 0, 0);
  const img = await loadImage(c.toBuffer('image/jpeg', 95));
  const d = createCanvas(W, H);
  const ctx = d.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return new Uint8Array(ctx.getImageData(0, 0, W, H).data);
}

afterEach(() => {
  delete (window as unknown as { motionEditor?: unknown }).motionEditor;
});

describe('raw pipe ≡ staged path, pixel for pixel', () => {
  it('the fixture exercises straight alpha, not just opaque pixels', () => {
    const px = readCanvasPixels(fixture())!.data;
    const alphas = new Set<number>();
    for (let i = 3; i < px.length; i += 4) alphas.add(px[i]!);
    expect(alphas.has(0)).toBe(true);
    expect(alphas.has(255)).toBe(true);
    expect([...alphas].some((a) => a > 0 && a < 255)).toBe(true);
  });

  it('sends exactly the bytes the staged path gives its PNG encoder', async () => {
    const frame = fixture();
    const raw = await rawPipeBytes(frame);
    const staged = stagedInputBytes(frame);
    expect(raw.byteLength).toBe(W * H * 4);
    expect(Buffer.compare(Buffer.from(raw), Buffer.from(staged))).toBe(0);
  });

  it('and PNG staging is lossless, so ffmpeg decodes those same bytes from disk', async () => {
    const frame = fixture();
    const raw = await rawPipeBytes(frame);
    const decoded = await throughPng(stagedInputBytes(frame));
    expect(Buffer.compare(Buffer.from(raw), Buffer.from(decoded))).toBe(0);
  });

  it('whereas the JPEG stage the opaque formats used to go through is not', async () => {
    const frame = fixture();
    const staged = stagedInputBytes(frame);
    const decoded = await throughJpeg(staged);
    let differing = 0;
    for (let i = 0; i < staged.length; i += 4) {
      if (staged[i] !== decoded[i] || staged[i + 1] !== decoded[i + 1] || staged[i + 2] !== decoded[i + 2]) differing += 1;
    }
    expect(differing).toBeGreaterThan(0);
  });

  it('is deterministic frame to frame — the same canvas reads back the same bytes', async () => {
    const frame = fixture();
    const a = await rawPipeBytes(frame);
    const b = await rawPipeBytes(frame);
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0);
  });
});
