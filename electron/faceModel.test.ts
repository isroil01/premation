/**
 * Face Tracking's landmark model on disk (faceModel.ts): downloaded on first
 * use into <userData>/models/face-landmarks, where the engine's faceTrack job
 * reads face_landmark.onnx; an HTML answer is refused; removal empties it.
 */

jest.mock('electron', () => ({
  ipcMain: { handle: () => undefined, on: () => undefined },
}));

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FACE_MODEL_FILE, faceModelUserDir, installFaceModel, readFaceModelInstall, removeFaceModel } from './faceModel';

const ONNX = new Uint8Array([0x08, 0x07, ...new Array(30).fill(1)]);
const HTML = new TextEncoder().encode('<!DOCTYPE html><html>no</html>');
const URL_ = 'https://models.example/face_landmark.onnx';

const realFetch = globalThis.fetch;
function stubFetch(bytes: Uint8Array): void {
  globalThis.fetch = (async () => ({
    ok: true, status: 200, statusText: 'OK',
    headers: { get: () => String(bytes.byteLength) },
    body: (async function* () { yield bytes; })(),
  })) as unknown as typeof fetch;
}

let root = '';
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'fm-')); });
afterEach(async () => {
  globalThis.fetch = realFetch;
  await rm(root, { recursive: true, force: true });
});

describe('faceModel', () => {
  it('installs into userData/models/face-landmarks and reads it back; removal empties it', async () => {
    stubFetch(ONNX);
    const dir = faceModelUserDir(root);
    expect(dir).toBe(path.join(root, 'models', 'face-landmarks'));
    const res = await installFaceModel(dir, URL_, new AbortController().signal, () => undefined);
    expect(res.ok).toBe(true);
    expect((await readdir(dir)).sort()).toEqual([FACE_MODEL_FILE, 'model.json'].sort());
    expect(await readFaceModelInstall(dir)).toMatchObject({ url: URL_, bytes: ONNX.byteLength });
    await removeFaceModel(dir);
    expect(await readFaceModelInstall(dir)).toBeNull();
  });

  it('refuses HTML and plain http, writing nothing', async () => {
    stubFetch(HTML);
    const dir = faceModelUserDir(root);
    expect((await installFaceModel(dir, URL_, new AbortController().signal, () => undefined)).ok).toBe(false);
    expect((await installFaceModel(dir, 'http://models.example/x.onnx', new AbortController().signal, () => undefined)).ok).toBe(false);
    expect(await readFaceModelInstall(dir)).toBeNull();
  });
});
