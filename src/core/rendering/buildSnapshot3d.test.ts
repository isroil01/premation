import { buildSnapshot } from './buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { Project3D } from '@motion/scene';

const COMP = { width: 800, height: 600, background: '#101014' };

/** A shape at the comp centre, optionally carrying 3D depth props. */
function node3D(id: string, three?: { z?: number; rotationX?: number; rotationY?: number }): SceneNode {
  const props: Record<string, unknown> = { [SCENE_KIND_PROP]: 'shape', x: 400, y: 300, rotation: 0 };
  if (three) {
    if (three.z !== undefined) props.z = three.z;
    if (three.rotationX !== undefined) props.rotationX = three.rotationX;
    if (three.rotationY !== undefined) props.rotationY = three.rotationY;
  }
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 400, y: 300 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#2b7eff' } },
    ],
  } as unknown as SceneNode;
}

function layerOf(node: SceneNode) {
  const graph = new SceneGraph();
  graph.addNode(node);
  return buildSnapshot(graph, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP).layers[0]!;
}

describe('buildSnapshot — 3D projection (2.5D)', () => {
  it('leaves a pure-2D layer completely unchanged', () => {
    const l = layerOf(node3D('flat'));
    expect(l.x).toBeCloseTo(400);
    expect(l.y).toBeCloseTo(300);
    expect(l.scaleX).toBeCloseTo(1);
    expect(l.scaleY).toBeCloseTo(1);
  });

  it('+z dollies the layer away: uniform shrink, centred layer stays put', () => {
    const cam = Project3D.defaultCamera(COMP.width, COMP.height);
    const l = layerOf(node3D('deep', { z: cam.focalLength })); // dist doubles ⇒ scale 0.5
    expect(l.scaleX).toBeCloseTo(0.5, 5);
    expect(l.scaleY).toBeCloseTo(0.5, 5);
    expect(l.x).toBeCloseTo(400); // on the camera axis ⇒ no parallax shift
  });

  it('-z brings the layer closer: it enlarges', () => {
    const cam = Project3D.defaultCamera(COMP.width, COMP.height);
    const l = layerOf(node3D('near', { z: -cam.focalLength / 2 }));
    expect(l.scaleX).toBeGreaterThan(1);
    expect(l.scaleY).toBeGreaterThan(1);
  });

  it('rotationY foreshortens horizontally only (~cos, with real perspective)', () => {
    // The projected affine gives ~cos60 = 0.5 horizontally; it differs from exact
    // cos by <1% because the tilted edge's own depth perspectives it (true 3D).
    const l = layerOf(node3D('panned', { rotationY: 60 }));
    expect(l.scaleX).toBeCloseTo(0.5, 2);
    expect(l.scaleY).toBeCloseTo(1, 2);
    expect(l.matrix).toBeDefined(); // full affine present for the tilt
  });

  it('rotationX foreshortens vertically only (~cos, with real perspective)', () => {
    const l = layerOf(node3D('tilted', { rotationX: 60 }));
    expect(l.scaleX).toBeCloseTo(1, 2);
    expect(l.scaleY).toBeCloseTo(0.5, 2);
    expect(l.matrix).toBeDefined();
  });

  it('a pure-2D layer carries no matrix (2D draw path untouched)', () => {
    const graph = new SceneGraph();
    graph.addNode(node3D('flat2d'));
    const l = buildSnapshot(graph, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP).layers[0]!;
    expect(l.matrix).toBeUndefined();
  });

  it('a combined X+Y rotation produces shear in the affine (real tilt, not a squish)', () => {
    const l = layerOf(node3D('tilted', { rotationX: 40, rotationY: 40 }));
    expect(l.matrix).toBeDefined();
    const m = l.matrix!;
    // Off-diagonal terms (b, c) non-zero ⇒ the layer plane is genuinely sheared.
    expect(Math.abs(m[1]) + Math.abs(m[2])).toBeGreaterThan(0.01);
  });

  it('off-axis +z parallaxes toward the vanishing point', () => {
    // A layer to the right of centre, pushed back, is pulled toward centre x.
    const graph = new SceneGraph();
    const n = node3D('off', { z: 400 });
    (n.components[0]!.props as Record<string, unknown>).x = 800; // right edge
    n.transform.position.x = 800;
    graph.addNode(n);
    const l = buildSnapshot(graph, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP).layers[0]!;
    expect(l.x).toBeGreaterThan(400);
    expect(l.x).toBeLessThan(800);
  });
});

/** A camera layer at the comp root. */
function cameraNode(id: string, props: { x?: number; y?: number; z?: number; focalLength?: number }): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: props.x ?? 960, y: props.y ?? 540 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'camera', ...props } }],
  } as unknown as SceneNode;
}

describe('buildSnapshot — camera layer + depth sort', () => {
  it('a Camera layer never draws (structural)', () => {
    const graph = new SceneGraph();
    graph.addNode(cameraNode('cam', { z: -2000, focalLength: 2000 }));
    graph.addNode(node3D('s', { z: 300 }));
    const snap = buildSnapshot(graph, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP);
    expect(snap.layers.find((l) => l.id === 'cam')).toBeUndefined();
    expect(snap.layers.find((l) => l.id === 's')).toBeDefined();
  });

  it('the scene camera drives the projection (a longer focal shrinks a +z layer less)', () => {
    const shortCam = new SceneGraph();
    shortCam.addNode(cameraNode('c1', { focalLength: 800, z: -800 }));
    shortCam.addNode(node3D('s', { z: 800 }));
    const wideCam = new SceneGraph();
    wideCam.addNode(cameraNode('c2', { focalLength: 4000, z: -4000 }));
    wideCam.addNode(node3D('s', { z: 800 }));
    const a = buildSnapshot(shortCam, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP).layers.find((l) => l.id === 's')!;
    const b = buildSnapshot(wideCam, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP).layers.find((l) => l.id === 's')!;
    // Same +z, longer focal ⇒ less perspective shrink (scale nearer 1).
    expect(b.scaleX).toBeGreaterThan(a.scaleX);
  });

  it('depth-sorts 3D layers back-to-front (farther layer drawn first)', () => {
    const graph = new SceneGraph();
    graph.addNode(node3D('near', { z: -200 })); // added first, but closer
    graph.addNode(node3D('far', { z: 600 }));   // added second, but farther
    const snap = buildSnapshot(graph, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP);
    const ids = snap.layers.map((l) => l.id);
    expect(ids.indexOf('far')).toBeLessThan(ids.indexOf('near')); // far drawn first
  });

  it('does NOT reorder a pure-2D scene', () => {
    const graph = new SceneGraph();
    graph.addNode(node3D('a'));
    graph.addNode(node3D('b'));
    const snap = buildSnapshot(graph, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP);
    expect(snap.layers.map((l) => l.id)).toEqual(['a', 'b']);
  });
});
