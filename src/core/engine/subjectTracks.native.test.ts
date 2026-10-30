/**
 * Subjects Pro round 2 on the real engine:
 *
 *   tracking lanes  setLayerMatte frames keep the tracker's confidence and the
 *                   user's fixes; getSubjectTracks answers them per subject,
 *                   in composition time, through merges and other subjects
 *   view modes      setViewport subjectView: the viewport shows the subject on
 *                   black / white / as its alpha, through the subject matte;
 *                   a bad mode is refused
 *
 * The footage is a flat orange clip; its subject is the left half (x < 160).
 * Needs ffmpeg on PATH (the clip is made once in the OS temp folder); the view
 * modes need the full engine with a GPU adapter (PREMATION_GPU_TESTS=1).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { flicksToSeconds, type Command } from '@motion/engine-api';
import { activeCompRootId } from '@core/scene/activeComp';
import { engineIdle } from '@core/engine/engineInstance';
import { styleOpacityPath, styleSpanKeys } from '@core/workspace/subjectStyleTime';
import { startContentAwareFill } from '@core/tracking/contentAwareFill';
import { sec, settleEdits, setupAppEngine, type Harness } from './__testHelpers__/appEngine';

jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick', 'setImmediate'] });

const W = 320;
const H = 180;
const DIR = path.join(os.tmpdir(), 'premation-test-clips');

function clip(): string | null {
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, 'object_matte_flat_320x180.mp4');
  if (fs.existsSync(file)) return file;
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0xd0502a:s=${W}x${H}:r=30:d=2`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '4', '-pix_fmt', 'yuv420p', file], { stdio: 'ignore', timeout: 120_000 });
    return file;
  } catch {
    return null;
  }
}

const file = clip();
const suite = file ? describe : describe.skip;
const gpuSuite = file && process.env.PREMATION_GPU_TESTS === '1' ? describe : describe.skip;

/** A cut-out frame of the orange footage, opaque where `inside(x)`. */
function matteFrame(dir: string, name: string, inside: (x: number) => boolean): string {
  const png = new PNG({ width: W, height: H });
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      png.data[i] = 208; png.data[i + 1] = 80; png.data[i + 2] = 42;
      png.data[i + 3] = inside(x) ? 255 : 0;
    }
  }
  const f = path.join(dir, name);
  fs.writeFileSync(f, PNG.sync.write(png));
  return f;
}

interface Tracks { subjects: Array<{ subject: string; frames: Array<{ time: number; confidence?: number; fix: boolean }> }> }

async function footage(h: Harness): Promise<string> {
  const comp = activeCompRootId() as string;
  await h.run({ type: 'setCompositionSettings', comp, patch: { width: W, height: H, frameRate: { num: 30, den: 1 }, duration: sec(2) } } as Command);
  const items = (await h.run({ type: 'importFiles', files: [{ path: file!, asSequence: false, createComposition: false }] } as Command)) as unknown as { items: string[] };
  const video = ((await h.run({ type: 'createLayer', comp, kind: 'video', source: items.items[0], init: [] } as Command)) as unknown as { layer: string }).layer;
  await settleEdits();
  return video;
}

suite('subject tracking lanes', () => {
  let h: Harness;
  let video = '';
  let dir = '';
  let left = '';
  beforeAll(async () => {
    h = await setupAppEngine();
    video = await footage(h);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'premation-subject-track-'));
    left = matteFrame(dir, 'left.png', (x) => x < W / 2);
  }, 180_000);
  afterAll(async () => {
    await h.dispose();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const tracks = async (): Promise<Tracks['subjects']> => {
    await engineIdle();
    const r = (await h.query({ type: 'getSubjectTracks', layer: video } as never)) as Tracks;
    return r.subjects.map((s) => ({ ...s, frames: s.frames.map((f) => ({ ...f, time: Math.round(flicksToSeconds(f.time) * 30) })) }));
  };

  it('keeps each frame\'s confidence and fix, in composition frames', async () => {
    const frames = [0, 1, 2, 3, 4].map((i) => ({
      time: sec(i / 30), src: left, ...(i === 0 ? { fix: true, confidence: 1 } : { confidence: i === 3 ? 0.2 : 0.9 }),
    }));
    await h.run({ type: 'setLayerMatte', layer: video, frames, merge: false, cut: false } as Command);
    const [s1] = await tracks();
    expect(s1!.subject).toBe('s1');
    expect(s1!.frames.map((f) => f.time)).toEqual([0, 1, 2, 3, 4]);
    expect(s1!.frames.map((f) => f.fix)).toEqual([true, false, false, false, false]);
    expect(s1!.frames[3]!.confidence).toBeCloseTo(0.2);
    expect(s1!.frames[1]!.confidence).toBeCloseTo(0.9);
  });

  it('a one-frame fix replaces that frame alone and becomes a fix', async () => {
    await h.run({ type: 'setLayerMatte', layer: video, frames: [{ time: sec(3 / 30), src: left, fix: true }], merge: true, cut: false } as Command);
    const [s1] = await tracks();
    expect(s1!.frames.map((f) => f.time)).toEqual([0, 1, 2, 3, 4]);
    expect(s1!.frames[3]).toEqual({ time: 3, fix: true });  // the edit measured nothing: no confidence
    expect(s1!.frames[4]!.confidence).toBeCloseTo(0.9);
  });

  it('another subject has its own lane; confidence outside 0–1 is clamped', async () => {
    await h.run({ type: 'setLayerMatte', layer: video, frames: [{ time: sec(1), src: left, confidence: 7 }], merge: false, cut: false, subject: 's2' } as Command);
    const all = await tracks();
    expect(all.map((s) => s.subject)).toEqual(['s1', 's2']);
    expect(all[1]!.frames).toEqual([{ time: 30, confidence: 1, fix: false }]);
    expect(all[0]!.frames).toHaveLength(5);
  });

  it('refuses a subject view with an unknown mode', async () => {
    await expect(h.run({
      type: 'setViewport', viewport: 1, width: W, height: H, devicePixelRatio: 1, zoom: 0, pan: { x: 0, y: 0 }, channel: 'rgb', exposure: 0,
      transparencyGrid: false, displayTransform: '', layerRenderEffects: true, subjectView: { layer: video, mode: 'sepia' },
    } as Command)).rejects.toThrow(/subjectView mode/);
  });
});

gpuSuite('subject view modes in the viewport', () => {
  let h: Harness;
  let video = '';
  let dir = '';
  beforeAll(async () => {
    h = await setupAppEngine({ gpu: true });
    video = await footage(h);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'premation-subject-view-'));
    await h.run({ type: 'setLayerMatte', layer: video, frames: [{ time: sec(0), src: matteFrame(dir, 'left.png', (x) => x < W / 2) }], merge: true, cut: false } as Command);
    await settleEdits();
  }, 180_000);
  afterAll(async () => {
    await h.dispose();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  type Rgb = [number, number, number];
  const encode = (v: number): number => Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055));
  async function view(mode: string | null): Promise<void> {
    await h.run({
      type: 'setViewport', viewport: 1, width: W, height: H, devicePixelRatio: 1, zoom: 0, pan: { x: 0, y: 0 }, channel: 'rgb', exposure: 0,
      transparencyGrid: false, displayTransform: '', layerRenderEffects: true, ...(mode ? { subjectView: { layer: video, mode } } : {}),
    } as Command);
  }
  /** The viewport's pixel at (x, 90) once it reads `want` (frames land a few round trips after the change). */
  async function pixelBecomes(x: number, want: (c: Rgb) => boolean): Promise<Rgb> {
    let got: Rgb = [NaN, NaN, NaN];
    for (let i = 0; i < 50; i++) {
      try {
        const p = (await h.query({ type: 'readPixels', viewport: 1, region: { x, y: 90, width: 1, height: 1 } } as never)) as { rgba: number[] };
        got = p.rgba.slice(0, 3).map(encode) as Rgb;
        if (want(got)) return got;
      } catch {
        // no frame shown yet
      }
      await new Promise((r) => { setTimeout(r, 100); });
    }
    return got;
  }
  const orange = (c: Rgb): boolean => c[0] > 170 && c[1] < 120 && c[2] < 90;
  const black = (c: Rgb): boolean => c.every((v) => v < 16);
  const white = (c: Rgb): boolean => c.every((v) => v > 239);

  it('off: the footage whole', async () => {
    await view(null);
    expect(orange(await pixelBecomes(240, orange))).toBe(true);
  });

  it('black / white: the subject over black, over white', async () => {
    await view('black');
    expect(black(await pixelBecomes(240, black))).toBe(true);
    expect(orange(await pixelBecomes(60, orange))).toBe(true);
    await view('white');
    expect(white(await pixelBecomes(240, white))).toBe(true);
    expect(orange(await pixelBecomes(60, orange))).toBe(true);
  });

  it('alpha: the matte, white on black', async () => {
    await view('alpha');
    expect(white(await pixelBecomes(60, white))).toBe(true);
    expect(black(await pixelBecomes(240, black))).toBe(true);
  });

  it('overlay: the subject tinted see-through, the rest as it is', async () => {
    await view('overlay');
    // The subject's colour mixed with the orange footage: neither the plain footage nor a flat tint.
    const tinted = (c: Rgb): boolean => !orange(c) && c[2] > 80 && c[0] > 150;
    const inside = await pixelBecomes(60, tinted);
    expect(tinted(inside)).toBe(true);
    expect(inside[2]).toBeLessThan(200);  // not the solid #ff3fd4 tint (b 212)
    expect(orange(await pixelBecomes(240, orange))).toBe(true);
    await view(null);
  });

  it('a style over part of the shot shows only inside its span (Effect Opacity keys)', async () => {
    await view(null);
    const id = 'fx_span_test';
    await h.run({ type: 'addEffect', layers: [video], effect: 'fill', id, params: [{ path: 'color', value: { kind: 'color', value: { r: 1, g: 1, b: 1, a: 1 } } }] } as Command);
    await h.run({ type: 'setProperty', prop: { layer: video, path: `effects/${id}/compositing/subject` }, value: { kind: 'string', value: 'subject' } } as Command);
    await h.run({ type: 'setKeyframes', prop: { layer: video, path: styleOpacityPath(id) }, keys: styleSpanKeys({ start: 1, end: 1.5, fade: 0 }, 30) } as Command);
    await settleEdits();
    const still = async (t: number, x: number): Promise<Rgb> => {
      await engineIdle();
      const th = (await h.query({ type: 'getThumbnail', item: activeCompRootId() as string, time: sec(t), maxSize: W } as never)) as { data: Uint8Array };
      const png = PNG.sync.read(Buffer.from(th.data));
      const i = (Math.round(90 * png.height / H) * png.width + Math.round(x * png.width / W)) * 4;
      return [png.data[i]!, png.data[i + 1]!, png.data[i + 2]!];
    };
    expect(orange(await still(0.5, 60))).toBe(true);   // before the span: no style
    expect(white(await still(1.2, 60))).toBe(true);    // inside: the subject filled
    expect(orange(await still(1.2, 240))).toBe(true);  // …the subject only
    expect(orange(await still(1.6, 60))).toBe(true);   // after it: gone again
    await h.run({ type: 'removePropertyGroups', groups: [{ layer: video, path: `effects/${id}` }] } as Command);
  });

  it('fills the gap a subject leaves: the hole is its own matte, the frames are attached', async () => {
    // The subject (left half) on frames 0–4, tracked; the fill runs over those frames.
    const left = matteFrame(dir, 'gap.png', (x) => x < W / 2);
    await h.run({ type: 'setLayerMatte', layer: video, frames: [0, 1, 2, 3, 4].map((i) => ({ time: sec(i / 30), src: left })), merge: false, cut: false, subject: 'gap' } as Command);
    await settleEdits();
    const handle = await startContentAwareFill({ layer: video, subject: 'gap', start: 0, end: 5 / 30, fps: 30, mode: 'object', lighting: 'off', expansion: 0, references: [] });
    const out = await handle.done;
    expect(out.status).toBe('done');
    expect(out.result?.frames).toBe(5);
    expect(out.result?.filledPixels).toBeGreaterThan(5 * (W / 2) * H * 0.9);  // the whole left half, every frame
    // The flat orange footage rebuilt where the subject was.
    await engineIdle();
    const th = (await h.query({ type: 'getThumbnail', item: activeCompRootId() as string, time: sec(2 / 30), maxSize: W } as never)) as { data: Uint8Array };
    const png = PNG.sync.read(Buffer.from(th.data));
    const i = (Math.round(90 * png.height / H) * png.width + Math.round(60 * png.width / W)) * 4;
    expect(orange([png.data[i]!, png.data[i + 1]!, png.data[i + 2]!])).toBe(true);
    await expect(startContentAwareFill({ layer: video, subject: 'nobody', start: 0, end: 1 / 30, fps: 30, mode: 'object', lighting: 'off', expansion: 0, references: [] })
      .then((hd) => hd.done).then((o) => { if (o.status !== 'done') throw new Error(o.error?.message ?? 'failed'); })).rejects.toThrow(/no subject/);
    await h.run({ type: 'setLayerMatte', layer: video, frames: [], merge: false, subject: 'gap' } as Command);
    await h.run({ type: 'setContentAwareFill', layer: video, frames: [] } as Command);
  }, 120_000);

  it('is a viewer aid: the comp still is untouched', async () => {
    await view('alpha');
    await engineIdle();
    const th = (await h.query({ type: 'getThumbnail', item: activeCompRootId() as string, time: sec(0.5), maxSize: W } as never)) as { data: Uint8Array };
    const png = PNG.sync.read(Buffer.from(th.data));
    const i = (Math.round(90 * png.height / H) * png.width + Math.round(240 * png.width / W)) * 4;
    expect(orange([png.data[i]!, png.data[i + 1]!, png.data[i + 2]!])).toBe(true);
    await view(null);
  });
});
