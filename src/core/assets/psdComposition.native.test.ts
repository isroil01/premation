/**
 * AE's Photoshop import on the C++ engine: Footage (the merged image) and
 * Import As: Composition – Retain Layer Sizes — one layer per Photoshop layer
 * where it sat, opacity, blend mode and visibility kept, groups and clipping
 * groups as nested compositions, the layer images in a "<file> Layers" folder,
 * all in one undo entry.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { setupAppEngine, type Harness } from '@core/engine/__testHelpers__/appEngine';

let h: Harness;
let dir = '';

beforeEach(async () => {
  h = await setupAppEngine();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'premation-psd-'));
});
afterEach(async () => {
  await h.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

interface L {
  name: string;
  left?: number; top?: number; w?: number; h?: number;
  rgba?: [number, number, number, number];
  opacity?: number; blend?: string; hidden?: boolean; clipped?: boolean;
  /** 1 a folder record (closes a group), 3 the group's divider (opens it). */
  section?: number;
}

/** A minimal 8-bit RGB PSD (raw channels), layers bottom to top as Photoshop stores them. */
function psd(width: number, height: number, layers: L[]): Buffer {
  const parts: number[] = [];
  const u8 = (v: number): void => { parts.push(v & 0xff); };
  const u16 = (v: number): void => { u8(v >> 8); u8(v); };
  const u32 = (v: number): void => { u16(v >>> 16); u16(v & 0xffff); };
  const str = (s: string): void => { for (const c of s) u8(c.charCodeAt(0)); };
  const block = (fill: () => void): number[] => {
    const save = parts.splice(0);
    fill();
    const out = parts.splice(0);
    parts.push(...save);
    return out;
  };
  str('8BPS'); u16(1); for (let i = 0; i < 6; i++) u8(0); u16(4); u32(height); u32(width); u16(8); u16(3);
  u32(0); u32(0);
  const li = block(() => {
    u16(layers.length);
    const data: number[][] = [];
    for (const l of layers) {
      const w = l.section ? 0 : l.w ?? 0;
      const hh = l.section ? 0 : l.h ?? 0;
      const n = w * hh;
      const chans = [-1, 0, 1, 2].map((id) => {
        const comp = id === -1 ? 3 : id;
        return [0, 0, ...Array.from({ length: n }, () => l.rgba?.[comp] ?? 0)];
      });
      u32(l.top ?? 0); u32(l.left ?? 0); u32((l.top ?? 0) + hh); u32((l.left ?? 0) + w);
      u16(4);
      [-1, 0, 1, 2].forEach((id, i) => { u16(id & 0xffff); u32(chans[i]!.length); });
      data.push(...chans);
      str('8BIM'); str(l.blend ?? 'norm'); u8(l.opacity ?? 255); u8(l.clipped ? 1 : 0); u8(l.hidden ? 2 : 0); u8(0);
      const extra = block(() => {
        u32(0); u32(0);
        const name = l.name.slice(0, 31);
        u8(name.length); str(name);
        for (let k = name.length + 1; k % 4 !== 0; k++) u8(0);
        if (l.section) { str('8BIM'); str('lsct'); u32(12); u32(l.section); str('8BIM'); str(l.blend ?? 'norm'); }
      });
      u32(extra.length); parts.push(...extra);
    }
    for (const d of data) parts.push(...d);
    if (parts.length % 2) u8(0);
  });
  u32(li.length + 8); u32(li.length); parts.push(...li); u32(0);
  u16(0);
  for (let c = 0; c < 4; c++) for (let i = 0; i < width * height; i++) u8(c === 3 ? 255 : 90);
  return Buffer.from(parts);
}

async function layersOf(comp: string): Promise<Array<{ id: string; name: string; kind: string; source?: string; visible: boolean; blend: string }>> {
  const r = await h.query({ type: 'getComposition', comp });
  return (r.layers as unknown as Array<Record<string, unknown>>).map((l) => ({
    id: String(l.id), name: String(l.name), kind: String(l.kind), source: l.source as string | undefined,
    visible: (l.switches as { visible: boolean }).visible, blend: String(l.blendMode),
  }));
}

async function value(layer: string, p: string): Promise<unknown> {
  const r = await h.query({ type: 'getPropertyValues', props: [{ layer, path: p }], time: 0, evaluated: true });
  const v = r.values[0]!.value as { kind: string; value: unknown };
  return v.value;
}

it('imports a Photoshop file as a composition of its layers, groups and clipping groups', async () => {
  const file = path.join(dir, 'Poster.psd');
  fs.writeFileSync(file, psd(200, 100, [
    { name: 'Background', w: 200, h: 100, rgba: [20, 20, 20, 255] },
    { name: 'Card', left: 40, top: 10, w: 60, h: 40, rgba: [200, 30, 30, 255], opacity: 153, blend: 'mul ' },
    { name: 'Shine', left: 40, top: 10, w: 20, h: 20, rgba: [255, 255, 255, 255], clipped: true },
    { name: '</Layer group>', section: 3 },
    { name: 'Logo', left: 150, top: 60, w: 30, h: 20, rgba: [0, 0, 255, 255], hidden: true },
    { name: 'Brand', section: 1, blend: 'scrn', opacity: 255 },
  ]));
  const { items } = await h.run({ type: 'importFiles', files: [{ path: file, asSequence: false, createComposition: true }] });
  const [comp, folder] = items as string[];

  const doc = await h.query({ type: 'getItems', items: [comp!, folder!] });
  const all = doc.items as Array<{ id: string; name: string; kind: string; parent?: string; folder?: string }>;
  expect(all.find((i) => i.id === comp)?.name).toBe('Poster');
  expect(all.find((i) => i.id === folder)?.name).toBe('Poster Layers');

  const top = await layersOf(comp!);
  // getLayers lists top first: Brand (group), the Card clipping group, Background.
  expect(top.map((l) => l.name)).toEqual(['Brand', 'Card', 'Background']);
  const [brand, card, bg] = top;
  expect(brand!.kind).toBe('precomp');
  expect(brand!.blend).toBe('screen');
  expect(card!.kind).toBe('precomp');
  expect(card!.blend).toBe('multiply');
  expect(await value(card!.id, 'transform/opacity')).toBeCloseTo(60, 0);
  expect(bg!.kind).toBe('image');
  expect(await value(bg!.id, 'transform/position')).toEqual({ x: 100, y: 50 });

  const inCard = await layersOf(card!.source!);
  expect(inCard.map((l) => l.name)).toEqual(['Shine', 'Card']);
  expect(await value(inCard[1]!.id, 'transform/position')).toEqual({ x: 70, y: 30 });
  expect(await value(inCard[1]!.id, 'transform/opacity')).toBeCloseTo(100, 5);

  const inBrand = await layersOf(brand!.source!);
  expect(inBrand.map((l) => l.name)).toEqual(['Logo']);
  expect(inBrand[0]!.visible).toBe(false);
  expect(await value(inBrand[0]!.id, 'transform/position')).toEqual({ x: 165, y: 70 });

  // One undo entry takes all of it away.
  await h.run({ type: 'undo' });
  await expect(h.query({ type: 'getComposition', comp: comp! })).rejects.toThrow();
});

it('imports a Photoshop file as footage: the merged image, the .psd as its path', async () => {
  const file = path.join(dir, 'Flat.psd');
  fs.writeFileSync(file, psd(64, 32, [{ name: 'L', w: 64, h: 32, rgba: [1, 2, 3, 255] }]));
  const { items } = await h.run({ type: 'importFiles', files: [{ path: file, asSequence: false, createComposition: false }] });
  const all = (await h.query({ type: 'getItems', items: items as string[] })).items as Array<{ id: string; name: string; kind: string }>;
  const item = all.find((i) => i.id === items[0]);
  expect(item?.name).toBe('Flat.psd');
  expect(item?.kind).toBe('footage');
});

it('refuses what it cannot read, by name', async () => {
  const file = path.join(dir, 'Broken.psd');
  fs.writeFileSync(file, Buffer.from('8BPS-not-really'));
  await expect(h.run({ type: 'importFiles', files: [{ path: file, asSequence: false, createComposition: true }] })).rejects.toThrow(/Broken\.psd/);
});
