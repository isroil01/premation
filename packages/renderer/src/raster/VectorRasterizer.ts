/**
 * VectorRasterizer — the formal rasterizer seam (engine-unification Phase 1).
 *
 * ONE component turns resolved vector content (shape paths, text glyphs, masks,
 * gradients) into GPU textures; the GPU compositor then does all blending,
 * mattes, effects, and motion blur. This is the After Effects / Toon Boom
 * model: vectors rasterized on CPU, frames composed on GPU, one definition of
 * what a vector layer's pixels are.
 *
 * STATUS: contract + resolution-tier logic. The concrete `Canvas2DVectorRasterizer`
 * is produced by MOVING the raster functions currently duplicated in
 * `src/core/rendering/AppTextureProvider.ts` (rasterizePath/rasterizeText/
 * rasterizeLight/rasterizeGradient + mask paint) and `Canvas2DBackend.ts`
 * (shapePath/strokeShape/drawGlyphs/…) into a single implementation both
 * backends delegate to — closing the stroke/text drift the golden suite
 * measures. See the phase plan; this file defines the shape that work fills.
 *
 * Cache key = contentHash (from the snapshot; see src/core/rendering/contentHash.ts)
 * × resolution tier (below) × padding class. Transform-only animation reuses the
 * texture (contentHash unchanged); crossing a resolution tier (zoom / 4K export)
 * re-rasters at native scale instead of upscaling a stale texture.
 */

/** A GPU texture handle owned by the rasterizer's cache. Binds to the renderer's
 *  concrete texture handle when Canvas2DVectorRasterizer is implemented. */
export interface EngineTexture {
  readonly id: string;
  readonly width: number;
  readonly height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A fully-resolved drawable from the snapshot: geometry + fill/stroke/gradient +
 * glyph runs + mask geometry, plus the content hash the snapshot already carries
 * (RenderLayer.contentHash). NO document references — snapshot data only. Typed
 * loosely here; binds to RenderLayer's vector projection at implementation time.
 */
export interface ResolvedVectorDrawable {
  readonly contentHash: string;
  readonly width: number;
  readonly height: number;
  readonly [field: string]: unknown;
}

export interface RasterRequest {
  drawable: ResolvedVectorDrawable;
  /** Device pixels per scene unit for this raster (zoom / export scale aware). */
  resolutionScale: number;
  /** Extra padding in px around tight bounds (feather, stroke overshoot, mesh). */
  padding: number;
}

export interface RasterResult {
  texture: EngineTexture;
  /** Placement rect in scene units incl. padding. */
  uvRect: Rect;
  resolutionScale: number;
}

export interface RasterStats {
  textures: number;
  bytes: number;
  hits: number;
  misses: number;
}

export interface VectorRasterizer {
  /** Cache-aware; the hot path must be a lookup (contentHash × tier × padding). */
  rasterize(req: RasterRequest): RasterResult;
  invalidate(contentHash: string): void;
  stats(): RasterStats;
}

// ── Resolution tiers ────────────────────────────────────────────────────────
// Quantize the target scale to discrete steps so a continuous zoom re-rasters
// only when it crosses a tier (not every frame), while a 4K export still gets a
// native-resolution raster instead of upscaling a viewport-resolution texture.

/** Discrete rasterization scales. A drawable is rastered at its box × tier. */
export const RESOLUTION_TIERS = [0.5, 1, 2, 4] as const;

/**
 * The tier to rasterize at for a target device scale: the smallest tier that is
 * >= the requested scale (round UP so content is never softer than requested),
 * clamped to the tier range. So scale 1.0 → 1, 1.3 → 2, 0.4 → 0.5, 6 → 4.
 *
 * The 4× ceiling is the whole reason CONTINUOUS RASTERIZATION is a feature: a
 * shape scaled to 800% asks for 8 and gets 4, so the GPU magnifies the texture
 * 2× and the edge goes soft. Everything else CR needs already works — the
 * layer's own scale, its parent chain and its 3D camera distance all reach this
 * function (measured in rasterScale.probe.test.ts) — it is this clamp that
 * throws the information away. Left exactly as it was so CR OFF is byte
 * -identical for every existing project; `continuousResolutionTier` is the
 * opted-in path.
 */
export function resolutionTier(scale: number): number {
  if (!(scale > 0) || Number.isNaN(scale)) return 1;
  for (const t of RESOLUTION_TIERS) {
    if (scale <= t) return t;
  }
  return RESOLUTION_TIERS[RESOLUTION_TIERS.length - 1]!;
}

/**
 * Tiers reachable with Continuous Rasterization on — the same power-of-two
 * ladder, continued. Doubling keeps re-rasters rare (a continuous zoom crosses a
 * tier only when it doubles) and keeps the scaler on clean ratios.
 */
export const CONTINUOUS_RESOLUTION_TIERS = [0.5, 1, 2, 4, 8, 16, 32, 64] as const;

/** Hard ceiling on either axis of a raster texture when the backend does not
 *  report its own. 8192 is the floor of what WebGL2/WebGPU guarantee in
 *  practice; exceeding the real limit fails the texture allocation outright. */
export const DEFAULT_MAX_RASTER_DIMENSION = 8192;

/** Pixel budget for a single continuously-rasterized layer. 16M px = 64MB at
 *  RGBA8 — a 4096² raster, which is a 512px box at 8× or a 1024px box at 4×.
 *  Chosen so a handful of CR layers coexist in a normal VRAM budget. */
export const DEFAULT_MAX_RASTER_PIXELS = 16 * 1024 * 1024;

/**
 * Largest tier a box may be rasterized at without blowing a limit.
 *
 * Two independent bounds, both real:
 *
 *  - `maxDimension` — the GPU refuses a texture wider or taller than this, so
 *    this one is a hardware fact, not a policy. A 1000px box cannot exceed 8×
 *    against an 8192 limit.
 *  - `maxPixels` — a policy budget. The dimension limit alone still permits
 *    8192² = 67M pixels = 268MB for ONE layer, and a comp full of them would
 *    exhaust VRAM. This is what keeps CR from being a footgun.
 *
 * Returns the largest ladder tier satisfying both, never below the smallest
 * tier — a box that cannot fit even at 0.5× is degenerate and the caller's
 * existing clamps handle it.
 */
export function maxContinuousTier(
  boxWidth: number,
  boxHeight: number,
  maxDimension: number = DEFAULT_MAX_RASTER_DIMENSION,
  maxPixels: number = DEFAULT_MAX_RASTER_PIXELS,
): number {
  const w = Math.max(1, boxWidth || 1);
  const h = Math.max(1, boxHeight || 1);
  let best: number = CONTINUOUS_RESOLUTION_TIERS[0]!;
  for (const t of CONTINUOUS_RESOLUTION_TIERS) {
    if (w * t > maxDimension || h * t > maxDimension) break;
    if (w * t * h * t > maxPixels) break;
    best = t;
  }
  return best;
}

/**
 * The tier for a CONTINUOUSLY RASTERIZED drawable.
 *
 * Same round-up rule as `resolutionTier`, on the extended ladder, then bounded
 * by what the box can actually be allocated at and by `ceiling` — the per-frame
 * cap the renderer lowers during draft/reduced-resolution preview so scrubbing
 * does not pay for export-grade rasters.
 */
export function continuousResolutionTier(
  scale: number,
  boxWidth: number,
  boxHeight: number,
  ceiling: number = CONTINUOUS_RESOLUTION_TIERS[CONTINUOUS_RESOLUTION_TIERS.length - 1]!,
  maxDimension?: number,
  maxPixels?: number,
): number {
  if (!(scale > 0) || Number.isNaN(scale)) return 1;
  const limit = Math.min(maxContinuousTier(boxWidth, boxHeight, maxDimension, maxPixels), ceiling);
  let chosen: number = CONTINUOUS_RESOLUTION_TIERS[0]!;
  for (const t of CONTINUOUS_RESOLUTION_TIERS) {
    chosen = t;
    if (scale <= t) break;
  }
  return Math.min(chosen, Math.max(CONTINUOUS_RESOLUTION_TIERS[0]!, limit));
}

/**
 * Padding class bucket (px) — coarse buckets so feather/stroke-overshoot
 * variations don't fragment the cache into near-duplicate entries. Rounds a
 * padding request up to the next bucket.
 */
export const PADDING_CLASSES = [0, 8, 24, 64] as const;

export function paddingClass(padding: number): number {
  const p = Math.max(0, padding || 0);
  for (const c of PADDING_CLASSES) {
    if (p <= c) return c;
  }
  return PADDING_CLASSES[PADDING_CLASSES.length - 1]!;
}

/**
 * Round a draw scale up onto the EXTENDED ladder, for cache-key purposes only.
 *
 * `resolutionTier` cannot be used here: it tops out at 4, and the scale that
 * reaches a raster cache key has already been quantised by the provider's
 * `tierFor`, which escalates onto the continuous ladder (8, 16, 32, 64) above
 * that. Re-quantising with the clamped ladder rewrote every such key back down
 * to `@4`, which is the whole of the "text vanishes past 4x" bug — see
 * `rasterCacheKey`.
 *
 * Identical to `resolutionTier` at and below 4, so every key already in flight
 * for an existing project is byte-for-byte unchanged.
 */
export function rasterKeyTier(scale: number): number {
  if (!(scale > 0) || Number.isNaN(scale)) return 1;
  for (const t of CONTINUOUS_RESOLUTION_TIERS) {
    if (scale <= t) return t;
  }
  return CONTINUOUS_RESOLUTION_TIERS[CONTINUOUS_RESOLUTION_TIERS.length - 1]!;
}

/**
 * The full cache key for a raster: content × tier × padding class.
 *
 * The tier MUST round-trip: the rasterizer writes its pixels into the resource
 * pool under `poolKeyFor(this key)`, and `AppTextureProvider` then reads the
 * texture back out under `raster:<sig>@<tier>~<pad>` built from its OWN tier.
 * When the two spellings disagree the provider asks the pool for a key nothing
 * ever wrote to, gets a freshly-minted EMPTY texture, and the layer renders as
 * nothing at all — box, handles and selection intact, pixels gone.
 *
 * That is exactly what `resolutionTier` did here: it clamps at 4, so a layer at
 * 5x or more was drawn into `@4` and read from `@8`. Reported as "text
 * disappears when you scale it up"; shapes with a custom path did the same.
 */
export function rasterCacheKey(contentHash: string, scale: number, padding: number): string {
  return `${contentHash}@${rasterKeyTier(scale)}~${paddingClass(padding)}`;
}
