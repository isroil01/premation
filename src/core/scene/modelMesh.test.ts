/**
 * Model conversions — the two spots a 3D import silently goes wrong:
 * the coordinate change of basis (a model that imports upside-down or
 * mirrored) and the quaternion→euler conversion (a rig that leans when its
 * file says it stands straight). The euler test round-trips through the
 * renderer's OWN Matrix4Math.compose, so whatever rotation convention the
 * engine uses, this conversion is pinned as its inverse.
 */

import {
  primitiveToEntry,
  gltfRotationToEulerDeg,
  gltfTranslationToLocal,
  modelKeyForBytes,
} from './modelMesh';
import { Matrix4Math } from '@motion/scene';
import type { ParsedGltf } from '@core/media/gltf';

function parsedWith(positions: number[], opts: { uvs?: number[]; material?: number } = {}): ParsedGltf {
  return {
    meshes: [{
      name: 'm',
      primitives: [{
        positions: new Float32Array(positions),
        normals: new Float32Array(positions.map((_, i) => (i % 3 === 2 ? 1 : 0))),
        uvs: opts.uvs ? new Float32Array(opts.uvs) : null,
        indices: new Uint32Array(Array.from({ length: positions.length / 3 }, (_, i) => i)),
        material: opts.material ?? null,
      }],
    }],
    materials: [
      { name: 'red', baseColorFactor: [1, 0, 0, 1], baseColorImage: null, doubleSided: true, metallicFactor: 0, roughnessFactor: 0.5 },
    ],
    images: [],
    nodes: [],
    roots: [],
  };
}

describe('primitiveToEntry — change of basis', () => {
  it('negates y and z on positions and normals (rotX 180 conjugation)', () => {
    const entry = primitiveToEntry(parsedWith([1, 2, 3]), 'k', 0, 0, [])!;
    // Interleaved: pos(1,-2,-3), normal was (0,0,1) → (0,0,-1).
    expect(Array.from(entry.vertices.slice(0, 6))).toEqual([1, -2, -3, 0, 0, -1]);
  });

  it('boxes the CONVERTED coordinates and passes UVs through', () => {
    const entry = primitiveToEntry(
      parsedWith([0, 0, 0, 2, 4, 6], { uvs: [0.25, 0.75, 1, 0] }),
      'k', 0, 0, [],
    )!;
    expect(entry.bbox).toEqual({ minX: 0, minY: -4, minZ: -6, maxX: 2, maxY: 0, maxZ: 0 });
    expect(entry.vertices[6]).toBeCloseTo(0.25);
    expect(entry.vertices[7]).toBeCloseTo(0.75);
  });

  it('renders the material base colour as #rrggbbaa and keeps doubleSided', () => {
    const entry = primitiveToEntry(parsedWith([0, 0, 0], { material: 0 }), 'k', 0, 0, [])!;
    expect(entry.fill).toBe('#ff0000ff');
    expect(entry.doubleSided).toBe(true);
  });

  it('downgrades indices to Uint16 when the vertex count allows', () => {
    const entry = primitiveToEntry(parsedWith([0, 0, 0, 1, 1, 1]), 'k', 0, 0, [])!;
    expect(entry.indices).toBeInstanceOf(Uint16Array);
  });
});

describe('gltfRotationToEulerDeg — round-trips through Matrix4Math.compose', () => {
  /** Rotation part of the compositor matrix for euler degrees. */
  const composedRotation = (deg: { x: number; y: number; z: number }): number[] => {
    const DEG = Math.PI / 180;
    const m = Matrix4Math.compose({
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: deg.x * DEG, y: deg.y * DEG, z: deg.z * DEG },
      scale: { x: 1, y: 1, z: 1 },
      anchor: { x: 0, y: 0, z: 0 },
    });
    // Column-major → row-major 3×3.
    return [m[0]!, m[4]!, m[8]!, m[1]!, m[5]!, m[9]!, m[2]!, m[6]!, m[10]!];
  };

  /** Row-major 3×3 of the CONVERTED quaternion (the ground truth). */
  const quatRotation = (q: [number, number, number, number]): number[] => {
    const x = q[0], y = -q[1], z = -q[2], w = q[3];
    return [
      1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
      2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
      2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
    ];
  };

  const quats: Array<[number, number, number, number]> = [
    [0, 0, 0, 1],
    [0.7071068, 0, 0, 0.7071068],          // 90° about x
    [0, 0.7071068, 0, 0.7071068],          // 90° about y
    [0, 0, 0.7071068, 0.7071068],          // 90° about z
    [0.2705981, 0.2705981, 0.6532815, 0.6532815],
    [-0.36, 0.44, 0.12, 0.82],
    [0.5, -0.5, 0.5, 0.5],
  ];

  it.each(quats.map((q, i) => [i, q] as const))('quaternion #%i', (_i, q) => {
    const n = Math.hypot(...q);
    const qn: [number, number, number, number] = [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
    const euler = gltfRotationToEulerDeg(qn);
    const got = composedRotation(euler);
    const want = quatRotation(qn);
    for (let k = 0; k < 9; k++) {
      expect(got[k]!).toBeCloseTo(want[k]!, 4);
    }
  });
});

describe('helpers', () => {
  it('translation converts like positions do', () => {
    expect(gltfTranslationToLocal([1, 2, 3])).toEqual({ x: 1, y: -2, z: -3 });
  });

  it('model keys are content-stable and size-tagged', () => {
    const a = modelKeyForBytes(new Uint8Array([1, 2, 3]));
    expect(a).toBe(modelKeyForBytes(new Uint8Array([1, 2, 3])));
    expect(a).not.toBe(modelKeyForBytes(new Uint8Array([1, 2, 4])));
    expect(a).toMatch(/^gltf-[0-9a-f]{8}-3$/);
  });
});
