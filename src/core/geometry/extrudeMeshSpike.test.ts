/**
 * A bevelled acute corner must not grow a spike. The inset ring is mitred
 * along each corner's bisector, and at a sharp tip (the leg of an R, the
 * apex of an A) that miter runs far past the outline's own thickness — so
 * every bevel and front-cap vertex has to stay INSIDE the outline the mesh
 * was built from.
 */
import { extrudeOutline, MESH_VERTEX_FLOATS, type ExtrudedMesh } from './extrudeMesh';
import type { Pt2 } from './polygonTriangulate';

function inside(ring: ReadonlyArray<Pt2>, x: number, y: number): boolean {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!;
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

function distToRing(ring: ReadonlyArray<Pt2>, x: number, y: number): number {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!;
    const dx = b.x - a.x, dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t)));
  }
  return best;
}

/** A leg with a 20° tip, like the diagonal stroke of an R. */
function wedge(): Pt2[] {
  return [
    { x: -100, y: -60 }, { x: 100, y: -60 }, { x: 100, y: -30 },
    { x: 20, y: -30 }, { x: 60, y: 90 }, { x: 40, y: 95 }, { x: 0, y: -30 }, { x: -100, y: -30 },
  ];
}

function outsideBy(m: ExtrudedMesh, ring: ReadonlyArray<Pt2>): number {
  let worst = 0;
  for (let i = 0; i < m.vertexCount; i++) {
    const o = i * MESH_VERTEX_FLOATS;
    const x = m.vertices[o]!, y = m.vertices[o + 1]!;
    if (!inside(ring, x, y)) worst = Math.max(worst, distToRing(ring, x, y));
  }
  return worst;
}

/**
 * The same leg as a bitmap trace draws it: the tip is not one vertex but a
 * short arc of close points turning through ~160 degrees. That is the shape
 * whose mitres used to escape: each tip vertex's bisector points a little
 * sideways, the arc-length clearance reads the far wall as "the ring merely
 * continuing", and the 2.9x mitre limit ran out through the other edge.
 */
function tracedWedge(): Pt2[] {
  const pts: Pt2[] = [{ x: -100, y: -60 }, { x: 100, y: -60 }, { x: 100, y: -30 }, { x: 20, y: -30 }];
  const c = { x: 50, y: 90 };
  for (let k = 0; k <= 6; k++) {
    const a = (-20 + (k / 6) * 220) * (Math.PI / 180);
    pts.push({ x: c.x + Math.cos(a) * 2.5, y: c.y + Math.sin(a) * 2.5 });
  }
  pts.push({ x: 0, y: -30 }, { x: -100, y: -30 });
  return pts;
}

/** Shoelace area of the front bevel row (z = 0, angular profile): the inset ring in corner order. */
function insetRingArea(m: ExtrudedMesh): number {
  const bev = m.ranges.find((r) => r.role === 'bevel')!;
  const ids = new Set<number>();
  for (let k = bev.first; k < bev.first + bev.count; k++) ids.add(m.indices[k]!);
  const ring = [...ids].sort((a, b) => a - b).filter((k) => m.vertices[k * MESH_VERTEX_FLOATS + 2] === 0)
    .map((k) => ({ x: m.vertices[k * MESH_VERTEX_FLOATS]!, y: m.vertices[k * MESH_VERTEX_FLOATS + 1]! }));
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j]!.x * ring[i]!.y - ring[i]!.x * ring[j]!.y;
  return Math.abs(a) / 2;
}

function capArea(m: ExtrudedMesh): number {
  const fr = m.ranges.find((r) => r.role === 'front')!;
  let a = 0;
  for (let k = fr.first; k < fr.first + fr.count; k += 3) {
    const [p, q, r] = [0, 1, 2].map((d) => { const o = m.indices[k + d]! * MESH_VERTEX_FLOATS; return { x: m.vertices[o]!, y: m.vertices[o + 1]! }; });
    a += Math.abs((q!.x - p!.x) * (r!.y - p!.y) - (r!.x - p!.x) * (q!.y - p!.y)) / 2;
  }
  return a;
}

/**
 * An M's bottom notch as a trace draws it: two legs meeting in a sharp V,
 * with every corner a small arc. Offsetting it naively crosses the V's
 * inset edges before the notch and folds every arc into a loop; the cap's
 * ear clipping then keeps a fraction of the letter.
 */
function tracedNotch(): Pt2[] {
  const pts: Pt2[] = [];
  const arc = (cx: number, cy: number, r: number, a0: number, a1: number, k = 6) => {
    for (let i = 0; i <= k; i++) { const a = (a0 + ((a1 - a0) * i) / k) * (Math.PI / 180); pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r }); }
  };
  arc(-97, -97, 3, 180, 270); arc(97, -97, 3, 270, 360); // top corners
  pts.push({ x: 100, y: 100 }, { x: 70, y: 100 }, { x: 70, y: -40 });
  arc(3, 40, 3, 0, 180); // the notch's apex, rounded and tiny
  pts.push({ x: -70, y: -40 }, { x: -70, y: 100 }, { x: -100, y: 100 });
  return pts;
}

describe('extrudeOutline — acute corners', () => {
  it('a traced notch keeps a simple inset ring, so the cap covers the whole inset', () => {
    const ring = tracedNotch();
    const m = extrudeOutline([{ points: ring, hole: false }], { depth: 140, bevel: 10, bevelStyle: 'angular', frontCap: true })!;
    expect(m).not.toBeNull();
    expect(outsideBy(m, ring)).toBeLessThan(0.5);
    const inset = insetRingArea(m);
    expect(inset).toBeGreaterThan(0);
    expect(capArea(m)).toBeCloseTo(inset, 0);
  });

  it.each(['angular', 'convex'] as const)('%s bevel on a TRACED tip (an arc of close points) stays inside', (style) => {
    const ring = tracedWedge();
    const m = extrudeOutline([{ points: ring, hole: false }], { depth: 140, bevel: 12, bevelStyle: style, bevelSegments: 5, frontCap: true })!;
    expect(m).not.toBeNull();
    expect(outsideBy(m, ring)).toBeLessThan(0.5);
  });

  it.each(['angular', 'convex', 'concave'] as const)('%s bevel keeps every vertex inside the outline', (style) => {
    const ring = wedge();
    const m = extrudeOutline([{ points: ring, hole: false }], { depth: 140, bevel: 40, bevelStyle: style, bevelSegments: 5, frontCap: true })!;
    expect(m).not.toBeNull();
    // A vertex sitting ON the outline reads as outside by float noise; anything past ~0.5px is a spike.
    expect(outsideBy(m, ring)).toBeLessThan(0.5);
  });
});
