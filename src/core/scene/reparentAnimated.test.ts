/**
 * Parenting an ANIMATED layer to an ANIMATED parent — issue #16, "Bug Position
 * when Parent to Null".
 *
 * The invariant every case here asserts is the one the feature promises: the
 * layer is in the SAME PLACE ON SCREEN the frame after it is parented as it was
 * the frame before. `parenting.test.ts` covers that for static layers, which is
 * the case the old static-props compensation could handle; these cover the case
 * it silently could not — the compensation was computed against the parent's
 * base x/y instead of its keyframed value, and written to a base x/y the
 * child's own keyframes then overrode.
 */

import SceneGraph from '@core/scene/SceneGraph';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { Matrix } from '@motion/scene';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { world2DAt } from '@core/scene/layerSpace';
import { useProjectStore } from '@stores/projectStore';
import { reparentNode } from './parenting';
import type { SceneNode } from '@core/types';

function layer(id: string, kind: string, x: number, y: number, rotation = 0): SceneNode {
  return {
    id, name: id, parent: 'comp_root', children: [], visible: true, locked: false,
    transform: { position: { x, y }, rotation, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: kind, x, y, rotation } },
    ],
  } as unknown as SceneNode;
}

/** Add a layer as a child of the composition root, as every insert path does. */
function add(node: SceneNode): void {
  defaultSceneGraph.addChild('comp_root', node);
}

/** Where the layer's origin actually lands on screen at `t`. */
function screenAt(id: string, t: number): { x: number; y: number } {
  return Matrix.transformPoint(world2DAt(id, t), { x: 0, y: 0 });
}

/** Move the playhead the way the app does — reparenting preserves the pose there. */
function seek(t: number): void {
  const s = useProjectStore.getState();
  const tabId = s.activeTabId;
  if (!tabId) return;
  useProjectStore.setState({ tabs: { ...s.tabs, [tabId]: { ...s.tabs[tabId]!, time: t } } });
}

beforeEach(() => {
  (defaultSceneGraph as unknown as SceneGraph).clear();
  defaultAnimation.clear();
  seek(0);
  // Parenting is scoped to a composition, so the layers must live in one.
  defaultSceneGraph.addNode({
    id: 'comp_root', name: 'Composition', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 'comp_root_meta', type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode);
});

afterAll(() => seek(0));

describe('reparent an animated layer onto an animated null', () => {
  test('THE REPORTED BUG: the circle does not jump when parented to the null', () => {
    add(layer('circle', 'shape', 100, 40));
    add(layer('null', 'null', 160, 120));
    // Both are animated — the shape of the report.
    defaultAnimation.setKeyframes('circle', 'x', [{ t: 0, value: 100 }, { t: 1, value: 300 }]);
    defaultAnimation.setKeyframes('circle', 'y', [{ t: 0, value: 40 }, { t: 1, value: 40 }]);
    defaultAnimation.setKeyframes('null', 'x', [{ t: 0, value: 500 }, { t: 1, value: 700 }]);
    defaultAnimation.setKeyframes('null', 'y', [{ t: 0, value: 300 }, { t: 1, value: 300 }]);

    const before = screenAt('circle', 0);
    expect(before).toEqual({ x: 100, y: 40 });

    expect(reparentNode('circle', 'null')).toBe(true);

    const after = screenAt('circle', 0);
    expect(after.x).toBeCloseTo(100, 6);
    expect(after.y).toBeCloseTo(40, 6);
  });

  test('the child keeps its OWN animation — it is now added to the parent’s', () => {
    add(layer('circle', 'shape', 100, 0));
    add(layer('null', 'null', 0, 0));
    defaultAnimation.setKeyframes('circle', 'x', [{ t: 0, value: 100 }, { t: 1, value: 300 }]);
    defaultAnimation.setKeyframes('null', 'x', [{ t: 0, value: 500 }, { t: 1, value: 700 }]);

    reparentNode('circle', 'null');

    // Held at the playhead …
    expect(screenAt('circle', 0).x).toBeCloseTo(100, 6);
    // … and from there the two motions compose: the circle's own +200 over the
    // second plus the null's +200 = +400. That IS what parenting is for.
    expect(screenAt('circle', 1).x).toBeCloseTo(500, 6);
  });

  test('the correction lands on the KEYFRAMES, not only the base props', () => {
    add(layer('circle', 'shape', 100, 0));
    add(layer('null', 'null', 0, 0));
    defaultAnimation.setKeyframes('circle', 'x', [
      { t: 0, value: 100, easing: 'easeInOut' },
      { t: 1, value: 300, easing: 'linear' },
    ]);
    defaultAnimation.setKeyframes('null', 'x', [{ t: 0, value: 500 }, { t: 1, value: 700 }]);

    reparentNode('circle', 'null');

    const kfs = defaultAnimation.getTrackKeyframes('circle', 'x')!;
    // Shifted by −400 (100 → −400 puts the circle back at 100 under a null at 500).
    expect(kfs.map((k) => k.value)).toEqual([-400, -200]);
    // Times and easing are the user's authored animation and must survive.
    expect(kfs.map((k) => k.t)).toEqual([0, 1]);
    expect(kfs.map((k) => k.easing)).toEqual(['easeInOut', 'linear']);
  });

  test('the parent is read at the PLAYHEAD, not from its base props', () => {
    // The static child is the half of the bug that has nothing to do with the
    // child's own tracks: the null's base x is 160, its animated x is 500.
    add(layer('circle', 'shape', 100, 40));
    add(layer('null', 'null', 160, 120));
    defaultAnimation.setKeyframes('null', 'x', [{ t: 0, value: 500 }, { t: 1, value: 700 }]);
    defaultAnimation.setKeyframes('null', 'y', [{ t: 0, value: 300 }, { t: 1, value: 300 }]);

    reparentNode('circle', 'null');

    expect(screenAt('circle', 0).x).toBeCloseTo(100, 6);
    expect(screenAt('circle', 0).y).toBeCloseTo(40, 6);
    // Compensated against 500/300, not against the base 160/120.
    expect(defaultSceneGraph.getNode('circle')!.transform.position.x).toBeCloseTo(-400, 6);
    expect(defaultSceneGraph.getNode('circle')!.transform.position.y).toBeCloseTo(-260, 6);
  });

  test('the pose is preserved at the playhead wherever the playhead is', () => {
    add(layer('circle', 'shape', 100, 0));
    add(layer('null', 'null', 0, 0));
    defaultAnimation.setKeyframes('circle', 'x', [{ t: 0, value: 100 }, { t: 2, value: 500 }]);
    defaultAnimation.setKeyframes('null', 'x', [{ t: 0, value: 0 }, { t: 2, value: 400 }]);

    seek(1);
    const before = screenAt('circle', 1);
    expect(before.x).toBeCloseTo(300, 6); // midway

    reparentNode('circle', 'null');

    expect(screenAt('circle', 1).x).toBeCloseTo(300, 6);
  });

  test('UN-parenting an animated child off an animated null also holds still', () => {
    add(layer('circle', 'shape', 100, 0));
    add(layer('null', 'null', 0, 0));
    defaultAnimation.setKeyframes('circle', 'x', [{ t: 0, value: 100 }, { t: 1, value: 300 }]);
    defaultAnimation.setKeyframes('null', 'x', [{ t: 0, value: 500 }, { t: 1, value: 700 }]);
    reparentNode('circle', 'null');
    expect(screenAt('circle', 0).x).toBeCloseTo(100, 6);

    expect(reparentNode('circle', null)).toBe(true);

    expect(defaultSceneGraph.getNode('circle')!.parent).toBe('comp_root');
    expect(screenAt('circle', 0).x).toBeCloseTo(100, 6);
  });

  test('a rotated animated null re-bases the child without moving it', () => {
    add(layer('circle', 'shape', 200, 0));
    add(layer('null', 'null', 0, 0));
    defaultAnimation.setKeyframes('circle', 'x', [{ t: 0, value: 200 }, { t: 1, value: 400 }]);
    defaultAnimation.setKeyframes('null', 'rotation', [{ t: 0, value: 90 }, { t: 1, value: 180 }]);

    reparentNode('circle', 'null');

    const after = screenAt('circle', 0);
    expect(after.x).toBeCloseTo(200, 4);
    expect(after.y).toBeCloseTo(0, 4);
    // The child's own rotation absorbed the parent's −90° so the pair cancels.
    const rot = defaultAnimation.evaluateNode('circle', 0).get('rotation')
      ?? defaultSceneGraph.getNode('circle')!.transform.rotation;
    expect(rot).toBeCloseTo(-90, 4);
  });

  test('preserveWorld: false still skips every correction (importer path)', () => {
    add(layer('circle', 'shape', 100, 0));
    add(layer('null', 'null', 0, 0));
    defaultAnimation.setKeyframes('circle', 'x', [{ t: 0, value: 100 }, { t: 1, value: 300 }]);
    defaultAnimation.setKeyframes('null', 'x', [{ t: 0, value: 500 }, { t: 1, value: 700 }]);

    reparentNode('circle', 'null', { preserveWorld: false });

    expect(defaultAnimation.getTrackKeyframes('circle', 'x')!.map((k) => k.value)).toEqual([100, 300]);
    expect(screenAt('circle', 0).x).toBeCloseTo(600, 6); // moves, by design
  });
});
