/**
 * poseIk3D / bakeIk3D (B4 round 8) in both engines: the same 3D chain and
 * animated target built in the TypeScript engine and the real C++ engine, the
 * joints' solved rotations compared (the C++ solver is a port of boneIK3d.ts;
 * the maths is the same, so the angles agree to well under a thousandth of a
 * degree), and each command is one history entry.
 *
 * Skipped, saying so, when the engine is not built.
 */

import { ProcessEngineClient, unwrap, type Command, type EngineClient, type PropRef } from '@motion/engine-api';
import { nativeEngineExe, startNativeEngine, type NativeEngine } from '@core/engine/__testHelpers__/nativeEngine';
import { setupEngine, sec, type Harness } from '@core/engine/__testHelpers__/harness';

jest.setTimeout(120_000);

const exe = nativeEngineExe();
if (!exe) console.log('[IK native] premation-engine is not built — skipped');
const maybe = exe ? describe : describe.skip;

type Run = (cmd: Command) => Promise<unknown>;
type Query = <T>(q: object) => Promise<T>;

async function rig(run: Run): Promise<{ chain: string[]; target: string }> {
  const mk = async (name: string, x: number, y = 0): Promise<string> => {
    const { layer } = (await run({ type: 'createLayer', comp: 'comp_root', kind: 'null', name, init: [] } as Command)) as { layer: string };
    await run({ type: 'setLayerSwitches', layers: [layer], patch: { threeD: true } } as Command);
    await run({ type: 'setProperty', prop: { layer, path: 'transform/position' }, value: { kind: 'vec3', value: { x, y, z: 0 } } } as Command);
    return layer;
  };
  const root = await mk('Root', 100);
  const elbow = await mk('Elbow', 200);
  const tip = await mk('Tip', 300);
  await run({ type: 'setParent', layers: [elbow], parent: root, keepWorldTransform: true } as Command);
  await run({ type: 'setParent', layers: [tip], parent: elbow, keepWorldTransform: true } as Command);
  const target = await mk('Target', 160, 90);
  await run({
    type: 'addKeyframes',
    keys: [0, 1].map((t) => ({ prop: { layer: target, path: 'transform/position' }, time: sec(t), value: { kind: 'vec3', value: { x: 160 + 40 * t, y: 90 + 60 * t, z: 20 * t } }, spatialIn: [], spatialOut: [] })),
  } as Command);
  return { chain: [root, elbow, tip], target };
}

/** Every rotation track of the chain's joints (values of the static props and every key), in a fixed order. */
async function rotations(query: Query, chain: string[]): Promise<number[]> {
  const out: number[] = [];
  for (const layer of chain.slice(0, -1)) {
    const tree = await query<{ nodes: Array<{ path: string; matchName: string }> }>({ type: 'getPropertyTree', layer, path: 'transform', depth: 2 });
    const refs: PropRef[] = tree.nodes.filter((n) => /Rotat/i.test(n.matchName) && !/Orient/i.test(n.matchName)).map((n) => ({ layer, path: n.path }));
    const values = await query<{ values: Array<{ value: { kind: string; value: number } }> }>({ type: 'getPropertyValues', props: refs, time: sec(0.5), evaluated: false });
    for (const v of values.values) out.push(v.value.value);
    const keys = await query<{ sets: Array<{ keyframes: Array<{ value: { value: number } }> }> }>({ type: 'getKeyframes', props: refs });
    for (const s of keys.sets) for (const k of s.keyframes) out.push(k.value.value);
  }
  return out;
}

maybe('3D IK in both engines', () => {
  let native: NativeEngine;
  let client: EngineClient;
  let h: Harness;

  beforeEach(async () => {
    native = await startNativeEngine({ extraArgs: ['--no-gpu'] });
    const c = new ProcessEngineClient(native.bridge);
    await c.whenReady();
    client = c;
    unwrap(await client.execute({ type: 'newProject' } as Command));
    h = await setupEngine();
  });
  afterEach(async () => {
    await native?.stop();
    await h?.dispose();
  });

  const tsQuery: Query = async <T>(q: object) => (await h.query(q as never)) as T;
  const cppQuery: Query = async <T>(q: object) => unwrap(await client.query(q as never)) as T;

  it('poseIk3D solves the same joint rotations', async () => {
    const ts = await rig((cmd) => h.run(cmd as never));
    const cpp = await rig(async (cmd) => unwrap(await client.execute(cmd)));
    await h.run({ type: 'poseIk3D', chain: ts.chain, target: ts.target, time: sec(0.5) } as never);
    unwrap(await client.execute({ type: 'poseIk3D', chain: cpp.chain, target: cpp.target, time: sec(0.5) } as Command));
    const a = await rotations(tsQuery, ts.chain);
    const b = await rotations(cppQuery, cpp.chain);
    expect(b).toHaveLength(a.length);
    expect(a.some((v) => Math.abs(v) > 1)).toBe(true);
    b.forEach((v, i) => expect(v).toBeCloseTo(a[i]!, 3));
  });

  it('bakeIk3D bakes the same keys, one per frame, as one entry', async () => {
    const ts = await rig((cmd) => h.run(cmd as never));
    const cpp = await rig(async (cmd) => unwrap(await client.execute(cmd)));
    const range = { start: 0, duration: sec(0.5) };
    const r1 = (await h.run({ type: 'bakeIk3D', chain: ts.chain, target: ts.target, range } as never)) as { frames: number };
    const before = unwrap(await client.query({ type: 'getHistory' } as never)) as { entries: unknown[] };
    const r2 = unwrap(await client.execute({ type: 'bakeIk3D', chain: cpp.chain, target: cpp.target, range } as Command)) as { frames: number };
    const after = unwrap(await client.query({ type: 'getHistory' } as never)) as { entries: Array<{ label: string }> };
    expect(r2.frames).toBe(r1.frames);
    expect(after.entries.length).toBe(before.entries.length + 1);
    expect(after.entries.at(-1)?.label).toBe('Bake 3D IK');
    const a = await rotations(tsQuery, ts.chain);
    const b = await rotations(cppQuery, cpp.chain);
    expect(b).toHaveLength(a.length);
    expect(a.length).toBeGreaterThan(6 * 2);
    b.forEach((v, i) => expect(v).toBeCloseTo(a[i]!, 3));
  });
});
