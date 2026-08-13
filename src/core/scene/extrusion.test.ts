import { extrusionFaces, clampBevel, EXTRUSION_WALL_GAIN, EXTRUSION_BACK_GAIN, ELLIPSE_WALL_SEGMENTS } from './extrusion';
import { Matrix4Math } from '@motion/scene';

const W = 100, H = 60, D = 40;

function corners(m: import('@motion/scene').Matrix4, w: number, h: number) {
  return [
    { x: -w / 2, y: -h / 2 }, { x: w / 2, y: -h / 2 },
    { x: -w / 2, y: h / 2 }, { x: w / 2, y: h / 2 },
  ].map((p) => Matrix4Math.transformPoint(m, { x: p.x, y: p.y, z: 0 }));
}

describe('extrusionFaces — rect box geometry', () => {
  const faces = extrusionFaces(W, H, D, 'rect');
  const by = (s: string) => faces.find((f) => f.suffix === s)!;

  it('returns back cap first, then 4 walls', () => {
    expect(faces.map((f) => f.suffix)).toEqual(['back', 'r', 'l', 't', 'b']);
    expect(faces[0]!.role).toBe('back');
    expect(faces.slice(1).every((f) => f.role === 'wall')).toBe(true);
  });

  it('back cap: the front plane translated to z = d', () => {
    const f = by('back');
    expect(f.w).toBe(W); expect(f.h).toBe(H);
    for (const c of corners(f.m, f.w, f.h)) expect(c.z).toBeCloseTo(D, 9);
    const o = Matrix4Math.transformPoint(f.m, { x: 0, y: 0, z: 0 });
    expect(o).toEqual({ x: 0, y: 0, z: D });
    // Corners land exactly over the front face's corners.
    const cs = corners(f.m, f.w, f.h);
    expect(cs[0]!.x).toBeCloseTo(-W / 2); expect(cs[0]!.y).toBeCloseTo(-H / 2);
    expect(cs[3]!.x).toBeCloseTo(W / 2); expect(cs[3]!.y).toBeCloseTo(H / 2);
  });

  it('right wall: d×h plane on the x = +w/2 plane spanning z ∈ [0, d]', () => {
    const f = by('r');
    expect(f.w).toBe(D); expect(f.h).toBe(H);
    const cs = corners(f.m, f.w, f.h);
    for (const c of cs) {
      expect(c.x).toBeCloseTo(W / 2, 9);
      expect(Math.abs(c.y)).toBeCloseTo(H / 2, 9);
    }
    const zs = cs.map((c) => c.z).sort((a, b) => a - b);
    expect(zs[0]).toBeCloseTo(0, 9);
    expect(zs[3]).toBeCloseTo(D, 9);
  });

  it('left wall mirrors at x = −w/2', () => {
    const cs = corners(by('l').m, D, H);
    for (const c of cs) expect(c.x).toBeCloseTo(-W / 2, 9);
    expect(Math.min(...cs.map((c) => c.z))).toBeCloseTo(0, 9);
    expect(Math.max(...cs.map((c) => c.z))).toBeCloseTo(D, 9);
  });

  it('top and bottom walls: w×d planes at y = ∓h/2 spanning z ∈ [0, d]', () => {
    for (const [s, y] of [['t', -H / 2], ['b', H / 2]] as const) {
      const f = by(s);
      expect(f.w).toBe(W); expect(f.h).toBe(D);
      const cs = corners(f.m, f.w, f.h);
      for (const c of cs) {
        expect(c.y).toBeCloseTo(y, 9);
        expect(Math.abs(c.x)).toBeCloseTo(W / 2, 9);
      }
      expect(Math.min(...cs.map((c) => c.z))).toBeCloseTo(0, 9);
      expect(Math.max(...cs.map((c) => c.z))).toBeCloseTo(D, 9);
    }
  });

  it('wall normals point along the box axes (per-face +Z after transform)', () => {
    // The face matrix's +Z axis is the plane normal the lit path shades by.
    const n = (s: string) => Matrix4Math.transformVector(by(s).m, { x: 0, y: 0, z: 1 });
    expect(Math.abs(n('r').x)).toBeCloseTo(1, 9); // side walls face ±X
    expect(Math.abs(n('t').y)).toBeCloseTo(1, 9); // top/bottom face ±Y
    expect(Math.abs(n('back').z)).toBeCloseTo(1, 9);
  });

  it('d = 0 (or non-positive box) synthesizes nothing', () => {
    expect(extrusionFaces(W, H, 0)).toEqual([]);
    expect(extrusionFaces(W, H, -10)).toEqual([]);
    expect(extrusionFaces(0, H, D)).toEqual([]);
  });
});

describe('extrusionFaces — ellipse segmented wall', () => {
  const faces = extrusionFaces(W, H, D, 'ellipse');

  it('returns back cap + N chord strips', () => {
    expect(faces[0]!.role).toBe('back');
    expect(faces.length).toBe(1 + ELLIPSE_WALL_SEGMENTS);
  });

  it('strip corners land ON the ellipse outline at z = 0 and z = d', () => {
    const a = W / 2, b = H / 2;
    for (const f of faces.slice(1)) {
      expect(f.h).toBe(D);
      const cs = corners(f.m, f.w, f.h);
      const zs = cs.map((c) => c.z).sort((p, q) => p - q);
      expect(zs[0]).toBeCloseTo(0, 9);
      expect(zs[3]).toBeCloseTo(D, 9);
      for (const c of cs) {
        const r = (c.x / a) ** 2 + (c.y / b) ** 2;
        expect(r).toBeCloseTo(1, 9); // exactly on the outline
      }
    }
  });

  it('strips chain: consecutive strips share chord endpoints (closed ring)', () => {
    const ends = faces.slice(1).map((f) =>
      corners(f.m, f.w, f.h).filter((c) => Math.abs(c.z) < 1e-9),
    );
    const near = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      Math.hypot(a.x - b.x, a.y - b.y) < 1e-6;
    for (let i = 0; i < ends.length; i++) {
      const next = ends[(i + 1) % ends.length]!;
      // One endpoint of strip i equals one endpoint of strip i+1.
      expect(ends[i]!.some((e) => next.some((n) => near(e, n)))).toBe(true);
    }
  });
});

describe('extrusionFaces — rect bevel (chamfer rings)', () => {
  const B = 10;
  const faces = extrusionFaces(W, H, D, 'rect', undefined, { bevel: B });
  const by = (s: string) => faces.find((f) => f.suffix === s)!;

  it('bevel = 0 is byte-identical to the unbevelled box', () => {
    const plain = extrusionFaces(W, H, D, 'rect');
    const zero = extrusionFaces(W, H, D, 'rect', undefined, { bevel: 0 });
    expect(zero).toEqual(plain);
  });

  it('emits back + 4 walls + 2 chamfer rings (13 faces)', () => {
    expect(faces.map((f) => f.suffix)).toEqual([
      'back', 'r', 'l', 't', 'b',
      'cfr', 'cfl', 'cft', 'cfb', // front ring
      'cbr', 'cbl', 'cbt', 'cbb', // back ring
    ]);
  });

  it('back cap is inset by b on every side (w−2b × h−2b), still at z = d', () => {
    const f = by('back');
    expect(f.w).toBe(W - 2 * B);
    expect(f.h).toBe(H - 2 * B);
    for (const c of corners(f.m, f.w, f.h)) expect(c.z).toBeCloseTo(D, 9);
  });

  it('walls retreat to span z ∈ [b, d−b] (depth d−2b)', () => {
    const r = by('r');
    expect(r.w).toBe(D - 2 * B); // side-wall plane is now shorter in depth
    const zs = corners(r.m, r.w, r.h).map((c) => c.z).sort((a, b) => a - b);
    expect(zs[0]).toBeCloseTo(B, 9);
    expect(zs[3]).toBeCloseTo(D - B, 9);
  });

  it('front chamfer bridges the shrunk front (z=0) to the wall front (z=b)', () => {
    const cs = corners(by('cfr').m, by('cfr').w, by('cfr').h);
    const zs = cs.map((c) => c.z).sort((a, b) => a - b);
    expect(zs[0]).toBeCloseTo(0, 9);       // inner edge on the front plane
    expect(zs[3]).toBeCloseTo(B, 9);       // outer edge at the wall front
    const xInner = cs.filter((c) => c.z < B / 2).map((c) => c.x);
    const xOuter = cs.filter((c) => c.z > B / 2).map((c) => c.x);
    for (const x of xInner) expect(x).toBeCloseTo(W / 2 - B, 9);
    for (const x of xOuter) expect(x).toBeCloseTo(W / 2, 9);
  });

  it('back chamfer bridges the wall back (z=d−b) to the shrunk back (z=d)', () => {
    const zs = corners(by('cbr').m, by('cbr').w, by('cbr').h).map((c) => c.z).sort((a, b) => a - b);
    expect(zs[0]).toBeCloseTo(D - B, 9);
    expect(zs[3]).toBeCloseTo(D, 9);
  });

  it('front chamfer normals point OUTWARD + FORWARD (−z, toward viewer)', () => {
    const n = (s: string) => Matrix4Math.transformVector(by(s).m, { x: 0, y: 0, z: 1 });
    // Right/left face ±x, top/bottom face ∓y — all with a forward (−z) tilt.
    expect(n('cfr').x).toBeGreaterThan(0.5); expect(n('cfr').z).toBeLessThan(-0.5);
    expect(n('cfl').x).toBeLessThan(-0.5);   expect(n('cfl').z).toBeLessThan(-0.5);
    expect(n('cft').y).toBeLessThan(-0.5);   expect(n('cft').z).toBeLessThan(-0.5);
    expect(n('cfb').y).toBeGreaterThan(0.5); expect(n('cfb').z).toBeLessThan(-0.5);
  });

  it('back chamfer normals point OUTWARD + BACKWARD (+z, away from viewer)', () => {
    const n = (s: string) => Matrix4Math.transformVector(by(s).m, { x: 0, y: 0, z: 1 });
    expect(n('cbr').x).toBeGreaterThan(0.5); expect(n('cbr').z).toBeGreaterThan(0.5);
    expect(n('cbl').x).toBeLessThan(-0.5);   expect(n('cbl').z).toBeGreaterThan(0.5);
    expect(n('cbt').y).toBeLessThan(-0.5);   expect(n('cbt').z).toBeGreaterThan(0.5);
    expect(n('cbb').y).toBeGreaterThan(0.5); expect(n('cbb').z).toBeGreaterThan(0.5);
  });

  it('clampBevel never inverts geometry: capped at min(w,h)/2 and d/2', () => {
    expect(clampBevel(W, H, D, 10)).toBe(10);
    expect(clampBevel(W, H, D, 999)).toBe(Math.min(W / 2, H / 2, D / 2)); // = d/2 = 20
    expect(clampBevel(W, H, D, 0)).toBe(0);
    expect(clampBevel(W, H, D, -5)).toBe(0);
    expect(clampBevel(0, H, D, 10)).toBe(0);
  });

  it('at the clamp limit (b = d/2) zero-depth walls are omitted, caps + rings remain', () => {
    const capped = extrusionFaces(W, H, D, 'rect', undefined, { bevel: 999 });
    expect(capped.some((f) => f.suffix === 'r')).toBe(false); // wall depth d−2b = 0
    expect(capped.find((f) => f.suffix === 'back')).toBeDefined();
    expect(capped.filter((f) => f.suffix.startsWith('cf') || f.suffix.startsWith('cb'))).toHaveLength(8);
  });

  it('ellipse ignores bevel (deferred): still back cap + N chord strips', () => {
    const e = extrusionFaces(W, H, D, 'ellipse', undefined, { bevel: 10 });
    expect(e.length).toBe(1 + ELLIPSE_WALL_SEGMENTS);
    expect(e.every((f) => !f.suffix.startsWith('cf') && !f.suffix.startsWith('cb'))).toBe(true);
  });
});

describe('extrusion shading constants', () => {
  it('walls are brighter than the back cap, both < 1 (front stays full)', () => {
    expect(EXTRUSION_WALL_GAIN).toBeGreaterThan(EXTRUSION_BACK_GAIN);
    expect(EXTRUSION_WALL_GAIN).toBeLessThan(1);
    expect(EXTRUSION_BACK_GAIN).toBeGreaterThan(0);
  });
});

/**
 * Winding — every face's normal points OUT of the solid.
 *
 * ── Why nothing above catches this ──────────────────────────────────────────
 *
 * Left shared `Ry(90°)` with right and bottom shared `Rx(90°)` with top, so
 * each pair carried the SAME normal and one of every pair pointed into the
 * body. The suite above passed throughout, and had to: mirroring a quad within
 * its own plane moves no corner, and every existing assertion is about where
 * corners land. Two-sided lighting (`abs(dot(N, L))`, in `lightShading.ts` and
 * all four `builtin.ts` shaders) then made the wrong sign render identically to
 * the right one.
 *
 * So the normal is asserted directly, against the face's own position on the
 * body — the only statement of the property that does not go through pixels or
 * through corners.
 */
describe('extrusionFaces — face winding', () => {
  /** A face's outward direction: its own +Z axis (columns 8..10). */
  const normalOf = (m: import('@motion/scene').Matrix4) => {
    const n = [m[8]!, m[9]!, m[10]!];
    const len = Math.hypot(n[0]!, n[1]!, n[2]!) || 1;
    return n.map((v) => v / len) as [number, number, number];
  };
  /** Where the face sits, in the layer's centred frame. */
  const centreOf = (m: import('@motion/scene').Matrix4) => [m[12]!, m[13]!, m[14]!] as const;

  /**
   * A wall's normal must point AWAY from the body's axis, i.e. agree in sign
   * with its own offset from the centre line. Stated as a dot product rather
   * than as literal vectors so it holds for the chamfer rings and the ellipse
   * ring too, whose normals are diagonal.
   */
  const pointsOutward = (m: import('@motion/scene').Matrix4) => {
    const n = normalOf(m);
    const c = centreOf(m);
    // Only the planar offset — z is the extrusion axis, along which every wall
    // sits at d/2 and carries no outward component.
    return n[0]! * c[0]! + n[1]! * c[1]! > 0;
  };

  it('opposing walls of a box carry OPPOSED normals', () => {
    const faces = extrusionFaces(W, H, D, 'rect');
    const by = (s: string) => normalOf(faces.find((f) => f.suffix === s)!.m);
    const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
    // Exactly −1: the walls are parallel planes, so anything else is not a
    // winding difference but a geometry one.
    expect(dot(by('r'), by('l'))).toBeCloseTo(-1, 9);
    expect(dot(by('t'), by('b'))).toBeCloseTo(-1, 9);
  });

  it('every wall of a box points out of the body', () => {
    for (const f of extrusionFaces(W, H, D, 'rect')) {
      if (f.role !== 'wall') continue;
      expect([f.suffix, pointsOutward(f.m)]).toEqual([f.suffix, true]);
    }
  });

  it('every wall STRIP points out of the body (the gradient split)', () => {
    // The split path repeated the shared-rotation mistake verbatim, twenty
    // strips at a time, so it needs its own assertion rather than trusting the
    // unsplit case to stand for it.
    for (const f of extrusionFaces(W, H, D, 'rect', undefined, { wallSegments: 20 })) {
      if (f.role !== 'wall') continue;
      expect([f.suffix, pointsOutward(f.m)]).toEqual([f.suffix, true]);
    }
  });

  it('every bevel chamfer points out of the body', () => {
    for (const f of extrusionFaces(W, H, D, 'rect', undefined, { bevel: 8 })) {
      if (f.role !== 'wall') continue;
      expect([f.suffix, pointsOutward(f.m)]).toEqual([f.suffix, true]);
    }
  });

  it('every facet of an ellipse ring points out of the body', () => {
    for (const f of extrusionFaces(W, H, D, 'ellipse')) {
      if (f.role !== 'wall') continue;
      expect([f.suffix, pointsOutward(f.m)]).toEqual([f.suffix, true]);
    }
  });

  it('every facet of a rounded-rect outline points out of the body', () => {
    for (const f of extrusionFaces(W, H, D, 'rect', undefined, { cornerRadius: 16 })) {
      if (f.role !== 'wall') continue;
      expect([f.suffix, pointsOutward(f.m)]).toEqual([f.suffix, true]);
    }
  });

  it('the back cap faces away from the viewer (+z is away, see project3d)', () => {
    const back = extrusionFaces(W, H, D, 'rect').find((f) => f.suffix === 'back')!;
    expect(normalOf(back.m)[2]).toBeCloseTo(1, 9);
  });
});
