/**
 * Render artefacts a user sees as "little border strokes" and "3D parts that
 * blink in and out", measured in pixels on the GPU engine (route A frames,
 * comp drawn 1:1 in the viewport).
 *
 * - coplanar: two 3D layers on one plane (a card on a panel, AE's commonest 3D
 *   setup) turning together. AE draws the upper layer on top; a depth test
 *   that compares two independently interpolated depths shows the lower layer
 *   through the upper in noisy patches that move every frame.
 * - near: the same with the upper layer 1 px in front, the camera far away.
 * - fringe: two 3D cards cutting through each other. The anti-aliased edge of
 *   the first drawn writes depth and hides the second behind a dark outline.
 * - white: white layers (rotated, scaled, 2D and 3D) over a white solid. Any
 *   pixel that is not white is a seam or border the renderer drew.
 *
 * RENDER_ARTEFACT_DUMP=<folder> writes every captured frame as a PPM.
 * Run with the bench jest config; needs the full engine (GPU).
 */

import fs from 'node:fs';
import type { Command } from '@motion/engine-api';
import { activeCompRootId } from '@core/scene/activeComp';
import { runToolTurn } from '@core/ai/aiTurn';
import { onSharedEnginePixels, sec, settleEdits, setupAppEngine, type Harness } from '../__testHelpers__/appEngine';
import { nativeEngineIsHeadless } from '../__testHelpers__/nativeEngine';
import { MAIN_VIEWPORT } from '@stores/overlayGeometry';

jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick', 'setImmediate', 'hrtime', 'performance', 'Date'] });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const W = 960;
const H = 540;
const FPS = 30;
const SECONDS = 2;
const SAMPLES = [0, 7, 15, 22, 30, 37, 45, 52, 59];
const DUMP = process.env.RENDER_ARTEFACT_DUMP;

type Px = { data: Uint8Array; width: number; height: number; bytesPerRow: number };
type Call = { name: string; args: Record<string, unknown> };

function dumpPpm(file: string, px: Px): void {
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

const rgb = (px: Px, x: number, y: number): [number, number, number] => {
  const i = y * px.bytesPerRow + x * 4;
  return [px.data[i]!, px.data[i + 1]!, px.data[i + 2]!];
};

describe('render artefacts', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setupAppEngine({ gpu: true, copyFrames: true });
  }, 60_000);
  afterAll(async () => { await h.dispose(); });

  async function scene(calls: Call[]): Promise<void> {
    await h.run({ type: 'newProject' } as Command);
    await settleEdits();
    const comp = activeCompRootId() as string;
    await h.run({ type: 'setCompositionSettings', comp, patch: { width: W, height: H, frameRate: { num: FPS, den: 1 }, duration: sec(SECONDS) } } as Command);
    const r = await runToolTurn('render artefacts', calls);
    const failed = r.results.filter((x) => !x.ok).map((x) => x.content);
    if (failed.length) console.log(`[artefacts] tool failures ${JSON.stringify(failed.slice(0, 5))}`);
    await settleEdits();
    await h.run({
      type: 'setViewport', viewport: MAIN_VIEWPORT, width: W, height: H, devicePixelRatio: 1, zoom: 0, pan: { x: 0, y: 0 },
      channel: 'rgb', exposure: 0, transparencyGrid: false, displayTransform: '', layerRenderEffects: true, view: 'active',
    } as Command);
    await h.run({ type: 'setPreviewQuality', resolution: 'full', fastPreview: 'off', draft3d: false, motionBlur: true, adaptiveFloor: 'full' } as Command);
  }

  /** The settled paused frame at each sampled frame number. */
  async function capture(tag: string): Promise<Map<number, Px>> {
    const out = new Map<number, Px>();
    let raws: Array<{ frame: number; px: Px }> | null = null;
    const off = onSharedEnginePixels((ready, px) => {
      if (px.width !== W || px.height !== H) return;
      raws?.push({ frame: ready.frame, px: { ...px, data: new Uint8Array(px.data) } });
    });
    for (const f of SAMPLES) {
      raws = [];
      await h.run({ type: 'seek', time: sec(f / FPS), mode: 'exact' } as Command);
      const until = Date.now() + 5000;
      while (Date.now() < until && !raws.some((r) => r.frame === f)) await sleep(5);
      await sleep(60);
      const mine = raws.filter((r) => r.frame === f);
      if (mine.length) {
        out.set(f, mine[mine.length - 1]!.px);
        if (DUMP) dumpPpm(`${DUMP}/${tag}-${String(f).padStart(2, '0')}.ppm`, mine[mine.length - 1]!.px);
      }
    }
    raws = null;
    off();
    return out;
  }

  const turning = (id: string): Call => ({ name: 'set_keyframes', args: { keyframes: [
    { nodeId: id, prop: 'rotationY', t: 0, value: -55 }, { nodeId: id, prop: 'rotationY', t: SECONDS, value: 55 },
    { nodeId: id, prop: 'rotationX', t: 0, value: 25 }, { nodeId: id, prop: 'rotationX', t: SECONDS, value: -20 },
  ] } });

  it('coplanar 3D layers: the upper layer always wins', async () => {
    if (nativeEngineIsHeadless()) return;
    const coplanarTotals: number[] = [];
    for (const gap of [0, 1] as const) {
      const camZ = gap === 0 ? -1400 : -6000;
      const camera: Call[] = [
        { name: 'create_layer', args: { id: 'cam', kind: 'camera', name: 'Cam' } },
        { name: 'update_layer', args: { nodeId: 'cam', z: camZ } },
      ];
      const panel: Call[] = [
        { name: 'create_layer', args: { id: 'panel', kind: 'solid', name: 'Panel', width: gap === 0 ? 560 : 1600, height: gap === 0 ? 360 : 1000, fill: '#e01010', x: W / 2, y: H / 2 } },
        { name: 'update_layer', args: { nodeId: 'panel', threeD: true, z: 0 } },
        turning('panel'),
      ];
      const card: Call[] = [
        { name: 'create_layer', args: { id: 'card', kind: 'solid', name: 'Card', width: gap === 0 ? 300 : 900, height: gap === 0 ? 180 : 540, fill: '#ffffff', x: W / 2, y: H / 2 } },
        { name: 'update_layer', args: { nodeId: 'card', threeD: true, z: -gap } },
        turning('card'),
      ];
      await scene([...camera, ...panel, ...card]);
      const both = await capture(`coplanar${gap}-both`);
      // The reference: the card alone, same camera and transforms.
      await scene([...camera, ...card]);
      const alone = await capture(`coplanar${gap}-card`);
      // Pixels the card alone paints solid white that show red with the panel behind it.
      const lost: Record<number, number> = {};
      let total = 0;
      for (const [f, a] of alone) {
        const b = both.get(f);
        if (!b) continue;
        let n = 0;
        for (let y = 1; y < H - 1; y++) {
          for (let x = 1; x < W - 1; x++) {
            const [ar, ag, ab] = rgb(a, x, y);
            if (ar < 250 || ag < 250 || ab < 250) continue;
            // Interior only: the four neighbours white too (edges blend with the panel by design).
            const nb = [rgb(a, x - 1, y), rgb(a, x + 1, y), rgb(a, x, y - 1), rgb(a, x, y + 1)];
            if (nb.some(([r, g, bb]) => r < 250 || g < 250 || bb < 250)) continue;
            const [, bg, bb] = rgb(b, x, y);
            if (Math.min(bg, bb) < 235) n++;
          }
        }
        lost[f] = n;
        total += n;
      }
      console.log(`[artefacts] coplanar gap=${gap} camZ=${camZ} red-through-card px per frame ${JSON.stringify(lost)} total=${total}`);
      expect(alone.size).toBeGreaterThan(SAMPLES.length - 2);
      coplanarTotals.push(total);
    }
    expect(coplanarTotals).toEqual([0, 0]);
  }, 240_000);

  it('cards cutting through each other: no dark outline along the cut', async () => {
    if (nativeEngineIsHeadless()) return;
    await scene([
      { name: 'create_layer', args: { id: 'bg', kind: 'solid', name: 'BG', width: W, height: H, fill: '#ffffff', x: W / 2, y: H / 2 } },
      { name: 'create_layer', args: { id: 'cam', kind: 'camera', name: 'Cam' } },
      { name: 'update_layer', args: { nodeId: 'cam', z: -1300 } },
      { name: 'create_layer', args: { id: 'a', kind: 'solid', name: 'A', width: 420, height: 300, fill: '#ffffff', x: W / 2, y: H / 2 } },
      { name: 'update_layer', args: { nodeId: 'a', threeD: true, rotationY: 35 } },
      { name: 'create_layer', args: { id: 'b', kind: 'solid', name: 'B', width: 420, height: 300, fill: '#ffffff', x: W / 2 + 40, y: H / 2 } },
      { name: 'update_layer', args: { nodeId: 'b', threeD: true, rotationY: -35 } },
      { name: 'set_keyframes', args: { keyframes: [
        { nodeId: 'cam', prop: 'x', t: 0, value: W / 2 - 300 }, { nodeId: 'cam', prop: 'x', t: SECONDS, value: W / 2 + 300 },
      ] } },
    ]);
    const frames = await capture('cut');
    // Everything is white: any darker pixel is a line the renderer drew.
    const dark: Record<number, number> = {};
    let total = 0;
    for (const [f, px] of frames) {
      let n = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const [r, g, b] = rgb(px, x, y);
        if (Math.min(r, g, b) < 235) n++;
      }
      dark[f] = n;
      total += n;
    }
    console.log(`[artefacts] cut: non-white px per frame ${JSON.stringify(dark)} total=${total}`);

    // The same cut in colour on black: inside either card, a pixel darker than
    // both cards' colours is the background showing through an edge that
    // occluded what was drawn after it.
    await scene([
      { name: 'create_layer', args: { id: 'cam', kind: 'camera', name: 'Cam' } },
      { name: 'update_layer', args: { nodeId: 'cam', z: -1300 } },
      { name: 'create_layer', args: { id: 'a', kind: 'solid', name: 'A', width: 420, height: 300, fill: '#ff2020', x: W / 2, y: H / 2 } },
      { name: 'update_layer', args: { nodeId: 'a', threeD: true, rotationY: 35 } },
      { name: 'create_layer', args: { id: 'b', kind: 'shape', shape: 'ellipse', name: 'B', width: 380, height: 300, fill: '#2060ff', x: W / 2 + 40, y: H / 2 } },
      { name: 'update_layer', args: { nodeId: 'b', threeD: true, rotationY: -35 } },
      { name: 'set_keyframes', args: { keyframes: [
        { nodeId: 'cam', prop: 'x', t: 0, value: W / 2 - 300 }, { nodeId: 'cam', prop: 'x', t: SECONDS, value: W / 2 + 300 },
      ] } },
    ]);
    const colour = await capture('cutcolour');
    const holes: Record<number, number> = {};
    let holeTotal = 0;
    for (const [f, px] of colour) {
      let n = 0;
      for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        const lum = (c: [number, number, number]): number => c[0] + c[1] + c[2];
        const c = rgb(px, x, y);
        // Surrounded by card colour left and right (or above and below), yet much darker than both.
        const l = rgb(px, x - 1, y), r = rgb(px, x + 1, y), u = rgb(px, x, y - 1), d = rgb(px, x, y + 1);
        const lit = (p: [number, number, number]): boolean => lum(p) > 200;
        if ((lit(l) && lit(r) && lum(c) < Math.min(lum(l), lum(r)) * 0.6) || (lit(u) && lit(d) && lum(c) < Math.min(lum(u), lum(d)) * 0.6)) n++;
      }
      holes[f] = n;
      holeTotal += n;
    }
    console.log(`[artefacts] cut colour: dark seam px per frame ${JSON.stringify(holes)} total=${holeTotal}`);
    expect([total, holeTotal]).toEqual([0, 0]);
  }, 240_000);

  it('white on white: no layer draws a border', async () => {
    if (nativeEngineIsHeadless()) return;
    const totals: number[] = [];
    for (const threeD of [false, true]) {
      const calls: Call[] = [
        { name: 'create_layer', args: { id: 'bg', kind: 'solid', name: 'BG', width: W, height: H, fill: '#ffffff', x: W / 2, y: H / 2 } },
        { name: 'create_layer', args: { id: 'rect', kind: 'shape', shape: 'rect', name: 'Rect', width: 260, height: 160, fill: '#ffffff', x: 250, y: 170 } },
        { name: 'update_layer', args: { nodeId: 'rect', rotation: 17, scaleX: 0.73, scaleY: 0.73 } },
        { name: 'create_layer', args: { id: 'ell', kind: 'shape', shape: 'ellipse', name: 'Ellipse', width: 220, height: 220, fill: '#ffffff', x: 650, y: 190 } },
        { name: 'create_layer', args: { id: 'sol', kind: 'solid', name: 'Solid', width: 300, height: 120, fill: '#ffffff', x: 300, y: 400 } },
        { name: 'update_layer', args: { nodeId: 'sol', rotation: -9, scaleX: 1.37, scaleY: 1.37 } },
        { name: 'create_layer', args: { id: 'txt', kind: 'text', name: 'Text', text: 'WHITE', x: 680, y: 420, fill: '#ffffff' } },
        { name: 'update_layer', args: { nodeId: 'txt', fontSize: 90 } },
        { name: 'set_keyframes', args: { keyframes: [
          { nodeId: 'rect', prop: 'x', t: 0, value: 250 }, { nodeId: 'rect', prop: 'x', t: SECONDS, value: 333.3 },
          { nodeId: 'ell', prop: 'scaleX', t: 0, value: 0.5 }, { nodeId: 'ell', prop: 'scaleX', t: SECONDS, value: 1.21 },
          { nodeId: 'ell', prop: 'scaleY', t: 0, value: 0.5 }, { nodeId: 'ell', prop: 'scaleY', t: SECONDS, value: 1.21 },
        ] } },
      ];
      if (threeD) {
        calls.push({ name: 'create_layer', args: { id: 'cam', kind: 'camera', name: 'Cam' } });
        for (const id of ['rect', 'ell', 'sol', 'txt']) calls.push({ name: 'update_layer', args: { nodeId: id, threeD: true, rotationY: 20 } });
        calls.push({ name: 'set_keyframes', args: { keyframes: [
          { nodeId: 'cam', prop: 'z', t: 0, value: -1500 }, { nodeId: 'cam', prop: 'z', t: SECONDS, value: -1100 },
        ] } });
      }
      await scene(calls);
      const frames = await capture(threeD ? 'white3d' : 'white2d');
      const off: Record<number, number> = {};
      let total = 0;
      let worst = 255;
      for (const [f, px] of frames) {
        let n = 0;
        // The frame's outer 2 px are left out: the frame-sized background
        // solid's bottom-right corner pixels cover ~93 % (a known, steady
        // 3 px corner of the edge coverage), which is not a layer border.
        for (let y = 2; y < H - 2; y++) for (let x = 2; x < W - 2; x++) {
          const m = Math.min(...rgb(px, x, y));
          worst = Math.min(worst, m);
          if (m < 250) n++;
        }
        off[f] = n;
        total += n;
      }
      console.log(`[artefacts] white ${threeD ? '3D' : '2D'}: non-white px per frame ${JSON.stringify(off)} total=${total} darkest=${worst}`);
      expect(frames.size).toBeGreaterThan(SAMPLES.length - 2);
      totals.push(total);
    }
    expect(totals).toEqual([0, 0]);
  }, 240_000);

});
