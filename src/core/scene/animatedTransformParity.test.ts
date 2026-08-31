/**
 * The defect class behind issue #16, pinned across every command that reaches it.
 *
 * ## The class
 *
 * A layer's on-screen pose is `parentWorld · local`, where `local` is the
 * ANIMATED value at the playhead. Two readings of that are wrong, and the whole
 * family is one of them:
 *
 *   1. reading a layer's BASE props as if they were its current pose — right
 *      only at time 0, and a motion-design tool is never at time 0; and
 *   2. reading or writing a layer's `x`/`y`/`rotation`/`scale` as if they were
 *      COMPOSITION coordinates — right only while the layer is unparented.
 *
 * Every case below was measured failing before its fix. They are gathered in one
 * suite deliberately: the bugs were found one report at a time precisely because
 * nothing stated the invariant in one place.
 *
 * ## The invariant
 *
 * A command that is not ASKING the layer to move must leave its world pose
 * alone, and one that is must land it exactly where it was asked to.
 */

import SceneGraph from '@core/scene/SceneGraph';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { Matrix } from '@motion/scene';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { world2DAt } from '@core/scene/layerSpace';
import { readGeometry } from '@core/workspace/geometry';
import { createCommandPort, createSceneGraphPort } from '@core/workspace/ports';
import { commands } from '@motion/workspace';
import { useProjectStore } from '@stores/projectStore';
import { useSelectionStore } from '@stores/selectionStore';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import { moveAnchorCompensated } from '@core/scene/anchor';
import { centreAnchorInContent } from '@core/source/fitCommands';
import { alignNodes } from '@core/scene/alignNodes';
import {
  groupSelectedLayers, ungroupSelected, ungroupSelectedNode, precomposeSelected,
} from '@core/scene/sceneInsert';
import { reparentNode } from './parenting';
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

/** Where the layer's origin lands on screen at `t` — the thing that must not drift. */
function poseAt(id: string, t: number): { x: number; y: number; rotation: number; scaleX: number } {
  const d = Matrix.decompose(world2DAt(id, t));
  return {
    x: +d.position.x.toFixed(4),
    y: +d.position.y.toFixed(4),
    rotation: +((d.rotation * 180) / Math.PI).toFixed(4),
    scaleX: +d.scale.x.toFixed(4),
  };
}

/** Move the playhead, as the transport does. Every command reads it. */
function seek(t: number): void {
  const s = useProjectStore.getState();
  const id = s.activeTabId!;
  useProjectStore.setState({ tabs: { ...s.tabs, [id]: { ...s.tabs[id]!, time: t } } });
}

/** A layer keyframed 100 → 900 over 2s: at the 1s playhead its world x is 500. */
function animateX(id: string, from = 100, to = 900): void {
  defaultAnimation.setKeyframes(id, 'x', [{ t: 0, value: from }, { t: 2, value: to }]);
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
  seek(1); // NOT at 0 — that is the only time the old readers were right
  defaultSceneGraph.addNode({
    id: 'comp_root', name: 'Composition', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 'comp_root_meta', type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode);
});

describe('commands that read a layer’s CURRENT pose, not its rest pose', () => {
  test('Pan Behind holds the content still on an animated layer', () => {
    add(layer('a', 'shape', 100, 100, { anchorX: 0, anchorY: 0 }));
    animateX('a');
    expect(poseAt('a', 1).x).toBe(500);

    moveAnchorCompensated('a', 20, 0);

    // The pivot moved 20px right INSIDE the layer and position followed it, so
    // the artwork is untouched and the origin sits 20px further along.
    // Reading the base props instead put it at 120 — a 380px teleport.
    expect(poseAt('a', 1).x).toBeCloseTo(520, 4);
  });

  test('Centre Anchor in Content holds the content still on an animated layer', () => {
    add(layer('b', 'shape', 100, 100, { anchorX: 30, anchorY: 0 }));
    animateX('b');

    centreAnchorInContent('b');

    expect(poseAt('b', 1).x).toBeCloseTo(470, 4); // was 70
  });

  test('Align measures the artwork at the playhead, not at time 0', () => {
    add(layer('c1', 'shape', 100, 100));
    add(layer('c2', 'shape', 200, 100));
    // c1 rests at 100 but is at 700 right now, so c2 is the LEFTMOST layer.
    defaultAnimation.setKeyframes('c1', 'x', [{ t: 0, value: 100 }, { t: 2, value: 1300 }]);

    alignNodes(['c1', 'c2'], 'left', 'selection');

    expect(poseAt('c1', 1).x).toBeCloseTo(200, 4);
    expect(poseAt('c2', 1).x).toBeCloseTo(200, 4); // both were dragged to 100
  });

  test('Pan Behind on an animated ROTATION points the compensation correctly', () => {
    add(layer('r', 'shape', 100, 100, { anchorX: 0, anchorY: 0 }));
    // 90° at the playhead; the base prop still says 0.
    defaultAnimation.setKeyframes('r', 'rotation', [{ t: 0, value: 0 }, { t: 2, value: 180 }]);

    moveAnchorCompensated('r', 10, 0);

    // Rotated 90°, a +10 anchor shift moves position along +Y, not +X.
    expect(poseAt('r', 1).x).toBeCloseTo(100, 3);
    expect(poseAt('r', 1).y).toBeCloseTo(110, 3);
  });
});

describe('commands that must respect the PARENT chain', () => {
  test('Align works in composition space for a parented layer', () => {
    add(layer('p', 'null', 500, 0));
    add(layer('d1', 'shape', 100, 100));
    add(layer('d2', 'shape', 300, 100));
    reparentNode('d1', 'p'); // d1 stays at world 100, local −400

    alignNodes(['d1', 'd2'], 'left', 'selection');

    // d1 is already leftmost at world 100; d2 joins it there. Reading d1's
    // local −400 as a comp coordinate flung d2 out to −400.
    expect(poseAt('d1', 1).x).toBeCloseTo(100, 4);
    expect(poseAt('d2', 1).x).toBeCloseTo(100, 4);
  });

  test('rotating a layer under a ROTATED parent lands at the angle asked for', () => {
    add(layer('rp', 'null', 0, 0, { rotation: 30 }));
    add(layer('rc', 'shape', 200, 0));
    reparentNode('rc', 'rp');
    expect(poseAt('rc', 1).rotation).toBeCloseTo(0, 3);

    // The tool always sends the ABSOLUTE angle it measured off the world matrix.
    createCommandPort().execute(commands.rotateNode('rc', (10 * Math.PI) / 180, { x: 0, y: 0 }) as never);

    // 10°, not 40° — the parent's 30° must not be counted twice.
    expect(poseAt('rc', 1).rotation).toBeCloseTo(10, 3);
  });

  test('resizing a layer under a SCALED, OFFSET parent lands where it is asked to', () => {
    add(layer('sp', 'null', 400, 0, { scaleX: 2, scaleY: 2 }));
    add(layer('sc', 'shape', 100, 0));
    reparentNode('sc', 'sp');
    const before = poseAt('sc', 1);
    expect(before).toMatchObject({ x: 100, scaleX: 1 });

    const box = [...createSceneGraphPort().getNodes()].find((n) => n.id === 'sc')!.worldBounds;
    createCommandPort().execute(commands.resizeNode(
      'sc',
      { x: box.x, y: box.y, width: box.width * 1.5, height: box.height * 1.5 },
      { x: 1.5, y: 1.5 },      // the WORLD scale the tool resolved
      { x: 100, y: 0 },        // the WORLD centre it wants
    ) as never);

    // 1.5× at world x 100 — not 3× at 600, which is what writing the tool's
    // world numbers straight into parent-space props produced.
    expect(poseAt('sc', 1).scaleX).toBeCloseTo(1.5, 3);
    expect(poseAt('sc', 1).x).toBeCloseTo(100, 3);
  });
});

describe('container commands preserve the pose of an ANIMATED layer', () => {
  test('Group Layers', () => {
    add(layer('g1', 'shape', 100, 100));
    animateX('g1');
    useSelectionStore.getState().set(['g1']);

    groupSelectedLayers();

    expect(defaultSceneGraph.getNode('g1')!.parent).not.toBe('comp_root');
    expect(poseAt('g1', 1).x).toBeCloseTo(500, 4); // was 660 — the group's offset
  });

  test('Precompose', () => {
    add(layer('g2', 'shape', 100, 100));
    animateX('g2');
    useSelectionStore.getState().set(['g2']);

    precomposeSelected();

    expect(poseAt('g2', 1).x).toBeCloseTo(500, 4);
  });

  test('Ungroup — both routes, animated and static', () => {
    add(layer('u1', 'shape', 300, 200));
    add(layer('u2', 'shape', 100, 100));
    animateX('u2');
    useSelectionStore.getState().set(['u1', 'u2']);
    groupSelectedLayers();
    const groupId = defaultSceneGraph.getNode('u1')!.parent!;
    const staticPose = poseAt('u1', 1);
    const animatedPose = poseAt('u2', 1);

    ungroupSelectedNode(groupId);

    expect(poseAt('u1', 1)).toEqual(staticPose);
    expect(poseAt('u2', 1)).toEqual(animatedPose);
  });

  test('Ungroup via the selection route', () => {
    add(layer('u3', 'shape', 300, 200));
    animateX('u3');
    useSelectionStore.getState().set(['u3']);
    groupSelectedLayers();
    const groupId = defaultSceneGraph.getNode('u3')!.parent!;
    const pose = poseAt('u3', 1);

    useSelectionStore.getState().set([groupId]);
    ungroupSelected();

    expect(poseAt('u3', 1)).toEqual(pose);
  });
});

describe('a group’s box answers two different questions', () => {
  test('the CHROME box follows the children through their animation', () => {
    add(layer('gg', 'group', 0, 0));
    const kid = layer('kid', 'shape', 0, 0);
    defaultSceneGraph.addChild('gg', kid);
    defaultAnimation.setKeyframes('kid', 'x', [{ t: 0, value: 0 }, { t: 2, value: 800 }]);

    const chrome = [...createSceneGraphPort().getNodes()].find((n) => n.id === 'gg')!;
    // The child is at 400 right now, so the selection box is centred there —
    // measured from base props it sat at 0, where nothing was drawn.
    expect(chrome.worldBounds.x + chrome.worldBounds.width / 2).toBeCloseTo(400, 3);
  });

  test('the LAYOUT box stays at rest, because that is what a transition measures', () => {
    add(layer('gl', 'group', 0, 0));
    const kid = layer('kid2', 'shape', 0, 0);
    defaultSceneGraph.addChild('gl', kid);
    defaultAnimation.setKeyframes('kid2', 'x', [{ t: 0, value: 0 }, { t: 2, value: 800 }]);

    // A slide-off transition sizes its move from the element's settled box; a
    // box measured mid-flight would under-shoot and leave it on screen.
    expect(readGeometry(defaultSceneGraph.getNode('gl')!)!.offsetX).toBeCloseTo(0, 3);
  });
});
