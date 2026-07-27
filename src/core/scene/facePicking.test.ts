/**
 * Face picking — the geometry, not the wiring.
 *
 * These use an explicit projector so a failure means the picking maths is wrong,
 * not that a camera moved.
 */

import { projectedFaces, pickFace } from './facePicking';
import { Matrix4Math } from '@motion/scene';
import type { SceneNode } from '@core/types';

/** Orthographic-down-the-z-axis projector: screen == x/y, depth == z. */
const ortho = (p: { x: number; y: number; z: number }) => ({ x: p.x, y: p.y, depth: p.z });

function node(props: Record<string, unknown>): SceneNode {
  return {
    id: 'n1',
    name: 'n',
    parent: null,
    children: [],
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 'tr', type: 'Transform', props }],
  } as unknown as SceneNode;
}

const IDENTITY = Matrix4Math.compose({
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
  scale: { x: 1, y: 1, z: 1 },
  anchor: { x: 0, y: 0, z: 0 },
});

describe('projectedFaces', () => {
  it('returns nothing for an unextruded layer (it is just the plane)', () => {
    expect(projectedFaces(node({ extrusionDepth: 0 }), IDENTITY, 100, 100, ortho)).toEqual([]);
  });

  it('emits a front cap, a back cap and four walls for a plain box', () => {
    const faces = projectedFaces(node({ extrusionDepth: 50 }), IDENTITY, 100, 80, ortho);
    const kinds = faces.map((f) => f.kind);
    expect(kinds.filter((k) => k === 'front')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'back')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'side')).toHaveLength(4);
    expect(kinds).not.toContain('bevel');
  });

  it('classifies chamfer rings as bevel, not side', () => {
    const faces = projectedFaces(node({ extrusionDepth: 60, bevelDepth: 10 }), IDENTITY, 100, 100, ortho);
    expect(faces.filter((f) => f.kind === 'bevel').length).toBeGreaterThan(0);
    // Bevels must not be miscounted as walls — that is what makes the two
    // material rows address different geometry.
    expect(faces.filter((f) => f.kind === 'side').length).toBe(4);
  });

  it('puts the back cap further from the camera than the front', () => {
    const faces = projectedFaces(node({ extrusionDepth: 50 }), IDENTITY, 100, 100, ortho);
    const front = faces.find((f) => f.kind === 'front')!;
    const back = faces.find((f) => f.kind === 'back')!;
    expect(back.depth).toBeGreaterThan(front.depth);
  });

  it('insets the front cap by the bevel, exactly as the renderer draws it', () => {
    const bevelled = projectedFaces(node({ extrusionDepth: 60, bevelDepth: 10 }), IDENTITY, 100, 100, ortho)
      .find((f) => f.kind === 'front')!;
    const xs = bevelled.quad.map((p) => p.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(80, 5);
  });
});

describe('pickFace', () => {
  const faces = () => projectedFaces(node({ extrusionDepth: 50 }), IDENTITY, 100, 100, ortho);

  it('picks the front face at the centre — it is nearest the camera', () => {
    expect(pickFace(faces(), { x: 0, y: 0 })!.kind).toBe('front');
  });

  it('returns null outside the object', () => {
    expect(pickFace(faces(), { x: 500, y: 500 })).toBeNull();
  });

  it('prefers the nearest face where faces overlap', () => {
    // Both caps project onto the same square down this axis; the front wins.
    const picked = pickFace(faces(), { x: 10, y: 10 })!;
    const back = faces().find((f) => f.kind === 'back')!;
    expect(picked.depth).toBeLessThan(back.depth);
  });

  it('picks a side wall when the object is turned so a wall faces the camera', () => {
    // 90° about Y puts the right-hand wall in the camera's face.
    const turned = Matrix4Math.compose({
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: Math.PI / 2, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
      anchor: { x: 0, y: 0, z: 0 },
    });
    const f = projectedFaces(node({ extrusionDepth: 50 }), turned, 100, 100, ortho);
    expect(pickFace(f, { x: 0, y: 0 })!.kind).toBe('side');
  });

  it('ignores an edge-on face even though it sits at the nearest depth', () => {
    // Turned 90°, the front cap collapses to a line THROUGH the origin at z = 0
    // — nearer than the wall the user is actually looking at. Nearest-wins alone
    // would hand it every click.
    const turned = Matrix4Math.compose({
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: Math.PI / 2, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
      anchor: { x: 0, y: 0, z: 0 },
    });
    const f = projectedFaces(node({ extrusionDepth: 50 }), turned, 100, 100, ortho);
    const front = f.find((x) => x.kind === 'front')!;
    expect(front.area).toBeLessThan(1);
    expect(front.depth).toBeLessThan(pickFace(f, { x: 0, y: 0 })!.depth);
  });

  it('carries the renderer face suffix, so a highlight can name the exact quad', () => {
    const picked = pickFace(faces(), { x: 0, y: 0 })!;
    expect(typeof picked.suffix).toBe('string');
    expect(picked.suffix.length).toBeGreaterThan(0);
  });
});
