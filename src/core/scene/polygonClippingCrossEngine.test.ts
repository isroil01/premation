/**
 * Cross-engine parity of polygon-clipping (plan D2w).
 *
 * Live Merge Paths (mergePaths.ts booleanPolygons) and Offset Paths' cleanup run
 * `polygon-clipping` (Martinez–Rueda over a splay-tree sweep). The C++ port
 * (`native/engine/src/scene/polygon_clipping.cpp`, with splaytree and
 * robust-predicates' orient2d) must return the same rings — start point,
 * winding and every coordinate — so this test runs the library over shapes that
 * exercise its hard cases (shared and colinear edges, T-junctions, snapped
 * near-coincident vertices, self-intersecting rings, holes, disjoint islands,
 * several clipping operands, all four operations) and stores the results in
 * `native/engine/tests/data/polygon_clipping_parity.json`; the C++ test
 * requires them exactly.
 *
 * `GEN_NATIVE_PC=1 npx jest polygonClippingCrossEngine` rewrites the fixture.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import polygonClipping, { type MultiPolygon, type Polygon, type Pair } from 'polygon-clipping';

const OUT = path.resolve(__dirname, '../../../native/engine/tests/data/polygon_clipping_parity.json');

const rect = (x: number, y: number, w: number, h: number): Pair[] => [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
const circle = (cx: number, cy: number, r: number, n: number, phase = 0): Pair[] => {
  const out: Pair[] = [];
  for (let i = 0; i < n; i++) {
    const a = phase + (i / n) * Math.PI * 2;
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  out.push(out[0]!);
  return out;
};
const star = (cx: number, cy: number, ro: number, ri: number, n: number, phase = 0): Pair[] => {
  const out: Pair[] = [];
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 === 0 ? ro : ri;
    const a = phase + (i * Math.PI) / n;
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  out.push(out[0]!);
  return out;
};
/** A deterministic LCG so the fixture is stable. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const blob = (seed: number, cx: number, cy: number, r: number, n: number): Pair[] => {
  const rnd = lcg(seed);
  const out: Pair[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = r * (0.6 + 0.8 * rnd());
    out.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
  }
  out.push(out[0]!);
  return out;
};

interface Case { name: string; subject: MultiPolygon; clipping: MultiPolygon[] }

const CASES: Case[] = [
  { name: 'overlapping rects', subject: [[rect(0, 0, 100, 80)]], clipping: [[[rect(50, 40, 100, 80)]]] },
  { name: 'shared edge (colinear)', subject: [[rect(0, 0, 100, 100)]], clipping: [[[rect(100, 0, 100, 100)]]] },
  { name: 'T-junction partial edge', subject: [[rect(0, 0, 100, 100)]], clipping: [[[rect(100, 25, 60, 50)]]] },
  { name: 'contained with hole result', subject: [[rect(0, 0, 200, 200)]], clipping: [[[rect(50, 50, 100, 100)]]] },
  { name: 'disjoint islands', subject: [[rect(0, 0, 50, 50)]], clipping: [[[rect(100, 100, 50, 50)]]] },
  { name: 'circles (flattened ellipses)', subject: [[circle(0, 0, 80, 32)]], clipping: [[[circle(60, 10, 70, 32, 0.1)]]] },
  { name: 'stars', subject: [[star(0, 0, 100, 40, 5)]], clipping: [[[star(30, 20, 90, 35, 7, 0.3)]]] },
  { name: 'three operands', subject: [[circle(0, 0, 60, 24)]], clipping: [[[rect(-10, -80, 20, 160)]], [[star(40, 0, 50, 20, 6)]]] },
  { name: 'polygon with a hole vs rect', subject: [[rect(0, 0, 200, 200), rect(50, 50, 100, 100).slice().reverse()]], clipping: [[[rect(120, 20, 150, 60)]]] },
  { name: 'self-intersecting bow tie', subject: [[[[0, 0], [100, 100], [100, 0], [0, 100], [0, 0]]]], clipping: [[[rect(25, 25, 50, 50)]]] },
  { name: 'near-coincident vertices (snap)', subject: [[rect(0, 0, 100, 100)]], clipping: [[[[100 + 1e-14, 0], [200, 0], [200, 100], [100 - 1e-14, 100], [100 + 1e-14, 0]]]] },
  { name: 'identical polygons', subject: [[star(0, 0, 50, 20, 5)]], clipping: [[[star(0, 0, 50, 20, 5)]]] },
  { name: 'random blobs A', subject: [[blob(1, 0, 0, 100, 40)]], clipping: [[[blob(2, 40, 30, 90, 36)]]] },
  { name: 'random blobs B', subject: [[blob(3, 0, 0, 120, 60)]], clipping: [[[blob(4, -30, 20, 80, 50)]], [[blob(5, 50, -40, 70, 44)]]] },
  { name: 'many small circles', subject: [[circle(0, 0, 30, 16)]], clipping: [0, 1, 2, 3, 4].map((i) => [[circle(i * 25 - 50, (i % 2) * 20, 28, 16, i * 0.2)]]) },
  { name: 'rotated squares', subject: [[circle(0, 0, 70.7, 4, Math.PI / 4)]], clipping: [[[circle(0, 0, 70.7, 4, 0)]]] },
];

const OPS = ['union', 'intersection', 'xor', 'difference'] as const;

/** The library accepts a Polygon or a MultiPolygon; the fixture stores MultiPolygons. */
const asMulti = (g: Polygon | MultiPolygon): MultiPolygon =>
  (typeof (g as unknown as number[][][])[0]![0]![0] === 'number' ? [g as Polygon] : (g as MultiPolygon));

function generate(): unknown[] {
  const out: unknown[] = [];
  for (const raw of CASES) {
    const c = { ...raw, subject: asMulti(raw.subject), clipping: raw.clipping.map(asMulti) };
    for (const op of OPS) {
      let result: MultiPolygon | null = null;
      let error: string | null = null;
      try {
        result = (polygonClipping[op] as (g: Polygon | MultiPolygon, ...m: Array<Polygon | MultiPolygon>) => MultiPolygon)(c.subject, ...c.clipping);
      } catch (e) {
        error = (e as Error).message;
      }
      out.push({ name: `${c.name} / ${op}`, op, subject: c.subject, clipping: c.clipping, result, error });
    }
  }
  return out;
}

test('the C++ polygon-clipping parity fixture matches polygon-clipping', () => {
  const cases = generate();
  const text = `${JSON.stringify({ comment: 'Generated by src/core/scene/polygonClippingCrossEngine.test.ts (GEN_NATIVE_PC=1). Do not edit.', cases })}\n`;
  if (process.env.GEN_NATIVE_PC === '1') {
    writeFileSync(OUT, text);
  } else {
    expect(existsSync(OUT)).toBe(true);
    expect(JSON.parse(readFileSync(OUT, 'utf8'))).toEqual(JSON.parse(text));
  }
  expect((cases as Array<{ result: unknown }>).filter((c) => c.result !== null).length).toBeGreaterThan(50);
});
