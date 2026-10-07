/**
 * Installing the Object Matte model — a different SAM-class model than the
 * one bundled with the app (a bigger export, a fine-tune), without waiting for
 * a release.
 *
 * The segmentation runs in the ENGINE (the objectMatte job: SAM through ONNX
 * Runtime in `premation-engine`), so the model has to be files the engine can
 * read. The desktop app's main process downloads the encoder/decoder pair into
 * `<userData>/models/object-matte/` (electron/objectMatteModel.ts) and the
 * engine prefers that folder over the bundled pair on every job — an install
 * or a removal applies to the next click. The page never holds the bytes and
 * runs no ONNX itself.
 *
 * ── Never automatic ────────────────────────────────────────────────────
 * Nothing here runs on its own: a person accepts or types URLs and presses a
 * button, the hosts are on screen before the request, and with nothing
 * installed the engine uses the bundled pair.
 *
 * ── Where the state lives ──────────────────────────────────────────────
 * This module does the work and reports through a `(status) => void`
 * callback; the zustand store the UI subscribes to is `@stores/samModelStore`.
 * `src/core` does not import zustand (docs/NATIVE_CORE_PLAN.md §4 T0).
 */

/**
 * A suggested model, not a bundled one: the same SlimSAM pair the app bundles,
 * offered as the field default so the common case is one click, and editable
 * because the right model is a moving target. Both halves of the
 * transformers.js export layout are needed.
 */
export const SUGGESTED_MODEL = {
  label: 'SlimSAM-77 (encoder + decoder, ONNX)',
  encoderUrl: 'https://huggingface.co/Xenova/slimsam-77-uniform/resolve/main/onnx/vision_encoder_quantized.onnx',
  decoderUrl: 'https://huggingface.co/Xenova/slimsam-77-uniform/resolve/main/onnx/prompt_encoder_mask_decoder_quantized.onnx',
  approxBytes: 14 * 1024 * 1024,
} as const;

export type ModelStatus =
  /** Nothing installed: the engine uses the pair bundled with the app. */
  | { kind: 'absent' }
  | { kind: 'downloading'; receivedBytes: number; totalBytes: number | null }
  | { kind: 'ready'; sourceUrl: string; decoderUrl?: string; bytes: number; installedAt: number }
  | { kind: 'failed'; message: string };

/** How the install flow reports: every state change goes through here. */
export type StatusReporter = (status: ModelStatus) => void;

interface InstalledModel {
  encoderUrl: string;
  decoderUrl: string;
  bytes: number;
  installedAt: number;
}

/** The main-process installer, when the desktop bridge offers one. */
interface InstallBridge {
  status: () => Promise<InstalledModel | null>;
  install: (request: { encoderUrl: string; decoderUrl: string; requestId: string }) => Promise<
    { ok: true; model: InstalledModel } | { ok: false; message: string }
  >;
  remove: () => Promise<boolean>;
  cancelDownload: (requestId: string) => Promise<boolean>;
  onDownloadProgress: (handler: (event: unknown) => void) => () => void;
}

function installBridge(): InstallBridge | null {
  const om = typeof window !== 'undefined' ? window.motionEditor?.objectMatte : undefined;
  if (om?.status && om.install && om.remove && om.cancelDownload && om.onDownloadProgress) return om as InstallBridge;
  return null;
}

const statusFor = (m: InstalledModel): ModelStatus => ({
  kind: 'ready',
  sourceUrl: m.encoderUrl,
  ...(m.decoderUrl ? { decoderUrl: m.decoderUrl } : {}),
  bytes: m.bytes,
  installedAt: m.installedAt,
});

/** Both files must be https; the reason names which one is wrong. */
export function checkUrls(encoderUrl: string, decoderUrl: string): string | null {
  for (const [label, value] of [['encoder', encoderUrl], ['decoder', decoderUrl]] as const) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return `The ${label} URL is not a valid URL.`;
    }
    if (parsed.protocol !== 'https:') {
      // Plain HTTP would let anything on the path substitute the model that is
      // about to be run on the user's footage.
      return `Only https:// model URLs are accepted (the ${label} URL is not).`;
    }
  }
  return null;
}

let inFlight: string | null = null;

function newRequestId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
}

/** What is installed now. Safe to call repeatedly; never touches the network. */
export async function restoreSamModel(set: StatusReporter): Promise<void> {
  const bridge = installBridge();
  if (!bridge) return;
  try {
    const m = await bridge.status();
    set(m ? statusFor(m) : { kind: 'absent' });
  } catch {
    set({ kind: 'absent' });
  }
}

/** Download and install through main. Rejects nothing — the status carries failure. */
export async function installSamModel(encoderUrl: string, decoderUrl: string, set: StatusReporter): Promise<void> {
  const enc = encoderUrl.trim();
  const dec = decoderUrl.trim();
  const refusal = checkUrls(enc, dec);
  if (refusal) {
    set({ kind: 'failed', message: refusal });
    return;
  }
  const bridge = installBridge();
  if (!bridge) {
    set({ kind: 'failed', message: 'Installing a model needs the desktop app: the engine reads it from this computer.' });
    return;
  }
  if (inFlight) void bridge.cancelDownload(inFlight);
  const requestId = newRequestId();
  inFlight = requestId;
  set({ kind: 'downloading', receivedBytes: 0, totalBytes: null });
  const unsubscribe = bridge.onDownloadProgress((event) => {
    const p = event as { requestId?: unknown; receivedBytes?: unknown; totalBytes?: unknown };
    if (p?.requestId !== requestId || typeof p.receivedBytes !== 'number') return;
    set({ kind: 'downloading', receivedBytes: p.receivedBytes, totalBytes: typeof p.totalBytes === 'number' ? p.totalBytes : null });
  });
  try {
    const result = await bridge.install({ encoderUrl: enc, decoderUrl: dec, requestId });
    if (result.ok) set(statusFor(result.model));
    // A Cancel lands as `absent` (the bundled model stays in use), not as an error.
    else set(inFlight === requestId ? { kind: 'failed', message: result.message } : { kind: 'absent' });
  } catch (err) {
    set({ kind: 'failed', message: err instanceof Error ? err.message : String(err) });
  } finally {
    unsubscribe();
    if (inFlight === requestId) inFlight = null;
  }
}

/** Remove the installed model; the engine goes back to the bundled one. */
export async function removeSamModel(set: StatusReporter): Promise<void> {
  const bridge = installBridge();
  if (inFlight && bridge) void bridge.cancelDownload(inFlight);
  inFlight = null;
  if (bridge) await bridge.remove().catch(() => false);
  set({ kind: 'absent' });
}

/** Abort a download in flight. */
export function cancelSamDownload(): void {
  const bridge = installBridge();
  const id = inFlight;
  inFlight = null;
  if (bridge && id) void bridge.cancelDownload(id);
}
