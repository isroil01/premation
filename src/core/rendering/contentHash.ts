/**
 * Vector content hashing (Phase 1 — rasterizer seam).
 *
 * A layer's `contentHash` digests ONLY the fields that determine its own
 * rasterized pixels — geometry + fills/strokes + text + masks + the pre-DOF
 * effect stack + rasterization size (width/height). It deliberately EXCLUDES:
 *   - transform/placement: x, y, rotation, scaleX/Y, anchor, matrix, depth,
 *     opacity, motionSamples — so a transform-only animation reuses one texture;
 *   - compositing: blend, matte, isMatteSource, isAdjustment — those describe how
 *     the finished texture blends against the stack, not the texture's pixels;
 *   - `filter`: it folds in DOF blur + cast-shadow, which depend on depth/
 *     position; hashing it would let a pure XY move bust the cache. We hash the
 *     pre-DOF `effects` stack instead.
 *
 * This is the cache key the VectorRasterizer keys on (× a resolution tier ×
 * padding class). Same content + same scale ⇒ same texture.
 */

import type { RenderLayer } from './RenderBackend';
import { layerSubpaths } from './raster/subpaths';

/**
 * Bump when the hashing scheme OR the rasterizer's pixel output semantics
 * change, so textures cached under a prior scheme are never reused across the
 * change. Folded into the digest input.
 */
export const CONTENT_HASH_VERSION = 2;

/** FNV-1a 32-bit — cheap, deterministic, no crypto. (Mirrors the renderer's
 *  `hashString`; kept local so app-side hashing doesn't depend on a renderer
 *  internal.) */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** The content-only projection of a layer, in a fixed key order (deterministic
 *  JSON). Nested style objects (fillPaint/stroke/mask/…) are constructed
 *  consistently by buildSnapshot, so their own key order is stable run-to-run. */
function contentOf(layer: RenderLayer): unknown {
  return {
    v: CONTENT_HASH_VERSION,
    k: layer.kind,
    // geometry + rasterization size
    prim: layer.primitive,
    cr: layer.cornerRadius,
    crs: layer.cornerRadii,
    // The normalized run list, NOT the raw fields. Two layers whose geometry is
    // the same drawing must hash the same whichever field carried it, and — the
    // reason this matters — one path cut into two runs must NOT hash the same as
    // the concatenation of those runs. `layerSubpaths` preserves the run
    // boundaries, so the structure is in the key and a trim that only moves a
    // split point still busts the cache.
    // PER-RUN PAINT is in the key too. Two paths with identical geometry and
    // different run paint are different pictures; hashing only the points would
    // let the second reuse the first's raster. Same class as the run-boundary
    // point above, but harder to catch, because the geometry genuinely matches.
    pts: layerSubpaths(layer).map((s) => ({ p: s.points, o: s.open === true, pa: s.paint })),
    w: layer.width,
    h: layer.height,
    q: layer.quality,
    // fills / strokes / paint / mask
    fill: layer.fill,
    fp: layer.fillPaint,
    fps: layer.fillPaints,
    st: layer.stroke,
    sts: layer.strokes,
    paint: layer.paint,
    mask: layer.mask,
    // text
    t: layer.text,
    fs: layer.fontSize,
    ff: layer.fontFamily,
    fw: layer.fontWeight,
    fst: layer.fontStyle,
    lsp: layer.letterSpacing,
    lh: layer.lineHeight,
    al: layer.align,
    psp: layer.paragraphSpacing,
    gl: layer.glyphs,
    runs: layer.runs,
    tp: layer.textPath,
    // pre-DOF effects + media source
    fx: layer.effects,
    src: layer.src,
    aid: layer.assetId,
    // sourceTime / frameBlend pick WHICH source frame rasterizes — content only
    // for media layers. For shapes/text they track the timeline time, so
    // including them would (wrongly) bust the cache every frame of a
    // transform-only animation. Gate to media kinds.
    stime: layer.kind === 'image' || layer.kind === 'video' ? layer.sourceTime : undefined,
    fb: layer.kind === 'video' ? layer.frameBlend : undefined,
    // precomp: fold in inner layers' own content (recursively)
    pc: layer.precompLayers?.map(contentHashOf),
  };
}

/** Stable content digest for a fully-resolved vector RenderLayer. */
export function contentHashOf(layer: RenderLayer): string {
  return fnv1a(JSON.stringify(contentOf(layer)));
}
