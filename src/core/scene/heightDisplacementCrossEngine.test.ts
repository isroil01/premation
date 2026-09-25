/**
 * Cross-engine height displacement parity (plan D2w 3D leftovers). For a
 * spread of meshes × fields × amounts × subdivision counts the fixture
 * records what `displacedMeshFor` produces: the cache key, the displaced
 * interleaved vertices and the (always 32-bit) indices as FNV-1a 64 of their
 * exact bytes, and the triangle scale. The C++ port
 * (`native/engine/src/scene/height_displacement.cpp`,
 * tests/test_height_displacement_parity.cpp) rebuilds each mesh — primitives
 * from their `prim:` key, the hand-made meshes from the fixture — and must
 * match byte for byte.
 *
 * Includes the `primitive-displaced-sphere` golden's exact mesh, field and
 * amount: that golden primes its field in memory (`prime:bumps`), so its
 * project document cannot carry it and this fixture is what pins the port.
 *
 * `GEN_NATIVE_HEIGHT=1 npx jest heightDisplacementCrossEngine` rewrites the
 * fixture; without it this test fails when the fixture is stale.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SceneNode } from '@core/types';
import { defaultPrimitiveSpec, makePrimitiveComponent, primitiveEntryFor, clearPrimitiveMeshCache, type PrimitiveSpec } from './primitiveLayer';
import { displacedMeshFor, type HeightField } from './heightDisplacement';

const OUT = path.resolve(__dirname, '../../../native/engine/tests/data/height_displacement_parity.json');

function node(spec: PrimitiveSpec): SceneNode {
  return { id: 'p', name: 'p', parent: null, children: [], visible: true, locked: false, components: [makePrimitiveComponent('p', spec)] } as unknown as SceneNode;
}

function fnv1a64(view: ArrayBufferView): string {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  let h = 0xcbf29ce484222325n;
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

/** The golden's field (render-tests/harness/scenes/primitives.ts bumpsField). */
function bumps(): HeightField {
  const w = 64; const h = 64;
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      data[y * w + x] = 0.5 + 0.5 * Math.sin((x / w) * Math.PI * 2 * 6) * Math.sin((y / h) * Math.PI * 2 * 4);
    }
  }
  return { width: w, height: h, data };
}

/** A seeded noise field (LCG) — every texel different, non-square. */
function noise(w: number, h: number, seed: number): HeightField {
  const data = new Float32Array(w * h);
  let s = seed >>> 0;
  for (let i = 0; i < data.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    data[i] = s / 4294967296;
  }
  return { width: w, height: h, data };
}

const FIELDS: Record<string, HeightField> = {
  'prime:bumps': bumps(),
  'noise:17x9': noise(17, 9, 7),
  flat: { width: 1, height: 1, data: Float32Array.of(0.75) },
};

interface MeshIn { name: string; key: string; vertices: Float32Array; indices: Uint16Array | Uint32Array; prim: boolean }

function primMesh(spec: PrimitiveSpec): MeshIn {
  const e = primitiveEntryFor(node(spec))!;
  return { name: e.key, key: e.key, vertices: e.vertices, indices: e.indices, prim: true };
}

/** A quad of two triangles with its own (duplicated) corners, uv 0..1. */
function quad(): MeshIn {
  const v = Float32Array.of(
    -50, -50, 0, 0, 0, -1, 0, 0,
    50, -50, 0, 0, 0, -1, 1, 0,
    50, 50, 0, 0, 0, -1, 1, 1,
    -50, -50, 0, 0, 0, -1, 0, 0,
    50, 50, 0, 0, 0, -1, 1, 1,
    -50, 50, 0, 0, 0, -1, 0, 1,
  );
  return { name: 'quad', key: 'mesh:quad', vertices: v, indices: Uint16Array.of(0, 1, 2, 3, 4, 5), prim: false };
}

/** Uneven values, a trailing partial triangle, uv outside 0..1 (clamped). */
function ragged(): MeshIn {
  const v = Float32Array.of(
    0.1, 0.2, 0.3, 0.6, 0.0, 0.8, -0.25, 0.5,
    10.7, -3.3, 1.9, 0.0, 1.0, 0.0, 0.33, 1.4,
    -7.25, 4.125, -2.5, 0.0, 0.0, 1.0, 0.9, 0.1,
    3.3, 3.3, 3.3, 0.577, 0.577, 0.577, 0.5, 0.5,
  );
  return { name: 'ragged', key: 'mesh:ragged', vertices: v, indices: Uint32Array.of(0, 1, 2, 2, 1, 3, 0, 3), prim: false };
}

const sphereGolden = { ...defaultPrimitiveSpec('sphere'), radius: 96, radialSegments: 36, heightSegments: 18 };

interface Case { mesh: () => MeshIn; field: keyof typeof FIELDS; amount: number; subdivisions: number }

const CASES: Case[] = [
  // The golden: primitive-displaced-sphere (radius 96, 36 × 18, 22 px, one subdivision).
  { mesh: () => primMesh(sphereGolden), field: 'prime:bumps', amount: 22, subdivisions: 1 },
  { mesh: () => primMesh(sphereGolden), field: 'noise:17x9', amount: -13.25, subdivisions: 0 },
  { mesh: () => primMesh(defaultPrimitiveSpec('box')), field: 'prime:bumps', amount: 9.5, subdivisions: 2 },
  { mesh: () => primMesh({ ...defaultPrimitiveSpec('cylinder'), capped: false, radialSegments: 9 }), field: 'noise:17x9', amount: 30, subdivisions: 1.7 },
  { mesh: () => primMesh({ ...defaultPrimitiveSpec('torus', 180), radialSegments: 12, heightSegments: 6 }), field: 'flat', amount: 4.0005, subdivisions: 3 },
  { mesh: quad, field: 'noise:17x9', amount: 12, subdivisions: 5 }, // clamped to 3
  { mesh: quad, field: 'prime:bumps', amount: 0.1, subdivisions: -2 }, // clamped to 0
  { mesh: ragged, field: 'noise:17x9', amount: 2.5, subdivisions: 2 },
  { mesh: ragged, field: 'flat', amount: -1e-3, subdivisions: 1 },
];

interface Row {
  mesh: string;
  prim: boolean;
  vertices?: number[];
  indices?: number[];
  index32?: boolean;
  field: string;
  amount: number;
  subdivisions: number;
  key: string;
  vertexCount: number;
  indexCount: number;
  verticesFnv: string;
  indicesFnv: string;
  triangleScale: number;
}

function generate(): { fields: Record<string, { width: number; height: number; data: number[] }>; rows: Row[] } {
  clearPrimitiveMeshCache();
  const fields = Object.fromEntries(Object.entries(FIELDS).map(([k, f]) => [k, { width: f.width, height: f.height, data: Array.from(f.data) }]));
  const rows = CASES.map((c): Row => {
    const m = c.mesh();
    const d = displacedMeshFor(m.key, c.field, m.vertices, m.indices, FIELDS[c.field]!, c.amount, c.subdivisions);
    return {
      mesh: m.name,
      prim: m.prim,
      ...(m.prim ? {} : { vertices: Array.from(m.vertices), indices: Array.from(m.indices), index32: m.indices instanceof Uint32Array }),
      field: c.field,
      amount: c.amount,
      subdivisions: c.subdivisions,
      key: d.key,
      vertexCount: d.vertices.length / 8,
      indexCount: d.indices.length,
      verticesFnv: fnv1a64(d.vertices),
      indicesFnv: fnv1a64(d.indices),
      triangleScale: d.triangleScale,
    };
  });
  return { fields, rows };
}

test('the C++ height displacement parity fixture matches displacedMeshFor', () => {
  const { fields, rows } = generate();
  const text = `${JSON.stringify({ comment: 'Generated by src/core/scene/heightDisplacementCrossEngine.test.ts (GEN_NATIVE_HEIGHT=1). Do not edit.', fields, rows })}\n`;
  if (process.env.GEN_NATIVE_HEIGHT === '1') {
    writeFileSync(OUT, text);
    return;
  }
  expect(existsSync(OUT)).toBe(true);
  const stored = JSON.parse(readFileSync(OUT, 'utf8')) as { rows: Row[] };
  expect(stored.rows).toEqual(rows);
  // Every displaced mesh is 32-bit and the golden's row is present.
  expect(rows[0]!.mesh.startsWith('prim:sphere')).toBe(true);
  expect(rows.some((r) => r.triangleScale === 64)).toBe(true);
});
