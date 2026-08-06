/**
 * Pixels, across the sandbox boundary.
 *
 * Until now the plugin API was entirely *structural* — layers, properties,
 * keyframes, time. A plugin that wanted to touch an image had no path at all,
 * so the only thing it could do was ask the user to upload the picture a second
 * time into its own panel iframe. That is not a missing convenience; it is the
 * reason a whole class of plugin could not be written.
 *
 * Two things make this different from every other method in the API, and both
 * are why this lives in its own file rather than inline in `hostApi.ts`.
 *
 * **It is the first non-JSON payload.** Pixel data must not go through
 * `JSON.stringify` or base64: base64 is 33% inflation, and stringifying a 4K
 * frame is a synchronous stall measured in hundreds of milliseconds on whichever
 * thread does it — which, in the host's direction, is the main thread. Buffers
 * ride structured clone and go in the `postMessage` transfer list instead.
 *
 * **It is the first unbounded allocation.** `assets:read` on an 8000×8000 image
 * is 256 MB of RGBA in one call. Without ceilings, a single plugin call ends the
 * app — and it would look like the editor crashed, not like a plugin did
 * something unreasonable. So every limit below is checked BEFORE decoding, and
 * exceeding one is an ordinary refused call: a named error, logged, with the
 * plugin left running.
 *
 * PIXEL FORMAT: plugin-facing bytes are STRAIGHT (un-premultiplied) RGBA8, which
 * is what `getImageData` gives and what a plugin author will expect. The engine's
 * own invariant is premultiplied-at-decode; that conversion happens where it
 * always did, on the way in, because `createImage` hands its result to the same
 * asset import path as a user drag-and-drop.
 */

import { useAssetStore, type ImportedAsset } from '@stores/assetStore';

/**
 * Every ceiling, in one block, because they only make sense relative to each
 * other and a limit that lives next to its check is a limit nobody can audit.
 */
export const ASSET_LIMITS = {
  /**
   * Longest edge. Not the binding constraint — it exists to refuse absurd
   * aspect ratios (1 × 100,000,000) that satisfy a pixel budget but break
   * every downstream assumption about an image.
   */
  MAX_DIMENSION: 8192,
  /**
   * Total pixels. 16 MP is exactly `MAX_DECODED_BYTES` of RGBA, so the two
   * express one rule in the two units the two checks have available: declared
   * dimensions before decode, actual length after.
   */
  MAX_PIXELS: 16 * 1024 * 1024,
  /** One asset, decoded. */
  MAX_DECODED_BYTES: 64 * 1024 * 1024,
  /**
   * How much one plugin may have in flight at once. Refused, never queued: a
   * queue turns "you asked for too much" into "the plugin has hung", and the
   * user cannot tell those apart.
   */
  MAX_IN_FLIGHT_BYTES: 96 * 1024 * 1024,
  /** Everything one plugin has created this session. Released when it stops. */
  MAX_PLUGIN_BUDGET_BYTES: 256 * 1024 * 1024,
} as const;

/** Encoded types a plugin may hand us, plus the raw form. */
export const ACCEPTED_IMAGE_MIMES = [
  'image/rgba8',
  'image/png',
  'image/jpeg',
  'image/webp',
] as const;

/** The wire form of raw pixels — `bytes.length === width * height * 4`. */
export const RAW_MIME = 'image/rgba8';

/**
 * A refused asset call.
 *
 * `code` is part of the contract, not decoration: the message crosses the
 * worker boundary as a plain string, so the code has to be IN it for a plugin
 * (or a test) to distinguish "too big" from "not found" without string-matching
 * English prose that will be reworded.
 */
export class AssetLimitError extends Error {
  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(`[${code}] ${detail}`);
    this.name = 'AssetLimitError';
  }
}

const refuse = (code: string, detail: string): never => {
  throw new AssetLimitError(code, detail);
};

// ── Per-plugin accounting ────────────────────────────────────────────────

interface Budget {
  inFlight: number;
  total: number;
}

const budgets = new Map<string, Budget>();

const budgetOf = (pluginId: string): Budget => {
  let b = budgets.get(pluginId);
  if (!b) { b = { inFlight: 0, total: 0 }; budgets.set(pluginId, b); }
  return b;
};

/**
 * Reserve `bytes` against a plugin's ceilings, or refuse by name.
 *
 * Returns the release function rather than exposing a matching `release(bytes)`
 * — a caller that reserves and forgets to release leaks the budget for the
 * session, and pairing them in one value is the only version of this that
 * cannot be got wrong at a call site.
 */
export function reserve(pluginId: string, bytes: number): () => void {
  const b = budgetOf(pluginId);
  if (b.inFlight + bytes > ASSET_LIMITS.MAX_IN_FLIGHT_BYTES) {
    refuse(
      'asset-busy',
      `this plugin already has ${Math.round(b.inFlight / 1024 / 1024)} MB of image data in flight; ` +
      `the limit is ${Math.round(ASSET_LIMITS.MAX_IN_FLIGHT_BYTES / 1024 / 1024)} MB. Await your previous call.`,
    );
  }
  if (b.total + bytes > ASSET_LIMITS.MAX_PLUGIN_BUDGET_BYTES) {
    refuse(
      'asset-budget-exhausted',
      `this plugin has used its ${Math.round(ASSET_LIMITS.MAX_PLUGIN_BUDGET_BYTES / 1024 / 1024)} MB ` +
      'image budget for this session. Restart the plugin to reset it.',
    );
  }
  b.inFlight += bytes;
  b.total += bytes;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    b.inFlight = Math.max(0, b.inFlight - bytes);
  };
}

/** Give a stopped plugin its budget back. Called from `PluginHost.stop`. */
export function releaseAssetBudget(pluginId: string): void {
  budgets.delete(pluginId);
}

/** Test/inspection read. */
export function assetBudget(pluginId: string): Readonly<Budget> {
  return { ...budgetOf(pluginId) };
}

// ── Validation ───────────────────────────────────────────────────────────

/** Check declared dimensions BEFORE anything allocates against them. */
export function assertDecodable(width: number, height: number): number {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    refuse('asset-bad-size', 'width and height must be whole numbers ≥ 1.');
  }
  if (width > ASSET_LIMITS.MAX_DIMENSION || height > ASSET_LIMITS.MAX_DIMENSION) {
    refuse(
      'asset-too-large-dimension',
      `${width}×${height} exceeds the ${ASSET_LIMITS.MAX_DIMENSION} px limit on a single side.`,
    );
  }
  const pixels = width * height;
  if (pixels > ASSET_LIMITS.MAX_PIXELS) {
    refuse(
      'asset-too-many-pixels',
      `${width}×${height} is ${Math.round(pixels / 1024 / 1024)} MP; the limit is ` +
      `${ASSET_LIMITS.MAX_PIXELS / 1024 / 1024} MP.`,
    );
  }
  const bytes = pixels * 4;
  if (bytes > ASSET_LIMITS.MAX_DECODED_BYTES) {
    refuse(
      'asset-too-large-bytes',
      `${width}×${height} decodes to ${Math.round(bytes / 1024 / 1024)} MB; the limit is ` +
      `${ASSET_LIMITS.MAX_DECODED_BYTES / 1024 / 1024} MB.`,
    );
  }
  return bytes;
}

// ── Decode / encode ──────────────────────────────────────────────────────

/**
 * Decode a source into straight RGBA8, off the DOM.
 *
 * `createImageBitmap` + `OffscreenCanvas` deliberately, not an `<img>` and a
 * `<canvas>`: this runs in response to a third-party call, and reaching into
 * the document to service one would put plugin-triggered work in the same place
 * as the editor's own rendering.
 */
export async function decodeToRgba(
  source: Blob,
): Promise<{ width: number; height: number; bytes: Uint8Array }> {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') {
    refuse('asset-undecodable', 'this build cannot decode images off the main thread.');
  }
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(source);
  } catch (err) {
    return refuse('asset-undecodable', `the image could not be decoded: ${(err as Error).message}`);
  }
  try {
    // Checked from the DECODED size, not a declared one — a 200-byte PNG can
    // declare 30000×30000, and the header is the attacker-controlled part.
    assertDecodable(bmp.width, bmp.height);
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return refuse('asset-undecodable', 'a 2D context was not available.');
    ctx.drawImage(bmp, 0, 0);
    const data = ctx.getImageData(0, 0, bmp.width, bmp.height);
    return {
      width: bmp.width,
      height: bmp.height,
      // Copied out of the ImageData so the buffer we hand to `postMessage` can
      // be transferred (and neutered) without touching canvas-owned memory.
      bytes: new Uint8Array(data.data.buffer.slice(0)),
    };
  } finally {
    bmp.close();
  }
}

/** Encode straight RGBA8 to a PNG blob. */
export async function encodeRgbaToPng(width: number, height: number, bytes: Uint8Array): Promise<Blob> {
  if (typeof OffscreenCanvas === 'undefined') {
    refuse('asset-undecodable', 'this build cannot encode images off the main thread.');
  }
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) return refuse('asset-undecodable', 'a 2D context was not available.');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(bytes), width, height), 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}

// ── Source resolution ────────────────────────────────────────────────────

/**
 * Turn a `src` (object URL, data URL, blob URL, file path) into a Blob.
 *
 * `fetch` on a same-origin object/data URL is not a network path — there is no
 * request and no remote host — but it is worth naming, because "the plugin
 * subsystem calls fetch" is exactly the line a future reader will stop at. The
 * URL comes from the user's own asset library, never from the plugin: a plugin
 * names an `assetId` or a `layerId` and the host resolves it here.
 */
async function blobFromSrc(src: string): Promise<Blob> {
  try {
    const res = await fetch(src);
    if (!res.ok) refuse('asset-not-found', `the image data could not be read (${res.status}).`);
    return await res.blob();
  } catch (err) {
    if (err instanceof AssetLimitError) throw err;
    return refuse('asset-not-found', `the image data could not be read: ${(err as Error).message}`);
  }
}

/** Look an asset up by id, or refuse by name. */
export function requireAsset(assetId: string): ImportedAsset {
  const found = useAssetStore.getState().assets.find((a) => a.id === assetId);
  if (!found) refuse('asset-not-found', `no asset with id "${assetId}".`);
  if (found!.type !== 'image') {
    refuse('asset-not-an-image', `asset "${assetId}" is ${found!.type}, not an image.`);
  }
  return found!;
}

/** Read an asset's pixels, with the plugin's budget reserved for the round trip. */
export async function readAssetPixels(
  pluginId: string,
  asset: ImportedAsset,
): Promise<{ assetId: string; width: number; height: number; mime: string; bytes: Uint8Array }> {
  // Reserve from the METADATA where we have it, so an oversized image is
  // refused before a single byte is fetched or decoded.
  const declaredW = asset.metadata?.width;
  const declaredH = asset.metadata?.height;
  if (typeof declaredW === 'number' && typeof declaredH === 'number') {
    assertDecodable(declaredW, declaredH);
  }

  const blob = await blobFromSrc(asset.src);
  const { width, height, bytes } = await decodeToRgba(blob);
  const release = reserve(pluginId, bytes.byteLength);
  // The reservation covers the message's trip to the worker. Released on the
  // next macrotask: the buffer is transferred by `postMessage`, so by then this
  // side no longer holds it.
  setTimeout(release, 0);
  return { assetId: asset.id, width, height, mime: RAW_MIME, bytes };
}

/**
 * Create an image asset from a plugin's bytes.
 *
 * Goes through `useAssetStore.addAsset` — the same path as a user dropping a
 * file in — so a plugin-made image is an ordinary library asset: it thumbnails,
 * it persists, it can be reused on other layers, and it is not a special case
 * anywhere downstream.
 */
export async function createImageAsset(
  pluginId: string,
  opts: { width: unknown; height: unknown; bytes: unknown; mime: unknown; name: unknown },
): Promise<{ assetId: string; width: number; height: number }> {
  const mime = typeof opts.mime === 'string' ? opts.mime : RAW_MIME;
  if (!(ACCEPTED_IMAGE_MIMES as readonly string[]).includes(mime)) {
    refuse('asset-bad-mime', `"${mime}" is not accepted. Use one of: ${ACCEPTED_IMAGE_MIMES.join(', ')}.`);
  }

  const raw = opts.bytes;
  const view =
    raw instanceof Uint8Array ? raw
    : raw instanceof ArrayBuffer ? new Uint8Array(raw)
    : ArrayBuffer.isView(raw) ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
    : null;
  if (!view || view.byteLength === 0) {
    refuse('asset-bad-bytes', 'bytes must be a non-empty Uint8Array or ArrayBuffer.');
  }
  if (view!.byteLength > ASSET_LIMITS.MAX_DECODED_BYTES) {
    refuse(
      'asset-too-large-bytes',
      `${Math.round(view!.byteLength / 1024 / 1024)} MB exceeds the ` +
      `${ASSET_LIMITS.MAX_DECODED_BYTES / 1024 / 1024} MB limit for one asset.`,
    );
  }

  const release = reserve(pluginId, view!.byteLength);
  try {
    let blob: Blob;
    let width: number;
    let height: number;

    if (mime === RAW_MIME) {
      width = Number(opts.width);
      height = Number(opts.height);
      assertDecodable(width, height);
      const expected = width * height * 4;
      if (view!.byteLength !== expected) {
        refuse(
          'asset-bytes-mismatch',
          `${width}×${height} raw RGBA needs exactly ${expected} bytes; got ${view!.byteLength}.`,
        );
      }
      blob = await encodeRgbaToPng(width, height, view!);
    } else {
      // Encoded input: the declared width/height are a claim, so they are
      // ignored entirely and the real ones come from decoding.
      const decoded = await decodeToRgba(new Blob([view!.slice(0)], { type: mime }));
      width = decoded.width;
      height = decoded.height;
      blob = await encodeRgbaToPng(width, height, decoded.bytes);
    }

    const name = typeof opts.name === 'string' && opts.name.trim()
      ? opts.name.trim().slice(0, 80).replace(/[/\\]/g, '-')
      : `${pluginId}-image`;
    const file = new File([blob], /\.png$/i.test(name) ? name : `${name}.png`, { type: 'image/png' });
    const asset = await useAssetStore.getState().addAsset(file, null);
    return { assetId: asset.id, width, height };
  } finally {
    release();
  }
}
