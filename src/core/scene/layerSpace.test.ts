/**
 * Coordinate-space conversion — `toComp` / `toWorld` / `fromComp` / `fromWorld`.
 *
 * Every expected coordinate below is derived on paper FIRST, from the composed
 * matrix written out in the comment above it. A test that asks the
 * implementation what the answer is cannot disagree with it.
 *
 * ── The clean values, and what they exclude (rule 3a) ────────────────────
 *
 * The main case uses a parent rotated by 90 degrees, because at 90 degrees
 * cos = 0 and sin = 1, so the composed matrix is exact integers and the whole
 * thing is checkable by hand. What that buys in derivability it pays for in
 * coverage: the composed matrix is {a:0, b:2, c:-3, d:0}, so its DIAGONAL is
 * zero, and any error in the diagonal terms contributes nothing at all. Every
 * one of the four main-case assertions is blind to it.
 *
 * That is not hypothetical — it was measured. Dropping the `a` and `d` terms
 * from the forward transform leaves all four main-case tests GREEN and is
 * caught only by the boundary fixtures below.
 *
 * 180 degrees is the complementary pattern ({a:-2, b:0, c:0, d:-3}: non-zero
 * diagonal, zero off-diagonal), so the two rotations together exercise both
 * halves of the matrix. Note the coverage runs the other way too — negating
 * the rotation ANGLE is invisible at 180 degrees and caught at 90 — which is
 * why both are here rather than whichever one looked sufficient.
 *
 * The others: identity pins that nothing spurious is added; unparented pins
 * that the parent chain is not required; and uniform scale isolates the
 * rotation from the non-uniform cases.
 */

import { defaultAnimation } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { layerSpaceAt } from './layerSpace';
import type { SceneNode } from '@core/types';

const COMP = { width: 1920, height: 1080 };

interface NodeOpts {
  x?: number;
  y?: number;
  rotation?: number;
  scaleX?: number;
  scaleY?: number;
  parent?: string | null;
  is3D?: boolean;
  z?: number;
}

function node(id: string, o: NodeOpts = {}): SceneNode {
  const { x = 0, y = 0, rotation = 0, scaleX = 1, scaleY = 1, parent = null, is3D = false, z = 0 } = o;
  return {
    id,
    name: id,
    parent,
    children: [],
    transform: { position: { x, y }, rotation, scale: { x: scaleX, y: scaleY } },
    visible: true,
    locked: false,
    components: [
      {
        id: `${id}_t`,
        type: 'Transform',
        props: {
          [SCENE_KIND_PROP]: 'shape', x, y, rotation, scaleX, scaleY,
          width: 100, height: 100, ...(is3D ? { z, is3D: true } : {}),
        },
      },
      { id: `${id}_g`, type: 'Geometry', props: { shapeType: 'rect' } },
    ],
  } as unknown as SceneNode;
}

function reset(): void {
  defaultAnimation.clear();
  defaultSceneGraph.clear();
  defaultSceneGraph.addNode({
    id: 'comp_root',
    name: 'Composition 1',
    parent: null,
    children: [],
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true,
    locked: false,
    components: [{ id: 'comp_root_meta', type: 'group', props: { __kind: 'group' } }],
  } as unknown as SceneNode);
}

const space = (id: string, t = 0) => layerSpaceAt(id, t, COMP)!;
const round = (p: readonly number[]): number[] => p.map((v) => Math.round(v * 1e6) / 1e6);

beforeEach(reset);

describe('toComp / fromComp — 2D', () => {
  /**
   * THE MAIN CASE: parented, rotated, non-uniformly scaled, all at once.
   *
   *   parent P at (100, 50), rotation 90 degrees, scale 1
   *   child  C parented to P, at local (200, 0), scale (2, 3)
   *
   * P     = translate(100,50) · rotate(90) = {a:0, b:1, c:-1, d:0, e:100, f:50}
   * Clocal= translate(200,0) · scale(2,3)  = {a:2, b:0, c:0,  d:3, e:200, f:0}
   * W = P · Clocal:
   *   a = 0·2 + (-1)·0 = 0      b = 1·2 + 0·0 = 2
   *   c = 0·0 + (-1)·3 = -3     d = 1·0 + 0·3 = 0
   *   e = 0·200 + (-1)·0 + 100 = 100
   *   f = 1·200 + 0·0    + 50  = 250
   * so W = {a:0, b:2, c:-3, d:0, e:100, f:250}, and x' = a·x + c·y + e.
   */
  function parentedRig(): void {
    defaultSceneGraph.addChild('comp_root', node('P', { x: 100, y: 50, rotation: 90 }));
    defaultSceneGraph.addChild('P', node('C', { x: 200, y: 0, scaleX: 2, scaleY: 3, parent: 'P' }));
  }

  it('the layer ORIGIN lands where the parent chain puts it', () => {
    parentedRig();
    // (e, f). Sanity in words: the child sits 200 along the parent's +X; the
    // parent is turned 90 degrees, so that is 200 along comp +Y from (100,50).
    expect(round(space('C').toComp([0, 0]))).toEqual([100, 250]);
  });

  it('the local X axis is SCALED then ROTATED by the parent', () => {
    parentedRig();
    // x' = 0·10 + (-3)·0 + 100 = 100 ; y' = 2·10 + 0·0 + 250 = 270
    // In words: 10 local units × scaleX 2 = 20, along the child's +X, which the
    // parent's 90 degrees points down comp +Y.
    expect(round(space('C').toComp([10, 0]))).toEqual([100, 270]);
  });

  it('the local Y axis takes the OTHER scale — the axes are not interchangeable', () => {
    parentedRig();
    // x' = 0·0 + (-3)·10 + 100 = 70 ; y' = 2·0 + 0·10 + 250 = 250
    // 10 local units × scaleY 3 = 30, along the child's +Y, which points down
    // comp -X. Reading scaleX here would give 20 and land at x = 80.
    expect(round(space('C').toComp([0, 10]))).toEqual([70, 250]);
  });

  it('fromComp is the exact inverse of toComp', () => {
    parentedRig();
    expect(round(space('C').fromComp([100, 270]))).toEqual([10, 0]);
    expect(round(space('C').fromComp([70, 250]))).toEqual([0, 10]);
  });

  /**
   * BOUNDARY — identity. Excluded by every case above, all of which move,
   * rotate, scale or parent something. Catches an implementation that adds a
   * spurious term: a layer at the origin with no transform must hand the point
   * straight back.
   */
  it('BOUNDARY identity: an untransformed, unparented layer is a passthrough', () => {
    defaultSceneGraph.addChild('comp_root', node('I'));
    expect(round(space('I').toComp([5, 7]))).toEqual([5, 7]);
    expect(round(space('I').fromComp([5, 7]))).toEqual([5, 7]);
  });

  /**
   * BOUNDARY — 180 degrees, which is what the 90-degree main case cannot see.
   *
   * At 90 the composed matrix is {a:0, b:2, c:-3, d:0} — zero on the DIAGONAL,
   * so an error in the `a` or `d` terms contributes nothing and every main-case
   * assertion passes regardless. Verified by deleting exactly those two terms:
   * all four main-case tests stayed green, this one and the identity case went
   * red. At 180 the pattern is the opposite, {a:-2, b:0, c:0, d:-3}.
   *
   *   layer at (400, 300), rotation 180, scale (2, 3), no parent
   *   W = translate · rotate(180) · scale = {a:-2, b:0, c:0, d:-3, e:400, f:300}
   *   toComp([10, 0]) = (-2·10 + 400, 300)      = (380, 300)
   *   toComp([0, 10]) = (400, -3·10 + 300)      = (400, 270)
   */
  it('BOUNDARY 180 degrees: the diagonal pattern the 90-degree case hides', () => {
    defaultSceneGraph.addChild('comp_root', node('R', { x: 400, y: 300, rotation: 180, scaleX: 2, scaleY: 3 }));
    expect(round(space('R').toComp([10, 0]))).toEqual([380, 300]);
    expect(round(space('R').toComp([0, 10]))).toEqual([400, 270]);
  });

  /**
   * BOUNDARY — no parent. Every rotation/scale case above is parented or
   * derived from a parented rig, so an implementation that REQUIRED a parent
   * chain (or double-applied the node's own transform when there was none)
   * would pass them all.
   */
  it('BOUNDARY unparented: a rotated, scaled layer with no parent still converts', () => {
    defaultSceneGraph.addChild('comp_root', node('U', { x: 10, y: 20, rotation: 90, scaleX: 2, scaleY: 3 }));
    // W = translate(10,20) · rotate(90) · scale(2,3) = {a:0, b:2, c:-3, d:0, e:10, f:20}
    expect(round(space('U').toComp([10, 0]))).toEqual([10, 40]);
    expect(round(space('U').toComp([0, 10]))).toEqual([-20, 20]);
  });

  /**
   * BOUNDARY — uniform scale 1. The non-uniform (2, 3) cases would still pass
   * if the two axes were multiplied together, or averaged, or one used twice;
   * a case where scale contributes NOTHING isolates the rotation.
   */
  it('BOUNDARY uniform scale: rotation alone, with scale contributing nothing', () => {
    defaultSceneGraph.addChild('comp_root', node('S', { x: 0, y: 0, rotation: 90 }));
    expect(round(space('S').toComp([10, 0]))).toEqual([0, 10]);
    expect(round(space('S').toComp([0, 10]))).toEqual([-10, 0]);
  });

  it('follows ANIMATED transform values, at the time asked for', () => {
    defaultSceneGraph.addChild('comp_root', node('A', { x: 0, y: 0 }));
    defaultAnimation.setKeyframe('A', 'x', 0, 0);
    defaultAnimation.setKeyframe('A', 'x', 2, 400);
    // Linear between the two keys: x = 200 at t = 1.
    expect(round(space('A', 0).toComp([0, 0]))).toEqual([0, 0]);
    expect(round(space('A', 1).toComp([0, 0]))).toEqual([200, 0]);
    expect(round(space('A', 2).toComp([0, 0]))).toEqual([400, 0]);
  });

  it('a PARENT’s animation moves the child too', () => {
    defaultSceneGraph.addChild('comp_root', node('PP', { x: 0, y: 0 }));
    defaultSceneGraph.addChild('PP', node('CC', { x: 50, y: 0, parent: 'PP' }));
    defaultAnimation.setKeyframe('PP', 'y', 0, 0);
    defaultAnimation.setKeyframe('PP', 'y', 2, 100);
    // Child at local (50,0) under a parent that has travelled 50 down at t=1.
    expect(round(space('CC', 1).toComp([0, 0]))).toEqual([50, 50]);
  });

  it('reports undefined for a node that is not there', () => {
    expect(layerSpaceAt('ghost', 0, COMP)).toBeUndefined();
  });
});

describe('toWorld / fromWorld — 2D', () => {
  it('world equals comp for a 2D layer, with z = 0', () => {
    // Not an alias in the code — two separate functions that agree here — so
    // this asserts the AGREEMENT, which is the AE-correct behaviour.
    defaultSceneGraph.addChild('comp_root', node('W', { x: 100, y: 50, rotation: 90, scaleX: 2, scaleY: 3 }));
    const s = space('W');
    const comp = s.toComp([10, 0]);
    expect(round(s.toWorld([10, 0]))).toEqual([...round(comp), 0]);
  });

  it('fromWorld drops z rather than refusing it', () => {
    // A 2D layer has no depth to resolve z against. Refusing would break the
    // ordinary `other.toWorld(p)` → `this.fromWorld(...)` round trip whenever
    // either layer is 2D, which is most of the time.
    defaultSceneGraph.addChild('comp_root', node('W2', { x: 10, y: 20 }));
    expect(round(space('W2').fromWorld([30, 40, 999]))).toEqual([20, 20]);
  });
});

describe('3D layers', () => {
  /**
   * A 3D layer at the composition centre with z = 0 must project back ONTO its
   * own comp position. That is the invariant the default camera is built to
   * hold (focal length derived from the comp width), and it is the one
   * absolute, non-relative fact available here without re-deriving the
   * projection — which is exactly what a test must not do.
   */
  it('a z = 0 3D layer projects to its own composition position', () => {
    defaultSceneGraph.addChild('comp_root', node('D', { x: 960, y: 540, is3D: true, z: 0 }));
    const s = space('D');
    const p = s.toComp([0, 0]);
    expect(Math.round(p[0])).toBe(960);
    expect(Math.round(p[1])).toBe(540);
  });

  it('toWorld carries the layer’s own z, which toComp then projects away', () => {
    defaultSceneGraph.addChild('comp_root', node('D2', { x: 960, y: 540, is3D: true, z: 300 }));
    const s = space('D2');
    expect(round(s.toWorld([0, 0]))).toEqual([960, 540, 300]);
  });

  /**
   * DIRECTIONAL, and absolute rather than a mere difference: a layer pushed
   * AWAY from the camera must project SMALLER — its off-centre points move
   * TOWARD the comp centre. Asserting only "the two differ" would pass on a
   * projection that magnified with distance.
   */
  it('DIRECTION: greater z shrinks toward the centre, it does not grow', () => {
    defaultSceneGraph.addChild('comp_root', node('N', { x: 960, y: 540, is3D: true, z: 0 }));
    defaultSceneGraph.addChild('comp_root', node('F', { x: 960, y: 540, is3D: true, z: 600 }));
    const near = space('N').toComp([100, 0]);
    const far = space('F').toComp([100, 0]);
    // Both sit right of centre; the far one must sit LESS far right.
    expect(near[0]).toBeGreaterThan(960);
    expect(far[0]).toBeGreaterThan(960);
    expect(far[0]).toBeLessThan(near[0]);
  });

  it('fromComp inverts toComp through the camera, onto the layer’s own plane', () => {
    // A round trip is a weak assertion on its own — it passes if both halves
    // are wrong in inverse ways — so it sits BESIDE the absolute checks above
    // rather than instead of them. What it adds is the ray/plane step, which
    // has no matrix form and therefore no absolute expectation that is not a
    // re-derivation of the projection.
    defaultSceneGraph.addChild('comp_root', node('T', { x: 700, y: 400, rotation: 30, is3D: true, z: 250 }));
    const s = space('T');
    for (const p of [[0, 0], [40, -25], [-60, 80]] as Array<[number, number]>) {
      const back = s.fromComp(s.toComp(p));
      expect(back[0]).toBeCloseTo(p[0], 4);
      expect(back[1]).toBeCloseTo(p[1], 4);
    }
  });

  /**
   * BOUNDARY — a 3D layer whose transform is identity apart from the switch.
   * Every 3D case above moves or rotates something, so an implementation that
   * only worked once a transform was present would pass them.
   */
  it('BOUNDARY 3D identity: the switch alone changes nothing about the origin', () => {
    defaultSceneGraph.addChild('comp_root', node('Z', { x: 0, y: 0, is3D: true, z: 0 }));
    expect(round(space('Z').toWorld([12, 34]))).toEqual([12, 34, 0]);
  });
});
