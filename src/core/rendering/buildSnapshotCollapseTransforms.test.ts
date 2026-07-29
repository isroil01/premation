/**
 * Collapse Transformations — the bridge between 2D and 3D composition.
 *
 * Without it a placed composition is a hard 2D barrier: it renders to its own
 * frame and composites as one flat card, so a 3D layer inside it can never meet
 * the host's camera. Building a 3D scene out of reusable comps — which is how
 * anyone organises real work — was therefore impossible.
 *
 * Collapsed, the inner layers are spliced into the host: they take the host's
 * camera, its depth sort and its lights, and the instance's own transform
 * composes through instead of being flattened first.
 */

import { buildSnapshot } from './buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { COMP_REF_PROP, COMP_COLLAPSE_PROP } from '@core/scene/compInstance';

const HOST = { width: 800, height: 600 };
const INNER = { width: 400, height: 300 };

function node(
  id: string,
  kind: string,
  parent: string | null,
  props: Record<string, unknown>,
  fx?: Record<string, unknown>,
): SceneNode {
  const components: unknown[] = [
    { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: kind, x: 0, y: 0, rotation: 0, ...props } },
    { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#2b7eff' } },
  ];
  if (fx) components.push({ id: `${id}_fx`, type: 'fx', props: fx });
  return {
    id, name: id, parent, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components,
  } as unknown as SceneNode;
}

/**
 * Host comp holding a placed composition at (500, 400). The inner comp holds one
 * 3D box at its own centre; the host holds a camera pushed off to one side, so
 * "did the host camera reach this layer?" is visible in the layer's x.
 */
function scene(collapsed: boolean) {
  const g = new SceneGraph();
  g.addNode(node('host', 'group', null, {}));
  g.addNode(node('inner', 'group', null, {}));
  g.addChild('inner', node('ibox', 'shape', 'inner', {
    x: INNER.width / 2, y: INNER.height / 2, z: 0, rotationX: 0, rotationY: 0, width: 50, height: 50,
  }));
  // A pure-2D sibling: no camera can touch it, so it reports the raw coordinate
  // space its layer was emitted in.
  g.addChild('inner', node('iflat', 'shape', 'inner', {
    x: INNER.width / 2, y: INNER.height / 2, width: 50, height: 50,
  }));
  g.addChild('host', node('cam', 'camera', 'host', {
    x: 1400, y: HOST.height / 2, z: -1000, focalLength: 1000,
  }));
  g.addChild('host', node('inst', 'comp', 'host', { x: 500, y: 400 }, {
    precomp: true,
    [COMP_REF_PROP]: 'inner',
    ...(collapsed ? { [COMP_COLLAPSE_PROP]: true } : {}),
  }));
  return buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, {
    ...HOST,
    background: '#000',
    rootId: 'host',
    compSizeOf: (id: string) => (id === 'inner' ? INNER : undefined),
  } as never);
}

describe('a placed composition, NOT collapsed', () => {
  const s = scene(false);

  it('composites through its own container', () => {
    const container = s.layers.find((l) => l.id === 'inst');
    expect(container).toBeDefined();
    expect(container!.precompLayers!.length).toBe(2);
  });

  it('keeps its layers out of the host list', () => {
    expect(s.layers.find((l) => l.id.endsWith('ibox'))).toBeUndefined();
  });

  it('leaves its content in the referenced comp\'s own space', () => {
    const inner = s.layers.find((l) => l.id === 'inst')!
      .precompLayers!.find((l) => l.id.endsWith('iflat'))!;
    expect(inner.x).toBeCloseTo(INNER.width / 2, 6);
  });

  it('seals its 3D layers off from the HOST camera', () => {
    // The point of an uncollapsed comp: it is a frame of its own. Its 3D layers
    // resolve the camera of the composition they LIVE in — here none, so the
    // default camera framed to a 400×300 comp — and the host's camera only ever
    // moves the flat card that results.
    //
    // This used to leak. `buildSnapshot` resolved exactly one camera per call
    // and projected every 3D layer in the tree through it, so a layer two comps
    // deep was shot by whichever camera the OUTERMOST composition owned: the
    // host camera at x = 1400 dragged this to −800.
    const inner = s.layers.find((l) => l.id === 'inst')!.precompLayers!;
    const inner3d = inner.find((l) => l.id.endsWith('ibox'))!;
    const inner2d = inner.find((l) => l.id.endsWith('iflat'))!;
    expect(inner3d.x).toBeCloseTo(INNER.width / 2, 6);
    // …and it agrees with its 2D sibling, which no camera can touch.
    expect(inner3d.x).toBeCloseTo(inner2d.x, 6);
  });

  it('re-keys nested layers per instance so two placements cannot collide', () => {
    // Layer ids are offscreen texture keys and matte-source references, and the
    // recursive pass renders the SAME source nodes for every placement.
    const inner = s.layers.find((l) => l.id === 'inst')!.precompLayers!;
    for (const l of inner) expect(l.id.startsWith('inst::')).toBe(true);
  });
});

describe('a placed composition, COLLAPSED', () => {
  const s = scene(true);

  it('emits no container — there is no intermediate frame', () => {
    expect(s.layers.find((l) => l.id === 'inst')).toBeUndefined();
  });

  it('splices its layers into the host list', () => {
    expect(s.layers.find((l) => l.id.endsWith('ibox'))).toBeDefined();
  });

  it('composes the instance transform through to the inner layers', () => {
    // Collapsed, the instance's position is not flattened away first — it
    // reaches the child, whose comp-space (200, 150) becomes (700, 550).
    // The host camera then projects that.
    const box = s.layers.find((l) => l.id.endsWith('ibox'))!;
    // Camera at x = 1400 with focal 1000 on the comp plane ⇒ scale 1, so the
    // box lands at principal.x + (700 − 1400) = 400 − 700.
    expect(box.x).toBeCloseTo(HOST.width / 2 - 700, 6);
  });

  it('puts the inner layer under the HOST camera, which the flat card never was', () => {
    const flat = scene(false).layers.find((l) => l.id === 'inst')!;
    const collapsed = s.layers.find((l) => l.id.endsWith('ibox'))!;
    // The container is a 2D carrier: the camera does not move it at all.
    expect(flat.x).toBeCloseTo(500, 6);
    // The collapsed layer is in the camera's space, so it does move.
    expect(collapsed.x).not.toBeCloseTo(500, 1);
  });
});
