/**
 * Environment images → SH probes.
 *
 * `environmentLight.ts` is pure maths: it knows how to project an equirect onto
 * spherical harmonics and how to expand that into a light rig, and it caches
 * both. What it deliberately does NOT know is where an image comes from — that
 * needs the asset library, the EXR float cache and a canvas, none of which
 * belong in a module the renderer imports and the unit tests exercise headless.
 *
 * This is that seam. It registers itself as the environment asset loader on
 * import, so the FIRST frame that asks for an image sky kicks a decode, falls
 * back to the default preset for that frame, and repaints when the projection
 * lands. Every failure mode — no such asset, undecodable file, no 2D context
 * (jsdom), a tainted canvas — is absorbed here and remembered, so a broken file
 * costs one attempt and then nothing.
 */

import { useAssetStore } from '@stores/assetStore';
import { bumpScene } from '@stores/sceneStore';
import { getFloatExrForAsset } from '@core/media/floatExr';
import {
  registerEnvironmentAssetLoader,
  setEnvironmentAssetSh,
  shProjectEquirect,
  hasEnvironmentAssetSh,
} from './environmentLight';

/**
 * Widest raster handed to the projector. The projector box-averages down to
 * 256×128 itself; this only bounds the intermediate `getImageData` buffer, so a
 * 8K HDRI does not allocate 256 MB on its way to 27 floats.
 */
const DECODE_MAX_WIDTH = 1024;

/** In flight — a second frame asking must not start a second decode. */
const pending = new Set<string>();
/**
 * Attempted and failed. Kept forever (until `resetEnvironmentImages`) because
 * the alternative is retrying a broken file on every single frame.
 */
const failed = new Set<string>();

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // Object URLs and same-origin files need no CORS dance; a remote source
    // does, or `getImageData` throws on a tainted canvas below.
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`environment image failed to load: ${src}`));
    img.src = src;
  });
}

/** Decode `src` into 8-bit sRGB RGBA, capped at {@link DECODE_MAX_WIDTH}. */
async function decodeSrgbPixels(
  src: string,
): Promise<{ pixels: Uint8ClampedArray; width: number; height: number } | null> {
  if (typeof document === 'undefined' || typeof Image === 'undefined') return null;
  const img = await loadImageElement(src);
  const natW = img.naturalWidth || img.width;
  const natH = img.naturalHeight || img.height;
  if (!natW || !natH) return null;
  const scale = Math.min(1, DECODE_MAX_WIDTH / natW);
  const w = Math.max(1, Math.round(natW * scale));
  const h = Math.max(1, Math.round(natH * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  // jsdom has no 2D backend; an env image is simply not resolvable there.
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);
  return { pixels: data.data, width: w, height: h };
}

/**
 * Make sure `assetId`'s SH projection exists, decoding it if need be.
 *
 * Idempotent and never rejects. Resolves `true` when the projection is in hand
 * (already, or as a result of this call).
 */
export async function ensureEnvironmentSh(assetId: string): Promise<boolean> {
  if (!assetId) return false;
  if (hasEnvironmentAssetSh(assetId)) return true;
  if (pending.has(assetId) || failed.has(assetId)) return false;
  pending.add(assetId);
  try {
    // EXR keeps its LINEAR float planes beside the tone-mapped PNG preview
    // (see floatExr.ts). Projecting those rather than the 8-bit stand-in is the
    // whole point of importing an HDRI: the sun keeps its real energy instead
    // of being clipped to 1.0 by the preview's tone map.
    const float = getFloatExrForAsset(assetId);
    if (float) {
      setEnvironmentAssetSh(
        assetId,
        shProjectEquirect(float.rgba, float.width, float.height, { isLinear: true }),
      );
      bumpScene();
      return true;
    }
    const asset = useAssetStore.getState().assets.find((a) => a.id === assetId);
    if (!asset || asset.type !== 'image' || !asset.src) {
      failed.add(assetId);
      return false;
    }
    const decoded = await decodeSrgbPixels(asset.src);
    if (!decoded) {
      failed.add(assetId);
      return false;
    }
    setEnvironmentAssetSh(
      assetId,
      shProjectEquirect(decoded.pixels, decoded.width, decoded.height, { isLinear: false }),
    );
    // The rig the renderer already drew this frame used the fallback preset —
    // this is what makes the real sky appear without a user gesture.
    bumpScene();
    return true;
  } catch {
    failed.add(assetId);
    return false;
  } finally {
    pending.delete(assetId);
  }
}

/** Forget every decode attempt — a re-import, or a test between cases. */
export function resetEnvironmentImages(): void {
  pending.clear();
  failed.clear();
}

registerEnvironmentAssetLoader((assetId) => {
  void ensureEnvironmentSh(assetId);
});
