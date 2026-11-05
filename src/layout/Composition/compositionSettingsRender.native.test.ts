/**
 * Composition Settings reach the PICTURE, not only the document: each setting
 * is saved the way the dialog saves it (`saveCompositionSettingsEdit`) and read
 * back from the engine's own pixels — the viewport's frame and the still an
 * export draws from.
 *
 * Needs the full engine and a GPU adapter; skipped (with a note) without them.
 */

import type { Command } from '@motion/engine-api';
import { setupAppEngine, sec, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { nativeEngineIsHeadless } from '@core/engine/__testHelpers__/nativeEngine';
import { decodePng } from '@core/ai/author/eval/contactSheet';
import { activeCompRootId } from '@core/scene/activeComp';
import { compRecordFromSettings } from '@core/mirror/compFacts';
import { documentMirror } from '@stores/documentMirror';
import type { CompositionSettings } from '@stores/projectStore';
import { saveCompositionSettingsEdit } from './compositionEdits';

jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick', 'setImmediate'] });
jest.setTimeout(120_000);

const suite = nativeEngineIsHeadless() ? describe.skip : describe;

/** The main viewport framed on the comp (setupComp): 1920×1080 at zoom 1, comp px = viewport px. */
const FRAMED = { type: 'setViewport', viewport: 1, width: 1920, height: 1080, devicePixelRatio: 1, zoom: 1, pan: { x: 960, y: 540 }, exposure: 0, transparencyGrid: false, displayTransform: '', layerRenderEffects: true };

type Rgba = [number, number, number, number];
const encode = (v: number): number => Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055));
const near = (a: readonly number[], b: readonly number[], tol = 3): boolean => b.every((v, c) => Math.abs((a[c] ?? NaN) - v) <= tol);
const lum = (p: readonly number[]): number => ((p[0] ?? 0) + (p[1] ?? 0) + (p[2] ?? 0)) / 3;

suite('Composition Settings reach the picture', () => {
  let h: Harness;
  let gpu = true;

  beforeEach(async () => {
    if (!gpu) return;
    try {
      h = await setupAppEngine({ gpu: true, panels: true });
      await h.run({ ...FRAMED, channel: 'rgb' } as Command);
    } catch (e) {
      gpu = false;
      console.log(`[compositionSettingsRender] the engine did not start with a GPU: skipped (${String(e)})`);
    }
  });
  afterEach(async () => {
    if (gpu) await h.dispose();
  });

  const compId = (): string => activeCompRootId() as string;
  const record = (): CompositionSettings => compRecordFromSettings(compId(), documentMirror().comp(compId())!.settings);

  /** What the dialog's Save Changes does with a draft. */
  async function save(patch: Partial<CompositionSettings>): Promise<void> {
    const from = record();
    expect(await saveCompositionSettingsEdit(compId(), from, { ...from, ...patch })).toBe(true);
  }

  /** The comp's still, full size (what exports and thumbnails draw). */
  async function still(): Promise<(x: number, y: number) => Rgba> {
    const th = await h.query({ type: 'getThumbnail', item: compId(), time: sec(0.5), maxSize: 1920 });
    const d = decodePng(th.data);
    return (x, y) => Array.from(d.data.slice((y * d.width + x) * 4, (y * d.width + x) * 4 + 4)) as Rgba;
  }

  /** The viewport's frame at comp (x, y), display-encoded; polled until `want` (a frame lands a few round trips after the edit). */
  async function viewport(x: number, y: number, want: readonly number[]): Promise<number[]> {
    let got: number[] = [NaN, NaN, NaN];
    for (let i = 0; i < 40; i++) {
      try {
        const p = await h.query({ type: 'readPixels', viewport: 1, region: { x, y, width: 1, height: 1 } });
        got = Array.from(p.rgba.slice(0, 3)).map(encode);
        if (near(got, want)) return got;
      } catch {
        // pending: no frame shown yet
      }
      await new Promise((r) => { setTimeout(r, 100); });
    }
    return got;
  }

  const STOPS = [
    { id: 'a', offset: 0, color: '#ff0000' },
    { id: 'b', offset: 0.5, color: '#00ff00' },
    { id: 'c', offset: 1, color: '#0000ff' },
  ];

  it('a solid background colour shows in the viewport and the still', async () => {
    if (!gpu) return;
    await save({ background: '#336699' });
    expect(near((await still())(960, 540), [0x33, 0x66, 0x99])).toBe(true);
    expect(await viewport(960, 540, [0x33, 0x66, 0x99])).toEqual([0x33, 0x66, 0x99]);
  });

  it('Canvas Transparency: the still keeps alpha, and the viewport shows the checkerboard rather than black', async () => {
    if (!gpu) return;
    await save({ background: '#336699', transparent: true });
    expect((await still())(960, 540)[3]).toBe(0);
    // Two neighbouring cells of the checkerboard, at the frame's far corner too: it covers the whole comp.
    const samples = [await viewport(4, 4, [0x3d, 0x3d, 0x3d]), await viewport(4 + 16, 4, [0x2b, 0x2b, 0x2b]), await viewport(1916, 1076, [0x3d, 0x3d, 0x3d])];
    expect(samples.map((p) => lum(p) > 0)).toEqual([true, true, true]);
    expect(lum(samples[0]!)).not.toBe(lum(samples[1]!));
    // And off again: the colour comes back.
    await save({ transparent: false });
    expect(near(await viewport(4, 4, [0x33, 0x66, 0x99]), [0x33, 0x66, 0x99])).toBe(true);
  });

  it('a linear gradient background renders across its stops, multi-stop', async () => {
    if (!gpu) return;
    await save({ background: '#ff0000', backgroundPaint: { type: 'linear', angle: 0, stops: STOPS } });
    const px = await still();
    expect(near(px(2, 540), [255, 0, 0], 8)).toBe(true);
    expect(near(px(960, 540), [0, 255, 0], 12)).toBe(true);
    expect(near(px(1917, 540), [0, 0, 255], 8)).toBe(true);
    // The viewport draws the same gradient: right of centre it is past green, heading to blue.
    const v = await viewport(1917, 540, [0, 0, 255]);
    expect(near(v, [0, 0, 255], 12)).toBe(true);
  });

  it('a radial gradient background renders from its centre', async () => {
    if (!gpu) return;
    await save({
      background: '#ffffff',
      backgroundPaint: { type: 'radial', cx: 0.5, cy: 0.5, radius: 1, stops: [{ id: 'a', offset: 0, color: '#ffffff' }, { id: 'b', offset: 1, color: '#000000' }] },
    });
    const px = await still();
    expect(px(960, 540)[0]).toBeGreaterThan(240);
    expect(px(2, 2)[0]).toBeLessThan(20);
  });

  it('removing the gradient returns to the solid; transparency wins over a gradient', async () => {
    if (!gpu) return;
    await save({ background: '#ff0000', backgroundPaint: { type: 'linear', angle: 0, stops: STOPS } });
    await save({ transparent: true });
    expect((await still())(960, 540)[3]).toBe(0);
    await save({ transparent: false, background: '#336699', backgroundPaint: undefined });
    expect(near((await still())(1917, 540), [0x33, 0x66, 0x99])).toBe(true);
  });

  it('the alpha view is not fooled by the checkerboard of a transparent comp', async () => {
    if (!gpu) return;
    await save({ transparent: true });
    await h.run({ ...FRAMED, channel: 'alpha' } as Command);
    expect(near(await viewport(4, 4, [0, 0, 0]), [0, 0, 0])).toBe(true);
    await h.run({ ...FRAMED, channel: 'rgb' } as Command);
  });

  /** A centred grey 3D card under a camera, with a light: what the World and Renderer tabs act on. */
  async function scene3d(): Promise<void> {
    const comp = compId();
    const { layer } = await h.run({ type: 'createLayer', comp, kind: 'rectangle', name: 'Card', init: [] } as Command) as unknown as { layer: string };
    await h.run({ type: 'setLayerSwitches', layers: [layer], patch: { threeD: true } } as Command);
    await h.run({ type: 'setProperty', prop: { layer, path: 'layer/fill' }, value: { kind: 'color', value: { r: 0.5, g: 0.5, b: 0.5, a: 1 } }, time: sec(0) } as Command);
    await h.run({ type: 'createLayer', comp, kind: 'camera', name: 'Camera', init: [] } as Command);
  }
  /** Whether saving `patch` changes any pixel of the still, at the given sampling points. */
  async function changes(patch: Partial<CompositionSettings>, points: ReadonlyArray<readonly [number, number]>): Promise<boolean> {
    const a = await still();
    const before = points.map(([x, y]) => a(x, y));
    await save(patch);
    const b = await still();
    return points.some(([x, y], i) => lum(b(x, y)) !== lum(before[i]!));
  }
  const GRID_POINTS = [[960, 540], [960, 300], [700, 540], [1200, 800], [100, 100], [960, 1000]] as const;

  it('World ▸ Fog changes the 3D picture', async () => {
    if (!gpu) return;
    await scene3d();
    expect(await changes({ fog: { enabled: true, mode: 'linear', start: 0, end: 500, density: 1, color: '#ff0000', maxOpacity: 100 } }, GRID_POINTS)).toBe(true);
  });

  it('Color ▸ Display Transform changes the still', async () => {
    if (!gpu) return;
    await save({ background: '#336699' });
    const a = (await still())(960, 540);
    await h.run({ type: 'setColorManagement', patch: { displayTransform: 'aces' } } as Command);
    const b = (await still())(960, 540);
    await h.run({ type: 'setColorManagement', patch: { displayTransform: 'srgb' } } as Command);
    expect(b.slice(0, 3)).not.toEqual(a.slice(0, 3));
  });

  it('Color ▸ Blend colors changes how a half-transparent layer mixes', async () => {
    if (!gpu) return;
    const comp = compId();
    await save({ background: '#000000' });
    const { layer } = await h.run({ type: 'createLayer', comp, kind: 'rectangle', name: 'Half', init: [] } as Command) as unknown as { layer: string };
    await h.run({ type: 'setProperty', prop: { layer, path: 'layer/fill' }, value: { kind: 'color', value: { r: 1, g: 1, b: 1, a: 1 } }, time: sec(0) } as Command);
    await h.run({ type: 'setProperty', prop: { layer, path: 'transform/opacity' }, value: { kind: 'scalar', value: 50 }, time: sec(0) } as Command);
    const from = record();
    await saveCompositionSettingsEdit(comp, from, from, { linearBlending: false });
    const gamma = (await still())(960, 540)[0];
    await saveCompositionSettingsEdit(comp, from, from, { linearBlending: true });
    const linear = (await still())(960, 540)[0];
    expect(linear).not.toBe(gamma);
  });

  it("a nested composition's gradient is not a backdrop in its parent", async () => {
    if (!gpu) return;
    const parent = compId();
    await save({ background: '#336699' });
    const created = await h.run({ type: 'createComposition', settings: {
      name: 'Inner', width: 1920, height: 1080, frameRate: { num: 30, den: 1 }, duration: 10 * 705_600_000,
      background: { r: 1, g: 0, b: 0, a: 1 }, backgroundPaint: JSON.stringify({ type: 'linear', angle: 0, stops: STOPS }),
    }, fromItems: [] } as Command) as unknown as { item: string };
    // Content, so the nested comp draws: a default rectangle in its middle. Around it is the parent's own background.
    await h.run({ type: 'createLayer', comp: created.item, kind: 'rectangle', name: 'Content', init: [] } as Command);
    await h.run({ type: 'createLayer', comp: parent, kind: 'precomp', source: created.item, init: [] } as Command);
    const th = await h.query({ type: 'getThumbnail', item: parent, time: sec(0.5), maxSize: 1920 });
    const d = decodePng(th.data);
    const at = (x: number, y: number): number[] => Array.from(d.data.slice((y * d.width + x) * 4, (y * d.width + x) * 4 + 3));
    for (const [x, y] of [[4, 4], [1900, 20], [100, 980]] as const) expect(near(at(x, y), [0x33, 0x66, 0x99])).toBe(true);
  });
});
