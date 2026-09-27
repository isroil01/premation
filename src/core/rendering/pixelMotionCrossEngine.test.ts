/**
 * Cross-engine parity of the footage pixel kernels (plan D2w time/comp:
 * Pixel Motion frame blending; Interpret Footage ▸ Fields): pixelMotionFlow.ts
 * (`lumaIntOf`, `computeFlow`, `warpBlend`) and deinterlace.ts
 * (`deinterlaceData`) on synthetic frames. The C++ port
 * (`native/engine/src/scene/pixel_motion.cpp`, tests/test_pixel_motion_parity.cpp)
 * must produce the same flow floats and the same bytes.
 *
 * Frames travel base64; big outputs as FNV-1a 32 of their bytes.
 *
 * The fixture (`native/engine/tests/data/pixel_motion_parity.json`) was
 * recorded from this engine and is now frozen, C++-owned data:
 * `PARITY_REBLESS=1` re-blesses its answers from the C++ test. This test
 * remains only as a TypeScript-vs-fixture drift check until
 * docs/TS_ENGINE_REMOVAL.md phase 4 deletes it with the TypeScript engine.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { computeFlow, lumaIntOf, warpBlend, type FlowOptions } from './pixelMotionFlow';
import { deinterlaceData } from './deinterlace';

const OUT = path.resolve(__dirname, '../../../native/engine/tests/data/pixel_motion_parity.json');

function fnv32(bytes: ArrayLike<number>): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ (bytes[i]! & 0xff), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

function b64(bytes: Uint8ClampedArray | Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

/** A textured RGBA frame: smooth blobs plus hashed grain, shifted by (sx, sy). */
function frame(w: number, h: number, sx: number, sy: number, seed: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x - sx;
      const v = y - sy;
      let g = Math.imul((Math.floor(u) * 73856093) ^ (Math.floor(v) * 19349663) ^ seed, 0x27d4eb2d) >>> 0;
      g = (g >>> 13) & 63;
      const o = (y * w + x) * 4;
      out[o] = 128 + 90 * Math.sin(u * 0.31) * Math.cos(v * 0.23) + g;
      out[o + 1] = 100 + 80 * Math.sin((u + v) * 0.17) + (g >> 1);
      out[o + 2] = 60 + 70 * Math.cos(u * 0.11 - v * 0.29);
      out[o + 3] = x < 3 ? 128 : 255;
    }
  }
  return out;
}

interface FlowCase { name: string; w: number; h: number; shift: [number, number]; opts: FlowOptions; flat?: boolean }

const FLOWS: FlowCase[] = [
  { name: 'shift right 3', w: 48, h: 40, shift: [3, 0], opts: {} },
  { name: 'diagonal 2,-4', w: 48, h: 40, shift: [2, -4], opts: {} },
  { name: 'sub-pixel 1.5, 0.5', w: 40, h: 32, shift: [1.5, 0.5], opts: {} },
  { name: 'coarse grid, wide search', w: 52, h: 36, shift: [-6, 5], opts: { step: 12, blockRadius: 4, searchRadius: 8, minImprovement: 0.1 } },
  { name: 'flat frames abstain', w: 24, h: 24, shift: [0, 0], opts: {}, flat: true },
  { name: 'tiny frame (one cell)', w: 9, h: 7, shift: [1, 1], opts: { step: 2, blockRadius: 1, searchRadius: 1 } },
];

function generate() {
  const flows = FLOWS.map((c) => {
    const a = c.flat ? new Uint8ClampedArray(c.w * c.h * 4).fill(90) : frame(c.w, c.h, 0, 0, 7);
    const b = c.flat ? new Uint8ClampedArray(c.w * c.h * 4).fill(90) : frame(c.w, c.h, c.shift[0], c.shift[1], 7);
    const la = lumaIntOf(a, c.w, c.h);
    const lb = lumaIntOf(b, c.w, c.h);
    const f = computeFlow(la, lb, c.w, c.h, c.opts);
    // Warp at 1.5× the flow resolution (the full-res warp over a downscaled flow), three weights.
    const W = Math.round(c.w * 1.5);
    const H = Math.round(c.h * 1.5);
    const A = c.flat ? new Uint8ClampedArray(W * H * 4).fill(90) : frame(W, H, 0, 0, 11);
    const B = c.flat ? new Uint8ClampedArray(W * H * 4).fill(90) : frame(W, H, c.shift[0] * 1.5, c.shift[1] * 1.5, 11);
    const warps = [0, 0.37, 0.5, 1].map((t) => {
      const out = new Uint8ClampedArray(W * H * 4);
      warpBlend(A, B, W, H, f, W / c.w, H / c.h, t, out);
      return { t, fnv: fnv32(out), head: Array.from(out.subarray(0, 64)) };
    });
    return {
      name: c.name, w: c.w, h: c.h, opts: c.opts, a: b64(a), b: b64(b),
      lumaFnv: fnv32(new Uint8Array(la.buffer)),
      flow: { cols: f.cols, rows: f.rows, step: f.step, dx: Array.from(f.dx), dy: Array.from(f.dy), valid: Array.from(f.valid) },
      warp: { W, H, A: b64(A), B: b64(B), warps },
    };
  });
  const fields = [[5, 7], [4, 2], [3, 1], [6, 8]].flatMap(([w, h]) => (['upper', 'lower'] as const).map((keep) => {
    const src = frame(w!, h!, 0, 0, 3);
    const out = new Uint8ClampedArray(src);
    deinterlaceData(out, w!, h!, keep);
    return { w, h, keep, src: b64(src), out: Array.from(out) };
  }));
  return { flows, fields };
}

test('the C++ Pixel Motion / deinterlace parity fixture matches pixelMotionFlow + deinterlace', () => {
  const fixture = generate();
  expect(existsSync(OUT)).toBe(true);
  const { comment: _comment, ...stored } = JSON.parse(readFileSync(OUT, 'utf8')) as Record<string, unknown>;
  expect(stored).toEqual(JSON.parse(JSON.stringify(fixture)));
  expect(fixture.flows[0]!.flow.valid.some((v) => v === 1)).toBe(true);
  expect(fixture.flows.find((f) => f.name === 'flat frames abstain')!.flow.valid.every((v) => v === 0)).toBe(true);
});
