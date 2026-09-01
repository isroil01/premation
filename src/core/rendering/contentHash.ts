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
 * v3: structural hasher (float bits + word-mixed FNV) replaced
 * JSON.stringify + per-character FNV. The old scheme built a fresh multi-KB
 * string per layer per frame — on a 600-layer comp the hash alone cost as much
 * as the whole rest of buildSnapshot (measured ~14.5µs/layer, half of it the
 * charCodeAt loop over stringified float text).
 */
export const CONTENT_HASH_VERSION = 3;

// ── Structural FNV-1a (word-granular) ────────────────────────────────
// Same determinism contract as the old string FNV, an order of magnitude
// cheaper: numbers hash as their two Float64 bit-words (2 mixes instead of
// ~20 charCodeAt rounds of decimal text), and no intermediate string is ever
// built. Type tags keep 1, "1" and [1] distinct. Object keys hash too, so
// {a:1} ≠ {b:1}. Key ORDER matters exactly as it did for JSON.stringify —
// contentOf constructs every object with a fixed literal order, which is the
// same assumption the JSON scheme already leaned on.

const f64Scratch = new Float64Array(1);
const u32Scratch = new Uint32Array(f64Scratch.buffer);

const TAG_NULL = 0x6e756c6c; // 'null'
const TAG_UNDEF = 0x756e6465;
const TAG_FALSE = 0x66616c73;
const TAG_TRUE = 0x74727565;
const TAG_NUM = 0x6e756d62;
const TAG_STR = 0x73747200;
const TAG_ARR = 0x61727200;
const TAG_OBJ = 0x6f626a00;
const TAG_END = 0x656e6400;

// The mix is written inline everywhere (`h = Math.imul(h ^ w, 0x01000193)`)
// rather than through a helper: this leaf runs hundreds of times per layer per
// frame and the call itself was the measurable cost.
function hashUnknown(h: number, v: unknown): number {
  if (v === null) return Math.imul(h ^ TAG_NULL, 0x01000193);
  switch (typeof v) {
    case 'undefined':
      return Math.imul(h ^ TAG_UNDEF, 0x01000193);
    case 'boolean':
      return Math.imul(h ^ (v ? TAG_TRUE : TAG_FALSE), 0x01000193);
    case 'number':
      f64Scratch[0] = v;
      h = Math.imul(h ^ TAG_NUM, 0x01000193);
      h = Math.imul(h ^ u32Scratch[0]!, 0x01000193);
      return Math.imul(h ^ u32Scratch[1]!, 0x01000193);
    case 'string': {
      h = Math.imul(h ^ TAG_STR, 0x01000193);
      h = Math.imul(h ^ v.length, 0x01000193);
      for (let i = 0; i < v.length; i++) h = Math.imul(h ^ v.charCodeAt(i), 0x01000193);
      return h;
    }
    case 'object': {
      if (Array.isArray(v)) {
        h = Math.imul(h ^ TAG_ARR, 0x01000193);
        h = Math.imul(h ^ v.length, 0x01000193);
        for (let i = 0; i < v.length; i++) h = hashUnknown(h, v[i]);
        return Math.imul(h ^ TAG_END, 0x01000193);
      }
      h = Math.imul(h ^ TAG_OBJ, 0x01000193);
      const o = v as Record<string, unknown>;
      for (const k in o) {
        const val = o[k];
        // JSON.stringify dropped undefined-valued keys; keep that shape so
        // optional fields present-but-undefined hash like absent ones.
        if (val === undefined) continue;
        h = Math.imul(h ^ TAG_STR, 0x01000193);
        for (let i = 0; i < k.length; i++) h = Math.imul(h ^ k.charCodeAt(i), 0x01000193);
        h = hashUnknown(h, val);
      }
      return Math.imul(h ^ TAG_END, 0x01000193);
    }
    default:
      return Math.imul(h ^ TAG_UNDEF, 0x01000193);
  }
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
  const h = hashUnknown(0x811c9dc5, contentOf(layer));
  return (h >>> 0).toString(16).padStart(8, '0');
}
