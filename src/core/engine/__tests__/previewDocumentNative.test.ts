/**
 * Preview documents on the REAL C++ engine: the library / template / preset
 * cards and the component thumbnails are `renderDocumentStill` of a throwaway
 * scene (core/engine/previewDocument.ts). This pins that the engine actually
 * DRAWS them — every catalogue item answers a picture that is not just its
 * background, a choreography moves between two times, a transparent preview
 * keeps its alpha, and the open document is not touched.
 *
 * Skipped, saying so, when the full engine (with the scene) is not built.
 */

import { ProcessEngineClient, secondsToFlicks, unwrap, type EngineClient } from '@motion/engine-api';
import { nativeEngineExe, startNativeEngine, type NativeEngine } from '@core/engine/__testHelpers__/nativeEngine';
import type { PreviewDocument } from '@core/engine/previewDocument';
import { buildPreviewScene, type PreviewSpec } from '@core/template/previewController';
import { MOGRAPH_ITEMS, mographPreviewSpec } from '@core/library/mographLibrary';
import { TRANSITION_ITEMS, transitionPreviewSpec } from '@core/library/transitionLibrary';
import { ANIM_PRESETS, animPresetPreviewSpec } from '@core/template/animPresets';
import { TEMPLATES } from '@core/template/registry';
import { templatePreviewSpec } from '@core/template/templatePreview';
import { componentThumbDocument } from '@core/library/componentThumbs';
import type { ComponentDef } from '@stores/componentStore';

jest.setTimeout(300_000);

const exe = nativeEngineExe();
const full = !!exe && !/headless/i.test(exe);
if (!full) console.log('[preview documents native] the full premation-engine is not built — skipped');
const maybe = full ? describe : describe.skip;

interface Picture { width: number; height: number; data: Uint8Array }

function decode(t: { format: string; data: Uint8Array }): Picture {
  expect(t.format).toBe('png');
  // Test-only decoder (devDependency).
  const { PNG } = require('pngjs') as { PNG: { sync: { read(b: Buffer): { width: number; height: number; data: Buffer } } } };
  const png = PNG.sync.read(Buffer.from(t.data));
  return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
}

/** A preview background as RGBA bytes: `#rrggbb`, or a transparent colour (alpha 0). */
function backgroundRgba(css: string | undefined): [number, number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(css ?? '');
  if (!hex) return [0, 0, 0, 0];
  const v = Number.parseInt(hex[1]!, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255, 255];
}

/**
 * Share of pixels that are NOT the bare background (more than 8 levels off in
 * any channel; against a transparent background, any alpha at all). A frame
 * the item covers evenly — a dip to black over the whole comp — is all ink.
 */
function inkShare(p: Picture, background: string | undefined): number {
  const bg = backgroundRgba(background);
  let n = 0;
  for (let i = 0; i < p.data.length; i += 4) {
    const ink = bg[3] === 0
      ? p.data[i + 3]! > 8
      : Math.abs(p.data[i]! - bg[0]) > 8 || Math.abs(p.data[i + 1]! - bg[1]) > 8 || Math.abs(p.data[i + 2]! - bg[2]) > 8;
    if (ink) n++;
  }
  return n / (p.data.length / 4);
}

/** Share of RGBA bytes that differ by more than 8 levels. */
function differing(a: Picture, b: Picture): number {
  expect(a.data.length).toBe(b.data.length);
  let n = 0;
  for (let i = 0; i < a.data.length; i++) if (Math.abs(a.data[i]! - b.data[i]!) > 8) n++;
  return n / a.data.length;
}

maybe('preview documents in the C++ engine', () => {
  let native: NativeEngine;
  let client: EngineClient;

  beforeAll(async () => {
    native = await startNativeEngine({ extraArgs: [] });
    const c = new ProcessEngineClient(native.bridge);
    await c.whenReady();
    client = c;
  });
  afterAll(async () => {
    await native?.stop();
  });

  const still = async (doc: PreviewDocument, seconds: number, maxSize = 320): Promise<Picture> => {
    const res = await client.query({ type: 'renderDocumentStill', document: doc.json, comp: doc.compId, time: secondsToFlicks(seconds), maxSize });
    if (!res.ok) throw new Error(`renderDocumentStill: ${res.error.code} ${res.error.message}`);
    return decode(res.value);
  };

  /** Every item of a catalogue: the engine draws its poster, and it is not an empty frame. */
  const drawsEvery = (name: string, specs: () => Array<{ id: string; spec: PreviewSpec }>): void => {
    it(`draws every ${name} card's poster`, async () => {
      const empty: string[] = [];
      for (const { id, spec } of specs()) {
        const scene = buildPreviewScene(spec);
        const p = await still(scene.doc, scene.posterTime);
        // The composition's aspect, long side at the size asked.
        expect(Math.max(p.width, p.height)).toBe(320);
        expect(p.width / p.height).toBeCloseTo(spec.width / spec.height, 1);
        if (inkShare(p, spec.background) < 0.002) empty.push(id);
      }
      expect(empty).toEqual([]);
    });
  };

  drawsEvery('mograph', () => MOGRAPH_ITEMS.map((item) => ({ id: item.id, spec: mographPreviewSpec(item) })));
  drawsEvery('transition', () => TRANSITION_ITEMS.map((item) => ({ id: item.id, spec: transitionPreviewSpec(item) })));
  drawsEvery('animated preset', () => ANIM_PRESETS.map((p) => ({ id: p.id, spec: animPresetPreviewSpec(p) })));
  drawsEvery('template', () => TEMPLATES.map((t) => ({ id: t.id, spec: templatePreviewSpec(t) })));

  it('a choreography moves: the flipbook\'s first frame is not its poster', async () => {
    const item = MOGRAPH_ITEMS.find((m) => !m.loop)!;
    const scene = buildPreviewScene(mographPreviewSpec(item));
    expect(scene.duration).toBeGreaterThan(0);
    const first = await still(scene.doc, 0);
    const rest = await still(scene.doc, scene.posterTime);
    expect(differing(first, rest)).toBeGreaterThan(0.001);
  });

  it('a transparent preview keeps its alpha; an opaque one is filled with its background', async () => {
    const preset = buildPreviewScene(animPresetPreviewSpec(ANIM_PRESETS.find((p) => p.kind === 'object')!));
    const clear = await still(preset.doc, preset.posterTime);
    expect(clear.data[3]).toBe(0); // the corner is outside the element
    const mograph = buildPreviewScene(mographPreviewSpec(MOGRAPH_ITEMS[0]!));
    const filled = await still(mograph.doc, mograph.posterTime);
    expect(filled.data[3]).toBe(255);
    // '#101016'
    expect([filled.data[0], filled.data[1], filled.data[2]].map((v) => Math.abs(v! - [0x10, 0x10, 0x16][0]!) <= 12)).toEqual([true, true, true]);
  });

  it('draws a component thumbnail: the layers inside a transparent margin, a parented child where its parent carries it', async () => {
    const row = (id: string, parent: string | null, children: string[], x: number, y: number, w: number, h: number, fill: string) => ({
      row: {
        id, name: id, parent, children,
        transform: { position: { x, y }, rotation: 0, scale: { x: 1, y: 1 } },
        components: [
          { id: `${id}_t`, type: 'Transform', props: { __kind: 'shape', x, y, rotation: 0, width: w, height: h } },
          { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill } },
        ],
      },
    });
    const def = {
      id: 'c1', name: 'Card', createdAt: 1,
      fragment: {
        version: 1,
        // A 200 × 100 red plate far from the origin, and a 40 × 40 blue chip parented to it (LOCAL offset −60, 0).
        data: JSON.stringify({ layers: [row('plate', 'comp_root', ['chip'], 1500, 900, 200, 100, '#ff0000'), row('chip', 'plate', [], -60, 0, 40, 40, '#0000ff')] }),
      },
    } as unknown as ComponentDef;
    const doc = componentThumbDocument(def)!;
    expect(doc).not.toBeNull();
    // Bounds 200 × 100 plus the 12 px margin each side.
    expect([doc.width, doc.height]).toEqual([224, 124]);
    const p = await still(doc, 0, 224);
    expect([p.width, p.height]).toEqual([224, 124]);
    const at = (x: number, y: number): number[] => Array.from(p.data.slice((y * p.width + x) * 4, (y * p.width + x) * 4 + 4));
    expect(at(2, 2)[3]).toBe(0); // the margin is transparent
    const plate = at(160, 62);
    expect(plate[0]).toBeGreaterThan(200);
    expect(plate[2]).toBeLessThan(60);
    expect(plate[3]).toBe(255);
    // The chip sits 60 px left of the plate's centre (112, 62), carried by its parent.
    const chip = at(52, 62);
    expect(chip[2]).toBeGreaterThan(200);
    expect(chip[0]).toBeLessThan(60);
  });

  it('leaves the open document alone', async () => {
    const before = unwrap(await client.query({ type: 'getHistory' })).entries.length;
    const scene = buildPreviewScene(mographPreviewSpec(MOGRAPH_ITEMS[0]!));
    await still(scene.doc, 0);
    expect(unwrap(await client.query({ type: 'getHistory' })).entries.length).toBe(before);
  });
});
