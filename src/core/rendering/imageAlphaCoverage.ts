/**
 * Image-alpha coverage for puppet meshing (CPU side, buildSnapshot).
 *
 * `buildRestMesh` can cull mesh cells that fall on fully-transparent pixels of an
 * image layer, but that needs the bitmap's alpha — which is only available after
 * an async decode. This module owns that decode + cache seam:
 *
 *   • `getImageCoverageMask(key, src)` returns a cached `PuppetCoverageMask` when
 *     the bitmap has already been decoded, or `undefined` while it is still
 *     loading (the caller then falls back to the bbox grid for that frame — it
 *     never blocks or throws).
 *   • The first miss kicks off a bounded, deterministic decode: draw the image
 *     into a small offscreen canvas (capped at COVERAGE_SAMPLES per side), read
 *     the alpha channel once, and derive the coverage grid. When it finishes we
 *     fire an AnimationChanged event so the surface re-renders and the tighter
 *     mesh appears next frame.
 *
 * Determinism: the coverage grid is a fixed-resolution alpha downsample with a
 * fixed threshold, keyed by asset identity — the same source always caches the
 * same mask, so scrubbing/replaying never resamples or drifts.
 */

import { coverageMaskFromImageData, type PuppetCoverageMask } from '../rig/puppet';
import { getEventBus } from '@core/events/EventBus';

/** Fixed decode resolution (per side). Matches buildRestMesh's 64-sample cap. */
const COVERAGE_SAMPLES = 64;
/** Alpha (0-255) at/above which a pixel counts as artwork rather than background. */
const ALPHA_THRESHOLD = 12;

const cache = new Map<string, PuppetCoverageMask>();
const inFlight = new Set<string>();
/** Sources whose decode failed — never retried, so a broken URL can't thrash. */
const failed = new Set<string>();

/**
 * Coverage mask for an image source, or undefined until its bitmap has decoded.
 * `key` is the stable cache identity (asset id when available, else the src).
 */
export function getImageCoverageMask(key: string, src: string): PuppetCoverageMask | undefined {
  const cached = cache.get(key);
  if (cached) return cached;
  if (!src || failed.has(key) || inFlight.has(key)) return undefined;
  // No DOM to decode in (SSR / tests) — stay on the bbox grid.
  if (typeof document === 'undefined' || typeof Image === 'undefined') return undefined;
  inFlight.add(key);
  void decode(key, src);
  return undefined;
}

async function decode(key: string, src: string): Promise<void> {
  try {
    const img = await loadImage(src);
    const w = Math.max(1, Math.min(COVERAGE_SAMPLES, img.naturalWidth || img.width || 1));
    const h = Math.max(1, Math.min(COVERAGE_SAMPLES, img.naturalHeight || img.height || 1));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      failed.add(key);
      return;
    }
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h);
    const mask = coverageMaskFromImageData(
      { data: data.data, width: w, height: h },
      { maxSamples: COVERAGE_SAMPLES, alphaThreshold: ALPHA_THRESHOLD },
    );
    cache.set(key, mask);
    // A tighter mesh is now available — nudge the surface to re-render.
    try {
      getEventBus().emit('AnimationChanged', { nodeId: '__puppet_coverage__' });
    } catch {
      /* no bus (tests) — the mask is cached; the next render picks it up */
    }
  } catch {
    failed.add(key);
  } finally {
    inFlight.delete(key);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image decode failed'));
    img.src = src;
  });
}

/** Test/debug seam: drop cached masks (and in-flight/failed bookkeeping). */
export function clearImageCoverageCache(): void {
  cache.clear();
  inFlight.clear();
  failed.clear();
}
