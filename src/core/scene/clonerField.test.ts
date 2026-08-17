/**
 * Layer-driven fields — a cloner reacting to another layer's position.
 *
 * This is the piece that makes a cloner feel alive rather than static: park a
 * null in a grid, animate it across, and the clones react as it passes. Two
 * things have to be right for that, and both fail quietly:
 *
 *  • the field must be measured in the CLONER's frame, or a rotated cloner
 *    sends its field sliding the wrong way;
 *  • a field pointing at a missing layer must apply NO field, not a zero
 *    weight — zeroing every effector reads as "the cloner broke" and gives the
 *    user nothing to go on.
 */

import defaultSceneGraph from './DefaultSceneGraph';
import { SCENE_KIND_PROP } from './seedDefaultScene';
import { buildSnapshot } from '@core/rendering/buildSnapshot';
import { defaultAnimation } from '@motion/animation';
import { useProjectStore } from '@stores/projectStore';
import { CLONER_PROP } from './clonerExpand';
import { fieldWeight, DEFAULT_CLONER, type ClonerConfig, type ClonerFalloff } from './cloner';
import type { SceneNode } from '@core/types';

const COMP = {
  width: 1920, height: 1080, fps: 30, durationSeconds: 10,
  background: '#000', transparent: false, startFrame: 0,
};

const fo = (p: Partial<ClonerFalloff>): ClonerFalloff => ({ ...DEFAULT_CLONER.falloff, ...p });

function resetScene(): void {
  const ids: string[] = [];
  defaultSceneGraph.traverse((n) => ids.push(n.id));
  for (const id of ids) defaultSceneGraph.removeNode(id);
  defaultAnimation.clear();
}

function addComp(id: string, name: string): void {
  defaultSceneGraph.addNode({
    id, name, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: `${id}_meta`, type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode);
}

function addShape(
  id: string, parent: string,
  opts: { x?: number; y?: number; rotation?: number; cloner?: Partial<ClonerConfig> } = {},
): void {
  defaultSceneGraph.addChild(parent, {
    id, name: id, parent, children: [], visible: true, locked: false,
    transform: { position: { x: opts.x ?? 0, y: opts.y ?? 0 }, rotation: opts.rotation ?? 0, scale: { x: 1, y: 1 } },
    components: [
      {
        id: `${id}_t`, type: 'Transform',
        props: {
          [SCENE_KIND_PROP]: 'shape',
          x: opts.x ?? 0, y: opts.y ?? 0, rotation: opts.rotation ?? 0,
          width: 20, height: 20,
        },
      },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#f00' } },
      {
        id: `${id}_fx`, type: 'fx',
        props: opts.cloner ? { [CLONER_PROP]: { ...DEFAULT_CLONER, enabled: true, ...opts.cloner } } : {},
      },
    ],
  } as never);
}

const snapshot = (): ReturnType<typeof buildSnapshot> =>
  buildSnapshot(defaultSceneGraph, defaultAnimation, 0, undefined, undefined, undefined, undefined, {
    width: 1920, height: 1080, background: '#000', transparent: false, rootId: 'comp_root',
  });

const clones = () => snapshot().layers.filter((l) => l.id.includes('~c'));

beforeEach(() => {
  resetScene();
  addComp('comp_root', 'Main');
  useProjectStore.getState().actions.replaceComps({
    comp_root: { id: 'comp_root', name: 'Main', ...COMP },
  });
  const proj = useProjectStore.getState();
  proj.actions.setActiveTab(proj.actions.openTab('comp_root', ['comp_root'], 'Main'));
});

afterEach(resetScene);

describe('fieldWeight (pure)', () => {
  const f = fo({ shape: 'linear', source: 'layer', radius: 100 });

  it('is full at the centre and zero at the radius', () => {
    expect(fieldWeight({ x: 0, y: 0 }, f, { x: 0, y: 0 })).toBeCloseTo(1, 6);
    expect(fieldWeight({ x: 100, y: 0 }, f, { x: 0, y: 0 })).toBeCloseTo(0, 6);
  });

  it('measures real distance, not one axis', () => {
    // A field that only looked at x would make a null passing above a row
    // affect it as strongly as one passing through it.
    const diag = fieldWeight({ x: 60, y: 80 }, f, { x: 0, y: 0 }); // exactly 100 away
    expect(diag).toBeCloseTo(0, 6);
  });

  it('applies NO field when the driving layer is missing', () => {
    // Not zero. Zeroing every effector looks like the cloner broke; there is
    // nothing on screen to tell the user their driver is gone.
    expect(fieldWeight({ x: 0, y: 0 }, f, null)).toBe(1);
  });

  it('is inert unless the source is `layer`', () => {
    const order = fo({ shape: 'linear', source: 'order', radius: 100 });
    expect(fieldWeight({ x: 999, y: 999 }, order, { x: 0, y: 0 })).toBe(1);
  });

  it('is inert when the shape is none, whatever the source', () => {
    expect(fieldWeight({ x: 999, y: 0 }, fo({ shape: 'none', source: 'layer' }), { x: 0, y: 0 })).toBe(1);
  });

  it('invert flips which clones the field reaches', () => {
    const inv = fo({ shape: 'linear', source: 'layer', radius: 100, invert: true });
    expect(fieldWeight({ x: 0, y: 0 }, inv, { x: 0, y: 0 })).toBeCloseTo(0, 6);
    expect(fieldWeight({ x: 100, y: 0 }, inv, { x: 0, y: 0 })).toBeCloseTo(1, 6);
  });
});

describe('through the renderer', () => {
  /**
   * The effector is RANDOM ROTATION, deliberately.
   *
   * A Step ramp is zero at t=0 by definition, so the first clone never moves
   * and "is this clone affected?" cannot be asked of it — which is exactly the
   * clone a field centred on the start of the row lands on. Random applies to
   * every index, and rotating rather than translating keeps x/y clean so a
   * clone can still be identified by where it sits.
   */
  const withField = (patch: Partial<ClonerConfig> = {}): Partial<ClonerConfig> => ({
    mode: 'linear', count: 3, offsetX: 100, offsetY: 0,
    random: { seed: 4, position: 0, rotation: 90, scale: 0 },
    falloff: fo({ shape: 'linear', source: 'layer', radius: 60, layerId: 'driver' }),
    ...patch,
  });

  /** x of every clone whose rotation the effectors actually reached. */
  const affected = (): number[] =>
    clones().filter((l) => Math.abs(l.rotation) > 0.5).map((l) => Math.round(l.x)).sort((a, b) => a - b);

  it('affects only the clones the driver is near', () => {
    // Cloner at the origin, clones at x = -100, 0, +100. The driver sits on the
    // left clone with a 60px radius, so only that one takes the step offset.
    addShape('cl', 'comp_root', { x: 0, y: 0, cloner: withField() });
    addShape('driver', 'comp_root', { x: -100, y: 0 });
    expect(affected()).toEqual([-100]);
  });

  it('follows the driver when it MOVES', () => {
    // The whole point: animate the null and the reaction travels with it.
    addShape('cl', 'comp_root', { x: 0, y: 0, cloner: withField() });
    addShape('driver', 'comp_root', { x: -100, y: 0 });
    expect(affected()).toEqual([-100]);
    // Move the driver to the far clone.
    defaultAnimation.setKeyframe('driver', 'x', 0, 100);
    expect(affected()).toEqual([100]);
  });

  it('measures in the CLONER’s frame, so a rotated cloner is not fooled', () => {
    // Rotating the cloner 90° turns its local +x into world +y. A field
    // resolved by subtracting world positions would still think the driver sat
    // on the local -x clone; measured properly, the driver directly ABOVE the
    // cloner in world space lands on a local-axis clone instead.
    //
    // Asserted as a difference rather than an absolute: what matters is that
    // rotating the cloner changes WHICH clone reacts.
    addShape('cl', 'comp_root', { x: 0, y: 0, cloner: withField() });
    addShape('driver', 'comp_root', { x: 0, y: -100 });
    // Unrotated: the driver is 100px off the row, outside a 60px radius, so
    // nothing reacts.
    expect(affected()).toEqual([]);

    // Rotate the cloner 90°. The driver has not moved in world space, but it is
    // now on the cloner's local axis — so a clone comes into range. Subtracting
    // world positions would have missed this entirely.
    defaultAnimation.setKeyframe('cl', 'rotation', 0, 90);
    expect(clones().filter((l) => Math.abs(l.rotation - 90) > 0.5).length).toBeGreaterThan(0);
  });

  it('a missing driver leaves the effectors at full strength', () => {
    addShape('cl', 'comp_root', { x: 0, y: 0, cloner: withField({ falloff: fo({ shape: 'linear', source: 'layer', radius: 60, layerId: 'ghost' }) }) });
    // Every clone keeps its random rotation, because there is no field to mask
    // it — rather than all of them being flattened to zero.
    expect(affected()).toHaveLength(3);
  });

  it('the order-based falloff still works alongside', () => {
    addShape('cl', 'comp_root', {
      x: 0, y: 0,
      cloner: withField({ falloff: fo({ shape: 'linear', source: 'order', position: 0, width: 0.4 }) }),
    });
    // Clone 0 sits at the falloff centre, clone 2 outside it — and with no
    // driving layer in the scene at all, proving the order source does not
    // quietly depend on the field resolver.
    expect(affected()).toEqual([-100]);
  });
});
