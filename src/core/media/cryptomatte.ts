/**
 * Cryptomatte — per-object ID mattes carried in an EXR's extra channels
 * (plan C2; the Fusion 21 workflow on imported renders).
 *
 * ## The format, in the part this reads
 *
 * A renderer writes, for each Cryptomatte layer (say `CryptoObject`):
 *  · header strings `cryptomatte/<id>/name` = "CryptoObject" and
 *    `cryptomatte/<id>/manifest` = JSON `{ "object name": "8 hex digits", … }`
 *    — each object's 32-bit hash (MurmurHash3 of its name);
 *  · channels `CryptoObject00.R/G/B/A`, `CryptoObject01.R/G/B/A`, …: pairs of
 *    (id, coverage) per RANK — R/G is the object that covers the pixel most,
 *    B/A the next, then the next layer's R/G … Ids are the hash's BITS stored
 *    as a float32, which is why the comparison below is on bit patterns and
 *    never on the float's value.
 *
 * The matte of an object is the sum, over ranks, of the coverage whose id bits
 * match its hash — so an anti-aliased edge shared by two objects splits
 * between their mattes, and every object's mattes sum to one. No hashing is
 * done here: the manifest already names every id the file carries; a file
 * without a manifest still lists its ids as anonymous entries.
 *
 * ## Where it lives
 *
 * Extracted once at import (`importExrWithFloat`) and cached by asset id like
 * the float planes; the Track Matte picker offers "ID matte: <name>" for a
 * layer whose asset carries a set, and `createIdMatteLayerEdit` (layout/Inspector/idMatteEdits.ts) bakes the
 * coverage to a grey PNG asset, inserts it above and sets it as the luma
 * matte — the existing matte machinery does the rest.
 */

import type { ExrImage } from './exr';

export interface CryptomatteLayer {
  /** The layer's channel prefix, e.g. "CryptoObject". */
  name: string;
  /** Object name → hash (uint32), from the manifest; anonymous ids get "#<hex>". */
  objects: Array<{ name: string; hash: number }>;
  /** (id, coverage) plane pairs in rank order. */
  ranks: Array<{ id: Float32Array; coverage: Float32Array }>;
}

export interface CryptomatteSet {
  width: number;
  height: number;
  layers: CryptomatteLayer[];
}

/** The uint32 bit pattern a float32 plane's sample holds. */
function bitsOf(plane: Float32Array): Uint32Array {
  return new Uint32Array(plane.buffer, plane.byteOffset, plane.length);
}

/** Every Cryptomatte layer the image carries, or null when there is none. */
export function extractCryptomatte(img: ExrImage): CryptomatteSet | null {
  const attrs = img.attributes ?? {};
  const layerNames = new Set<string>();
  const manifests = new Map<string, Record<string, string>>();
  for (const [key, value] of Object.entries(attrs)) {
    const m = /^cryptomatte\/([^/]+)\/(name|manifest)$/.exec(key);
    if (!m) continue;
    const id = m[1]!;
    if (m[2] === 'name') layerNames.add(value);
    else {
      try {
        const parsed = JSON.parse(value) as unknown;
        if (parsed && typeof parsed === 'object') manifests.set(id, parsed as Record<string, string>);
      } catch { /* a malformed manifest leaves the ids anonymous */ }
    }
  }
  // Layers can also be found from the channels alone (a stripped header).
  for (const c of img.channels) {
    const m = /^(.+?)(\d\d)\.(R|G|B|A)$/.exec(c.name);
    if (m && img.channels.some((o) => o.name === `${m[1]}${m[2]}.G`)) layerNames.add(m[1]!);
  }
  const layers: CryptomatteLayer[] = [];
  for (const name of layerNames) {
    const ranks: CryptomatteLayer['ranks'] = [];
    for (let k = 0; k < 16; k++) {
      const suffix = `${name}${k.toString().padStart(2, '0')}`;
      const ch = (s: string): Float32Array | undefined => img.channels.find((c) => c.name === `${suffix}.${s}`)?.data;
      const r = ch('R'); const g = ch('G'); const b = ch('B'); const a = ch('A');
      if (!r || !g) break;
      ranks.push({ id: r, coverage: g });
      if (b && a) ranks.push({ id: b, coverage: a });
    }
    if (ranks.length === 0) continue;
    // The manifest for this layer: the one whose `name` attribute matches, or
    // the only one there is.
    let manifest: Record<string, string> | undefined;
    for (const [id, mf] of manifests) {
      if (attrs[`cryptomatte/${id}/name`] === name || manifests.size === 1) { manifest = mf; break; }
    }
    const objects: CryptomatteLayer['objects'] = [];
    const known = new Set<number>();
    if (manifest) {
      for (const [objName, hex] of Object.entries(manifest)) {
        const hash = Number.parseInt(hex, 16) >>> 0;
        if (!Number.isFinite(hash)) continue;
        objects.push({ name: objName, hash });
        known.add(hash);
      }
    }
    // Ids present in the planes but absent from the manifest — listed so a
    // stripped file is still usable, named by their hex.
    const seen = new Set<number>();
    for (const rank of ranks) {
      const bits = bitsOf(rank.id);
      for (let i = 0; i < bits.length; i++) {
        const h = bits[i]!;
        if (h === 0 || known.has(h) || seen.has(h)) continue;
        seen.add(h);
        if (seen.size > 512) break;
      }
    }
    for (const h of seen) objects.push({ name: `#${h.toString(16).padStart(8, '0')}`, hash: h });
    objects.sort((p, q) => p.name.localeCompare(q.name));
    layers.push({ name, objects, ranks });
  }
  return layers.length > 0 ? { width: img.width, height: img.height, layers } : null;
}

/** Coverage 0..1 per pixel for the given objects (by hash) — summed over ranks. */
export function idMatteCoverage(set: CryptomatteSet, layer: CryptomatteLayer, hashes: ReadonlyArray<number>): Float32Array {
  const n = set.width * set.height;
  const out = new Float32Array(n);
  const want = new Set(hashes.map((h) => h >>> 0));
  if (want.size === 0) return out;
  for (const rank of layer.ranks) {
    const bits = bitsOf(rank.id);
    for (let i = 0; i < n; i++) {
      if (want.has(bits[i]!)) out[i] = Math.min(1, out[i]! + Math.max(0, rank.coverage[i]!));
    }
  }
  return out;
}

/** Coverage → straight grey RGBA8 bytes (white = fully covered), a luma matte's shape. */
export function coverageToRgba8(coverage: Float32Array): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(new ArrayBuffer(coverage.length * 4));
  for (let i = 0; i < coverage.length; i++) {
    const v = Math.round(Math.max(0, Math.min(1, coverage[i]!)) * 255);
    out[i * 4] = v; out[i * 4 + 1] = v; out[i * 4 + 2] = v; out[i * 4 + 3] = 255;
  }
  return out;
}

// ── Per-asset cache, beside the float planes ─────────────────────────────────

const cache = new Map<string, CryptomatteSet>();

export function setCryptomatteForAsset(assetId: string, set: CryptomatteSet | null): void {
  if (set) cache.set(assetId, set);
  else cache.delete(assetId);
}

export function getCryptomatteForAsset(assetId: string): CryptomatteSet | undefined {
  return cache.get(assetId);
}

export function clearCryptomatteCache(): void {
  cache.clear();
}

/** Bake coverage to a PNG File named after the objects it isolates. */
export async function idMattePngFile(set: CryptomatteSet, layerName: string, objectNames: ReadonlyArray<string>, baseName: string): Promise<File | null> {
  const layer = set.layers.find((l) => l.name === layerName);
  if (!layer) return null;
  const hashes = layer.objects.filter((o) => objectNames.includes(o.name)).map((o) => o.hash);
  if (hashes.length === 0) return null;
  const coverage = idMatteCoverage(set, layer, hashes);
  const canvas = document.createElement('canvas');
  canvas.width = set.width; canvas.height = set.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.putImageData(new ImageData(coverageToRgba8(coverage), set.width, set.height), 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) return null;
  const label = objectNames.length === 1 ? objectNames[0]! : `${objectNames.length} objects`;
  return new File([blob], `${baseName} — ID matte (${label}).png`, { type: 'image/png' });
}
