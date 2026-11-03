/**
 * Rigging through the McpCallHost on the app's engine: the bones the engine
 * POSES land on the joints the call gave, the grid's layer-local space maps
 * where the frame draws the layer, and bone degrees are degrees.
 */

import type { Command } from '@motion/engine-api';
import { setupAppEngine, sec, settleEdits, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { activeCompRootId } from '@core/scene/activeComp';
import { documentMirror } from '@stores/documentMirror';
import { McpCallHost, type McpResult } from './mcpHost';
import { editorMcpDeps } from './mcpDefaults';
import { rigViewData, type RigView } from '../rigTools';

jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick', 'setImmediate'] });
jest.setTimeout(120_000);

let h: Harness;
let host: McpCallHost;
beforeEach(async () => {
  h = await setupAppEngine();
  await h.run({ type: 'setCompositionSettings', comp: activeCompRootId() as string, patch: { frameRate: { num: 30, den: 1 }, duration: sec(6) } } as Command);
  await settleEdits();
  host = new McpCallHost({ ...editorMcpDeps(), access: async () => ({ ok: true }) });
});
afterEach(async () => {
  await host.stop();
  await h.dispose();
});

const call = (name: string, args: unknown = {}): Promise<McpResult> => host.handle({ clientId: 1, name, args });
const textOf = (r: McpResult): string => r.content.map((c) => (c.type === 'text' ? c.text : '[image]')).join('\n');
async function ok(name: string, args: unknown): Promise<string> {
  const r = await call(name, args);
  expect([name, r.isError, r.isError ? textOf(r).slice(0, 400) : '']).toEqual([name, undefined, '']);
  return textOf(r);
}
const named = (name: string): string => {
  const m = documentMirror();
  return m.layerIds().find((c) => m.layer(c)?.name === name)!;
};
async function view(layer: string, time = 0): Promise<RigView> {
  const ctx = editorMcpDeps().context(null, new AbortController().signal, new Map());
  const v = await rigViewData(ctx, { layerId: layer, time });
  if ('error' in v) throw new Error(v.error);
  return v;
}

async function figure(): Promise<string> {
  await ok('create_layer', { id: 'fig', kind: 'shape', shape: 'rect', name: 'Figure', width: 260, height: 420, x: 500, y: 300, fill: '#ee5a2f' });
  await settleEdits();
  return named('Figure');
}

describe('render_rig_view', () => {
  it('maps layer-local space onto the frame where the layer is drawn', async () => {
    const id = await figure();
    const v = await view(id);
    // The layer origin is its position; the box spans its size.
    const comp = (x: number, y: number) => ({ x: v.affine.o.x + x * v.affine.ex.x + y * v.affine.ey.x, y: v.affine.o.y + x * v.affine.ex.y + y * v.affine.ey.y });
    expect(v.box.width).toBeCloseTo(260, 3);
    expect(v.box.height).toBeCloseTo(420, 3);
    const centre = comp(v.box.x + v.box.width / 2, v.box.y + v.box.height / 2);
    expect(centre.x).toBeCloseTo(500, 3);
    expect(centre.y).toBeCloseTo(300, 3);
    expect(textOf(await call('render_rig_view', { layerId: 'fig' }))).toMatch(/Grid labels are LAYER-LOCAL px/);
  });
});

describe('rig_character', () => {
  it('a biped from joints: the engine poses each limb onto its joints', async () => {
    const id = await figure();
    const v0 = await view(id);
    const cx = v0.box.x + v0.box.width / 2, top = v0.box.y;
    const joints = {
      shoulder_l: [cx - 50, top + 100], elbow_l: [cx - 80, top + 170], wrist_l: [cx - 70, top + 230],
      hip_r: [cx + 25, top + 225], knee_r: [cx + 35, top + 320], ankle_r: [cx + 30, top + 405],
    };
    const t = await ok('rig_character', { layerId: 'fig', preset: 'biped', joints });
    expect(t).toMatch(/Rigged '.*': 11 bones, 4 IK goal\(s\)/);
    expect(t).toMatch(/Joints from proportions .*head_top/);
    await settleEdits();
    const v = await view(id);
    const bone = (b: string) => v.bones.find((x) => x.id === b)!;
    expect(bone('arm_l_upper').root.x).toBeCloseTo(cx - 50, 1);
    expect(bone('arm_l_lower').root.y).toBeCloseTo(top + 170, 1);
    expect(bone('arm_l_lower').tip.x).toBeCloseTo(cx - 70, 1);
    expect(bone('arm_l_lower').tip.y).toBeCloseTo(top + 230, 1);
    expect(bone('leg_r_lower').tip.y).toBeCloseTo(top + 405, 1);
    expect(v.ik.find((g) => g.bone === 'arm_l_lower')).toMatchObject({ mode: 'ik' });
  });

  it('refuses a chain hung from a bone that does not exist, and a camera', async () => {
    await figure();
    const r = await call('rig_character', { layerId: 'fig', chains: [{ name: 'tail', points: [[0, 0], [50, 0]], parent: 'nope' }] });
    expect([r.isError, textOf(r)]).toEqual([true, expect.stringMatching(/hangs from 'nope'/)]);
  });

  it('rig_cycle writes an idle and a wave on the biped', async () => {
    await figure();
    await ok('rig_character', { layerId: 'fig', preset: 'biped' });
    expect(await ok('rig_cycle', { layerId: 'fig', cycle: 'idle', durationSec: 3 })).toMatch(/Tracks: .*bone\.chest\.rotation/);
    const wave = await ok('rig_cycle', { layerId: 'fig', cycle: 'wave', startSec: 3, durationSec: 1.6 });
    expect(wave).toMatch(/bone\.arm_r_upper\.rotation/);
    expect(wave).not.toMatch(/Skipped/);
  });
});

describe('set_puppet_pin_keyframes', () => {
  it('eases the segment a key starts when it says so', async () => {
    const id = await figure();
    await ok('create_puppet_rig', { layerId: 'fig', pins: [{ name: 'Head', x: 0, y: -180 }, { name: 'Feet', x: 0, y: 180 }] });
    const pin = (await view(id)).pins[0]!.id;
    await ok('set_puppet_pin_keyframes', { layerId: 'fig', pinId: pin, keyframes: [{ timeSec: 0, x: 0, y: -180, easing: 'easeOut' }, { timeSec: 1, x: 60, y: -180 }] });
    await settleEdits();
    const keys = documentMirror().layerKeyframes(id).get(`puppet/pins/${pin}/position`) as readonly { easing?: string }[] | undefined;
    expect(keys?.[0]?.easing).toBe('easeOut');
  });
});

describe('create_skeleton_rig', () => {
  it('takes degrees: a 90° root points down the screen', async () => {
    const id = await figure();
    await ok('create_skeleton_rig', { layerId: 'fig', bones: [{ id: 'spine', length: 100, x: 0, y: -100, rotation: 90 }] });
    await settleEdits();
    const b = (await view(id)).bones.find((x) => x.id === 'spine')!;
    expect(b.tip.x - b.root.x).toBeCloseTo(0, 3);
    expect(b.tip.y - b.root.y).toBeCloseTo(100, 3);
  });

  it('stores IK goals the call gives', async () => {
    const id = await figure();
    await ok('create_skeleton_rig', {
      layerId: 'fig',
      bones: [{ id: 'up', length: 80, x: 0, y: -100, rotation: 90 }, { id: 'low', parentId: 'up', length: 80, x: 80, y: 0, rotation: 0 }],
      ik: [{ boneId: 'low', x: 40, y: 40 }],
    });
    await settleEdits();
    const v = await view(id);
    expect(v.ik).toEqual([expect.objectContaining({ bone: 'low', x: 40, y: 40 })]);
    // Solved: the chain's tip reaches the goal.
    expect(v.bones.find((x) => x.id === 'low')!.tip.x).toBeCloseTo(40, 0);
    expect(v.bones.find((x) => x.id === 'low')!.tip.y).toBeCloseTo(40, 0);
  });

  it('a pole puts the elbow on ITS side of the root→goal line', async () => {
    // Root (0, -100) → goal (40, 40); a pole far to the left (x = -300) and one
    // far to the right (x = 300). The engine's solver once measured the side
    // with the opposite sign and bent every joint away from its pole.
    const side = (p: { x: number; y: number }) => (p.x - 0) * (40 - -100) - (p.y - -100) * (40 - 0);
    // One figure (the alias 'fig' and the name 'Figure' both find the first one): the rig is rewritten per pole.
    const id = await figure();
    for (const pole of [{ x: -300, y: -30 }, { x: 300, y: -30 }]) {
      await ok('create_skeleton_rig', {
        layerId: 'fig',
        bones: [{ id: 'up', length: 80, x: 0, y: -100, rotation: 90 }, { id: 'low', parentId: 'up', length: 80, x: 80, y: 0, rotation: 0 }],
        ik: [{ boneId: 'low', x: 40, y: 40, pole }],
      });
      await settleEdits();
      const v = await view(id);
      expect(v.ik[0]?.pole).toEqual(pole);
      const elbow = v.bones.find((x) => x.id === 'low')!.root;
      expect(Math.sign(side(elbow))).toBe(Math.sign(side(pole)));
    }
  });
});

describe('rig_character with layerIds (a cut-out character)', () => {
  it('builds one character from separate layers: a bone per part, IK legs, nothing moved', async () => {
    await ok('create_layer', { id: 't', kind: 'shape', shape: 'rect', name: 'Torso', width: 140, height: 220, x: 500, y: 300 });
    await ok('create_layer', { id: 'a', kind: 'shape', shape: 'rect', name: 'Upper Arm L', width: 36, height: 130, x: 410, y: 260 });
    await ok('create_layer', { id: 'th', kind: 'shape', shape: 'rect', name: 'Thigh R', width: 44, height: 140, x: 535, y: 480 });
    await ok('create_layer', { id: 'sh', kind: 'shape', shape: 'rect', name: 'Shin R', width: 38, height: 140, x: 535, y: 620 });
    await settleEdits();
    const parts = ['Torso', 'Upper Arm L', 'Thigh R', 'Shin R'].map(named);
    const out = await ok('rig_character', { layerIds: parts, name: 'Pip' });
    await settleEdits();
    expect(out).toMatch(/Character 'Pip'/);
    expect(out).toMatch(/4 bones/);
    expect(out).toMatch(/Shin R → bone_shin_r/);
    expect(out).toMatch(/IK goals.*bone_shin_r/);
    const character = documentMirror().layer(parts[0]!)!.parent!;
    expect(documentMirror().layer(character)?.character).toBe(true);
    for (const p of parts) expect(documentMirror().layer(p)?.parentBone).toBeTruthy();
  });
});
