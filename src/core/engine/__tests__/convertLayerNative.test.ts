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
    const made = unwrap(await client.execute({ type: 'convertLayer', layer: text, conversion: 'shapesFromText' })).layers;
    expect(made).toHaveLength(1);
    expect(await lastLabel()).toBe('Create Shapes from Text');
    let all = await nodes();
    const shape = all.get(made[0]!)!;
    expect(shape.name).toBe('OK Outlines (traced)');
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

  it('refuses what it does not convert yet, naming why', async () => {
    const comp = unwrap(await client.execute({ type: 'createComposition', settings: { name: 'Refuse' }, fromItems: [] })).item;
    const solid = unwrap(await client.execute({ type: 'createLayer', comp, kind: 'solid', init: [] })).layer;
    const r = await client.execute({ type: 'convertLayer', layer: solid, conversion: 'uncompose' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('unsupported');
  });
});
