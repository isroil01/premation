/**
 * Cross-engine parity of the image-alpha puppet mesh (plan D1: "image-layer rig
 * culling"): `coverageMaskFromImageData` (puppet.ts), `alphaOutlineRegions` and
 * `buildAlphaOutlineGeometry` (alphaMesh.ts), and `buildRestMesh` fed that mask
 * in grid and silhouette mode. The C++ port (`native/engine/src/scene/alpha_mesh.cpp`,
 * rig_mesh.cpp's coverage paths via `rest_mesh_for`,
 * tests/test_alpha_mesh_parity.cpp) must give the same mask, rings and mesh,
 * float for float.
 *
 * `GEN_NATIVE_ALPHAMESH=1 npx jest alphaMeshCrossEngine` rewrites the fixture.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildRestMesh, coverageMaskFromImageData, type PuppetRig } from './puppet';
import { alphaOutlineRegions, buildAlphaOutlineGeometry } from './alphaMesh';

const OUT = path.resolve(__dirname, '../../../native/engine/tests/data/alpha_mesh_parity.json');

function b64(bytes: Uint8ClampedArray): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

/** An RGBA image whose alpha is `inside(x, y)` (255) with a soft rim, else 0. */
function image(w: number, h: number, inside: (x: number, y: number) => number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const a = inside(x + 0.5, y + 0.5);
      out[o] = 200;
      out[o + 1] = 120;
      out[o + 2] = 40;
      out[o + 3] = a;
    }
  }
  return out;
}

const disc = (cx: number, cy: number, r: number) => (x: number, y: number): number => {
  const d = Math.hypot(x - cx, y - cy);
  return d <= r ? 255 : d <= r + 1.5 ? 8 : 0;
};

const IMAGES = {
  // A character: torso, head, one thin arm (the limb the grid probes must not drop).
  character: { w: 120, h: 160, img: image(120, 160, (x, y) => {
    const torso = x > 40 && x < 80 && y > 50 && y < 130;
    const head = Math.hypot(x - 60, y - 32) < 16;
    const arm = y > 60 && y < 66 && x > 80 && x < 115;
    return torso || head || arm ? 255 : 0;
  }) },
  disc: { w: 90, h: 90, img: image(90, 90, disc(45, 45, 30)) },
  // A ring: an outer region with a hole.
  ring: { w: 100, h: 100, img: image(100, 100, (x, y) => {
    const d = Math.hypot(x - 50, y - 50);
    return d < 42 && d > 20 ? 255 : 0;
  }) },
  // Smaller than the 64-sample grid, and two islands.
  specks: { w: 30, h: 20, img: image(30, 20, (x, y) => ((x < 12 && y < 12) || (x > 20 && y > 10) ? 255 : 0)) },
  empty: { w: 16, h: 16, img: image(16, 16, () => 0) },
};

interface Case { image: keyof typeof IMAGES; lw: number; lh: number; pad: number; rig: PuppetRig }

const pin = (id: string, x: number, y: number) => ({ id, x, y });

const CASES: Case[] = [
  { image: 'character', lw: 240, lh: 320, pad: 0, rig: { pins: [pin('a', 0, -100), pin('b', 90, -40)], meshMode: 'silhouette' } },
  { image: 'character', lw: 240, lh: 320, pad: 4, rig: { pins: [pin('a', 0, 0)], meshMode: 'silhouette', meshDensity: 12.6, meshExpansion: 6 } },
  { image: 'character', lw: 240, lh: 320, pad: 0, rig: { pins: [pin('a', 0, 0)], meshMode: 'grid', meshDensity: 22 } },
  { image: 'character', lw: 120, lh: 160, pad: 2, rig: { pins: [pin('a', 0, 0)], meshDensity: 40, meshExpansion: 3 } },
  { image: 'disc', lw: 180, lh: 180, pad: 0, rig: { pins: [pin('a', 0, 0)], meshMode: 'silhouette', meshDensity: 50 } },
  { image: 'ring', lw: 200, lh: 200, pad: 0, rig: { pins: [pin('a', 0, -60)], meshMode: 'silhouette', meshExpansion: -4 } },
  { image: 'ring', lw: 200, lh: 200, pad: 0, rig: { pins: [pin('a', 0, -60)], meshMode: 'grid', meshDensity: 9 } },
  { image: 'specks', lw: 300, lh: 200, pad: 0, rig: { pins: [pin('a', -80, -60)], meshMode: 'silhouette', meshDensity: 2 } },
  { image: 'empty', lw: 100, lh: 100, pad: 0, rig: { pins: [pin('a', 0, 0)], meshMode: 'silhouette' } },
];

function generate() {
  const masks = Object.fromEntries(Object.entries(IMAGES).map(([name, im]) => {
    const m = coverageMaskFromImageData({ data: im.img, width: im.w, height: im.h }, { maxSamples: 64, alphaThreshold: 12 });
    return [name, { w: im.w, h: im.h, rgba: b64(im.img), cols: m.cols, rows: m.rows, cells: Array.from(m.cells), key: m.key }];
  }));
  const cases = CASES.map((c) => {
    const im = IMAGES[c.image];
    const mask = coverageMaskFromImageData({ data: im.img, width: im.w, height: im.h }, { maxSamples: 64, alphaThreshold: 12 });
    const regions = alphaOutlineRegions(mask, c.lw, c.lh, c.rig.meshExpansion ?? 0);
    const geom = buildAlphaOutlineGeometry(c.lw, c.lh, c.pad, c.rig.meshDensity ?? 22, c.rig.meshExpansion ?? 0, mask);
    const rest = buildRestMesh(c.lw, c.lh, c.pad, c.rig, undefined, mask);
    return {
      ...c,
      regions: regions.map((r) => ({ outer: r.outer.flatMap((p) => [p.x, p.y]), holes: r.holes.map((h) => h.flatMap((p) => [p.x, p.y])) })),
      geom: geom ? { vertices: Array.from(geom.vertices), triangles: Array.from(geom.triangles), numVertices: geom.numVertices } : null,
      rest: { vertices: Array.from(rest.vertices), triangles: Array.from(rest.triangles), layout: rest.layout ?? 'grid' },
    };
  });
  return { masks, cases };
}

test('the C++ alpha mesh parity fixture matches coverageMaskFromImageData + alphaMesh + buildRestMesh', () => {
  const fixture = generate();
  const text = `${JSON.stringify({ comment: 'Generated by src/core/rig/alphaMeshCrossEngine.test.ts (GEN_NATIVE_ALPHAMESH=1). Do not edit.', ...fixture })}\n`;
  if (process.env.GEN_NATIVE_ALPHAMESH === '1') {
    writeFileSync(OUT, text);
    return;
  }
  expect(existsSync(OUT)).toBe(true);
  expect(JSON.parse(readFileSync(OUT, 'utf8'))).toEqual(JSON.parse(text));
  expect(fixture.cases.filter((c) => c.geom).length).toBeGreaterThanOrEqual(4);
  expect(fixture.cases.find((c) => c.image === 'ring' && c.regions.length > 0)!.regions[0]!.holes.length).toBe(1);
});
