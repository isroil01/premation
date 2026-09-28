/**
 * Rig Logo for Animation on the REAL engine (the `rigLogo` job,
 * native/engine/src/jobs/kind_rig_logo.cpp):
 *   rasterize  two solids drawn alone TOGETHER by a child engine (GPU),
 *              cropped to what drew, imported as a PNG and placed as one image
 *              layer where they were, above them, with the starter pins — one
 *              history entry.
 *   self       one shape layer: the pins land on it, nothing is imported.
 *
 * Skipped, saying so, when the full engine is not built.
 */

import { ProcessEngineClient, unwrap, type EngineClient, type EventBatch, type JobInfo } from '@motion/engine-api';
import { nativeEngineExe, startNativeEngine, type NativeEngine } from '../__testHelpers__/nativeEngine';

jest.setTimeout(180_000);

const exe = nativeEngineExe();
const full = !!exe && !/headless/i.test(exe);
if (!full) console.log('[rigLogo native] the full premation-engine is not built — skipped');
const maybe = full ? describe : describe.skip;

async function runJob(client: EngineClient, job: unknown): Promise<{ job: JobInfo; error?: { code: string; message: string } }> {
  const started = unwrap(await client.execute({ type: 'startJob', job, apply: true } as never)) as unknown as { job: string };
  return new Promise((resolve) => {
    const off = client.subscribe((b: EventBatch) => {
      for (const e of b.events) {
        if (e.type === 'jobFinished' && e.job.id === started.job) {
          off();
          resolve({ job: e.job, ...(e.error ? { error: e.error } : {}) });
        }
      }
    });
  });
}

async function pinsOf(client: EngineClient, layer: string): Promise<Array<{ name: string; y: number }>> {
  const tree = unwrap(await client.query({ type: 'getPropertyTree', layer, path: 'puppet/pins', depth: 2 } as never)) as unknown as {
    nodes: Array<{ path: string; name: string }>;
  };
  const pins = tree.nodes.filter((n) => /^puppet\/pins\/[^/]+$/.test(n.path));
  const out: Array<{ name: string; y: number }> = [];
  for (const p of pins) {
    const v = unwrap(await client.query({ type: 'getPropertyValues', props: [{ layer, path: `${p.path}/restPosition` }], time: 0, evaluated: false } as never)) as unknown as {
      values: Array<{ value: { value: { x: number; y: number } } }>;
    };
    out.push({ name: p.name, y: v.values[0]!.value.value.y });
  }
  return out;
}

const vec2 = (x: number, y: number) => ({ kind: 'vec2', value: { x, y } });

maybe('Rig Logo for Animation (engine job)', () => {
  let native: NativeEngine;
  let client: EngineClient;

  beforeAll(async () => {
    native = await startNativeEngine();
    const c = new ProcessEngineClient(native.bridge);
    await c.whenReady();
    client = c;
  });
  afterAll(async () => {
    await native?.stop();
  });

  it('rasterizes a multi-layer selection into one rigged image layer where it drew', async () => {
    const comp = unwrap(await client.execute({ type: 'createComposition', settings: { name: 'Logo', width: 320, height: 180 }, fromItems: [] } as never)) as unknown as { item: string };
    // Two solids at a quarter of the comp (80 x 45), side by side.
    const left = (unwrap(await client.execute({
      type: 'createLayer', comp: comp.item, kind: 'solid', name: 'Mark', init: [{ path: 'transform/position', value: vec2(100, 90) }, { path: 'transform/scale', value: vec2(25, 25) }],
    } as never)) as unknown as { layer: string }).layer;
    const right = (unwrap(await client.execute({
      type: 'createLayer', comp: comp.item, kind: 'solid', name: 'Word', init: [{ path: 'transform/position', value: vec2(220, 90) }, { path: 'transform/scale', value: vec2(25, 25) }],
    } as never)) as unknown as { layer: string }).layer;
    const before = unwrap(await client.query({ type: 'getHistory' } as never)) as unknown as { entries: unknown[] };

    const done = await runJob(client, { kind: 'rigLogo', value: { layers: [left, right], time: 0 } });
    if (done.error?.code === 'unsupported') {
      console.log(`[rigLogo native] skipped: ${done.error.message}`);
      return;
    }
    expect(done.error).toBeUndefined();
    const result = JSON.parse(done.job.result) as { mode: string; layer: string; width: number; height: number };
    expect(result.mode).toBe('rasterize');
    // The two solids span x 60…260, y 67.5…112.5; + 4 px each side.
    expect(Math.abs(result.width - 208)).toBeLessThanOrEqual(2);
    expect(Math.abs(result.height - 53)).toBeLessThanOrEqual(2);

    const after = unwrap(await client.query({ type: 'getHistory' } as never)) as unknown as { entries: Array<{ label: string }> };
    expect(after.entries.length).toBe(before.entries.length + 1);
    expect(after.entries[after.entries.length - 1]!.label).toBe('Rig Logo for Animation');

    const layers = unwrap(await client.query({ type: 'getLayers', layers: [result.layer] } as never)) as unknown as { layers: Array<{ name: string; kind: string }> };
    expect(layers.layers[0]).toMatchObject({ name: 'Mark (Rigged)', kind: 'image' });
    const bounds = unwrap(await client.query({ type: 'getLayerBounds', layers: [result.layer], time: 0, space: 'comp', includeEffects: false } as never)) as unknown as {
      bounds: Array<{ bounds: { x: number; y: number; width: number; height: number } }>;
    };
    const b = bounds.bounds[0]!.bounds;
    expect(Math.abs(b.x + b.width / 2 - 160)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(b.y + b.height / 2 - 90)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(b.width - result.width)).toBeLessThanOrEqual(1);

    const pins = await pinsOf(client, result.layer);
    expect(pins.map((p) => p.name)).toEqual(['Anchor', 'Wave']);
    expect(pins[0]!.y).toBeCloseTo(result.height / 2, 5);
    expect(pins[1]!.y).toBeCloseTo(-result.height / 2, 5);

    // Undo takes the whole thing back: the layer, the pins, the import.
    unwrap(await client.execute({ type: 'undo' } as never));
    const gone = await client.query({ type: 'getLayers', layers: [result.layer] } as never);
    expect(gone.ok && (gone.value as unknown as { layers: unknown[] }).layers.length > 0).toBe(false);
  });

  it('rigs one shape layer in place', async () => {
    const comp = unwrap(await client.execute({ type: 'createComposition', settings: { name: 'Shape', width: 320, height: 180 }, fromItems: [] } as never)) as unknown as { item: string };
    const shape = (unwrap(await client.execute({ type: 'createLayer', comp: comp.item, kind: 'rectangle', name: 'Box', init: [] } as never)) as unknown as { layer: string }).layer;
    const done = await runJob(client, { kind: 'rigLogo', value: { layers: [shape] } });
    expect(done.error).toBeUndefined();
    expect(JSON.parse(done.job.result)).toEqual({ mode: 'self', layer: shape });
    const pins = await pinsOf(client, shape);
    expect(pins.map((p) => p.name)).toEqual(['Anchor', 'Wave']);
    expect(pins[0]!.y).toBeGreaterThan(0);
    expect(pins[1]!.y).toBeCloseTo(-pins[0]!.y, 5);
  });

  it('refuses layers from different compositions', async () => {
    const a = unwrap(await client.execute({ type: 'createComposition', settings: { name: 'A', width: 64, height: 64 }, fromItems: [] } as never)) as unknown as { item: string };
    const b = unwrap(await client.execute({ type: 'createComposition', settings: { name: 'B', width: 64, height: 64 }, fromItems: [] } as never)) as unknown as { item: string };
    const la = (unwrap(await client.execute({ type: 'createLayer', comp: a.item, kind: 'solid', init: [] } as never)) as unknown as { layer: string }).layer;
    const lb = (unwrap(await client.execute({ type: 'createLayer', comp: b.item, kind: 'solid', init: [] } as never)) as unknown as { layer: string }).layer;
    const res = await client.execute({ type: 'startJob', job: { kind: 'rigLogo', value: { layers: [la, lb] } }, apply: true } as never);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(/different compositions/);
  });
});
