import {
  extrudeOutline,
  rectOutline,
  ellipseOutline,
  bezierRunsToRings,
  clampMeshBevel,
  MESH_VERTEX_FLOATS,
  type ExtrudedMesh,
  type MeshRole,
} from './extrudeMesh';

function vert(m: ExtrudedMesh, i: number) {
  const o = i * MESH_VERTEX_FLOATS;
  const v = m.vertices;
  return { x: v[o]!, y: v[o + 1]!, z: v[o + 2]!, nx: v[o + 3]!, ny: v[o + 4]!, nz: v[o + 5]!, u: v[o + 6]!, v: v[o + 7]! };
}

function range(m: ExtrudedMesh, role: MeshRole) {
  return m.ranges.find((r) => r.role === role);
}

/** Sum of triangle areas of one role, projected onto the given axis plane. */
function roleArea(m: ExtrudedMesh, role: MeshRole): number {
  const r = range(m, role);
  if (!r) return 0;
  let a = 0;
  for (let i = r.first; i < r.first + r.count; i += 3) {
    const p = vert(m, m.indices[i]!), q = vert(m, m.indices[i + 1]!), s = vert(m, m.indices[i + 2]!);
    const e1 = [q.x - p.x, q.y - p.y, q.z - p.z], e2 = [s.x - p.x, s.y - p.y, s.z - p.z];
    const cx = e1[1]! * e2[2]! - e1[2]! * e2[1]!, cy = e1[2]! * e2[0]! - e1[0]! * e2[2]!, cz = e1[0]! * e2[1]! - e1[1]! * e2[0]!;
    a += Math.hypot(cx, cy, cz) / 2;
  }
  return a;
}

/** Every triangle's geometric normal agrees with its vertices' normals. */
function windingAgrees(m: ExtrudedMesh): boolean {
  for (let i = 0; i < m.indices.length; i += 3) {
    const p = vert(m, m.indices[i]!), q = vert(m, m.indices[i + 1]!), s = vert(m, m.indices[i + 2]!);
    const e1 = [q.x - p.x, q.y - p.y, q.z - p.z], e2 = [s.x - p.x, s.y - p.y, s.z - p.z];
    const gx = e1[1]! * e2[2]! - e1[2]! * e2[1]!, gy = e1[2]! * e2[0]! - e1[0]! * e2[2]!, gz = e1[0]! * e2[1]! - e1[1]! * e2[0]!;
    const nx = p.nx + q.nx + s.nx, ny = p.ny + q.ny + s.ny, nz = p.nz + q.nz + s.nz;
    if (gx * nx + gy * ny + gz * nz < 0) return false;
  }
  return true;
}

describe('extrudeOutline — box', () => {
  const mesh = extrudeOutline(rectOutline(100, 60), { depth: 40 })!;

  it('emits walls and a back cap with the right areas', () => {
    expect(mesh).not.toBeNull();
    expect(range(mesh, 'side')).toBeDefined();
    expect(range(mesh, 'back')).toBeDefined();
    expect(range(mesh, 'bevel')).toBeUndefined();
    expect(range(mesh, 'front')).toBeUndefined();
    // Perimeter × depth.
    expect(roleArea(mesh, 'side')).toBeCloseTo((100 + 60) * 2 * 40, 3);
    expect(roleArea(mesh, 'back')).toBeCloseTo(100 * 60, 3);
  });

  it('wall normals are axis-aligned and outward (hard corners split vertices)', () => {
    const r = range(mesh, 'side')!;
    const seen = new Set<string>();
    for (let i = r.first; i < r.first + r.count; i++) {
      const v = vert(mesh, mesh.indices[i]!);
      expect(v.nz).toBeCloseTo(0, 6);
      // Outward: the normal points the same way as the vertex's own offset from centre.
      expect(v.nx * v.x + v.ny * v.y).toBeGreaterThan(0);
      seen.add(`${Math.round(v.nx)},${Math.round(v.ny)}`);
    }
    expect([...seen].sort()).toEqual(['-1,0', '0,-1', '0,1', '1,0']);
  });

  it('the back cap faces +z and sits at z = depth', () => {
    const r = range(mesh, 'back')!;
    for (let i = r.first; i < r.first + r.count; i++) {
      const v = vert(mesh, mesh.indices[i]!);
      expect(v.z).toBe(40);
      expect(v.nz).toBe(1);
    }
  });

  it('winding agrees with the normals everywhere', () => {
    expect(windingAgrees(mesh)).toBe(true);
  });

  it('cap UVs span the layer box', () => {
    const r = range(mesh, 'back')!;
    let minU = 1, maxU = 0;
    for (let i = r.first; i < r.first + r.count; i++) {
      const v = vert(mesh, mesh.indices[i]!);
      minU = Math.min(minU, v.u);
      maxU = Math.max(maxU, v.u);
    }
    expect(minU).toBeCloseTo(0, 6);
    expect(maxU).toBeCloseTo(1, 6);
  });
});

describe('extrudeOutline — bevel', () => {
  it('angular bevel: a chamfer ring at each end, walls shortened, cap inset', () => {
    const m = extrudeOutline(rectOutline(100, 60), { depth: 40, bevel: 5 })!;
    expect(m.bevel).toBe(5);
    expect(range(m, 'bevel')).toBeDefined();
    // Walls now span depth − 2·bevel.
    expect(roleArea(m, 'side')).toBeCloseTo(320 * 30, 3);
    // Back cap is the inset rect.
    expect(roleArea(m, 'back')).toBeCloseTo(90 * 50, 3);
    expect(windingAgrees(m)).toBe(true);
    // Front chamfer normals point outward AND toward the viewer (−z).
    const r = range(m, 'bevel')!;
    let sawFront = false;
    for (let i = r.first; i < r.first + r.count; i++) {
      const v = vert(m, m.indices[i]!);
      if (v.z < 20) {
        sawFront = true;
        expect(v.nz).toBeLessThan(0);
        expect(Math.abs(v.nz)).toBeCloseTo(Math.SQRT1_2, 5);
      } else {
        expect(v.nz).toBeGreaterThan(0);
      }
    }
    expect(sawFront).toBe(true);
  });

  it('convex and concave profiles subdivide the ring and stay consistently wound', () => {
    for (const style of ['convex', 'concave'] as const) {
      const m = extrudeOutline(rectOutline(100, 60), { depth: 40, bevel: 8, bevelStyle: style, bevelSegments: 6 })!;
      expect(range(m, 'bevel')!.count).toBeGreaterThan(range(extrudeOutline(rectOutline(100, 60), { depth: 40, bevel: 8 })!, 'bevel')!.count);
      expect(windingAgrees(m)).toBe(true);
    }
  });

  it('the bevel is clamped to half the depth and a quarter of the outline', () => {
    expect(clampMeshBevel(rectOutline(100, 60), 40, 100)).toBe(15);
    expect(clampMeshBevel(rectOutline(100, 60), 10, 100)).toBe(5);
    expect(extrudeOutline(rectOutline(100, 60), { depth: 10, bevel: 100 })!.bevel).toBe(5);
  });
});

describe('extrudeOutline — cylinder and holes', () => {
  it('an ellipse wall is SMOOTH: one shared vertex per outline point per level', () => {
    const m = extrudeOutline(ellipseOutline(80, 80, 48), { depth: 30 })!;
    const side = range(m, 'side')!;
    const ids = new Set<number>();
    for (let i = side.first; i < side.first + side.count; i++) ids.add(m.indices[i]!);
    expect(ids.size).toBe(48 * 2);
    // Normals vary continuously around the ring (radial).
    for (const id of ids) {
      const v = vert(m, id);
      const r = Math.hypot(v.x, v.y);
      expect(v.nx).toBeCloseTo(v.x / r, 3);
      expect(v.ny).toBeCloseTo(v.y / r, 3);
    }
  });

  it('a ring with a hole (an O) gets inner walls and a cap with the hole cut out', () => {
    const outer = ellipseOutline(100, 100, 32)[0]!;
    const inner = ellipseOutline(50, 50, 24)[0]!;
    const m = extrudeOutline([outer, { points: inner.points, hole: true }], { depth: 20 })!;
    const outerArea = Math.PI * 50 * 50;
    const innerArea = Math.PI * 25 * 25;
    // Polygon areas are slightly under the true circle; compare within 2 %.
    expect(roleArea(m, 'back')).toBeGreaterThan((outerArea - innerArea) * 0.97);
    expect(roleArea(m, 'back')).toBeLessThan(outerArea - innerArea);
    // Inner wall normals point INTO the hole (toward the axis).
    const side = range(m, 'side')!;
    let innerSeen = 0;
    for (let i = side.first; i < side.first + side.count; i++) {
      const v = vert(m, m.indices[i]!);
      const r = Math.hypot(v.x, v.y);
      if (r < 30) {
        innerSeen++;
        expect(v.nx * v.x + v.ny * v.y).toBeLessThan(0);
      }
    }
    expect(innerSeen).toBeGreaterThan(0);
    expect(windingAgrees(m)).toBe(true);
  });

  it('depth 0 yields nothing', () => {
    expect(extrudeOutline(rectOutline(10, 10), { depth: 0 })).toBeNull();
  });
});

describe('bezierRunsToRings', () => {
  const corner = (x: number, y: number) => ({ x, y, inX: x, inY: y, outX: x, outY: y });
  it('flattens straight runs verbatim and flags nested runs as holes', () => {
    const outer = { points: [corner(-50, -50), corner(50, -50), corner(50, 50), corner(-50, 50)] };
    const hole = { points: [corner(-10, -10), corner(10, -10), corner(10, 10), corner(-10, 10)] };
    const rings = bezierRunsToRings([outer, hole]);
    expect(rings.length).toBe(2);
    expect(rings[0]!.hole).toBe(false);
    expect(rings[1]!.hole).toBe(true);
    expect(rings[0]!.points.length).toBe(4);
  });

  it('subdivides curved segments', () => {
    const r = 40;
    const k = 0.5523 * r;
    const circle = {
      points: [
        { x: r, y: 0, inX: r, inY: -k, outX: r, outY: k },
        { x: 0, y: r, inX: k, inY: r, outX: -k, outY: r },
        { x: -r, y: 0, inX: -r, inY: k, outX: -r, outY: -k },
        { x: 0, y: -r, inX: -k, inY: -r, outX: k, outY: -r },
      ],
    };
    const rings = bezierRunsToRings([circle]);
    expect(rings[0]!.points.length).toBeGreaterThan(16);
    for (const p of rings[0]!.points) expect(Math.hypot(p.x, p.y)).toBeCloseTo(r, 0);
  });

  it('skips open runs', () => {
    expect(bezierRunsToRings([{ points: [corner(0, 0), corner(1, 0), corner(1, 1)], open: true }])).toEqual([]);
  });
});
