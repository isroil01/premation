/**
 * 3D IK — what must hold for the feature to be trustworthy:
 *
 *  • the euler extraction is the exact inverse of `Matrix4Math.compose` (a
 *    wrong convention here poses every joint sideways),
 *  • the CCD solve actually REACHES a reachable target, in and out of plane,
 *  • parent transforms on the chain root do not break the solve (the chain
 *    lives inside an imported model's fitted/centred root),
 *  • baking lands rotation keyframes on every joint except the effector.
 */

import { Matrix4Math } from '@motion/scene';
import {
  axisAngleMatrix,
  matrixToEulerDeg,
  solveCcdChain,
  ikChainFromTip,
  bakeIk3D,
} from './boneIK3d';
import type { Node3DTransform } from './nodeMatrix';
import { composeNodeWorld3d } from './nodeMatrix';
import defaultSceneGraph from './DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { SCENE_KIND_PROP } from './seedDefaultScene';
import type { SceneNode } from '@core/types';

const DEG = Math.PI / 180;

const local = (over: Partial<Node3DTransform> = {}): Node3DTransform => ({
  x: 0, y: 0, z: 0,
  rotationX: 0, rotationY: 0, rotationZ: 0,
  orientationX: 0, orientationY: 0, orientationZ: 0,
  scaleX: 1, scaleY: 1, scaleZ: 1,
  anchorX: 0, anchorY: 0, anchorZ: 0,
  ...over,
});

/** Forward-compose the chain with solved totals; return the tip origin. */
function tipOf(
  locals: Node3DTransform[],
  totals: { x: number; y: number; z: number }[],
  rootParent: ReturnType<typeof Matrix4Math.identity> | null = null,
): { x: number; y: number; z: number } {
  let acc = rootParent;
  for (let i = 0; i < locals.length; i++) {
    const own = composeNodeWorld3d({
      ...locals[i]!,
      rotationX: totals[i]!.x, rotationY: totals[i]!.y, rotationZ: totals[i]!.z,
      orientationX: 0, orientationY: 0, orientationZ: 0,
    });
    acc = acc ? Matrix4Math.multiply(acc, own) : own;
  }
  return { x: acc![12]!, y: acc![13]!, z: acc![14]! };
}

describe('axisAngleMatrix / matrixToEulerDeg', () => {
  it('rotates +x onto +y for a 90° z spin', () => {
    const m = axisAngleMatrix(0, 0, 1, Math.PI / 2);
    const p = Matrix4Math.transformPoint(m, { x: 1, y: 0, z: 0 });
    expect(p.x).toBeCloseTo(0, 6);
    expect(p.y).toBeCloseTo(1, 6);
  });

  it('is the exact inverse of compose for a general rotation', () => {
    const m = Matrix4Math.compose({
      position: { x: 5, y: -3, z: 8 },
      rotation: { x: 20 * DEG, y: 35 * DEG, z: -50 * DEG },
      scale: { x: 2, y: 2, z: 2 }, // scale must normalize out
      anchor: { x: 0, y: 0, z: 0 },
    });
    const e = matrixToEulerDeg(m);
    expect(e.x).toBeCloseTo(20, 4);
    expect(e.y).toBeCloseTo(35, 4);
    expect(e.z).toBeCloseTo(-50, 4);
  });
});

describe('solveCcdChain', () => {
  it('a two-bone chain reaches an in-plane target', () => {
    // Root at origin, elbow 100 along +x, wrist 100 further: reach (100, 100).
    const locals = [local(), local({ x: 100 }), local({ x: 100 })];
    const target = { x: 100, y: 100, z: 0 };
    const totals = solveCcdChain(locals, null, target, { iterations: 30 });
    const tip = tipOf(locals, totals);
    expect(Math.hypot(tip.x - target.x, tip.y - target.y, tip.z - target.z)).toBeLessThan(1.5);
    // The effector's own rotation is untouched.
    expect(totals[2]).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('reaches an OUT-OF-PLANE target (real 3D, not a 2D solve in disguise)', () => {
    const locals = [local(), local({ x: 80 }), local({ x: 80 })];
    const target = { x: 60, y: 50, z: -90 };
    const totals = solveCcdChain(locals, null, target, { iterations: 40 });
    const tip = tipOf(locals, totals);
    expect(Math.hypot(tip.x - target.x, tip.y - target.y, tip.z - target.z)).toBeLessThan(2);
  });

  it('solves correctly under a transformed chain root (fitted model parent)', () => {
    const rootParent = Matrix4Math.compose({
      position: { x: 400, y: 300, z: -50 },
      rotation: { x: 0, y: 0, z: 30 * DEG },
      scale: { x: 0.5, y: 0.5, z: 0.5 },
      anchor: { x: 0, y: 0, z: 0 },
    });
    const locals = [local(), local({ y: 100 }), local({ y: 100 })];
    const target = { x: 430, y: 320, z: -60 };
    const totals = solveCcdChain(locals, rootParent, target, { iterations: 40 });
    const tip = tipOf(locals, totals, rootParent);
    expect(Math.hypot(tip.x - target.x, tip.y - target.y, tip.z - target.z)).toBeLessThan(2);
  });

  it('an unreachable target stretches the chain toward it, not into NaN', () => {
    const locals = [local(), local({ x: 50 }), local({ x: 50 })];
    const totals = solveCcdChain(locals, null, { x: 1000, y: 0, z: 0 }, { iterations: 20 });
    const tip = tipOf(locals, totals);
    expect(Number.isFinite(tip.x) && Number.isFinite(tip.y) && Number.isFinite(tip.z)).toBe(true);
    // Fully extended along +x.
    expect(tip.x).toBeGreaterThan(95);
  });
});

// ── Graph-integrated: chain discovery + baking ──────────────────────────────

const nullLayer = (id: string, props: Record<string, unknown>): SceneNode => ({
  id, name: id, parent: null, children: [], visible: true, locked: false,
  transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
  components: [{
    id: `${id}_t`,
    type: 'Transform',
    props: {
      [SCENE_KIND_PROP]: 'null',
      x: 0, y: 0, z: 0, rotation: 0, scaleX: 1, scaleY: 1,
      anchorX: 0, anchorY: 0, width: 20, height: 20,
      ...props,
    },
  }],
} as unknown as SceneNode);

describe('ikChainFromTip / bakeIk3D on the live graph', () => {
  const ids = ['ik_root', 'ik_j1', 'ik_j2', 'ik_target'];
  afterEach(() => {
    for (const id of ids) {
      try { defaultSceneGraph.removeNode(id); } catch { /* already gone */ }
      defaultAnimation.setTrackKeyframes(id, 'rotationX', []);
      defaultAnimation.setTrackKeyframes(id, 'rotationY', []);
      defaultAnimation.setTrackKeyframes(id, 'rotation', []);
      defaultAnimation.setTrackKeyframes(id, 'x', []);
    }
  });

  function buildRig(): void {
    defaultSceneGraph.addNode(nullLayer('ik_root', {}));
    defaultSceneGraph.addChild('ik_root', nullLayer('ik_j1', { x: 100 }));
    defaultSceneGraph.addChild('ik_j1', nullLayer('ik_j2', { x: 100 }));
    defaultSceneGraph.addNode(nullLayer('ik_target', { x: 100, y: 100 }));
  }

  it('walks the tip up through its 3D ancestors, root first', () => {
    buildRig();
    expect(ikChainFromTip('ik_j2')).toEqual(['ik_root', 'ik_j1', 'ik_j2']);
  });

  it('bakes rotation keyframes on every joint except the effector', () => {
    buildRig();
    // Animate the target so the bake has something to chase.
    defaultAnimation.setTrackKeyframes('ik_target', 'x', [
      { t: 0, value: 100, easing: 'linear' },
      { t: 1, value: 160, easing: 'linear' },
    ]);
    const frames = bakeIk3D(['ik_root', 'ik_j1', 'ik_j2'], 'ik_target', 0, 1, 10);
    expect(frames).toBe(11);
    const rz = defaultAnimation.tracksFor('ik_root').find((tr) => tr.prop === 'rotation');
    expect(rz?.keyframes.length).toBe(11);
    // The effector keeps no baked tracks.
    const tipRz = defaultAnimation.tracksFor('ik_j2').find((tr) => tr.prop === 'rotation');
    expect(tipRz?.keyframes.length ?? 0).toBe(0);
  });
});
