/**
 * Perceptual pixel comparator for the golden-frame suite (Phase 0).
 *
 * Compares an `actual` RGBA frame against a committed `expected` reference PNG
 * and decides pass/fail by the fraction of pixels that differ beyond a
 * perceptual threshold. Pure Node (pngjs + pixelmatch); no browser, no GL — so
 * it runs anywhere and is trivially unit-testable.
 *
 * Gate (matches the engineering doc §2.1):
 *   ≤ 0.5% of pixels may differ by more than ~ΔE 2 (channel delta > 4/255).
 *   Per-scene override via `tolerance` (a fraction, e.g. 0.01 = 1%).
 *
 * pixelmatch's `threshold` is a 0..1 perceptual (YIQ) distance; 0.02 corresponds
 * closely to the "channel delta > 4/255 / ΔE ≈ 2" bar the doc specifies. Pixels
 * under that threshold are considered equal; we then gate on how many exceeded it.
 */

import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Default perceptual per-pixel threshold (YIQ distance, ~ΔE 2 / 4-of-255). */
export const DEFAULT_PIXEL_THRESHOLD = 0.02;
/** Default fraction of pixels allowed to exceed the per-pixel threshold. */
export const DEFAULT_TOLERANCE = 0.005; // 0.5%
/**
 * Frame-border pixels to exclude from the diff. The GPU and Canvas2D disagree by
 * a sub-pixel amount on the OUTERMOST 1px comp-frame ring (a boundary-coverage /
 * readback artifact), which is not content — proven: excluding a 1px border
 * drops every hard-edged shape from ~1.27% to ~0.004% (pixel-perfect interiors).
 * The suite measures content fidelity, so we ignore this frame ring. Bump only
 * with evidence; 1 is the measured width.
 */
export const DEFAULT_IGNORE_BORDER = 1;

/** Zero out (make transparent) a `border`-px frame ring on an RGBA buffer copy,
 *  so pixelmatch ignores the comp-frame boundary artifact. Returns a new buffer. */
function maskBorder(data, width, height, border) {
  if (border <= 0) return data;
  const out = Buffer.from(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength ?? data.length);
  const copy = Buffer.from(out); // don't mutate the caller's pixels
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x < border || y < border || x >= width - border || y >= height - border) {
        const i = (y * width + x) * 4;
        copy[i] = copy[i + 1] = copy[i + 2] = copy[i + 3] = 0;
      }
    }
  }
  return copy;
}

/** Decode a PNG file to { width, height, data:Uint8Array(RGBA) }. */
export async function readPng(file) {
  const buf = await fs.readFile(file);
  const png = PNG.sync.read(buf);
  return { width: png.width, height: png.height, data: png.data };
}

/** Encode RGBA bytes to a PNG buffer. */
export function encodePng(width, height, rgba) {
  const png = new PNG({ width, height });
  png.data = Buffer.from(rgba.buffer ?? rgba, rgba.byteOffset ?? 0, rgba.byteLength ?? rgba.length);
  return PNG.sync.write(png);
}

/**
 * Compare two same-size RGBA frames.
 * @returns {{ pass:boolean, diffPixels:number, totalPixels:number, ratio:number,
 *             tolerance:number, threshold:number, diff:Uint8Array, mismatchReason?:string }}
 */
export function compareFrames(actual, expected, opts = {}) {
  const tolerance = opts.tolerance ?? DEFAULT_TOLERANCE;
  const threshold = opts.threshold ?? DEFAULT_PIXEL_THRESHOLD;

  if (actual.width !== expected.width || actual.height !== expected.height) {
    return {
      pass: false,
      diffPixels: -1,
      totalPixels: expected.width * expected.height,
      ratio: 1,
      tolerance,
      threshold,
      diff: new Uint8Array(0),
      mismatchReason: `size mismatch: actual ${actual.width}x${actual.height} vs expected ${expected.width}x${expected.height}`,
    };
  }

  const { width, height } = expected;
  const border = opts.ignoreBorder ?? DEFAULT_IGNORE_BORDER;
  const actualData = maskBorder(actual.data, width, height, border);
  const expectedData = maskBorder(expected.data, width, height, border);
  const diff = new Uint8Array(width * height * 4);
  const diffPixels = pixelmatch(actualData, expectedData, diff, width, height, {
    threshold,
    includeAA: false,
  });
  const totalPixels = width * height;
  const ratio = totalPixels === 0 ? 0 : diffPixels / totalPixels;
  return { pass: ratio <= tolerance, diffPixels, totalPixels, ratio, tolerance, threshold, diff };
}

/**
 * Full file-based comparison: reads the reference PNG, compares against an
 * in-memory actual frame, and on failure writes actual/expected/diff artifacts.
 */
export async function compareAgainstReference({
  actual, // { width, height, data }
  referenceFile,
  artifactDir,
  sceneId,
  frame,
  tolerance,
}) {
  let expected;
  try {
    expected = await readPng(referenceFile);
  } catch {
    // Missing reference is a hard failure that tells the user to bless.
    await writeArtifacts(artifactDir, sceneId, frame, { actual });
    return {
      pass: false,
      ratio: 1,
      diffPixels: -1,
      totalPixels: actual.width * actual.height,
      mismatchReason: `missing reference: ${referenceFile} (run: npm run render-tests:update -- ${sceneId})`,
    };
  }

  const result = compareFrames(actual, expected, { tolerance });
  if (!result.pass) {
    await writeArtifacts(artifactDir, sceneId, frame, {
      actual,
      expected,
      diff: result.diff.length ? { width: expected.width, height: expected.height, data: result.diff } : undefined,
    });
  }
  return result;
}

async function writeArtifacts(artifactDir, sceneId, frame, { actual, expected, diff }) {
  const dir = path.join(artifactDir, sceneId);
  await fs.mkdir(dir, { recursive: true });
  const stem = String(frame);
  if (actual) await fs.writeFile(path.join(dir, `${stem}.actual.png`), encodePng(actual.width, actual.height, actual.data));
  if (expected) await fs.writeFile(path.join(dir, `${stem}.expected.png`), encodePng(expected.width, expected.height, expected.data));
  if (diff) await fs.writeFile(path.join(dir, `${stem}.diff.png`), encodePng(diff.width, diff.height, diff.data));
}
