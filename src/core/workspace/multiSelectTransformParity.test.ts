/**
 * Multi-select scale/rotate commands, held to the transform-parity invariant
 * (`animatedTransformParity.test.ts`): the tool measures in WORLD space, a
 * layer's x/y/rotation/scale live in PARENT space, and its current pose is the
 * ANIMATED value at the playhead — so the handlers must convert through
 * `parentSpaceOf` and write down the keyframe-or-static dual path, exactly as
 * `moveNodes`/`resizeNode`/`rotateNode` do for one layer.
 *
 * The payloads carry each node's target as the world point its ANCHOR lands on
 * (`invParentWorld · position` IS the layer's own x/y), so these assert the
 * world pose the user asked for, at the playhead, under parents.
 */

import SceneGraph from '@core/scene/SceneGraph';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { Matrix } from '@motion/scene';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { world2DAt } from '@core/scene/layerSpace';
import { createCommandPort } from '@core/workspace/ports';
import { commands } from '@motion/workspace';
import { useProjectStore } from '@stores/projectStore';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import { reparentNode } from '@core/scene/parenting';
import type { SceneNode } from '@core/types';

function layer(id: string, kind: string, x: number, y: number, extra: Record<string, unknown> = {}): SceneNode {
  return {
    id, name: id, parent: 'comp_root', children: [], visible: true, locked: false,
    transform: { position: { x, y }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{
      id: `${id}_t`,
      type: 'Transform',
      props: { [SCENE_KIND_PROP]: kind, x, y, rotation: 0, width: 100, height: 100, scaleX: 1, scaleY: 1, ...extra },
    }],
  } as unknown as SceneNode;
}

const add = (n: SceneNode): void => { defaultSceneGraph.addChild('comp_root', n); };

/** World pose of the layer's origin at `t` — what the user's drag targeted. */
function poseAt(id: string, t: number): { x: number; y: number; rotation: number; scaleX: number } {
  const d = Matrix.decompose(world2DAt(id, t));
  return {
    x: +d.position.x.toFixed(4),
    y: +d.position.y.toFixed(4),
    rotation: +((d.rotation * 180) / Math.PI).toFixed(4),
    scaleX: +d.scale.x.toFixed(4),
  };
}

function seek(t: number): void {
  const s = useProjectStore.getState();
  const id = s.activeTabId!;
  useProjectStore.setState({ tabs: { ...s.tabs, [id]: { ...s.tabs[id]!, time: t } } });
}

beforeAll(() => {
  const services = {
    undo: { push: () => {}, undo: () => {}, redo: () => {}, canUndo: () => false, canRedo: () => false },
    selection: { get: () => [], set: () => {}, clear: () => {} },
    panels: { open: () => {}, close: () => {}, toggle: () => {}, isOpen: () => false },
    workspace: { setActive: () => {}, getActive: () => '' },
    get: () => undefined,
  };
  setCommandSystem(new CommandSystem({ services, getState: () => ({}) } as never));
});

afterAll(() => seek(0));

beforeEach(() => {
  (defaultSceneGraph as unknown as SceneGraph).clear();
  defaultAnimation.clear();
  seek(1); // NOT at 0 — the one time the wrong readers look right
  defaultSceneGraph.addNode({
    id: 'comp_root', name: 'Composition', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 'comp_root_meta', type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode);
});

const port = () => createCommandPort();

describe('multiResizeNodes', () => {
  test('scales a group about one pivot: scale multiplies, anchors spread by the ratio', () => {
    add(layer('a', 'shape', 100, 0));
    add(layer('b', 'shape', 300, 0));

    // The tool's 2× drag about the pivot at a's anchor (100,0):
    // a stays, b's anchor doubles its distance from the pivot.
    port().execute(commands.multiResizeNodes([
      { id: 'a', scale: { x: 2, y: 2 }, position: { x: 100, y: 0 } },
      { id: 'b', scale: { x: 2, y: 2 }, position: { x: 500, y: 0 } },
    ]) as never);

    expect(poseAt('a', 1)).toMatchObject({ x: 100, scaleX: 2 });
    expect(poseAt('b', 1)).toMatchObject({ x: 500, scaleX: 2 });
  });

  test('a layer under a SCALED, OFFSET parent lands exactly where it was asked to', () => {
    add(layer('sp', 'null', 400, 0, { scaleX: 2, scaleY: 2 }));
    add(layer('sc', 'shape', 100, 0));
    reparentNode('sc', 'sp'); // world pose preserved: still at world 100, ×1
    expect(poseAt('sc', 1)).toMatchObject({ x: 100, scaleX: 1 });

    port().execute(commands.multiResizeNodes([
      { id: 'sc', scale: { x: 1.5, y: 1.5 }, position: { x: 100, y: 0 } },
    ]) as never);

    // 1.5× at world 100 — writing the tool's world numbers straight into
    // parent-space props would have produced 3× at 600.
    expect(poseAt('sc', 1).scaleX).toBeCloseTo(1.5, 3);
    expect(poseAt('sc', 1).x).toBeCloseTo(100, 3);
  });

  test('an ANIMATED layer keyframes at the playhead instead of a discarded static write', () => {
    add(layer('k', 'shape', 100, 100));
    defaultAnimation.setKeyframes('k', 'x', [{ t: 0, value: 100 }, { t: 2, value: 900 }]);
    expect(poseAt('k', 1).x).toBe(500);

    port().execute(commands.multiResizeNodes([
      { id: 'k', scale: { x: 2, y: 2 }, position: { x: 600, y: 100 } },
    ]) as never);

    // x is tracked, so the write became a keyframe AT t=1 …
    expect(defaultAnimation.sample('k', 'x', 1)).toBeCloseTo(600, 4);
    expect(poseAt('k', 1)).toMatchObject({ x: 600, scaleX: 2 });
    // … and the rest of the animation is untouched.
    expect(defaultAnimation.sample('k', 'x', 0)).toBeCloseTo(100, 4);
  });

  test('a locked layer in the selection stays put', () => {
    add(layer('l', 'shape', 100, 0));
    const node = defaultSceneGraph.getNode('l')!;
    (node as { locked: boolean }).locked = true;

    port().execute(commands.multiResizeNodes([
      { id: 'l', scale: { x: 2, y: 2 }, position: { x: 700, y: 0 } },
    ]) as never);

    expect(poseAt('l', 1)).toMatchObject({ x: 100, scaleX: 1 });
  });
});

describe('multiRotateNodes', () => {
  test('rotates a group about its centre: anchors orbit, rotations add', () => {
    add(layer('a', 'shape', 100, 0));
    add(layer('b', 'shape', 300, 0));

    // A 90° sweep about the group centre (200,0), as the tool resolves it.
    const q = Math.PI / 2;
    port().execute(commands.multiRotateNodes([
      { id: 'a', rotation: q, position: { x: 200, y: -100 } },
      { id: 'b', rotation: q, position: { x: 200, y: 100 } },
    ]) as never);

    expect(poseAt('a', 1)).toMatchObject({ x: 200, y: -100, rotation: 90 });
    expect(poseAt('b', 1)).toMatchObject({ x: 200, y: 100, rotation: 90 });
  });

  test('a layer under a ROTATED parent lands at the angle asked for, not angle + parent', () => {
    add(layer('rp', 'null', 0, 0, { rotation: 30 }));
    add(layer('rc', 'shape', 200, 0));
    reparentNode('rc', 'rp');
    expect(poseAt('rc', 1).rotation).toBeCloseTo(0, 3);

    port().execute(commands.multiRotateNodes([
      { id: 'rc', rotation: (10 * Math.PI) / 180, position: { x: 200, y: 0 } },
    ]) as never);

    // 10°, not 40° — the parent's 30° must not be counted twice; and the
    // orbit target is a WORLD point, converted through the parent inverse.
    expect(poseAt('rc', 1).rotation).toBeCloseTo(10, 3);
    expect(poseAt('rc', 1).x).toBeCloseTo(200, 3);
    expect(poseAt('rc', 1).y).toBeCloseTo(0, 3);
  });

  test('an ANIMATED rotation keyframes at the playhead', () => {
    add(layer('kr', 'shape', 100, 0));
    defaultAnimation.setKeyframes('kr', 'rotation', [{ t: 0, value: 0 }, { t: 2, value: 180 }]);
    expect(poseAt('kr', 1).rotation).toBeCloseTo(90, 3);

    port().execute(commands.multiRotateNodes([
      { id: 'kr', rotation: Math.PI / 3, position: { x: 100, y: 0 } },
    ]) as never);

    expect(defaultAnimation.sample('kr', 'rotation', 1)).toBeCloseTo(60, 3);
    expect(poseAt('kr', 1).rotation).toBeCloseTo(60, 3);
  });
});
