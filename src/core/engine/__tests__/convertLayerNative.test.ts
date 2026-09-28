/**
 * convertLayer / separateLayer on the REAL C++ engine (core/handlers_convert.cpp
 * over the frame builder's fonts): Create Shapes from Text traces the painted
 * text into one path layer beside the hidden text, Create Masks from Text makes
 * a solid with a mask per contour (a counter subtracts), Separate splits the
 * shape into one layer per run — each one undoable entry. The TypeScript
 * engine answers `unsupported` (commands.test).
 *
 * Skipped, saying so, when the full engine is not built.
 */

import { ProcessEngineClient, unwrap, type EngineClient } from '@motion/engine-api';
import { nativeEngineExe, startNativeEngine, type NativeEngine } from '@core/engine/__testHelpers__/nativeEngine';
import { buildSvgLayerFragment } from '@/engine-client/svgFragment';

jest.setTimeout(120_000);

interface DocNode { id: string; name?: string; visible?: boolean; components: Array<{ type: string; props: Record<string, unknown> }> }

const exe = nativeEngineExe();
const full = !!exe && !/headless/i.test(exe);
if (!full) console.log('[convertLayer native] the full premation-engine is not built — skipped');
const maybe = full ? describe : describe.skip;

maybe('convertLayer in the C++ engine', () => {
  let native: NativeEngine;
  let client: EngineClient;

  beforeAll(async () => {
    // With the scene (no `--no-gpu`): the conversions trace on the frame
    // builder's fonts; a --no-gpu engine answers `unsupported` like the TS one.
    native = await startNativeEngine({ extraArgs: [] });
    const c = new ProcessEngineClient(native.bridge);
    await c.whenReady();
    client = c;
  });
  afterAll(async () => {
    await native?.stop();
  });

  async function nodes(): Promise<Map<string, DocNode>> {
    const bytes = unwrap(await client.query({ type: 'exportDocument' })).document;
    const doc = JSON.parse(new TextDecoder().decode(bytes)) as { scene: { nodes: DocNode[] } };
    return new Map(doc.scene.nodes.map((n) => [n.id, n]));
  }
  async function lastLabel(): Promise<string | undefined> {
    const h = unwrap(await client.query({ type: 'getHistory' })).entries;
    return h[h.length - 1]?.label;
  }

  it('Create Shapes from Text, then Separate, each one entry', async () => {
    const comp = unwrap(await client.execute({ type: 'createComposition', settings: { name: 'Convert' }, fromItems: [] })).item;
    const text = unwrap(await client.execute({ type: 'createLayer', comp, kind: 'text', name: 'OK', init: [] })).layer;
    const before = await picture(comp);
    const made = unwrap(await client.execute({ type: 'convertLayer', layer: text, conversion: 'shapesFromText' })).layers;
    // The outlines draw what the text drew (its colour, its place, its glyphs).
    expect(differing(before.data, (await picture(comp)).data)).toBeLessThan(0.003);
    expect(made).toHaveLength(1);
    expect(await lastLabel()).toBe('Create Shapes from Text');
    let all = await nodes();
    const shape = all.get(made[0]!)!;
    // The font's own Béziers (a plain centred style), not the trace.
    expect(shape.name).toBe('OK Outlines (outlines)');
    const runs = shape.components.find((c) => c.type === 'Geometry')!.props.subpaths as unknown[];
    // "O" is an outer ring and a counter, "K" one ring.
    expect(runs.length).toBeGreaterThanOrEqual(3);
    expect(all.get(text)!.visible).toBe(false);

    const parts = unwrap(await client.execute({ type: 'separateLayer', layer: made[0]! })).layers;
    expect(parts).toHaveLength(runs.length);
    expect(await lastLabel()).toBe('Separate Layer');
    all = await nodes();
    expect(all.has(made[0]!)).toBe(false);
    unwrap(await client.execute({ type: 'undo' }));
    unwrap(await client.execute({ type: 'undo' }));
    all = await nodes();
    expect(all.has(made[0]!)).toBe(false);
    expect(all.get(text)!.visible).not.toBe(false);
  });

  it('Create Masks from Text: a solid, the counter subtracted', async () => {
    const comp = unwrap(await client.execute({ type: 'createComposition', settings: { name: 'Masks' }, fromItems: [] })).item;
    const text = unwrap(await client.execute({ type: 'createLayer', comp, kind: 'text', name: 'O', init: [] })).layer;
    const made = unwrap(await client.execute({ type: 'convertLayer', layer: text, conversion: 'masksFromText' })).layers;
    expect(made).toHaveLength(1);
    expect(await lastLabel()).toBe('Create Masks from Text');
    const solid = (await nodes()).get(made[0]!)!;
    const masks = JSON.stringify(solid.components);
    expect(masks).toContain('"mode":"add"');
    expect(masks).toContain('"mode":"subtract"');
  });

  const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80" width="120" height="80">
    <defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs>
    <rect id="box" x="10" y="10" width="100" height="60" fill="url(#g)"/>
    <g transform="translate(60 40)"><circle r="12" fill="#fff" stroke="#000" stroke-width="2"/></g>
    <text x="10" y="75" font-family="Arial" font-size="10" fill="#0f0">Hi there</text>
  </svg>`;

  async function svgLayer(comp: string): Promise<string> {
    const made = buildSvgLayerFragment(LOGO, 'logo.svg', { compWidth: 1920, compHeight: 1080, x: 400, y: 300 });
    expect(made).not.toBeNull();
    return unwrap(await client.execute({ type: 'pasteLayers', comp, fragment: made!.built.fragment })).layers[0]!;
  }

  async function picture(comp: string): Promise<{ format: string; data: Uint8Array }> {
    const t = unwrap(await client.query({ type: 'getThumbnail', item: comp, time: 0, maxSize: 480 }));
    if (t.format !== 'png') return { format: t.format, data: t.data };
    // Test-only decoder (devDependency).
    const { PNG } = require('pngjs') as { PNG: { sync: { read(b: Buffer): { data: Buffer } } } };
    return { format: 'rgba', data: new Uint8Array(PNG.sync.read(Buffer.from(t.data)).data) };
  }
  /** Share of RGBA bytes that differ by more than 48 levels. */
  function differing(a: Uint8Array, b: Uint8Array): number {
    expect(a.length).toBe(b.length);
    let n = 0;
    for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) > 48) n++;
    return n / a.length;
  }

  it('Convert to Editable Shapes: a group of the parts in place, the source retained, one entry', async () => {
    const comp = unwrap(await client.execute({ type: 'createComposition', settings: { name: 'Svg' }, fromItems: [] })).item;
    const svg = await svgLayer(comp);
    const before = await picture(comp);
    const made = unwrap(await client.execute({ type: 'convertLayer', layer: svg, conversion: 'shapesFromVector' })).layers;
    const after = await picture(comp);
    // The picture is kept: shapes where the SVG drew (text reflows a little in its own font).
    if (before.format === after.format && before.format.startsWith('rgba')) expect(differing(before.data, after.data)).toBeLessThan(0.003);
    expect(await lastLabel()).toBe('Convert SVG to Editable Shapes');
    expect(made).toHaveLength(4); // group, rect, circle, text
    const all = await nodes();
    expect(all.has(svg)).toBe(false);
    const group = all.get(made[0]!)!;
    expect(JSON.stringify(group.components)).toContain('sourceMarkup');
    const box = all.get(made[1]!)!;
    const fx = box.components.find((c) => c.type === 'fx')?.props as { fill?: { type?: string; stops?: unknown[] } } | undefined;
    expect(fx?.fill?.type).toBe('linear');
    expect(fx?.fill?.stops).toHaveLength(2);
    const circle = all.get(made[2]!)!;
    expect((circle.components.find((c) => c.type === 'fx')!.props as { stroke?: { enabled: boolean } }).stroke?.enabled).toBe(true);
    const text = all.get(made[3]!)!;
    expect((text.components.find((c) => c.type === 'Text')!.props as { content: string }).content).toBe('Hi there');
    // The circle sits where the SVG drew it: the layer box maps the 120×80 viewport.
    const svgBox = { w: 120, h: 80 };
    const t = circle.components.find((c) => c.type === 'Transform')!.props as { x: number; y: number };
    const lt = group.components.find((c) => c.type === 'Transform')!.props as { width: number; height: number };
    expect(t.x).toBeCloseTo((60 - svgBox.w / 2) * (lt.width / svgBox.w), 6);
    expect(t.y).toBeCloseTo((40 - svgBox.h / 2) * (lt.height / svgBox.h), 6);
    unwrap(await client.execute({ type: 'undo' }));
    expect((await nodes()).has(svg)).toBe(true);
  });

  it('Convert to Editable Text: text layers over the SVG, which stops drawing its text', async () => {
    const comp = unwrap(await client.execute({ type: 'createComposition', settings: { name: 'SvgText' }, fromItems: [] })).item;
    const svg = await svgLayer(comp);
    const made = unwrap(await client.execute({ type: 'convertLayer', layer: svg, conversion: 'editableText' })).layers;
    expect(await lastLabel()).toBe('Convert to Editable Text');
    expect(made).toHaveLength(2);
    const all = await nodes();
    expect(all.has(svg)).toBe(true);
    expect(JSON.stringify(all.get(svg)!.components)).toContain('display: none');
  });

  it('refuses a conversion the layer kind has none of', async () => {
    const comp = unwrap(await client.execute({ type: 'createComposition', settings: { name: 'Refuse' }, fromItems: [] })).item;
    const solid = unwrap(await client.execute({ type: 'createLayer', comp, kind: 'solid', init: [] })).layer;
    const r = await client.execute({ type: 'convertLayer', layer: solid, conversion: 'uncompose' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalidArgument');
  });
});
