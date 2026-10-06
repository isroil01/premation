/**
 * The user's Object Matte model, installed on disk for the engine.
 *
 * The segmentation runs in `premation-engine` (the objectMatte job, SAM through
 * ONNX Runtime). The engine reads the model from files, so an installed model
 * lives at `<userData>/models/object-matte/`, the folder Electron passes the
 * engine as `PREMATION_SAM_USER_DIR` (engineHost.ts). The engine checks it on
 * every job, so an install or a removal applies to the next click with no
 * restart. Without it the engine uses the pair bundled with the app.
 *
 * The bytes come through `downloadModelBytes` (modelDownload.ts: https only,
 * no credentials, size-capped) and only when the user presses Install. Each
 * file is written to a temp name and renamed into place, the metadata last, so
 * a crash mid-install never leaves a half-written model the engine would load.
 */

import { type IpcMainInvokeEvent } from 'electron';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { handle } from './ipcGuard';
import { checkModelUrl, downloadModelBytes, registerDownloadCancel, type ModelDownloadProgress } from './modelDownload';

export const ENCODER_FILE = 'vision_encoder_quantized.onnx';
export const DECODER_FILE = 'prompt_encoder_mask_decoder_quantized.onnx';
const META_FILE = 'model.json';

export interface ObjectMatteInstall {
  encoderUrl: string;
  decoderUrl: string;
  bytes: number;
  installedAt: number;
}

export type ObjectMatteInstallResult = { ok: true; model: ObjectMatteInstall } | { ok: false; message: string };

/** The folder the engine reads the user's model from. */
export function objectMatteUserDir(userData: string): string {
  return path.join(userData, 'models', 'object-matte');
}

/** ONNX files are protobuf: field 1 (ir_version) as a varint, tag 0x08. An HTML error page is not. */
export function looksLikeOnnx(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 16) return false;
  const head = Buffer.from(bytes.subarray(0, 16)).toString('latin1').toLowerCase();
  if (head.includes('<!doctype') || head.includes('<html')) return false;
  return bytes[0] === 0x08;
}

/** The installed model, or null when the folder does not hold a complete one. */
export async function readObjectMatteInstall(dir: string): Promise<ObjectMatteInstall | null> {
  try {
    const [enc, dec] = await Promise.all([stat(path.join(dir, ENCODER_FILE)), stat(path.join(dir, DECODER_FILE))]);
    if (!enc.isFile() || !dec.isFile()) return null;
    const meta = JSON.parse(await readFile(path.join(dir, META_FILE), 'utf8')) as Partial<ObjectMatteInstall>;
    return {
      encoderUrl: typeof meta.encoderUrl === 'string' ? meta.encoderUrl : '',
      decoderUrl: typeof meta.decoderUrl === 'string' ? meta.decoderUrl : '',
      bytes: enc.size + dec.size,
      installedAt: typeof meta.installedAt === 'number' ? meta.installedAt : 0,
    };
  } catch {
    return null;
  }
}

async function writeAtomic(file: string, bytes: Uint8Array | string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, file);
}

/** Download both files, check they are ONNX, then put them in place. */
export async function installObjectMatte(
  dir: string,
  encoderUrl: string,
  decoderUrl: string,
  signal: AbortSignal,
  emit: (receivedBytes: number, totalBytes: number | null) => void,
): Promise<ObjectMatteInstallResult> {
  for (const [label, url] of [['encoder', encoderUrl], ['decoder', decoderUrl]] as const) {
    const refusal = checkModelUrl(url);
    if (refusal) return { ok: false, message: `The ${label} URL: ${refusal}` };
  }
  // One progress envelope over both files; a total only once both are known.
  let encDone = 0;
  let encTotal: number | null = null;
  const enc = await downloadModelBytes(encoderUrl, signal, (r, t) => {
    encTotal = t;
    emit(r, null);
  });
  if (!enc.ok) return enc;
  encDone = enc.bytes.byteLength;
  const dec = await downloadModelBytes(decoderUrl, signal, (r, t) => emit(encDone + r, t !== null && encTotal !== null ? encTotal + t : null));
  if (!dec.ok) return dec;
  if (!looksLikeOnnx(enc.bytes)) return { ok: false, message: 'The encoder URL did not return an ONNX model — check it points at the .onnx file itself.' };
  if (!looksLikeOnnx(dec.bytes)) return { ok: false, message: 'The decoder URL did not return an ONNX model — check it points at the .onnx file itself.' };
  try {
    await mkdir(dir, { recursive: true });
    // The metadata goes first-removed and last-written: without it the folder
    // still answers "not installed" to the status query while files land.
    await rm(path.join(dir, META_FILE), { force: true });
    await writeAtomic(path.join(dir, ENCODER_FILE), enc.bytes);
    await writeAtomic(path.join(dir, DECODER_FILE), dec.bytes);
    const model: ObjectMatteInstall = {
      encoderUrl,
      decoderUrl,
      bytes: enc.bytes.byteLength + dec.bytes.byteLength,
      installedAt: Date.now(),
    };
    await writeAtomic(path.join(dir, META_FILE), JSON.stringify(model));
    return { ok: true, model };
  } catch (err) {
    return { ok: false, message: `Could not save the model: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Remove the user's model; the engine goes back to the bundled one. */
export async function removeObjectMatte(dir: string): Promise<void> {
  await rm(path.join(dir, META_FILE), { force: true });
  await rm(path.join(dir, ENCODER_FILE), { force: true });
  await rm(path.join(dir, DECODER_FILE), { force: true });
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9-]{1,64}$/;

export function registerObjectMatteModelIpc(userData: () => string): void {
  const dir = (): string => objectMatteUserDir(userData());
  handle('objectMatte:status', async (): Promise<ObjectMatteInstall | null> => readObjectMatteInstall(dir()));
  handle('objectMatte:remove', async (): Promise<boolean> => {
    await removeObjectMatte(dir());
    return true;
  });
  handle('objectMatte:install', async (event: IpcMainInvokeEvent, request: unknown): Promise<ObjectMatteInstallResult> => {
    const { encoderUrl, decoderUrl, requestId } = (request ?? {}) as { encoderUrl?: unknown; decoderUrl?: unknown; requestId?: unknown };
    if (typeof encoderUrl !== 'string' || typeof decoderUrl !== 'string') return { ok: false, message: 'Both model URLs are required.' };
    if (typeof requestId !== 'string' || !SAFE_REQUEST_ID.test(requestId)) return { ok: false, message: 'Bad install request.' };
    const cancel = registerDownloadCancel(requestId);
    if (!cancel) return { ok: false, message: 'That download is already running.' };
    const sender = event.sender;
    try {
      return await installObjectMatte(dir(), encoderUrl.trim(), decoderUrl.trim(), cancel.signal, (receivedBytes, totalBytes) => {
        if (!sender.isDestroyed()) {
          sender.send('objectMatte:downloadProgress', { requestId, receivedBytes, totalBytes } satisfies ModelDownloadProgress);
        }
      });
    } finally {
      cancel.done();
    }
  });
}
