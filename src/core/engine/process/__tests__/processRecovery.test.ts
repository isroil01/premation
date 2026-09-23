/**
 * The process backend against the REAL premation-engine (C3): kill the engine
 * process mid-session → the supervisor restarts it → ProcessEngineClient
 * replays its command log → the document, the revision and the undo stack
 * come back exactly; three crashes inside the crash window → the TypeScript
 * engine takes over with ONE notice.
 *
 * Skips (saying so) when the engine has not been built.
 */

import { ProcessEngineClient, unwrap, type EngineClient, type ProcessEngineNotice } from '@motion/engine-api';
import { nativeEngineExe, startNativeEngine, type NativeEngine } from '../../__testHelpers__/nativeEngine';
import { setupEngine, sec, type Harness } from '../../__testHelpers__/harness';

jest.useFakeTimers();

const describeNative = nativeEngineExe() ? describe : describe.skip;

const waitFor = async (pred: () => boolean, ms = 15_000): Promise<void> => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise<void>((r) => jest.requireActual<typeof import('timers')>('timers').setTimeout(r, 20));
  }
};

async function snapshot(c: EngineClient, comp: string) {
  const doc = unwrap(await c.query({ type: 'getDocument', includeProperties: true, includeKeyframes: true }));
  const hist = unwrap(await c.query({ type: 'getHistory' }));
  const layers = unwrap(await c.query({ type: 'getComposition', comp })).comp.layers;
  const values = unwrap(await c.query({ type: 'getPropertyValues', props: layers.flatMap((l) => ['transform/position', 'transform/scale', 'transform/opacity'].map((path) => ({ layer: l, path }))), time: sec(0.5), evaluated: true }));
  return { layers: doc.layers, comps: doc.comps, history: { labels: hist.entries.map((e) => e.label), position: hist.position }, values: values.values };
}

describeNative('C3: the process backend recovers from engine crashes', () => {
  let native: NativeEngine | null = null;
  let client: ProcessEngineClient | null = null;
  let fallback: Harness | null = null;

  afterEach(async () => {
    await client?.close();
    await native?.stop();
    await fallback?.dispose();
    native = null;
    client = null;
    fallback = null;
  });

  it('a killed engine comes back with the whole document, by log replay', async () => {
    native = await startNativeEngine();
    const notices: ProcessEngineNotice[] = [];
    client = new ProcessEngineClient(native.bridge, { onNotice: (n) => notices.push(n) });
    await client.whenReady();
    const c = client;
    const { item: comp } = unwrap(await c.execute({ type: 'createComposition', settings: { name: 'Crash', width: 640, height: 360 }, fromItems: [] }));
    const { layer: a } = unwrap(await c.execute({ type: 'createLayer', comp, kind: 'solid', name: 'A', init: [] }));
    const { layer: b } = unwrap(await c.execute({ type: 'createLayer', comp, kind: 'rectangle', name: 'B', init: [] }));
    const { gesture } = unwrap(await c.execute({ type: 'beginGesture', label: 'Drag' }));
    for (let i = 0; i < 10; i++) unwrap(await c.execute({ type: 'setProperty', prop: { layer: b, path: 'transform/position' }, value: { kind: 'vec2', value: { x: 100 + i * 20, y: 90 } } }));
    unwrap(await c.execute({ type: 'endGesture', gesture, commit: true }));
    unwrap(await c.execute({ type: 'addKeyframes', keys: [0, 1].map((i) => ({ prop: { layer: a, path: 'transform/scale' }, time: sec(i), value: { kind: 'vec2' as const, value: { x: 100 + 50 * i, y: 100 } }, spatialIn: [], spatialOut: [] })) }));
    unwrap(await c.execute({ type: 'setProperty', prop: { layer: a, path: 'transform/opacity' }, value: { kind: 'scalar', value: 40 } }));
    unwrap(await c.execute({ type: 'undo' }));
    unwrap(await c.execute({ type: 'setActiveComposition', comp }));
    const before = await snapshot(c, comp);
    const revBefore = c.revision;
    const pidBefore = native.pid();

    native.kill();
    await waitFor(() => notices.length > 0);
    expect(native.pid()).not.toBe(pidBefore);
    expect(notices[0]).toMatchObject({ kind: 'restarted', cause: 'crash', mismatches: 0 });
    const after = await snapshot(c, comp);
    expect(after).toEqual(before);
    expect(c.revision).toBe(revBefore);
    // …and it keeps working: redo the undone opacity edit on the NEW process.
    const redo = unwrap(await c.execute({ type: 'redo' }));
    expect(redo.label).toBeTruthy();
    const op = unwrap(await c.query({ type: 'getPropertyValues', props: [{ layer: a, path: 'transform/opacity' }], time: 0, evaluated: true }));
    expect(op.values[0]!.value).toEqual({ kind: 'scalar', value: 40 });
    console.log(`[C3] engine killed → restarted, ${notices[0]!.kind === 'restarted' ? `${notices[0]!.replayed} requests replayed in ${notices[0]!.ms} ms` : ''}`);
  }, 60_000);

  it('three crashes inside the window → the TypeScript engine, one notice', async () => {
    native = await startNativeEngine({ backoffMs: [50, 50, 50] });
    fallback = await setupEngine();
    const notices: ProcessEngineNotice[] = [];
    const fb = fallback.engine;
    client = new ProcessEngineClient(native.bridge, { onNotice: (n) => notices.push(n), fallback: () => fb });
    await client.whenReady();
    unwrap(await client.execute({ type: 'createComposition', settings: { name: 'X' }, fromItems: [] }));
    for (let i = 1; i <= 3; i++) {
      native.kill();
      await waitFor(() => notices.length >= i);
    }
    expect(notices.map((n) => n.kind)).toEqual(['restarted', 'restarted', 'fallback']);
    expect(client.backend).toBe('fallback');
    // Requests now land on the TypeScript engine (its ids, its document).
    const r = unwrap(await client.execute({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name: 'on TS', init: [] }));
    expect(r.layer).toMatch(/^layer_/);
    expect(native.supervisor.state).toBe('fallback');
  }, 60_000);
});
