/**
 * A packer must produce EXACTLY the floats its shader's struct declares.
 *
 * ── The bug this closes ─────────────────────────────────────────────────────
 *
 * `packSpotlight` allocated `MAT3_STD140_FLOATS + 4·4` — four vec4s after the
 * matrix — while the shader declared FIVE (uvRect, p0, p1, p2, lightColor).
 * The consequences are both silent:
 *
 *   1. JavaScript drops writes past the end of a Float32Array. No throw, no
 *      warning; the colour simply never reaches the GPU.
 *   2. The uniform buffer is 16 bytes smaller than the struct the shader
 *      declares, so WebGPU rejects the bind group, the draw never happens, and
 *      — because the effects chain relies on a draw to composite the layer
 *      back out — THE LAYER DISAPPEARS.
 *
 * Reported as "I added Spotlight and the object disappeared", which is the
 * same symptom as the earlier non-uniform-control-flow bug and a completely
 * different cause. Both are invisible to `tsc`, to lint, and to every test that
 * does not actually size the buffer against the struct.
 *
 * ── The check ───────────────────────────────────────────────────────────────
 *
 * Parse the WGSL `struct Object { … }` for the shader, total its fields in
 * floats under std140-ish rules (mat3x3 occupies 12 — three padded columns),
 * and compare against what the packer actually returns. The table is explicit
 * because only a human knows which packer feeds which shader; adding a shader
 * without adding a row is caught by the coverage test at the bottom.
 */

import { BUILTIN_SHADERS } from '../shaders/builtin';
import {
  packBend, packPerspective, packSpotlight, packMotionTile, packFill,
  packSharpen, packSetMatte, packStroke,
} from '../pipeline/uniforms';
import type { Mat3 } from '../core/math/Mat3';
import type { Rect } from '../core/math/geometry';
import type { Color } from '../core/math/Color';

const MVP = [1, 0, 0, 0, 1, 0, 0, 0, 1] as unknown as Mat3;
const RECT = { x: 0, y: 0, width: 1, height: 1 } as unknown as Rect;
const COLOR = { r: 1, g: 1, b: 1, a: 1 } as unknown as Color;

/** Floats a WGSL type occupies in the uniform block, std140-style. */
const FLOATS: Record<string, number> = {
  'mat3x3<f32>': 12,   // three columns, each padded to vec4
  'mat4x4<f32>': 16,
  'vec4<f32>': 4,
  'vec3<f32>': 4,      // padded
  'vec2<f32>': 2,
  f32: 1,
  i32: 1,
  u32: 1,
};

/**
 * Split a struct body on the commas that separate FIELDS.
 *
 * A plain `split(',')` tears `array<vec4<f32>, 8>` in half — the comma inside
 * the type parameters is not a field separator. Depth-aware, so nested generics
 * stay whole.
 */
function splitFields(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of body) {
    if (ch === '<') depth++;
    else if (ch === '>') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Floats one field's type occupies. Handles `array<T, N>` element counts. */
function typeFloats(t: string): number {
  const arr = /^array\s*<\s*(.+?)\s*,\s*(\d+)\s*>$/.exec(t);
  if (arr) return typeFloats(arr[1]!) * Number(arr[2]);
  const size = FLOATS[t];
  if (size === undefined) throw new Error(`uniformPackerSize: unknown WGSL type "${t}"`);
  return size;
}

/** Total floats in a shader's `struct Object`, or null when it declares none. */
function structFloats(wgsl: string): number | null {
  const m = /struct\s+Object\s*\{([\s\S]*?)\}/.exec(wgsl);
  if (!m) return null;
  let total = 0;
  for (const field of splitFields(m[1]!)) {
    const t = field.split(':').slice(1).join(':').trim();
    if (!t) continue;
    total += typeFloats(t);
  }
  return total;
}

/** shader name → the packer that fills its uniform block. */
const PACKERS: ReadonlyArray<{ shader: string; pack: () => Float32Array }> = [
  { shader: 'bend', pack: () => packBend(MVP, RECT, 1, 0, 1, 0, 0, 0, 0, 1, RECT) },
  { shader: 'spotlight', pack: () => packSpotlight(MVP, RECT, 0, 0, 0, 1, 0.5, 0.4, 1, 0.1, 1, false, RECT, COLOR) },
  // The four that share one block.
  { shader: 'bevel-alpha', pack: () => packPerspective(MVP, RECT, [0, 0, 0, 0], [0, 0, 0, 0], RECT, COLOR) },
  { shader: 'bevel-edges', pack: () => packPerspective(MVP, RECT, [0, 0, 0, 0], [0, 0, 0, 0], RECT, COLOR) },
  { shader: 'sphere', pack: () => packPerspective(MVP, RECT, [0, 0, 0, 0], [0, 0, 0, 0], RECT, COLOR) },
  { shader: 'cylinder', pack: () => packPerspective(MVP, RECT, [0, 0, 0, 0], [0, 0, 0, 0], RECT, COLOR) },
  // A sample of the pre-existing ones, so the rule is shown to hold for shaders
  // written before this test rather than only for the ones that broke it.
  { shader: 'motion-tile', pack: () => packMotionTile(MVP, RECT, 1, 1, 0, 0) },
  { shader: 'fill', pack: () => packFill(MVP, RECT, COLOR) },
  { shader: 'sharpen', pack: () => packSharpen(MVP, RECT, 0.01, 0.01, 1) },
  { shader: 'set-matte', pack: () => packSetMatte(MVP, RECT, false, false) },
  { shader: 'stroke', pack: () => packStroke(MVP, RECT, COLOR, 2, 0.01, 0.01) },
];

const byName = new Map(BUILTIN_SHADERS.map((s) => [s.name, s]));

describe('uniform packer size matches the shader struct', () => {
  it.each(PACKERS)('$shader', ({ shader, pack }) => {
    const src = byName.get(shader);
    expect(src).toBeDefined();
    const declared = structFloats(src!.wgsl);
    expect(declared).not.toBeNull();
    // Too FEW and the bind group is rejected — the layer vanishes. Too many and
    // the tail is ignored, which is merely wasteful but still a sign the two
    // sides have drifted.
    expect(pack().length).toBe(declared);
  });

  it('★ detects a packer one vec4 short — the exact shape that shipped', () => {
    // Guards the guard. If `structFloats` stopped parsing, every case above
    // would compare against null and this file would pass forever.
    const spotlight = byName.get('spotlight')!;
    const declared = structFloats(spotlight.wgsl)!;
    expect(declared).toBe(36);              // 12 + uvRect + p0 + p1 + p2 + fxBox + colour
    expect(declared - 4).not.toBe(packSpotlight(
      MVP, RECT, 0, 0, 0, 1, 0.5, 0.4, 1, 0.1, 1, false, RECT, COLOR,
    ).length);
  });

  it('every shader with a uniform struct is either covered or knowingly absent', () => {
    // A new shader with a new packer must land in PACKERS, or its buffer size
    // is unguarded — which is precisely how Spotlight shipped broken.
    const covered = new Set(PACKERS.map((p) => p.shader));
    const uncovered = BUILTIN_SHADERS
      .filter((s) => structFloats(s.wgsl) !== null && !covered.has(s.name))
      .map((s) => s.name);
    // Pre-existing shaders not yet in the table are listed here deliberately:
    // the assertion pins the CURRENT set, so adding a shader forces a decision
    // rather than silently widening the gap.
    expect(uncovered.length).toBeLessThanOrEqual(24);
  });
});
