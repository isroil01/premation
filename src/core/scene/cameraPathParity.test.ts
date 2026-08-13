/**
 * The CPU projection and the GPU camera matrices must read the SAME camera.
 *
 * ── The boundary, and why it needs a guard of its own ───────────────────────
 *
 * One `Camera3D` feeds two entirely separate placement paths:
 *
 *   projectPoint(p, cam)         the affine/painter route. Every layer's 2D
 *                                position, scale and sort depth comes from it.
 *   cameraViewMatrix(cam)   +    the depth-tested route. Layers in a 3D group
 *   cameraProjectionMatrix(cam)  are placed by these matrices in the shader.
 *
 * `buildSnapshot` states the requirement where it builds the DTO — the two
 * "paths place layers identically". They can only do that if they consume the
 * same fields. A camera property honoured by one and dropped by the other does
 * not throw, does not fail typechecking and does not blank the frame: it moves
 * a layer, and only on frames that take the other route. That is the shape of
 * three defects already found in this subsystem — a value plumbed, asserted,
 * and dropped one layer short.
 *
 * ── Why the GPU side is a UNION ─────────────────────────────────────────────
 *
 * The view/projection split is a real decomposition, not a divergence:
 * position and orientation belong to the view, focal length and principal
 * point to the projection. Neither GPU function should read all four, so they
 * are compared as a union against the CPU. The cost is that a field dropped
 * from one GPU function while the other still reads it would pass — but no
 * field is read by both today, so in practice each is covered exactly once.
 *
 * IF THIS FAILS: either consume the field on both sides, or add it to
 * {@link ONE_SIDED} with the reason.
 */

import { readSource } from '@/__testHelpers__/readSource';

const PROJECT3D = '../packages/scene/src/utils/project3d.ts';

/**
 * Camera fields one path may read without the other, and why.
 *
 * Empty today: every field the CPU projection reads is one the GPU matrices
 * need, and vice versa. It is the escape hatch for a field that genuinely has
 * meaning on one route only — a rasterizer-specific bias, say — and the reason
 * is required so that adding one is a decision rather than a way to silence
 * the test.
 */
const ONE_SIDED: ReadonlyMap<string, string> = new Map<string, string>([]);

/**
 * The body of a top-level `function name(...)`, by brace matching.
 *
 * Walks the parameter list to its matching `)` first, so braces inside an
 * inline parameter type are stepped over rather than mistaken for the body —
 * the trap `lightShaderParity` documents, where matching the signature's own
 * `{ x, y, z }` made the assertions test almost nothing.
 */
function functionBody(src: string, name: string): string {
  const start = src.search(new RegExp(`function ${name}\\b`));
  if (start < 0) throw new Error(`cameraPathParity: no function \`${name}\``);
  const paren = src.indexOf('(', start);
  let parens = 0;
  let afterParams = -1;
  for (let i = paren; i < src.length; i++) {
    if (src[i] === '(') parens++;
    else if (src[i] === ')' && --parens === 0) { afterParams = i + 1; break; }
  }
  if (afterParams < 0) throw new Error(`cameraPathParity: unbalanced parens in \`${name}\``);
  const open = src.indexOf('{', afterParams);
  if (open < 0) throw new Error(`cameraPathParity: no body for \`${name}\``);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`cameraPathParity: unbalanced braces in \`${name}\``);
}

const src = readSource(PROJECT3D);

/** Properties read off the camera parameter in a body — `cam.foo`. */
const camReads = (body: string): Set<string> =>
  new Set([...body.matchAll(/\bcam\.([A-Za-z][A-Za-z0-9_]*)/g)].map((m) => m[1]!));

/** Reads in a function, plus those of any helper handed the WHOLE camera. */
function readsOf(fn: string, seen = new Set<string>()): Set<string> {
  if (seen.has(fn)) return new Set();
  seen.add(fn);
  const body = functionBody(src, fn);
  const out = camReads(body);
  for (const m of body.matchAll(/\b([a-zA-Z][A-Za-z0-9_]*)\s*\(\s*cam\b/g)) {
    for (const f of readsOf(m[1]!, seen)) out.add(f);
  }
  return out;
}

describe('Camera3D → CPU projection / GPU matrices parity', () => {
  const cpu = readsOf('projectPoint');
  const view = readsOf('cameraViewMatrix');
  const projection = readsOf('cameraProjectionMatrix');
  const gpu = new Set([...view, ...projection]);

  it('both sides read a non-trivial set of camera fields', () => {
    // Guards the guard. If `functionBody` or the read regex breaks, both sides
    // come back empty and every parity assertion below passes vacuously — which
    // is exactly how a throwaway version of this extractor misled an earlier
    // attempt into deleting a working test.
    expect([...cpu].sort()).toEqual(['focalLength', 'orientation', 'position', 'principal']);
    expect([...gpu].sort()).toEqual(['focalLength', 'orientation', 'position', 'principal']);
  });

  it('the view/projection split is a decomposition, not an overlap', () => {
    // Pinned because the union comparison's blind spot is a field read by BOTH
    // GPU functions: dropping it from one would then go unnoticed. While the
    // split stays disjoint, every field is covered exactly once.
    expect([...view].filter((f) => projection.has(f))).toEqual([]);
  });

  it.each([...new Set([...cpu, ...gpu])].sort())(
    '`cam.%s` is read by both paths, or exempt with a reason',
    (field) => {
      if (ONE_SIDED.has(field)) {
        expect(ONE_SIDED.get(field)!.length).toBeGreaterThan(20);
        return;
      }
      expect([field, cpu.has(field), gpu.has(field)]).toEqual([field, true, true]);
    },
  );

  it('every ONE_SIDED exemption is still read by at least one path', () => {
    for (const [field] of ONE_SIDED) {
      expect([field, cpu.has(field) || gpu.has(field)]).toEqual([field, true]);
    }
  });
});
