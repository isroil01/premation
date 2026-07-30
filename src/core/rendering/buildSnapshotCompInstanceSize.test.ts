/**
 * A composition placed as a layer renders at ITS OWN size.
 *
 * The bug this pins: the precomp container was hardcoded to the HOST comp's
 * width/height at the HOST comp's centre, and the expanded children inherited
 * the instance node's transform on top of their own comp-space coordinates. So
 * a 1080×1920 vertical comp dropped into the centre of a 1920×1080 master
 * arrived as a 1920×1080 carrier with its centre content at (1500, 1500) —
 * 420 px below the bottom edge of a 1080-tall frame. Mixing aspect ratios, which
 * is most of what "make a vertical cut of this" means, silently threw the
 * content out of shot.
 */

import { buildSnapshot } from './buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { COMP_REF_PROP } from '@core/scene/compInstance';

const HOST = { width: 1920, height: 1080 };
const VERTICAL = { width: 1080, height: 1920 };

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

/** Host comp with a vertical comp placed inside it at `at`. */
function scene(at: { x: number; y: number }) {
  const g = new SceneGraph();
  g.addNode(node('host', 'group', null, {}));
  g.addNode(node('vertical', 'group', null, {}));
  // A box at the VERTICAL comp's own centre.
  g.addChild('vertical', node('vbox', 'shape', 'vertical', {
    x: VERTICAL.width / 2, y: VERTICAL.height / 2, width: 200, height: 200,
  }));
  g.addChild('host', node('inst', 'comp', 'host', { x: at.x, y: at.y }, {
    precomp: true, [COMP_REF_PROP]: 'vertical',
  }));
  return buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, {
    ...HOST,
    background: '#000',
    rootId: 'host',
    compSizeOf: (id: string) => (id === 'vertical' ? VERTICAL : undefined),
  } as never);
}

describe('a composition used as a layer', () => {
  it('carries the referenced comp\'s dimensions, not the host\'s', () => {
    const container = scene({ x: 960, y: 540 }).layers.find((l) => l.id === 'inst')!;
    expect(container.width).toBe(VERTICAL.width);
    expect(container.height).toBe(VERTICAL.height);
  });

  it('sits at the instance layer\'s own position', () => {
    const container = scene({ x: 400, y: 300 }).layers.find((l) => l.id === 'inst')!;
    expect(container.x).toBeCloseTo(400, 6);
    expect(container.y).toBeCloseTo(300, 6);
  });

  it('leaves the expanded children in the referenced comp\'s coordinate space', () => {
    // The instance transform belongs to the CONTAINER. Adding it to the children
    // as well is what produced (1500, 1500) from a comp centre of (540, 960)
    // placed at (960, 540).
    const inner = scene({ x: 960, y: 540 }).layers
      .find((l) => l.id === 'inst')!
      .precompLayers!.find((l) => l.id.endsWith('vbox'))!;
    expect(inner.x).toBeCloseTo(VERTICAL.width / 2, 6);
    expect(inner.y).toBeCloseTo(VERTICAL.height / 2, 6);
  });

  it('falls back to the host size when the comp size is unknown', () => {
    // No `compSizeOf` (export paths that predate it, synthetic template roots):
    // the old full-comp carrier, so nothing that worked before changes.
    const g = new SceneGraph();
    g.addNode(node('host', 'group', null, {}));
    g.addNode(node('vertical', 'group', null, {}));
    g.addChild('vertical', node('vbox', 'shape', 'vertical', { x: 540, y: 960, width: 200, height: 200 }));
    g.addChild('host', node('inst', 'comp', 'host', { x: 960, y: 540 }, {
      precomp: true, [COMP_REF_PROP]: 'vertical',
    }));
    const container = buildSnapshot(
      g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined,
      { ...HOST, background: '#000', rootId: 'host' } as never,
    ).layers.find((l) => l.id === 'inst')!;
    expect(container.width).toBe(HOST.width);
    expect(container.height).toBe(HOST.height);
  });
});

describe('a placed composition is cropped to its own frame', () => {
  const container = () => scene({ x: 960, y: 540 }).layers.find((l) => l.id === 'inst')!;

  it('carries a frame mask at exactly its own bounds', () => {
    const mask = container().mask;
    expect(mask).toBeDefined();
    const frame = mask!.paths.find((p) => p.id.endsWith('::frame'))!;
    expect(frame).toBeDefined();
    expect(frame.closed).toBe(true);
    const xs = frame.points.map((p) => p.x);
    const ys = frame.points.map((p) => p.y);
    // Centred on the container's own box: ±w/2, ±h/2 in its local space.
    expect(Math.min(...xs)).toBeCloseTo(-VERTICAL.width / 2, 6);
    expect(Math.max(...xs)).toBeCloseTo(VERTICAL.width / 2, 6);
    expect(Math.min(...ys)).toBeCloseTo(-VERTICAL.height / 2, 6);
    expect(Math.max(...ys)).toBeCloseTo(VERTICAL.height / 2, 6);
  });

  it('gives the frame mask a STABLE id', () => {
    // The mask raster is cached on a signature that includes the path id, so a
    // freshly minted id (what `rectangleMask` produces) would miss the cache on
    // every single frame.
    const a = container().mask!.paths.find((p) => p.id.endsWith('::frame'))!.id;
    const b = container().mask!.paths.find((p) => p.id.endsWith('::frame'))!.id;
    expect(a).toBe(b);
    expect(a).toBe('inst::frame');
  });

  it('leaves a plain precomp group unmasked', () => {
    // Only a placed COMPOSITION has a frame to crop against. Masking group
    // precomps too would force every one of them through isolated compositing.
    const g = new SceneGraph();
    g.addNode(node('host', 'group', null, {}));
    g.addChild('host', node('grp', 'group', 'host', { x: 0, y: 0 }, { precomp: true }));
    g.addChild('grp', node('child', 'shape', 'grp', { x: 10, y: 10, width: 5, height: 5 }));
    const c = buildSnapshot(
      g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined,
      { ...HOST, background: '#000', rootId: 'host', compSizeOf: () => undefined } as never,
    ).layers.find((l) => l.id === 'grp')!;
    expect(c.mask).toBeUndefined();
  });
});

describe('a placed composition renders through its OWN camera', () => {
  /** Inner comp holding a 3D box and (optionally) a camera of its own. */
  function withCameras(innerCamX: number | null, hostCamX: number | null) {
    const g = new SceneGraph();
    g.addNode(node('host', 'group', null, {}));
    g.addNode(node('inner', 'group', null, {}));
    g.addChild('inner', node('ibox', 'shape', 'inner', {
      x: 200, y: 150, z: 0, rotationX: 0, rotationY: 0, width: 50, height: 50,
    }));
    if (innerCamX !== null) {
      g.addChild('inner', node('icam', 'camera', 'inner', {
        x: innerCamX, y: 150, z: -1000, focalLength: 1000,
      }));
    }
    if (hostCamX !== null) {
      g.addChild('host', node('hcam', 'camera', 'host', {
        x: hostCamX, y: 300, z: -1000, focalLength: 1000,
      }));
    }
    g.addChild('host', node('inst', 'comp', 'host', { x: 500, y: 400 }, {
      precomp: true, [COMP_REF_PROP]: 'inner',
    }));
    return buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, {
      ...HOST,
      background: '#000',
      rootId: 'host',
      compSizeOf: (id: string) => (id === 'inner' ? { width: 400, height: 300 } : undefined),
    } as never)
      .layers.find((l) => l.id === 'inst')!
      .precompLayers!.find((l) => l.id.endsWith('ibox'))!;
  }

  it('uses the nested comp\'s camera, not the host\'s', () => {
    // Inner camera at x = 600 shifts the box by −400 within the inner comp's own
    // 400×300 frame; the host camera at 1400 must not reach it at all.
    expect(withCameras(600, 1400).x).toBeCloseTo(200 - 400, 6);
  });

  it('falls back to the nested comp\'s DEFAULT camera when it has none', () => {
    // No inner camera ⇒ the default camera framed to a 400×300 comp, which
    // leaves a layer on the comp plane exactly where it was authored.
    expect(withCameras(null, 1400).x).toBeCloseTo(200, 6);
  });
});

describe('a plain precomp GROUP is unaffected', () => {
  it('keeps its full-comp carrier at the comp centre', () => {
    // Pre-compose makes a GROUP, not a comp instance: its children are already
    // in comp space and its transform reaches them through ordinary parenting.
    // Giving it an intrinsic frame would move every existing project.
    const g = new SceneGraph();
    g.addNode(node('host', 'group', null, {}));
    g.addChild('host', node('grp', 'group', 'host', { x: 700, y: 200 }, { precomp: true }));
    g.addChild('grp', node('child', 'shape', 'grp', { x: 100, y: 100, width: 50, height: 50 }));
    const container = buildSnapshot(
      g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined,
      { ...HOST, background: '#000', rootId: 'host', compSizeOf: () => undefined } as never,
    ).layers.find((l) => l.id === 'grp')!;
    expect(container.width).toBe(HOST.width);
    expect(container.height).toBe(HOST.height);
    expect(container.x).toBeCloseTo(HOST.width / 2, 6);
    expect(container.y).toBeCloseTo(HOST.height / 2, 6);
    // And its child still inherits the group's transform: 700+100, 200+100.
    const child = container.precompLayers!.find((l) => l.id === 'child')!;
    expect(child.x).toBeCloseTo(800, 6);
    expect(child.y).toBeCloseTo(300, 6);
  });
});
