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
    // (see below for the 2D-barrier rule, which shares this locking pass)
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

/**
 * The 2D-layer barrier — After Effects' rule that a 2D layer between two 3D
 * layers holds its stacking position and splits them into separate render
 * groups.
 *
 * This was implemented and correct but had NO test, which is a bad combination
 * for a rule enforced by a single `if (!l.matrix)` inside a shared locking pass:
 * any future change to adjustment/matte locking sits one line away from
 * silently un-barriering every 2D layer, and the failure is a paint-order
 * change that no other assertion in this file would catch.
 *
 * The second test is the one that matters. A 2D layer must not merely stay put
 * in the list — it must stay put as the CAMERA MOVES. `project` produces a
 * `depth` for flat layers too, so sorting on it made 2D layers reorder among
 * themselves under an orbited camera (in a Top view they sorted by their y).
 */
/**
 * A light is NOT a barrier — the one thing without a `matrix` that is allowed
 * through.
 *
 * Its wash occludes nothing and composites nothing: it is a screen-blended
 * overlay. But a light has no plane to project, so it carries no matrix, and the
 * `!l.matrix` barrier rule read it as a 2D wall. Dropping a light anywhere in
 * the middle of the timeline therefore broke depth sorting for the layers around
 * it — `[near, light, far]` kept list order, so the far layer painted OVER the
 * near one. AE's lights do not break the 3D stack.
 */
describe('a light is not a sort barrier', () => {
  function lightAt(id: string): SceneNode {
    return {
      id, name: id, parent: null, children: [], visible: true, locked: false,
      transform: { position: { x: 400, y: 300 }, rotation: 0, scale: { x: 1, y: 1 } },
      components: [
        { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'light', x: 400, y: 300, intensity: 80, radius: 250 } },
        { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#fff' } },
      ],
    } as unknown as SceneNode;
  }

  it('3D layers sort across a light between them', () => {
    // Listed near→far. A barrier would keep that order and paint `far` over
    // `near`; sorting across the light gives painter's order.
    const order = render([shape3D('near', -100), lightAt('L'), shape3D('far', 300)]);
    expect(order).toEqual(['far', 'L', 'near']);
  });

  it('the wash keeps its own stacking slot', () => {
    // Second of three before the sort, second of three after it: what the wash
    // brightens is still what the timeline stacked it over. Only the layers
    // either side moved.
    const order = render([shape3D('near', -100), lightAt('L'), shape3D('far', 300)]);
    expect(order.indexOf('L')).toBe(1);
  });

  it('several lights each keep their slot', () => {
    const order = render([
      lightAt('L1'),
      shape3D('near', -100),
      lightAt('L2'),
      shape3D('far', 300),
      lightAt('L3'),
    ]);
    expect(order).toEqual(['L1', 'far', 'L2', 'near', 'L3']);
  });

  it('a 2D layer next to a light is still a barrier', () => {
    // The exemption is for lights alone — it must not soften the real rule.
    const order = render([
      shape3D('near', -100),
      lightAt('L'),
      shape2DBare('flat'),
      shape3D('far', 300),
    ]);
    expect(order).toEqual(['near', 'L', 'flat', 'far']);
  });
});

/** A flat 2D shape: no z / rotationX / rotationY ⇒ no matrix ⇒ a barrier. */
function shape2DBare(id: string, x = 400, y = 300): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x, y }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x, y } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#fff' } },
    ],
  } as unknown as SceneNode;
}

describe('2D layers are sort barriers (AE parity)', () => {
  /** A flat 2D shape: no z / rotationX / rotationY ⇒ no matrix ⇒ a barrier. */
  function shape2D(id: string, x = 400, y = 300): SceneNode {
    return {
      id, name: id, parent: null, children: [], visible: true, locked: false,
      transform: { position: { x, y }, rotation: 0, scale: { x: 1, y: 1 } },
      components: [
        { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x, y } },
        { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#fff' } },
      ],
    } as unknown as SceneNode;
  }

  it('a 2D layer between two 3D layers splits them into separate groups', () => {
    // Listed NEAR first, so depth sorting would visibly reverse them: with the
    // barrier each 3D layer is alone in its run and the list order stands;
    // without it all three sort together into far → near.
    const order = render([
      shape3D('near', -100),
      shape2D('flat'),
      shape3D('far', 300),
    ]);
    expect(order).toEqual(['near', 'flat', 'far']);
  });

  it('the barrier holds when the camera orbits — 2D layers never reorder', () => {
    // Two 2D layers at different x/y, straddled by 3D ones, seen from a Top
    // view: the projected depth of a flat layer varies with its position there,
    // so an unbarriered sort would reshuffle them. Their paint order must be
    // exactly their list order regardless of the view.
    const graph = new SceneGraph();
    const nodes = [
      shape3D('deep', 400),
      shape2D('flatA', 100, 120),
      shape2D('flatB', 700, 500),
      shape3D('shallow', -200),
    ];
    const root = {
      id: 'comp_root', name: 'r', parent: null, children: nodes.map((n) => n.id),
      visible: true, locked: false,
      transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
      components: [{ id: 'comp_root_meta', type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
    } as unknown as SceneNode;
    graph.addNode(root);
    for (const n of nodes) { n.parent = 'comp_root'; graph.addChild('comp_root', n as never); }

    const orderIn = (camera3dMode: string): string[] =>
      buildSnapshot(graph, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, {
        ...COMP, rootId: 'comp_root', camera3dMode,
      } as never).layers.map((l) => l.id);

    for (const view of ['active', 'top', 'left', 'front']) {
      const order = orderIn(view);
      // The 2D layers keep both their positions and their relative order.
      expect(order.indexOf('flatA')).toBeLessThan(order.indexOf('flatB'));
      expect(order).toEqual(['deep', 'flatA', 'flatB', 'shallow']);
    }
  });
});
