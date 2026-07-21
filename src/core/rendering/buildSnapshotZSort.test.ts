/**
 * 3D depth sorting — run-bounded, not all-or-nothing.
 *
 * The bug: sorting was abandoned the moment a single adjustment layer or matte
 * appeared, so every 3D layer then rendered in list order at the wrong depth,
 * silently. Sortable 3D layers now sort WITHIN runs bounded by order-dependent
 * layers (adjustment layers, matte pairs), which also keeps those layers'
 * compositing semantics intact.
 */

import { buildSnapshot } from './buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';

const COMP = { width: 800, height: 600, background: '#000' };

/** A 3D shape at depth `z` (larger z = farther from the camera). */
function shape3D(id: string, z: number, fx?: Record<string, unknown>): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 400, y: 300 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 400, y: 300, z } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#fff' } },
      ...(fx ? [{ id: `${id}_fx`, type: 'fx', props: fx }] : []),
    ],
  } as unknown as SceneNode;
}

function render(nodes: SceneNode[]): string[] {
  const graph = new SceneGraph();
  const root = { id: 'comp_root', name: 'r', parent: null, children: nodes.map((n) => n.id), visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 'comp_root_meta', type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }] } as unknown as SceneNode;
  graph.addNode(root);
  for (const n of nodes) { n.parent = 'comp_root'; graph.addChild('comp_root', n as never); }
  return buildSnapshot(graph, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, { ...COMP, rootId: 'comp_root' })
    .layers.map((l) => l.id);
}

describe('3D depth sort', () => {
  it('sorts pure-3D layers farthest-first', () => {
    // Listed near→far; must render far→near (painter's order).
    const order = render([shape3D('near', -100), shape3D('mid', 0), shape3D('far', 300)]);
    expect(order).toEqual(['far', 'mid', 'near']);
  });

  it('still sorts the 3D layers when an adjustment layer is present', () => {
    // The regression: this used to leave everything in list order.
    const order = render([
      shape3D('near', -100),
      shape3D('far', 300),
      shape3D('adj', 0, { isAdjustment: true }),
    ]);
    // 'near'/'far' sort within the run below the adjustment barrier; adj stays last.
    expect(order).toEqual(['far', 'near', 'adj']);
  });

  it('an adjustment layer breaks 3D layers into separate render groups', () => {
    // Layers above and below the adjustment sort independently, not across it.
    const order = render([
      shape3D('a_far', 300),
      shape3D('a_near', -100),
      shape3D('adj', 0, { isAdjustment: true }),
      shape3D('b_far', 200),
      shape3D('b_near', -50),
    ]);
    expect(order).toEqual(['a_far', 'a_near', 'adj', 'b_far', 'b_near']);
  });

  it('keeps a positional matte adjacent to its source', () => {
    // A matte (no explicit source) consumes the layer above; the pair must stay
    // together and in order even though depth would otherwise separate them.
    const order = render([
      shape3D('src', 300),
      shape3D('matted', -100, { matte: { mode: 'alpha' } }),
      shape3D('other', 0),
    ]);
    // src(300) is the matte source at index above 'matted' — locked adjacent.
    // 'other' is the only sortable layer in its run.
    expect(order.indexOf('src')).toBe(order.indexOf('matted') - 1);
  });
});
