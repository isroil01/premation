/**
 * Physics reaching the renderer.
 *
 * `rigidBody.test.ts` proves the solver. This proves the two decisions that
 * only show up once it is wired to layers:
 *
 *  • bodies share ONE simulation per composition, so they actually collide —
 *    a cache per layer would simulate each in a world where the others did not
 *    exist, which looks like physics right up until two things pass through
 *    each other;
 *  • physics REPLACES a dynamic body's position rather than offsetting it,
 *    while a STATIC body keeps its own transform and any animation on it.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { buildSnapshot } from '@core/rendering/buildSnapshot';
import { defaultAnimation } from '@motion/animation';
import { useProjectStore } from '@stores/projectStore';
import { usePhysicsStore } from '@stores/physicsStore';
import { PHYSICS_PROP, resetPhysicsCaches } from './physicsBodies';
import { DEFAULT_PHYSICS_BODY, type PhysicsBodyConfig } from './rigidBody';
import type { SceneNode } from '@core/types';

const COMP = {
  width: 800, height: 600, fps: 30, durationSeconds: 10,
  background: '#000', transparent: false, startFrame: 0,
};

function resetScene(): void {
  const ids: string[] = [];
  defaultSceneGraph.traverse((n) => ids.push(n.id));
  for (const id of ids) defaultSceneGraph.removeNode(id);
  defaultAnimation.clear();
  resetPhysicsCaches();
}

function addComp(id: string, name: string): void {
  defaultSceneGraph.addNode({
    id, name, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: `${id}_meta`, type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode);
}

function addBox(id: string, x: number, y: number, phys?: Partial<PhysicsBodyConfig>, size = 40): void {
  defaultSceneGraph.addChild('comp_root', {
    id, name: id, parent: 'comp_root', children: [], visible: true, locked: false,
    transform: { position: { x, y }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x, y, width: size, height: size } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#f00' } },
      {
        id: `${id}_fx`, type: 'fx',
        props: phys ? { [PHYSICS_PROP]: { ...DEFAULT_PHYSICS_BODY, enabled: true, ...phys } } : {},
      },
    ],
  } as never);
}

const at = (t: number): ReturnType<typeof buildSnapshot> =>
  buildSnapshot(defaultSceneGraph, defaultAnimation, t, undefined, undefined, undefined, undefined, {
    width: COMP.width, height: COMP.height, background: '#000', transparent: false, rootId: 'comp_root',
  });

const layer = (t: number, id: string) => at(t).layers.find((l) => l.id === id)!;

beforeEach(() => {
  resetScene();
  addComp('comp_root', 'Main');
  useProjectStore.getState().actions.replaceComps({
    comp_root: { id: 'comp_root', name: 'Main', ...COMP },
  });
  const proj = useProjectStore.getState();
  proj.actions.setActiveTab(proj.actions.openTab('comp_root', ['comp_root'], 'Main'));
  usePhysicsStore.getState().set({ gravityX: 0, gravityY: 2000, useCompBounds: true, iterations: 6 });
});

afterEach(resetScene);

describe('a simulated layer', () => {
  it('stays put at frame 0 — the authored pose IS the start of the history', () => {
    addBox('a', 400, 100, {});
    expect(layer(0, 'a').y).toBeCloseTo(100, 3);
  });

  it('falls over time', () => {
    addBox('a', 400, 100, {});
    expect(layer(1, 'a').y).toBeGreaterThan(layer(0, 'a').y);
  });

  it('lands on the composition floor and stays there', () => {
    addBox('a', 400, 100, { restitution: 0 });
    // Floor at comp height 600, half-height 20.
    const settled = layer(5, 'a').y;
    expect(settled).toBeCloseTo(580, 0);
    expect(layer(8, 'a').y).toBeCloseTo(580, 0);
  });

  it('leaves the shot when the walls are switched off', () => {
    usePhysicsStore.getState().set({ useCompBounds: false });
    addBox('a', 400, 100, {});
    expect(layer(5, 'a').y).toBeGreaterThan(COMP.height);
  });

  it('is unaffected without a physics component', () => {
    addBox('a', 400, 100);
    expect(layer(5, 'a').y).toBeCloseTo(100, 3);
  });

  it('is unaffected when physics is present but disabled', () => {
    addBox('a', 400, 100, { enabled: false });
    expect(layer(5, 'a').y).toBeCloseTo(100, 3);
  });
});

describe('static bodies', () => {
  it('keep their own transform rather than the solver’s copy', () => {
    addBox('wall', 400, 500, { kind: 'static' });
    expect(layer(5, 'wall').y).toBeCloseTo(500, 3);
  });

  it('still ANIMATE — a keyframed wall is not frozen by the solver', () => {
    // Static bodies are deliberately excluded from the pose map. Including them
    // would overwrite a keyframed platform with its frame-0 position and the
    // animation would silently stop.
    addBox('wall', 400, 500, { kind: 'static' });
    defaultAnimation.setKeyframe('wall', 'y', 0, 500);
    defaultAnimation.setKeyframe('wall', 'y', 2, 300);
    expect(layer(2, 'wall').y).toBeCloseTo(300, 0);
  });

  it('stop a falling body', () => {
    addBox('wall', 400, 400, { kind: 'static' });
    addBox('ball', 400, 100, { restitution: 0 });
    // Boxes are 40 tall, so a ball resting on the wall sits at 400 - 40 = 360.
    const y = layer(6, 'ball').y;
    expect(y).toBeCloseTo(360, 0);
    expect(y).toBeLessThan(400);
  });
});

describe('bodies share one world', () => {
  it('two falling bodies stack instead of overlapping', () => {
    // The test that fails if each layer gets its own cache: both would settle
    // at the floor, in the same place, passing through each other.
    addBox('a', 400, 100, { restitution: 0 });
    addBox('b', 400, 40, { restitution: 0 });
    const ya = layer(8, 'a').y;
    const yb = layer(8, 'b').y;
    expect(Math.abs(ya - yb)).toBeGreaterThan(35);
  });
});

describe('physics replaces, rather than blends with, keyframes', () => {
  it('a keyframed dynamic body follows the SOLVER', () => {
    // Blending would put the body neither where physics computed nor where it
    // was keyframed, with no way to tell which half produced any given frame.
    addBox('a', 400, 100, { restitution: 0 });
    defaultAnimation.setKeyframe('a', 'y', 0, 100);
    defaultAnimation.setKeyframe('a', 'y', 5, 110);
    expect(layer(5, 'a').y).toBeCloseTo(580, 0);
  });
});

describe('scrubbing', () => {
  it('a hostile access order gives the same answer as playing through', () => {
    addBox('a', 400, 100, { restitution: 0.5 });
    addBox('b', 430, 40, { restitution: 0.5 });
    const forward: number[] = [];
    for (let f = 0; f <= 9; f++) forward.push(layer(f / 3, 'a').y);

    resetPhysicsCaches();
    layer(3, 'a');            // jump ahead
    layer(0.3, 'a');          // back
    layer(2, 'a');            // middle
    const scrubbed: number[] = [];
    for (let f = 0; f <= 9; f++) scrubbed.push(layer(f / 3, 'a').y);
    expect(scrubbed).toEqual(forward);
  });

  it('moving a body restarts the history rather than replaying the old one', () => {
    addBox('a', 400, 100, { restitution: 0 });
    const first = layer(3, 'a').y;
    resetScene();
    addComp('comp_root', 'Main');
    useProjectStore.getState().actions.replaceComps({ comp_root: { id: 'comp_root', name: 'Main', ...COMP } });
    const proj = useProjectStore.getState();
    proj.actions.setActiveTab(proj.actions.openTab('comp_root', ['comp_root'], 'Main'));
    addBox('a', 400, 560, { restitution: 0 });
    // Starting almost on the floor, it is already settled at the same frame.
    expect(layer(3, 'a').y).toBeCloseTo(580, 0);
    expect(first).not.toBeCloseTo(0, 0);
  });
});
