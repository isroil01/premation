/**
 * A saved project's frames as the viewport draws them, for looking at a
 * user's render problem on the GPU engine without touching the running app.
 *
 *   PROJECT_DOC=<project document .json> PROJECT_OUT=<folder>
 *   [PROJECT_TIMES=0,1.5,6] [PROJECT_SCALE=1]
 *
 * Restores the document, sizes the viewport to the composition × scale (1 =
 * every comp pixel drawn once), seeks each time paused and writes the settled
 * frame as <folder>/t<seconds>.ppm. Run with the bench jest config.
 */
import fs from 'node:fs';
import type { Command } from '@motion/engine-api';
import { activeCompRootId } from '@core/scene/activeComp';
import { onSharedEnginePixels, sec, settleEdits, setupAppEngine, type Harness } from '../__testHelpers__/appEngine';
import { nativeEngineIsHeadless } from '../__testHelpers__/nativeEngine';
import { MAIN_VIEWPORT } from '@stores/overlayGeometry';

jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick', 'setImmediate', 'hrtime', 'performance', 'Date'] });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type Px = { data: Uint8Array; width: number; height: number; bytesPerRow: number };

function writePpm(file: string, px: Px): void {
  const head = Buffer.from(`P6\n${px.width} ${px.height}\n255\n`);
  const body = Buffer.alloc(px.width * px.height * 3);
  for (let y = 0; y < px.height; y++) {
    for (let x = 0; x < px.width; x++) {
      const i = y * px.bytesPerRow + x * 4;
      const o = (y * px.width + x) * 3;
      body[o] = px.data[i]!;
      body[o + 1] = px.data[i + 1]!;
      body[o + 2] = px.data[i + 2]!;
    }
  }
  fs.writeFileSync(file, Buffer.concat([head, body]));
}

const doc = process.env.PROJECT_DOC;
const run = doc ? describe : describe.skip;

run('project frames', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setupAppEngine({ gpu: true, copyFrames: true });
  }, 60_000);
  afterAll(async () => { await h.dispose(); });

  it('writes the settled frame at each time', async () => {
    if (nativeEngineIsHeadless()) return;
    const out = process.env.PROJECT_OUT ?? '.';
    const times = (process.env.PROJECT_TIMES ?? '0').split(',').map(Number);
    const scale = Number(process.env.PROJECT_SCALE ?? 1);
    const text = fs.readFileSync(doc!, 'utf8');
    const comp = (JSON.parse(text) as { comps: Record<string, { width: number; height: number; fps: number }> }).comps;
    const first = Object.values(comp)[0]!;
    await h.run({ type: 'restoreDocument', document: new TextEncoder().encode(text) } as Command);
    await settleEdits();
    await h.run({ type: 'setActiveComposition', comp: activeCompRootId() as string } as Command);
    const W = Math.round(first.width * scale);
    const H = Math.round(first.height * scale);
    await h.run({
      type: 'setViewport', viewport: MAIN_VIEWPORT, width: W, height: H, devicePixelRatio: 1, zoom: 0, pan: { x: 0, y: 0 },
      channel: 'rgb', exposure: 0, transparencyGrid: false, displayTransform: '', layerRenderEffects: true, view: 'active',
    } as Command);
    await h.run({ type: 'setPreviewQuality', resolution: 'full', fastPreview: 'off', draft3d: false, motionBlur: true, adaptiveFloor: 'full' } as Command);
    let latest: { frame: number; px: Px } | null = null;
    const off = onSharedEnginePixels((ready, px) => {
      if (px.width !== W || px.height !== H) return;
      latest = { frame: ready.frame, px: { ...px, data: new Uint8Array(px.data) } };
    });
    for (const t of times) {
      latest = null;
      await h.run({ type: 'seek', time: sec(t), mode: 'exact' } as Command);
      const want = Math.round(t * first.fps);
      const until = Date.now() + 15_000;
      while (Date.now() < until && (latest as { frame: number } | null)?.frame !== want) await sleep(10);
      await sleep(400);  // the settled draw after any stand-in
      const got = latest as { frame: number; px: Px } | null;
      if (got) writePpm(`${out}/t${t}.ppm`, got.px);
      console.log(`[project] t=${t} frame=${got?.frame ?? 'none'} ${W}x${H}`);
    }
    off();
  }, 600_000);
});
