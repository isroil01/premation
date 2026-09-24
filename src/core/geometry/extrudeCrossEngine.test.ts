/**
 * Cross-engine extrusion parity (plan D2). Outline recipes (rect, rounded rect,
 * ellipse, Bézier runs with a hole, a traced bitmap) × extrusion options
 * (depth, bevel size and profile, caps, hole bevel, uv box) through the
 * editor's own geometry: the fixture records each mesh as counts, ranges, the
 * clamped bevel and the FNV-1a 64 of its exact vertex / index bytes.
 * `native/engine/tests/test_extrude_parity.cpp` rebuilds every case from the
 * same recipe with the C++ port (src/scene/extrude_mesh.cpp) and must match.
 *
 * `GEN_NATIVE_EXTRUDE=1 npx jest extrudeCrossEngine` rewrites the fixture.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { bezierRunsToRings, ellipseOutline, extrudeOutline, rectOutline, type ExtrudeOptions } from './extrudeMesh';
import { traceBitmap } from './traceBitmap';
import type { Ring } from './polygonTriangulate';

const OUT = path.resolve(__dirname, '../../../native/engine/tests/data/extrude_parity.json');

type Outline =
  | { kind: 'rect'; width: number; height: number; radii: [number, number, number, number]; segmentsPer90: number }
  | { kind: 'ellipse'; width: number; height: number; segments?: number }
  | { kind: 'runs'; runs: Array<{ points: number[][]; open: boolean }>; tolerance: number }
  | { kind: 'bitmap'; width: number; height: number; alpha: number[]; threshold: number; tolerance: number; minArea: number };

function fnv1a64(view: ArrayBufferView): string {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  let h = 0xcbf29ce484222325n;
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

/** A 48×40 alpha plate: a ring (disc with a hole) and a separate square blob. */
function plate(): number[] {
  const w = 48, h = 40, out: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x + 0.5 - 18, y + 0.5 - 20);
      const inRing = d <= 14 && d >= 6;
      const inBox = x >= 36 && x < 45 && y >= 8 && y < 30;
      out.push(inRing || inBox ? 255 : 0);
    }
  }
  return out;
}

function ringsOf(o: Outline): Ring[] {
  switch (o.kind) {
    case 'rect': return rectOutline(o.width, o.height, o.radii, o.segmentsPer90);
    case 'ellipse': return ellipseOutline(o.width, o.height, o.segments);
    case 'runs':
      return bezierRunsToRings(o.runs.map((r) => ({
        open: r.open,
        points: r.points.map(([x, y, inX, inY, outX, outY]) => ({ x: x!, y: y!, inX: inX!, inY: inY!, outX: outX!, outY: outY! })),
      })), o.tolerance);
    case 'bitmap':
      return traceBitmap(Uint8Array.from(o.alpha), o.width, o.height, 1, { threshold: o.threshold, tolerance: o.tolerance, minArea: o.minArea })
        .map((c) => ({ points: c.points.map((p) => ({ x: p.x, y: p.y })), hole: c.hole }));
  }
}

/** A curved run (a teardrop) and a hole inside it, handles absolute. */
const RUNS: Array<{ points: number[][]; open: boolean }> = [
  { open: false, points: [[0, -60, -30, -60, 30, -60], [50, 20, 50, -10, 50, 50], [0, 60, 30, 60, -30, 60], [-50, 20, -50, 50, -50, -10]] },
  { open: false, points: [[-10, 0, -10, 0, -10, 0], [10, 0, 10, 0, 10, 0], [10, 20, 10, 20, 10, 20], [-10, 20, -10, 20, -10, 20]] },
  { open: true, points: [[0, 0, 0, 0, 0, 0], [5, 5, 5, 5, 5, 5], [9, 0, 9, 0, 9, 0]] },
];

const CASES: Array<{ name: string; outline: Outline; opts: ExtrudeOptions }> = [
  { name: 'rect, flat', outline: { kind: 'rect', width: 200, height: 120, radii: [0, 0, 0, 0], segmentsPer90: 8 }, opts: { depth: 40 } },
  { name: 'rect, angular bevel + front cap', outline: { kind: 'rect', width: 200, height: 120, radii: [0, 0, 0, 0], segmentsPer90: 8 }, opts: { depth: 40, bevel: 8, frontCap: true } },
  { name: 'rounded rect, convex bevel', outline: { kind: 'rect', width: 180, height: 90, radii: [20, 5, 30, 0], segmentsPer90: 6 }, opts: { depth: 30, bevel: 10, bevelStyle: 'convex', frontCap: true } },
  { name: 'rounded rect, concave bevel, no back cap', outline: { kind: 'rect', width: 160, height: 160, radii: [40, 40, 40, 40], segmentsPer90: 8 }, opts: { depth: 24, bevel: 6, bevelStyle: 'concave', bevelSegments: 5, backCap: false } },
  { name: 'ellipse, default segments', outline: { kind: 'ellipse', width: 150, height: 90 }, opts: { depth: 50, bevel: 5, frontCap: true, smoothAngleDeg: 60 } },
  { name: 'ellipse, 12 segments, oversized bevel (clamped)', outline: { kind: 'ellipse', width: 40, height: 30, segments: 12 }, opts: { depth: 10, bevel: 40, frontCap: true } },
  { name: 'Bézier runs with a hole, hole bevel scaled', outline: { kind: 'runs', runs: RUNS, tolerance: 0.5 }, opts: { depth: 30, bevel: 4, frontCap: true, holeBevelScale: 0.5, uvBox: { x: -60, y: -60, width: 120, height: 120 } } },
  { name: 'Bézier runs, no front bevel', outline: { kind: 'runs', runs: RUNS, tolerance: 0.75 }, opts: { depth: 20, bevel: 3, frontCap: true, frontBevel: false } },
  { name: 'traced bitmap (ring + box)', outline: { kind: 'bitmap', width: 48, height: 40, alpha: plate(), threshold: 128, tolerance: 1, minArea: 4 }, opts: { depth: 12, bevel: 1.5, frontCap: true } },
];

interface Row {
  name: string;
  outline: Outline;
  opts: ExtrudeOptions;
  mesh: null | { vertexCount: number; indexCount: number; index32: boolean; bevel: number; ranges: Array<{ role: string; first: number; count: number }>; verticesFnv: string; indicesFnv: string };
}

function generate(): Row[] {
  return CASES.map((c) => {
    const m = extrudeOutline(ringsOf(c.outline), c.opts);
    return {
      name: c.name,
      outline: c.outline,
      opts: c.opts,
      mesh: m
        ? {
            vertexCount: m.vertexCount,
            indexCount: m.indices.length,
            index32: m.indices instanceof Uint32Array,
            bevel: m.bevel,
            ranges: m.ranges.map((r) => ({ role: r.role, first: r.first, count: r.count })),
            verticesFnv: fnv1a64(m.vertices),
            indicesFnv: fnv1a64(m.indices),
          }
        : null,
    };
  });
}

test('the C++ extrusion parity fixture matches extrudeOutline', () => {
  const rows = generate();
  const text = `${JSON.stringify({ comment: 'Generated by src/core/geometry/extrudeCrossEngine.test.ts (GEN_NATIVE_EXTRUDE=1). Do not edit.', rows })}\n`;
  if (process.env.GEN_NATIVE_EXTRUDE === '1') {
    writeFileSync(OUT, text);
    return;
  }
  expect(existsSync(OUT)).toBe(true);
  expect((JSON.parse(readFileSync(OUT, 'utf8')) as { rows: Row[] }).rows).toEqual(JSON.parse(JSON.stringify(rows)));
  expect(rows.every((r) => r.mesh && r.mesh.vertexCount > 0)).toBe(true);
});
