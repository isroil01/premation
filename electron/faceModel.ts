/**
 * The face landmark model for Face Tracking (AE parity 3.3), installed on disk
 * for the engine — downloaded on first use, never shipped in the installer
 * (owner decision 2026-10-06).
 *
 * The engine's faceTrack job reads `face_landmark.onnx` from
 * `<userData>/models/face-landmarks/`, passed as `PREMATION_FACE_USER_DIR`
 * (engineHost.ts), on every job — an install applies to the next track. The
 * download is the Object Matte installer's: https only, no credentials,
 * size-capped (modelDownload.ts), written to a temp name and renamed, the
 * metadata last.
 */

import { type IpcMainInvokeEvent } from 'electron';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { handle } from './ipcGuard';
import { checkModelUrl, downloadModelBytes, registerDownloadCancel, type ModelDownloadProgress } from './modelDownload';
import { looksLikeOnnx } from './objectMatteModel';

export const FACE_MODEL_FILE = 'face_landmark.onnx';
const META_FILE = 'model.json';

export interface FaceModelInstall {
  url: string;
  bytes: number;
  installedAt: number;
}

export type FaceModelInstallResult = { ok: true; model: FaceModelInstall } | { ok: false; message: string };

export function faceModelUserDir(userData: string): string {
  return path.join(userData, 'models', 'face-landmarks');
}

export async function readFaceModelInstall(dir: string): Promise<FaceModelInstall | null> {
  try {
    const s = await stat(path.join(dir, FACE_MODEL_FILE));
    if (!s.isFile()) return null;
    const meta = JSON.parse(await readFile(path.join(dir, META_FILE), 'utf8')) as Partial<FaceModelInstall>;
    return { url: typeof meta.url === 'string' ? meta.url : '', bytes: s.size, installedAt: typeof meta.installedAt === 'number' ? meta.installedAt : 0 };
  } catch {
    return null;
  }
}

async function writeAtomic(file: string, bytes: Uint8Array | string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, file);
}

export async function installFaceModel(
  dir: string,
  url: string,
  signal: AbortSignal,
  emit: (receivedBytes: number, totalBytes: number | null) => void,
): Promise<FaceModelInstallResult> {
  const refusal = checkModelUrl(url);
  if (refusal) return { ok: false, message: `The model URL: ${refusal}` };
  const got = await downloadModelBytes(url, signal, emit);
  if (!got.ok) return got;
  if (!looksLikeOnnx(got.bytes)) return { ok: false, message: 'The URL did not return an ONNX model — check it points at the .onnx file itself.' };
  try {
    await mkdir(dir, { recursive: true });
    await rm(path.join(dir, META_FILE), { force: true });
    await writeAtomic(path.join(dir, FACE_MODEL_FILE), got.bytes);
    const model: FaceModelInstall = { url, bytes: got.bytes.byteLength, installedAt: Date.now() };
    await writeAtomic(path.join(dir, META_FILE), JSON.stringify(model));
    return { ok: true, model };
  } catch (err) {
    return { ok: false, message: `Could not save the model: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function removeFaceModel(dir: string): Promise<void> {
  await rm(path.join(dir, META_FILE), { force: true });
  await rm(path.join(dir, FACE_MODEL_FILE), { force: true });
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9-]{1,64}$/;

export function registerFaceModelIpc(userData: () => string): void {
  const dir = (): string => faceModelUserDir(userData());
  handle('faceModel:status', async (): Promise<FaceModelInstall | null> => readFaceModelInstall(dir()));
  handle('faceModel:remove', async (): Promise<boolean> => {
    await removeFaceModel(dir());
    return true;
  });
  handle('faceModel:install', async (event: IpcMainInvokeEvent, request: unknown): Promise<FaceModelInstallResult> => {
    const { url, requestId } = (request ?? {}) as { url?: unknown; requestId?: unknown };
    if (typeof url !== 'string' || !url.trim()) return { ok: false, message: 'The model URL is required.' };
    if (typeof requestId !== 'string' || !SAFE_REQUEST_ID.test(requestId)) return { ok: false, message: 'Bad install request.' };
    const cancel = registerDownloadCancel(requestId);
    if (!cancel) return { ok: false, message: 'That download is already running.' };
    const sender = event.sender;
    try {
      return await installFaceModel(dir(), url.trim(), cancel.signal, (receivedBytes, totalBytes) => {
        if (!sender.isDestroyed()) sender.send('faceModel:downloadProgress', { requestId, receivedBytes, totalBytes } satisfies ModelDownloadProgress);
      });
    } finally {
      cancel.done();
    }
  });
}
