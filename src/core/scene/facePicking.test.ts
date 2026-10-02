/**
 * Face picking — the view half: the engine's world faces (`getLayerFaces`)
 * projected, culled, picked and grouped.
 *
 * These use an explicit projector and hand-built world faces, so a failure
 * means the picking maths is wrong, not that a camera or the engine's mesh
 * moved. The geometry itself (which faces an extruded layer has) is the
 * engine's and is pinned on the real binary in
 * core/engine/__tests__/facesMergeNative.test.ts.
 *
 * Two face shapes are under test: the flat QUADS of the engine's fallback, and
 * the mesh TRIANGLES (with vertex indices) of its extrusion mesh.
 */

import { projectWorldFaces, pickFace, faceHighlightGroups, isPickableFace, type WorldFace } from './facePicking';
import type { FaceKind } from './faceMaterials';

interface P3 { x: number; y: number; z: number }

/** Orthographic-down-the-z-axis projector: screen == x/y, depth == z. */
const ortho = (p: P3) => ({ x: p.x, y: p.y, depth: p.z });

/** Rotate about the Y axis (through the origin). */
const rotY = (a: number) => (p: P3): P3 => ({
  x: p.x * Math.cos(a) + p.z * Math.sin(a),
  y: p.y,
  z: -p.x * Math.sin(a) + p.z * Math.cos(a),
});
const IDENTITY = (p: P3): P3 => p;
/** 90° about Y: a side wall faces the camera, the caps go edge-on. */
const TURNED_Y = rotY(Math.PI / 2);
/** ~35° about Y: the front cap AND a side wall are both in view. */
const TILTED_Y = rotY(0.6);
/** 180° about Y: the back cap faces the camera. */
const FLIPPED_Y = rotY(Math.PI);

/** The 8 corners of a w×h box extruded `d` away from the camera (front at z 0). */
function corners(w: number, h: number, d: number): P3[] {
  const hw = w / 2, hh = h / 2;
  return [
    { x: -hw, y: -hh, z: 0 }, { x: hw, y: -hh, z: 0 }, { x: hw, y: hh, z: 0 }, { x: -hw, y: hh, z: 0 },
    { x: -hw, y: -hh, z: d }, { x: hw, y: -hh, z: d }, { x: hw, y: hh, z: d }, { x: -hw, y: hh, z: d },
  ];
}

/** Each face of the box: its kind, its suffix, its corner indices, its outward normal. */
const BOX_FACES: Array<{ kind: FaceKind; suffix: string; idx: [number, number, number, number]; n: P3 }> = [
  { kind: 'front', suffix: 'front', idx: [0, 1, 2, 3], n: { x: 0, y: 0, z: -1 } },
  { kind: 'back', suffix: 'back', idx: [4, 5, 6, 7], n: { x: 0, y: 0, z: 1 } },
  { kind: 'side', suffix: 't', idx: [0, 1, 5, 4], n: { x: 0, y: -1, z: 0 } },
  { kind: 'side', suffix: 'r', idx: [1, 2, 6, 5], n: { x: 1, y: 0, z: 0 } },
  { kind: 'side', suffix: 'b', idx: [2, 3, 7, 6], n: { x: 0, y: 1, z: 0 } },
  { kind: 'side', suffix: 'l', idx: [3, 0, 4, 7], n: { x: -1, y: 0, z: 0 } },
];

/** The box as the engine's flat-quad fallback answers it. */
function quadBox(w: number, h: number, d: number, world: (p: P3) => P3 = IDENTITY): WorldFace[] {
  const c = corners(w, h, d).map(world);
  return BOX_FACES.map((f) => ({ kind: f.kind, suffix: f.suffix, points: f.idx.map((i) => c[i]!) }));
}

/**
 * The box as the engine's extrusion mesh answers it: two triangles per face,
 * each wound to agree with its outward normal, the suffix the face's kind.
 */
function meshBox(w: number, h: number, d: number, world: (p: P3) => P3 = IDENTITY): WorldFace[] {
  const rest = corners(w, h, d);
  const c = rest.map(world);
  const out: WorldFace[] = [];
  for (const f of BOX_FACES) {
    const tris: Array<[number, number, number]> = [[f.idx[0], f.idx[1], f.idx[2]], [f.idx[0], f.idx[2], f.idx[3]]];
    for (const t of tris) {
      const [a, b, cc] = [rest[t[0]]!, rest[t[1]]!, rest[t[2]]!];
      const u = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
      const v = { x: cc.x - a.x, y: cc.y - a.y, z: cc.z - a.z };
      const dot = (u.y * v.z - u.z * v.y) * f.n.x + (u.z * v.x - u.x * v.z) * f.n.y + (u.x * v.y - u.y * v.x) * f.n.z;
      const verts: [number, number, number] = dot >= 0 ? t : [t[0], t[2], t[1]];
      out.push({ kind: f.kind, suffix: f.kind, points: verts.map((i) => c[i]!), verts });
    }
  }
  return out;
}

describe('projectWorldFaces — the quad fallback', () => {
  it('projects nothing from nothing', () => {
    expect(projectWorldFaces([], ortho)).toEqual([]);
  });

  it('keeps every quad, with no vertex indices', () => {
    const faces = projectWorldFaces(quadBox(100, 80, 50), ortho);
    const kinds = faces.map((f) => f.kind);
    expect(kinds.filter((k) => k === 'front')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'back')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'side')).toHaveLength(4);
    expect(faces.every((f) => f.verts === undefined && f.quad.length === 4)).toBe(true);
  });

  it('puts the back cap further from the camera than the front', () => {
    const faces = projectWorldFaces(quadBox(100, 100, 50), ortho);
    const front = faces.find((f) => f.kind === 'front')!;
    const back = faces.find((f) => f.kind === 'back')!;
    expect(back.depth).toBeGreaterThan(front.depth);
  });

  it('measures the projected area, so an edge-on face reads as ~0', () => {
    const faces = projectWorldFaces(quadBox(100, 80, 50), ortho);
    expect(faces.find((f) => f.kind === 'front')!.area).toBeCloseTo(8000, 5);
    // Looking straight down z every wall is edge-on.
    expect(faces.filter((f) => f.kind === 'side').every((f) => f.area < 1e-6 && !isPickableFace(f))).toBe(true);
  });

  it('drops a face with a point the projector clipped', () => {
    const clipBehind = (p: P3) => ({ x: p.x, y: p.y, depth: p.z, clipped: p.z > 10 });
    const faces = projectWorldFaces(quadBox(100, 100, 50), clipBehind);
    expect(faces.map((f) => f.kind)).toEqual(['front']);
  });
});

describe('pickFace — quad fallback', () => {
  const faces = () => projectWorldFaces(quadBox(100, 100, 50), ortho);

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
    const f = projectWorldFaces(quadBox(100, 100, 50, TURNED_Y), ortho);
    expect(pickFace(f, { x: 10, y: 0 })!.kind).toBe('side');
  });

  it('ignores an edge-on face even though it sits at the nearest depth', () => {
    // Turned 90°, the caps collapse to lines; one of them is nearer than part of
    // the wall the user is actually looking at. Nearest-wins alone would hand it
    // the click.
    const f = projectWorldFaces(quadBox(100, 100, 50, TURNED_Y), ortho);
    const front = f.find((x) => x.kind === 'front')!;
    expect(front.area).toBeLessThan(1);
    expect(pickFace(f, { x: 0, y: 0 })?.kind).not.toBe('front');
  });

  it('carries the renderer face suffix, so a highlight can name the exact quad', () => {
    const picked = pickFace(faces(), { x: 0, y: 0 })!;
    expect(picked.suffix).toBe('front');
  });
});

describe('projectWorldFaces — mesh triangles (what the engine draws)', () => {
  it('culls the faces turned away: front cap in, back cap out', () => {
    const faces = projectWorldFaces(meshBox(100, 80, 50), ortho);
    expect(faces.length).toBeGreaterThan(0);
    expect(faces.every((f) => f.verts !== undefined && f.quad.length === 3)).toBe(true);
    expect(faces.some((f) => f.kind === 'front')).toBe(true);
    expect(faces.some((f) => f.kind === 'back')).toBe(false);
    // Areas come back unsigned, whatever the winding was.
    expect(faces.every((f) => f.area >= 0)).toBe(true);
  });

  it('picks the front cap at the centre, and nothing outside the box', () => {
    const faces = projectWorldFaces(meshBox(100, 80, 50), ortho);
    expect(pickFace(faces, { x: 0, y: 0 })!.kind).toBe('front');
    expect(pickFace(faces, { x: 500, y: 500 })).toBeNull();
  });

  it('shows the back cap, not the front, when the object is turned around', () => {
    const faces = projectWorldFaces(meshBox(100, 80, 50, FLIPPED_Y), ortho);
    expect(pickFace(faces, { x: 0, y: 0 })!.kind).toBe('back');
    expect(faces.some((f) => f.kind === 'front')).toBe(false);
  });

  it('the cull does not depend on the projector\'s handedness', () => {
    const mirrored = (p: P3) => ({ x: -p.x, y: p.y, depth: p.z });
    const faces = projectWorldFaces(meshBox(100, 80, 50), mirrored);
    expect(faces.some((f) => f.kind === 'front')).toBe(true);
    expect(faces.some((f) => f.kind === 'back')).toBe(false);
  });

  it('picks a wall when the box is turned so a wall faces the camera', () => {
    const faces = projectWorldFaces(meshBox(100, 100, 50, TURNED_Y), ortho);
    expect(pickFace(faces, { x: 10, y: 0 })!.kind).toBe('side');
  });

  it('tilted: the cap where the cap is, the wall where the wall is, nothing beside them', () => {
    const faces = projectWorldFaces(meshBox(20, 20, 40, TILTED_Y), ortho);
    expect(pickFace(faces, { x: 0, y: 0 })!.kind).toBe('front');
    // Tilted 0.6 rad about Y, the right wall (x = 10, z ∈ [0, 40]) sweeps
    // screen x from 10·cos to 10·cos + 40·sin ≈ 8.3 … 30.8.
    expect(pickFace(faces, { x: 20, y: 0 })!.kind).toBe('side');
    // The left wall faces away (culled), so just left of the cap is empty.
    expect(pickFace(faces, { x: -9, y: 0 })).toBeNull();
    expect(pickFace(faces, { x: 70, y: 0 })).toBeNull();
    expect(pickFace(faces, { x: 0, y: 30 })).toBeNull();
  });

  it('keeps quads unculled when they ride with triangles', () => {
    // A mixed answer never happens for one layer, but the cull must only ever
    // apply to faces that carry a winding (triangles).
    const mixed: WorldFace[] = [...meshBox(100, 80, 50), { kind: 'back', suffix: 'q', points: corners(100, 80, 50).slice(4) }];
    const faces = projectWorldFaces(mixed, ortho);
    expect(faces.some((f) => f.suffix === 'q')).toBe(true);
  });
});

describe('faceHighlightGroups', () => {
  it('keeps every quad-fallback face as its own surface with its four edges', () => {
    const faces = projectWorldFaces(quadBox(100, 100, 50, TILTED_Y), ortho);
    const groups = faceHighlightGroups(faces);
    const visible = faces.filter((f) => f.area >= 4);
    expect(groups).toHaveLength(visible.length);
    expect(groups.every((g) => g.polygons.length === 1 && g.outline.length === 4)).toBe(true);
  });

  it('merges every triangle of a mesh kind into one surface outlined by its boundary', () => {
    const faces = projectWorldFaces(meshBox(100, 80, 50), ortho);
    const groups = faceHighlightGroups(faces);
    const front = groups.find((g) => g.kind === 'front')!;
    expect(front.polygons).toHaveLength(2);
    // The cap's boundary is the rectangle: four edges, however it triangulates.
    expect(front.outline).toHaveLength(4);
    expect(groups.filter((g) => g.kind === 'front')).toHaveLength(1);
  });

  it('reports the mean depth of a surface, so far surfaces paint first', () => {
    const faces = projectWorldFaces(quadBox(100, 100, 50), ortho);
    const groups = faceHighlightGroups(faces);
    expect(groups.find((g) => g.kind === 'front')!.depth).toBeCloseTo(0, 6);
    expect(groups.find((g) => g.kind === 'back')!.depth).toBeCloseTo(50, 6);
  });
});
