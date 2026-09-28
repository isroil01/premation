/**
 * getTimelineRows (B4 round 8) answers the SAME row projection in both engines:
 * the same scene is built in the TypeScript engine and the real C++ engine and
 * every layer's rows compared field by field — shape, text (with an animator),
 * solid with an effect and a mask, null, camera, a 3D layer, a paint stroke,
 * a keyed stroke Path.
 *
 * Skipped, saying so, when the engine is not built.
 */

import { ProcessEngineClient, unwrap, type Command, type EngineClient, type TimelineRowSet } from '@motion/engine-api';
import { nativeEngineExe, startNativeEngine, type NativeEngine } from '@core/engine/__testHelpers__/nativeEngine';
import { setupEngine, sec, type Harness } from '@core/engine/__testHelpers__/harness';

jest.setTimeout(120_000);

const exe = nativeEngineExe();
if (!exe) console.log('[getTimelineRows native] premation-engine is not built — skipped');
const maybe = exe ? describe : describe.skip;

type Run = (cmd: Command) => Promise<unknown>;

/** The scene, through either engine's command path. Returns the layer ids in creation order. */
async function build(run: Run): Promise<string[]> {
  const comp = 'comp_root';
  const mk = async (kind: string, name: string): Promise<string> =>
    ((await run({ type: 'createLayer', comp, kind, name, init: [] } as Command)) as { layer: string }).layer;
  const shape = await mk('shape', 'Shape');
  const text = await mk('text', 'Text');
  const solid = await mk('solid', 'Solid');
  const nul = await mk('null', 'Null');
  const cam = await mk('camera', 'Camera');
  const threeD = await mk('solid', 'ThreeD');
  await run({ type: 'addEffect', layers: [solid], effect: 'glow', params: [] } as Command);
  await run({
    type: 'addMask', layer: solid, mode: 'add', inverted: false,
    path: { vertices: [0, 0, 100, 0, 100, 100, 0, 100], inTangents: [], outTangents: [], closed: true, featherPoints: [], vertexStates: [] },
  } as Command);
  await run({ type: 'addPropertyGroup', layer: text, parent: 'text/animators', matchName: 'ADBE Text Animator', init: [] } as Command);
  await run({ type: 'setLayerSwitches', layers: [threeD], patch: { threeD: true } } as Command);
  await run({ type: 'addKeyframes', keys: [0, 1].map((t) => ({ prop: { layer: shape, path: 'transform/scale' }, time: sec(t), value: { kind: 'vec2', value: { x: 100 + t, y: 100 } }, spatialIn: [], spatialOut: [] })) } as Command);
  await run({ type: 'addPaintStroke', layer: solid, stroke: JSON.stringify({ points: [{ x: 0, y: 0 }, { x: 5, y: 5 }] }), keys: [] } as Command);
  return [shape, text, solid, nul, cam, threeD];
}

maybe('getTimelineRows in both engines', () => {
  let native: NativeEngine;
  let client: EngineClient;
  let h: Harness;

  beforeAll(async () => {
    native = await startNativeEngine({ extraArgs: ['--no-gpu'] });
    const c = new ProcessEngineClient(native.bridge);
    await c.whenReady();
    client = c;
    h = await setupEngine();
  });
  afterAll(async () => {
    await native?.stop();
    await h?.dispose();
  });

  it('answers the same rows for every layer', async () => {
    unwrap(await client.execute({ type: 'newProject' } as Command));
    const tsIds = await build((cmd) => h.run(cmd as never));
    const cppIds = await build(async (cmd) => unwrap(await client.execute(cmd)));
    const ts = (await h.query({ type: 'getTimelineRows', layers: tsIds })).sets;
    const cpp = unwrap(await client.query({ type: 'getTimelineRows', layers: cppIds })).sets;
    const strip = (sets: TimelineRowSet[]) => sets.map((s) => s.rows);
    expect(cpp).toHaveLength(tsIds.length);
    expect(strip(cpp)).toEqual(strip(ts));
    // Unknown ids answer no set.
    expect(unwrap(await client.query({ type: 'getTimelineRows', layers: ['nope'] })).sets).toEqual([]);
  });
});
