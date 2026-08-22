/**
 * Every text field that changes rasterized PIXELS must reach the cache key.
 *
 * ── Why this shape, and not a CPU-vs-GPU comparison ─────────────────────────
 *
 * The third of the three parity guards, and the third different shape. Lights
 * compare two consumers of one struct; the camera compares two placement PATHS;
 * text, like masks, has only one rasterizer — `setText` bakes a texture that
 * both routes then sample. There is no second implementation to disagree with.
 *
 * What text can lose instead is a CACHE INVALIDATION. `setText` re-rasterizes
 * only when its signature changes, so a `TextSpec` field that alters the baked
 * glyphs but is missing from that signature is a control the user can change
 * with no effect: the old texture is served forever. Nothing throws, nothing
 * looks broken, and the property keyframes happily against a frozen image.
 *
 * The signature's own comments record two near-misses of exactly this — fill
 * opacity ("changes the baked pixels, so it belongs in the cache key") and
 * animator/path output ("otherwise frame 1 of a sweep is reused for every frame
 * of it"). A per-glyph animator silently frozen at frame 1 is the worst version
 * of this bug, because it looks like the animator not working rather than like
 * a cache.
 *
 * ── Derived from the interface ──────────────────────────────────────────────
 *
 * Fields come from `TextSpec` itself, so adding one and forgetting to key it
 * fails here rather than shipping a frozen texture.
 *
 * IF THIS FAILS: fold the field into the signature, or add it to
 * {@link NOT_PIXELS} with the reason it cannot change baked glyphs.
 */

import { readSource } from '@/__testHelpers__/readSource';

const PROVIDER = 'core/rendering/AppTextureProvider.ts';

/**
 * Fields the signature may omit BY NAME, and why.
 *
 * The three here are not omissions at all — they are folded into `tier`, which
 * the signature ends with. `tierFor(effectiveScale, continuousRaster, w, h)`
 * turns the layer scale and the continuous-raster switch into the resolution
 * tier the glyphs are baked at, so a scale change that matters reaches the key
 * as a different tier, and one that does not matter deliberately reuses the
 * texture. Keying the raw floats instead would re-rasterize on every
 * sub-pixel zoom — the exact thing tiering exists to prevent.
 */
const NOT_PIXELS: ReadonlyMap<string, string> = new Map([
  ['scaleX', 'Folded into `tier` via tierFor(effectiveScale, …). Keying the raw float would re-rasterize on every sub-pixel zoom, which is what tiering exists to prevent.'],
  ['scaleY', 'Folded into `tier` via tierFor(effectiveScale, …), same as scaleX.'],
  ['continuousRaster', 'An input to tierFor, so it reaches the key as a different tier rather than as its own term.'],
]);

/** Field names declared on an exported/local interface. */
function interfaceFields(src: string, name: string): string[] {
  const at = src.indexOf(`interface ${name}`);
  if (at < 0) throw new Error(`textSignatureParity: no interface \`${name}\``);
  const open = src.indexOf('{', at);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) { end = i; break; }
  }
  if (end < 0) throw new Error(`textSignatureParity: unbalanced braces in \`${name}\``);
  const body = src.slice(open + 1, end).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  // Two-space indent only: nested object members sit deeper and are not fields
  // of this interface.
  return [...body.matchAll(/^ {2}([a-zA-Z][A-Za-z0-9_]*)\??\s*:/gm)].map((m) => m[1]!);
}

/**
 * `setText` up to and including the `signature` assignment.
 *
 * Deliberately not the whole method: everything after the key is built is
 * rasterization, and a field read only there is read too late to invalidate
 * anything. Cutting at the assignment is what makes this test about the KEY
 * rather than about the function.
 */
function signatureScope(src: string): string {
  const at = src.indexOf('setText(');
  if (at < 0) throw new Error('textSignatureParity: no `setText`');
  const sigAt = src.indexOf('const signature =', at);
  if (sigAt < 0) throw new Error('textSignatureParity: no `signature` assignment in setText');
  const end = src.indexOf(';', src.indexOf('`|t${tier}`', sigAt));
  if (end < 0) throw new Error('textSignatureParity: cannot find the end of the signature');
  return src.slice(at, end);
}

describe('TextSpec → raster cache signature parity', () => {
  const src = readSource(PROVIDER);
  const fields = interfaceFields(src, 'TextSpec');
  const scope = signatureScope(src);

  it('reads a plausible TextSpec, so the assertions below are not vacuous', () => {
    // Exact count, not a size floor. A broken parser returns an empty list and
    // every `it.each` then runs zero times, which reports as a pass — the
    // failure mode that made an earlier parity attempt in this branch look
    // meaningful while measuring nothing.
    expect(fields).toContain('text');
    expect(fields).toContain('glyphs');
    expect(fields.length).toBe(24);
  });

  it.each(
    // Listed from the interface itself, so a new field joins this table.
    interfaceFields(readSource(PROVIDER), 'TextSpec'),
  )('`%s` reaches the cache key, or is exempt with a reason', (field) => {
    if (NOT_PIXELS.has(field)) {
      expect(NOT_PIXELS.get(field)!.length).toBeGreaterThan(30);
      return;
    }
    expect([field, scope.includes(`spec.${field}`)]).toEqual([field, true]);
  });

  it('the animator and path terms are keyed, not just present', () => {
    // Called out separately because their comment records the exact bug they
    // were added for: without them "frame 1 of a sweep is reused for every
    // frame of it", which reads as the animator being broken.
    expect(scope).toMatch(/spec\.glyphs[\s\S]*JSON\.stringify\(spec\.glyphs\)/);
    expect(scope).toMatch(/spec\.textPath[\s\S]*JSON\.stringify\(spec\.textPath\)/);
  });

  it('every NOT_PIXELS exemption is still a real TextSpec field', () => {
    for (const [field] of NOT_PIXELS) {
      expect([field, fields.includes(field)]).toEqual([field, true]);
    }
  });
});
