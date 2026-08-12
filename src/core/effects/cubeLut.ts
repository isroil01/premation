/**
 * `.cube` colour LUTs — parsing and trilinear sampling.
 *
 * This is AE's Apply Color LUT, and the format is the one every grading tool
 * emits (Resolve, Lumetri, Photoshop). A 3D LUT is the only way to carry a
 * *look* that per-channel curves cannot express: curves remap each channel
 * independently, so they can never make one hue rotate while its neighbour
 * stays put, which is most of what a film emulation actually does.
 *
 * ## Format notes that are easy to get wrong
 *
 * **Red varies fastest.** The spec orders entries with red as the innermost
 * loop, so the flat index is `r + g*size + b*size²`. Getting this backwards
 * produces an image that looks plausibly graded and is wrong in a way nobody
 * spots until they compare against Resolve — which is why
 * `samples the corners in the documented axis order` exists as a test.
 *
 * **`DOMAIN_MIN`/`DOMAIN_MAX` are not decoration.** Log-space LUTs ship domains
 * other than 0..1, and ignoring them silently clips the shadows.
 *
 * **1D LUTs share the extension.** `LUT_1D_SIZE` files are per-channel curves
 * wearing the same suffix; they are parsed into the same structure with
 * `size1d` set, because rejecting them means a user's file "does not work" with
 * no explanation.
 *
 * ## Why the pipeline caveat is stated here
 *
 * Sampling happens in whatever space the pixels arrive in, and this renderer is
 * **not linear-light** (see EDITOR_REFERENCE §4). A LUT authored against log or
 * linear input will therefore not match its author's intent until the linear
 * colour work lands. That is a real limitation, not a rounding error, and it is
 * recorded here rather than discovered later.
 */

import { clamp01 } from '@utils/lang';

/** A parsed LUT. `size1d` is set for 1D LUTs, in which case `size` is 0. */
export interface CubeLut {
  /** Edge length of the 3D cube (0 for a 1D LUT). */
  size: number;
  /** Entry count of a 1D LUT (0 for a 3D LUT). */
  size1d: number;
  /** Interleaved RGB triples, `size³` (or `size1d`) of them. */
  data: Float32Array;
  domainMin: readonly [number, number, number];
  domainMax: readonly [number, number, number];
  title?: string;
}

/** Largest cube we accept. 64³ = 262 144 entries; beyond that is a hostile file. */
const MAX_3D_SIZE = 64;
/** 1D LUTs are commonly 1024 or 4096 entries. */
const MAX_1D_SIZE = 65536;

function parseTriple(parts: string[]): [number, number, number] | null {
  if (parts.length < 3) return null;
  const v = parts.slice(0, 3).map(Number);
  return v.every((n) => Number.isFinite(n)) ? [v[0]!, v[1]!, v[2]!] : null;
}

/**
 * Parse `.cube` text. Returns null for anything malformed rather than throwing:
 * the caller is a file drop, and a bad file is a user event, not an exception.
 */
export function parseCubeLut(text: string): CubeLut | null {
  let size = 0;
  let size1d = 0;
  let domainMin: [number, number, number] = [0, 0, 0];
  let domainMax: [number, number, number] = [1, 1, 1];
  let title: string | undefined;
  const entries: number[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    // `#` starts a comment anywhere on the line.
    const line = rawLine.split('#')[0]!.trim();
    if (line === '') continue;
    const parts = line.split(/\s+/);
    const head = parts[0]!.toUpperCase();

    if (head === 'TITLE') {
      title = line.slice(line.indexOf('TITLE') + 5).trim().replace(/^"|"$/g, '') || undefined;
      continue;
    }
    if (head === 'LUT_3D_SIZE') {
      const n = Number(parts[1]);
      if (!Number.isInteger(n) || n < 2 || n > MAX_3D_SIZE) return null;
      size = n;
      continue;
    }
    if (head === 'LUT_1D_SIZE') {
      const n = Number(parts[1]);
      if (!Number.isInteger(n) || n < 2 || n > MAX_1D_SIZE) return null;
      size1d = n;
      continue;
    }
    if (head === 'DOMAIN_MIN') {
      const t = parseTriple(parts.slice(1));
      if (!t) return null;
      domainMin = t;
      continue;
    }
    if (head === 'DOMAIN_MAX') {
      const t = parseTriple(parts.slice(1));
      if (!t) return null;
      domainMax = t;
      continue;
    }
    // Anything else must be a data row. An unknown keyword is NOT skipped
    // silently — a file we half-understand would grade wrongly and look fine.
    const t = parseTriple(parts);
    if (!t) return null;
    entries.push(t[0], t[1], t[2]);
  }

  if (size === 0 && size1d === 0) return null;
  if (size > 0 && size1d > 0) return null; // a file cannot be both
  const expected = size > 0 ? size * size * size * 3 : size1d * 3;
  if (entries.length !== expected) return null;
  // A degenerate domain would divide by zero in `sampleCubeLut`.
  for (let i = 0; i < 3; i++) if (!(domainMax[i]! > domainMin[i]!)) return null;

  return { size, size1d, data: new Float32Array(entries), domainMin, domainMax, ...(title ? { title } : {}) };
}

/** Normalise one channel into 0..1 across the LUT's domain. */
function toDomain(v: number, lut: CubeLut, i: number): number {
  return clamp01((v - lut.domainMin[i]!) / (lut.domainMax[i]! - lut.domainMin[i]!));
}

/**
 * Sample the LUT at an RGB triple in 0..1, trilinearly.
 *
 * Writes into `out` to keep this allocation-free — it runs per pixel, and a
 * 1080p frame is two million calls.
 */
export function sampleCubeLut(
  lut: CubeLut,
  r: number,
  g: number,
  b: number,
  out: [number, number, number] = [0, 0, 0],
): [number, number, number] {
  if (lut.size1d > 0) {
    const n = lut.size1d - 1;
    const ch = (v: number, i: number): number => {
      const x = toDomain(v, lut, i) * n;
      const lo = Math.floor(x);
      const hi = Math.min(lo + 1, n);
      const f = x - lo;
      const a = lut.data[lo * 3 + i]!;
      const c = lut.data[hi * 3 + i]!;
      return a + (c - a) * f;
    };
    out[0] = ch(r, 0); out[1] = ch(g, 1); out[2] = ch(b, 2);
    return out;
  }

  const n = lut.size - 1;
  const x = toDomain(r, lut, 0) * n;
  const y = toDomain(g, lut, 1) * n;
  const z = toDomain(b, lut, 2) * n;
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  const x1 = Math.min(x0 + 1, n), y1 = Math.min(y0 + 1, n), z1 = Math.min(z0 + 1, n);
  const fx = x - x0, fy = y - y0, fz = z - z0;

  // Red varies fastest — see the header. `size` is the green stride.
  const at = (xi: number, yi: number, zi: number, c: number): number =>
    lut.data[(xi + yi * lut.size + zi * lut.size * lut.size) * 3 + c]!;

  for (let c = 0; c < 3; c++) {
    const c00 = at(x0, y0, z0, c) + (at(x1, y0, z0, c) - at(x0, y0, z0, c)) * fx;
    const c10 = at(x0, y1, z0, c) + (at(x1, y1, z0, c) - at(x0, y1, z0, c)) * fx;
    const c01 = at(x0, y0, z1, c) + (at(x1, y0, z1, c) - at(x0, y0, z1, c)) * fx;
    const c11 = at(x0, y1, z1, c) + (at(x1, y1, z1, c) - at(x0, y1, z1, c)) * fx;
    const c0 = c00 + (c10 - c00) * fy;
    const c1 = c01 + (c11 - c01) * fy;
    out[c] = c0 + (c1 - c0) * fz;
  }
  return out;
}

/**
 * Apply a LUT in place over `ImageData` bytes, blended by `intensity` (0..1).
 *
 * `getImageData` hands back **un**premultiplied RGBA, so the channels are
 * graded directly — no divide-by-alpha dance. Fully transparent pixels are
 * skipped: their RGB is meaningless and grading it wastes the sample.
 *
 * `intensity` blends against the ORIGINAL rather than scaling the LUT output,
 * so 0 is exactly a no-op and 50 is the halfway look, which is how AE's
 * Apply Color LUT and every grading tool behave.
 */
export function applyLutToImageData(
  data: Uint8ClampedArray,
  lut: CubeLut,
  intensity = 1,
): void {
  if (!(intensity > 0)) return;
  const k = intensity > 1 ? 1 : intensity;
  const out: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const r = data[i]! / 255, g = data[i + 1]! / 255, b = data[i + 2]! / 255;
    sampleCubeLut(lut, r, g, b, out);
    data[i] = (r + (out[0] - r) * k) * 255;
    data[i + 1] = (g + (out[1] - g) * k) * 255;
    data[i + 2] = (b + (out[2] - b) * k) * 255;
  }
}

/**
 * Serialise a parsed LUT for storage in an effect param.
 *
 * `Float32Array` does not survive the JSON round-trip a `.motion` document
 * makes, so the stored form is a plain number array. Kept next to the parser so
 * the two halves cannot disagree about the layout.
 */
export interface StoredLut {
  size: number;
  size1d: number;
  data: number[];
  domainMin: [number, number, number];
  domainMax: [number, number, number];
  title?: string;
}

export function toStoredLut(lut: CubeLut): StoredLut {
  return {
    size: lut.size,
    size1d: lut.size1d,
    data: Array.from(lut.data),
    domainMin: [...lut.domainMin] as [number, number, number],
    domainMax: [...lut.domainMax] as [number, number, number],
    ...(lut.title ? { title: lut.title } : {}),
  };
}

/** Rehydrate a stored LUT, validating it the way the parser would. */
export function fromStoredLut(raw: unknown): CubeLut | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Partial<StoredLut>;
  const size = typeof o.size === 'number' ? o.size : 0;
  const size1d = typeof o.size1d === 'number' ? o.size1d : 0;
  if (!Array.isArray(o.data)) return null;
  if (size === 0 && size1d === 0) return null;
  if (size > 0 && size1d > 0) return null;
  const expected = size > 0 ? size * size * size * 3 : size1d * 3;
  if (o.data.length !== expected) return null;
  if (!o.data.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  const domainMin = (o.domainMin ?? [0, 0, 0]) as [number, number, number];
  const domainMax = (o.domainMax ?? [1, 1, 1]) as [number, number, number];
  for (let i = 0; i < 3; i++) if (!(domainMax[i]! > domainMin[i]!)) return null;
  return {
    size, size1d, data: new Float32Array(o.data), domainMin, domainMax,
    ...(o.title ? { title: o.title } : {}),
  };
}

/* ── The GPU path's two seams ─────────────────────────────────────────────── */

/**
 * The parsed LUT stored on an `apply-color-lut` effect, or null.
 *
 * Both render paths need this and neither should know how the parameter is
 * spelled: the CPU pass calls `fromStoredLut(paramsOf(e).lut)` inline, and the
 * GPU path needs the same table to upload. One reader, so a change to the stored
 * shape cannot leave one path grading and the other not.
 */
export function readCubeLutParam(e: { params?: Record<string, unknown> }): CubeLut | null {
  return fromStoredLut(e.params?.lut);
}

/**
 * A cache key for the uploaded strip.
 *
 * Keyed on the LUT's TITLE and dimensions rather than on its samples. Hashing a
 * 64³ table is a quarter of a million floats on every frame of a scrub, which
 * costs more than the upload it is trying to avoid — and a `.cube` file that
 * changes its contents without changing its title or size is not a case that
 * arises, because the parameter is replaced wholesale when a new file is
 * dropped.
 */
export function cubeLutSignature(e: { id?: string; params?: Record<string, unknown> }): string {
  const lut = readCubeLutParam(e);
  if (!lut) return 'none';
  return `${e.id ?? ''}|${lut.title ?? ''}|${lut.size}|${lut.size1d}|${lut.domainMin.join(',')}|${lut.domainMax.join(',')}`;
}
