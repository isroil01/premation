/**
 * Text ▸ Background (TextBackgroundRows): the switch and Shape are settings;
 * Color, Opacity, Padding and Roundness are keyframeable properties that exist
 * while the switch is on, stored on the Text component like Stroke Width.
 */

import { PNG } from 'pngjs';
import type { Command } from '@motion/engine-api';
import { activeCompRootId } from '@core/scene/activeComp';
import { documentMirror } from '@stores/documentMirror';
import { sec, settleEdits, setupAppEngine, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { values } from '@core/engine/propRefs';
import { runToolTurn } from '@core/ai/aiTurn';

jest.setTimeout(60_000);
jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick', 'setImmediate'] });

let h: Harness;

async function textLayer(): Promise<string> {
  const r = await runToolTurn('AI: caption', [{ name: 'create_layer', args: { id: 't', kind: 'text', name: 'T', text: 'CAPTION' } }]);
  expect(r.results.filter((x) => !x.ok).map((x) => x.content)).toEqual([]);
  const m = documentMirror();
  const id = m.layerIds().find((c) => m.layer(c)?.name === 'T');
  if (!id) throw new Error('no text layer');
  return id;
}

async function paths(layer: string): Promise<Map<string, { valueType?: string; animatable?: boolean }>> {
  const m = documentMirror();
  await m.loadTree(layer);
  const out = new Map<string, { valueType?: string; animatable?: boolean }>();
  for (const [path, n] of m.tree(layer)?.nodes ?? []) {
    if (path.startsWith('text/background')) out.set(path, n as { valueType?: string; animatable?: boolean });
  }
  return out;
}

const NUMBERS = ['text/backgroundOpacity', 'text/backgroundPadding', 'text/backgroundRadius'];

describe('text background', () => {
  beforeEach(async () => {
    h = await setupAppEngine();
    await h.run({ type: 'setCompositionSettings', comp: 'comp_root', patch: { frameRate: { num: 30, den: 1 }, duration: sec(10) } } as Command);
    await settleEdits();
  });
  afterEach(async () => { await h.dispose(); });

  it('has only its settings while off, and keyframeable properties while on', async () => {
    const layer = await textLayer();
    const off = await paths(layer);
    expect([...off.keys()].sort()).toEqual(['text/background', 'text/backgroundMode']);

    await h.run({ type: 'setProperty', prop: { layer, path: 'text/background' }, value: values.bool(true) });
    await settleEdits();
    const on = await paths(layer);
    for (const p of [...NUMBERS, 'text/backgroundColor']) {
      expect(on.get(p)).toMatchObject({ animatable: true });
    }
    expect(on.get('text/backgroundColor')).toMatchObject({ valueType: 'color' });
    expect(documentMirror().property(layer, 'text/backgroundPadding')?.value).toMatchObject({ value: 12 });
  });

  it('keys opacity and colour over time', async () => {
    const layer = await textLayer();
    await h.run({ type: 'setProperty', prop: { layer, path: 'text/background' }, value: values.bool(true) });
    const opacity = { layer, path: 'text/backgroundOpacity' };
    await h.run({ type: 'setAnimated', prop: opacity, animated: true, time: 0 });
    await h.run({ type: 'setProperty', prop: opacity, value: values.scalar(0), time: 0 });
    await h.run({ type: 'setProperty', prop: opacity, value: values.scalar(80), time: sec(1) });
    const colour = { layer, path: 'text/backgroundColor' };
    await h.run({ type: 'setProperty', prop: colour, value: values.color(1, 0, 0, 1) });
    await settleEdits();
    const m = documentMirror();
    await m.loadTree(layer);
    expect(m.property(layer, 'text/backgroundOpacity')).toMatchObject({ animated: true, keyframeCount: 2 });
    const r = await h.client.query({ type: 'getPropertyValues', props: [opacity], time: sec(0.5), evaluated: true } as never);
    const mid = JSON.stringify(r).match(/"value":(-?[\d.]+)/);
    expect(Number(mid?.[1])).toBeCloseTo(40, 0);
    expect(m.property(layer, 'text/backgroundColor')?.value).toMatchObject({ kind: 'color', value: { r: 1, g: 0, b: 0 } });
  });
});

// ── pixels: the full renderer (PREMATION_GPU_TESTS=1) ──
const gpuSuite = process.env.PREMATION_GPU_TESTS === '1' ? describe : describe.skip;
const W = 480;
const H = 270;

gpuSuite('text background on the full renderer', () => {
  let g: Harness;
  beforeAll(async () => {
    g = await setupAppEngine({ gpu: true });
    await g.run({ type: 'setCompositionSettings', comp: activeCompRootId() as string, patch: { width: W, height: H, duration: sec(4), background: { r: 0, g: 0, b: 0, a: 1 } } } as Command);
    await g.run({ type: 'setViewport', viewport: 1, width: W, height: H, devicePixelRatio: 1, zoom: 0, pan: { x: 0, y: 0 }, channel: 'rgb', exposure: 0, transparencyGrid: false, displayTransform: '', layerRenderEffects: true } as Command);
    await settleEdits();
  }, 60_000);
  afterAll(async () => { await g.dispose(); });

  async function frame(t: number): Promise<PNG> {
    await settleEdits();
    const th = (await g.query({ type: 'getThumbnail', item: activeCompRootId() as string, time: sec(t), maxSize: W } as never)) as { data: Uint8Array };
    return PNG.sync.read(Buffer.from(th.data));
  }
  /** Pure-ish red pixels (the background box, never the white glyphs). */
  const red = (p: PNG): number => {
    let n = 0;
    for (let i = 0; i < p.data.length; i += 4) if (p.data[i]! > 150 && p.data[i + 1]! < 60 && p.data[i + 2]! < 60) n++;
    return n;
  };

  it('draws the box behind the text, and fades it with keyed opacity', async () => {
    const r = await runToolTurn('AI: caption', [{ name: 'create_layer', args: { id: 't', kind: 'text', name: 'T', text: 'CAPTION', x: 240, y: 135 } }]);
    expect(r.results.filter((x) => !x.ok).map((x) => x.content)).toEqual([]);
    const m = documentMirror();
    const layer = m.layerIds().find((c) => m.layer(c)?.name === 'T')!;
    expect(red(await frame(0))).toBe(0);
    await g.run({ type: 'setProperty', prop: { layer, path: 'text/background' }, value: values.bool(true) });
    await g.run({ type: 'setProperty', prop: { layer, path: 'text/backgroundColor' }, value: values.color(1, 0, 0, 1) });
    const on = red(await frame(0));
    expect(on).toBeGreaterThan(3000);
    const opacity = { layer, path: 'text/backgroundOpacity' };
    await g.run({ type: 'setAnimated', prop: opacity, animated: true, time: 0 });
    await g.run({ type: 'setProperty', prop: opacity, value: values.scalar(100), time: 0 });
    await g.run({ type: 'setProperty', prop: opacity, value: values.scalar(0), time: sec(2) });
    expect(red(await frame(0))).toBeGreaterThan(3000);
    expect(red(await frame(2))).toBe(0);
  });
});
