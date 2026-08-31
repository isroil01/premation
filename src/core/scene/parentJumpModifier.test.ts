/**
 * Alt-parenting — After Effects' "jump" variant of the parent gesture.
 *
 * The default compensates, so the layer does not move when you parent it. Alt
 * says "keep my values", so the layer moves into the parent's coordinate space
 * instead. Both are correct; which one you want depends on whether the child's
 * numbers were authored in comp space or already in the parent's.
 *
 * `parentOptionsFor` is the single translation from a held modifier to the
 * option, shared by all four parenting surfaces (the inspector picker, the
 * compositing panel, the timeline's Parent & Link column, and the pick-whip on
 * each). It is unit-tested here because a modifier that means different things
 * on different surfaces is worse than no modifier at all.
 */

import SceneGraph from '@core/scene/SceneGraph';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { Matrix } from '@motion/scene';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { world2DAt } from '@core/scene/layerSpace';
import { reparentNode, parentOptionsFor } from './parenting';
import type { SceneNode } from '@core/types';

const layer = (id: string, kind: string, x: number, y: number): SceneNode => ({
  id, name: id, parent: 'comp_root', children: [], visible: true, locked: false,
  transform: { position: { x, y }, rotation: 0, scale: { x: 1, y: 1 } },
  components: [{
    id: `${id}_t`, type: 'Transform',
    props: { [SCENE_KIND_PROP]: kind, x, y, rotation: 0, width: 100, height: 100 },
  }],
} as unknown as SceneNode);

const worldX = (id: string): number =>
  Matrix.transformPoint(world2DAt(id, 0), { x: 0, y: 0 }).x;

beforeEach(() => {
  (defaultSceneGraph as unknown as SceneGraph).clear();
  defaultAnimation.clear();
  defaultSceneGraph.addNode({
    id: 'comp_root', name: 'Composition', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 'comp_root_meta', type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode);
  defaultSceneGraph.addChild('comp_root', layer('null', 'null', 500, 0));
  defaultSceneGraph.addChild('comp_root', layer('circle', 'shape', 100, 0));
});

describe('parentOptionsFor — modifier to option', () => {
  test('no modifier keeps the default (compensate, layer stays put)', () => {
    expect(parentOptionsFor(undefined)).toBeUndefined();
    expect(parentOptionsFor({ altKey: false })).toBeUndefined();
  });

  test('Alt asks for the jump variant', () => {
    expect(parentOptionsFor({ altKey: true })).toEqual({ preserveWorld: false });
  });
});

describe('the two gestures, end to end', () => {
  test('plain pick: the circle does not move', () => {
    expect(worldX('circle')).toBe(100);

    reparentNode('circle', 'null', parentOptionsFor({ altKey: false }));

    expect(defaultSceneGraph.getNode('circle')!.parent).toBe('null');
    expect(worldX('circle')).toBeCloseTo(100, 6);
  });

  test('Alt pick: the circle keeps its value of 100 and jumps into the null', () => {
    reparentNode('circle', 'null', parentOptionsFor({ altKey: true }));

    expect(defaultSceneGraph.getNode('circle')!.parent).toBe('null');
    // Its own x is untouched at 100, so it now renders at the null's 500 + 100.
    expect(defaultSceneGraph.getNode('circle')!.transform.position.x).toBe(100);
    expect(worldX('circle')).toBeCloseTo(600, 6);
  });

  test('Alt leaves an ANIMATED child’s keyframes untouched', () => {
    defaultAnimation.setKeyframes('circle', 'x', [{ t: 0, value: 100 }, { t: 1, value: 300 }]);

    reparentNode('circle', 'null', parentOptionsFor({ altKey: true }));

    // The plain gesture would have offset these to −400 / −200 to hold the pose.
    expect(defaultAnimation.getTrackKeyframes('circle', 'x')!.map((k) => k.value))
      .toEqual([100, 300]);
  });
});
