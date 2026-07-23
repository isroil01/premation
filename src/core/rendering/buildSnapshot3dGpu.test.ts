/**
 * GPU 3D plumbing: buildSnapshot attaches the full 4×4 world matrix + camera
 * matrices for 3D frames, and snapshotToFrameScene turns them into depth-path
 * renderables (threeD.model) + scene.camera3d, forcing the depth-capable scene
 * colour target. Pure-2D frames must carry NONE of it (2D parity guarantee).
 */

import { buildSnapshot } from './buildSnapshot';
import { snapshotToFrameScene } from './snapshotToFrameScene';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { Project3D, Matrix4Math } from '@motion/scene';

const COMP = { width: 800, height: 600, background: '#101014' };

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

function snapshotOf(...nodes: SceneNode[]) {
  const graph = new SceneGraph();
  for (const n of nodes) graph.addNode(n);
  return buildSnapshot(graph, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP);
}

describe('buildSnapshot — GPU 3D plumbing (world3d + camera3d)', () => {
  it('a 3D layer carries its 4×4 world matrix alongside the affine', () => {
    const snap = snapshotOf(node3D('deep', { z: 200, rotationY: 30 }));
    const l = snap.layers[0]!;
    expect(l.matrix).toBeDefined();
    expect(l.world3d).toBeDefined();
    expect(l.world3d).toHaveLength(16);
  });

  it('the world matrix reprojects to the same affine the CPU path emitted', () => {
    const snap = snapshotOf(node3D('deep', { z: 300, rotationX: 25, rotationY: -40 }));
    const l = snap.layers[0]!;
    const cam = Project3D.defaultCamera(COMP.width, COMP.height);
    const M = l.world3d! as import('@motion/scene').Matrix4;
    const project = (x: number, y: number) =>
      Project3D.projectPoint(Matrix4Math.transformPoint(M, { x, y, z: 0 }), cam);
    const O = project(0, 0);
    const X = project(1, 0);
    const Y = project(0, 1);
    const [a, b, c, d, e, f] = l.matrix!;
    expect(X.x - O.x).toBeCloseTo(a, 6);
    expect(X.y - O.y).toBeCloseTo(b, 6);
    expect(Y.x - O.x).toBeCloseTo(c, 6);
    expect(Y.y - O.y).toBeCloseTo(d, 6);
    expect(O.x).toBeCloseTo(e, 6);
    expect(O.y).toBeCloseTo(f, 6);
  });

  it('a 3D frame carries camera matrices; a 2D frame carries none', () => {
    const with3d = snapshotOf(node3D('deep', { z: 100 }));
    expect(with3d.camera3d).toBeDefined();
    expect(with3d.camera3d!.view).toHaveLength(16);
    expect(with3d.camera3d!.projection).toHaveLength(16);

    const flat = snapshotOf(node3D('flat'));
    expect(flat.layers[0]!.world3d).toBeUndefined();
    expect(flat.camera3d).toBeUndefined();
  });

  it('ortho view modes still produce camera matrices', () => {
    const graph = new SceneGraph();
    graph.addNode(node3D('deep', { z: 100 }));
    const snap = buildSnapshot(graph, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, {
      ...COMP,
      camera3dMode: 'top' as const,
    });
    expect(snap.camera3d).toBeDefined();
  });
});

describe('snapshotToFrameScene — depth-path renderables', () => {
  it('3D layers become threeD renderables and the scene carries the camera', () => {
    const snap = snapshotOf(node3D('deep', { z: 150, rotationY: 20 }), node3D('flat'));
    const scene = snapshotToFrameScene(snap);
    const deep = scene.renderables.find((r) => r.id === 'deep')!;
    const flat = scene.renderables.find((r) => r.id === 'flat')!;
    expect(deep.threeD).toBeDefined();
    expect(deep.threeD!.model).toHaveLength(16);
    expect(flat.threeD).toBeUndefined();
    expect(scene.camera3d).toBeDefined();
    // 3D frames route through the depth-capable scene colour target.
    expect(scene.hasEffects).toBe(true);
  });

  it('the threeD model folds in the w×h unit-quad bridge (no 1px-dot regression)', () => {
    const snap = snapshotOf(node3D('deep', { z: 0 }));
    const scene = snapshotToFrameScene(snap);
    const model = scene.renderables[0]!.threeD!.model as import('@motion/scene').Matrix4;
    const l = snap.layers[0]!;
    // Unit-quad corners map to the layer's centered box on its plane.
    const p00 = Matrix4Math.transformPoint(model, { x: 0, y: 0, z: 0 });
    const p11 = Matrix4Math.transformPoint(model, { x: 1, y: 1, z: 0 });
    expect(p11.x - p00.x).toBeCloseTo(l.width, 4);
    expect(p11.y - p00.y).toBeCloseTo(l.height, 4);
    const centre = Matrix4Math.transformPoint(model, { x: 0.5, y: 0.5, z: 0 });
    expect(centre.x).toBeCloseTo(400, 4);
    expect(centre.y).toBeCloseTo(300, 4);
  });

  it('a pure-2D frame is untouched: no threeD, no camera3d, hasEffects false', () => {
    const scene = snapshotToFrameScene(snapshotOf(node3D('flat')));
    expect(scene.renderables[0]!.threeD).toBeUndefined();
    expect(scene.camera3d).toBeUndefined();
    expect(scene.hasEffects).toBe(false);
  });
});
