/**
 * The bundled Object Matte model — neural segmentation with zero setup.
 *
 * The Settings install flow (`samModelInstall.ts`) asked a person to download a
 * model, and shipped unable to do it: the app's CSP names no model host, and
 * the suggested URL had gone dead upstream. Rather than widen the network
 * policy, the model now travels WITH the app: `scripts/fetchObjectMatte.cjs`
 * places the SlimSAM encoder/decoder pair (Apache-2.0, ~14 MB) plus the ORT
 * wasm runtime under `public/models/` at build time, and this module loads
 * them at boot. No network, no button, no failure mode that ends in GrabCut
 * silently standing in for the feature the release notes promised.
 *
 * ── Two transports, one decision ──
 * A dev server or web deploy serves `dist/` over http, so the assets are plain
 * same-origin fetches (`connect-src 'self'`). The packaged desktop app loads
 * the page from `file://`, where fetch reaches nothing — there the bytes come
 * over the preload bridge (`objectMatte:read`, an allowlisted read out of the
 * asar). The page's protocol is the whole decision; there is no configuration.
 *
 * Precedence: a model the USER installed through Settings wins over the
 * bundle — boot tries the cache first and only falls back here (main.tsx).
 * Missing assets (a checkout that never ran the fetch script) resolve to
 * `false` quietly: dev must keep working from a fresh clone, and GrabCut is
 * still a real matte.
 */

import { looksLikeOnnx } from './samModelInstall';
import { useSamModelStore } from '@stores/samModelStore';
import { setOrtWasmAssets, tryRegisterSamPipeline } from './samOnnxLoader';

export const BUNDLED_DIR = 'models/object-matte';
export const BUNDLED_ENCODER = 'vision_encoder_quantized.onnx';
export const BUNDLED_DECODER = 'prompt_encoder_mask_decoder_quantized.onnx';
/** The runtime pair `ort.bundle.min.mjs` (our import) requests at run time:
 *  the glue module it imports, and the wasm binary the glue loads. */
export const ORT_WASM_FILE = 'ort-wasm-simd-threaded.jsep.wasm';
export const ORT_MJS_FILE = 'ort-wasm-simd-threaded.jsep.mjs';
export const ORT_WASM_DIR = 'models/ort';

/** Reads a bundled asset over the preload bridge, or null outside Electron. */
type BridgeRead = ((name: string) => Promise<Uint8Array | null>) | undefined;

function bridgeRead(): BridgeRead {
  return window.motionEditor?.objectMatte?.read;
}

function bridgeUrl(): ((name: string) => Promise<string | null>) | undefined {
  return window.motionEditor?.objectMatte?.url;
}

/** file:// is the packaged desktop app; anything http-ish is a served build. */
function usesBridge(): boolean {
  return typeof location !== 'undefined' && location.protocol === 'file:' && !!bridgeRead();
}

async function fetchAsset(path: string): Promise<Uint8Array | null> {
  try {
    const res = await fetch(`/${path}`);
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
}

async function readAsset(dir: string, name: string): Promise<Uint8Array | null> {
  if (usesBridge()) {
    const bytes = await bridgeRead()!(name).catch(() => null);
    // Structured clone may deliver a Buffer-backed view; normalise.
    return bytes ? new Uint8Array(bytes) : null;
  }
  return fetchAsset(`${dir}/${name}`);
}

/**
 * Load and register the bundled pair. Returns whether the neural path is live.
 * Reflects success into the install store so Settings can say "bundled".
 */
export async function registerBundledSamAtBoot(): Promise<boolean> {
  if (usesBridge()) {
    // The glue module needs a URL `import()` can reach — main resolves it to a
    // file:// URL inside the bundle. The binary rides IPC as bytes, lazily.
    const mjsUrl = await bridgeUrl()?.(ORT_MJS_FILE).catch(() => null);
    if (!mjsUrl) return false;
    setOrtWasmAssets({
      kind: 'electron',
      mjsUrl,
      loadBinary: () => bridgeRead()!(ORT_WASM_FILE).then((b) => (b ? new Uint8Array(b) : null)).catch(() => null),
    });
  } else {
    setOrtWasmAssets({ kind: 'paths', prefix: `/${ORT_WASM_DIR}/` });
  }

  const [encoder, decoder] = await Promise.all([
    readAsset(BUNDLED_DIR, BUNDLED_ENCODER),
    readAsset(BUNDLED_DIR, BUNDLED_DECODER),
  ]);
  if (!encoder || !decoder || !looksLikeOnnx(encoder) || !looksLikeOnnx(decoder)) return false;

  const result = await tryRegisterSamPipeline(encoder, decoder);
  if (result.status !== 'ok') {
    console.warn(`[sam] bundled model did not load — ${result.status}: ${result.reason}`);
    return false;
  }
  useSamModelStore.setState({
    status: { kind: 'bundled', bytes: encoder.byteLength + decoder.byteLength },
  });
  return true;
}
