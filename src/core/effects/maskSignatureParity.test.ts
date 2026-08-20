/**
 * Every mask field that changes matte PIXELS must be in the cache signature.
 *
 * ── Why this boundary, and not a CPU-vs-GPU one ─────────────────────────────
 *
 * The obvious mask parity test does not exist to be written: `paintMaskMatte`
 * is SHARED. The CPU bake and the GPU mask texture both rasterize through it,
 * so the two cannot disagree about a mask's shape — there is only one
 * implementation to disagree with.
 *
 * The place a mask field CAN be silently dropped is the cache. `setMask`
 * re-rasterizes only when its signature changes, so a field that alters the
 * matte but is absent from the signature is a field the user can edit with no
 * effect: the matte is served from cache, unchanged, forever. Nothing throws
 * and nothing looks broken — the control simply does nothing.
 *
 * That is not hypothetical. The comment above the signature records it
 * happening: "the old one omitted mode/feather/opacity/expansion, so editing
 * any of them couldn't even trigger a re-rasterize". Four controls, dead, in
 * one line. This is the guard that would have caught it.
 *
 * ── Derived from the interface, not from a list ─────────────────────────────
 *
 * The fields come from `MaskPath` itself, so adding one and forgetting to hash
 * it fails here rather than shipping. A hand-written list would need the same
 * discipline it exists to enforce — which is exactly how the original defect
 * survived.
 *
 * IF THIS FAILS: hash the field in `setMask`, or add it to {@link NOT_PIXELS}
 * with the reason it cannot change a matte.
 */

import { readSource } from '@/__testHelpers__/readSource';

const MASK = 'core/effects/mask.ts';
const PROVIDER = 'core/rendering/AppTextureProvider.ts';

/**
 * Mask fields that genuinely cannot change matte pixels, and why.
 *
 * `id` is identity, not geometry — it names a path for selection and
 * keyframing. Two masks differing only by id rasterize identically, so hashing
 * it would only defeat the cache.
 */
const NOT_PIXELS: ReadonlyMap<string, string> = new Map([
  ['id', 'Identity for selection and keyframe tracks. Two paths differing only by id rasterize identically, so hashing it would defeat the cache without protecting anything.'],
  ['name', 'The AE mask-list label, shown only in the UI. Renaming a mask cannot move an outline, so hashing it would re-rasterize every matte on a keystroke in the layer panel.'],
]);

/** Field names declared on an exported interface. */
function interfaceFields(src: string, name: string): string[] {
  const at = src.search(new RegExp(`export interface ${name}\\s*\\{`));
  if (at < 0) throw new Error(`maskSignatureParity: no interface \`${name}\``);
  const open = src.indexOf('{', at);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) { end = i; break; }
  }
  if (end < 0) throw new Error(`maskSignatureParity: unbalanced braces in \`${name}\``);
  const body = src.slice(open + 1, end).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  return [...body.matchAll(/^\s*([A-Za-z][A-Za-z0-9_]*)\??\s*:/gm)].map((m) => m[1]!);
}

/** The body of `setMask`, where the signature is built. */
function setMaskBody(src: string): string {
  const at = src.indexOf('setMask(');
  if (at < 0) throw new Error('maskSignatureParity: no `setMask`');
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error('maskSignatureParity: unbalanced braces in `setMask`');
}

describe('MaskPath → cache signature parity', () => {
  const maskSrc = readSource(MASK);
  const fields = interfaceFields(maskSrc, 'MaskPath');
  const pointFields = interfaceFields(maskSrc, 'MaskPoint');
  const sig = setMaskBody(readSource(PROVIDER));

  it('reads a plausible MaskPath, so the assertions below are not vacuous', () => {
    // Guards the guard by EXACT set, not by size: a broken parser returns an
    // empty list and every `it.each` below then runs zero times, which reports
    // as a pass. An earlier parity attempt in this repo shipped that mistake.
    expect(fields.sort()).toEqual(
      ['closed', 'expansion', 'feather', 'id', 'inverted', 'mode', 'name', 'opacity', 'points'].sort(),
    );
    // 7 since per-vertex `feather` (variable-width feather) joined the anchor
    // and its two handles.
    expect(pointFields.length).toBe(7);
  });

  it.each(['closed', 'expansion', 'feather', 'id', 'inverted', 'mode', 'name', 'opacity', 'points'])(
    '`%s` is hashed into the mask signature, or exempt with a reason',
    (field) => {
      if (NOT_PIXELS.has(field)) {
        expect(NOT_PIXELS.get(field)!.length).toBeGreaterThan(30);
        return;
      }
      expect([field, sig.includes(`.${field}`)]).toEqual([field, true]);
    },
  );

  it('every point coordinate is hashed, not just the anchor', () => {
    // A signature over x/y alone would miss a bezier handle move: the anchor
    // stays put, the curve changes, and the cached matte is stale.
    for (const f of pointFields) {
      expect([f, sig.includes(`.${f}`)]).toEqual([f, true]);
    }
  });

  it('every NOT_PIXELS exemption is still a real MaskPath field', () => {
    for (const [field] of NOT_PIXELS) {
      expect([field, fields.includes(field)]).toEqual([field, true]);
    }
  });
});
