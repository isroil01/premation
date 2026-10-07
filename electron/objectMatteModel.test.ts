/**
 * The user's Object Matte model on disk (objectMatteModel.ts): what the engine
 * reads from <userData>/models/object-matte. An install writes both files and
 * the metadata; an HTML error page is refused and leaves nothing behind; a
 * removal empties the folder so the engine falls back to the bundled pair.
 */

jest.mock('electron', () => ({
  ipcMain: { handle: () => undefined, on: () => undefined },
}));

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DECODER_FILE,
  ENCODER_FILE,
  installObjectMatte,
  looksLikeOnnx,
  objectMatteUserDir,
  readObjectMatteInstall,
  removeObjectMatte,
} from './objectMatteModel';

const ONNX = new Uint8Array([0x08, 0x07, ...new Array(30).fill(1)]);
const HTML = new TextEncoder().encode('<!DOCTYPE html><html>not a model</html>');

const realFetch = globalThis.fetch;
function stubFetch(byUrl: Record<string, Uint8Array>): jest.Mock {
  const fn = jest.fn(async (url: string) => {
    const bytes = byUrl[url];
    return {
      ok: !!bytes,
      status: bytes ? 200 : 404,
      statusText: bytes ? 'OK' : 'Not Found',
      headers: { get: () => (bytes ? String(bytes.byteLength) : null) },
      body: (async function* () {
        if (bytes) yield bytes;
      })(),
    };
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

let root = '';
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'om-'));
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  await rm(root, { recursive: true, force: true });
});

const ENC = 'https://models.example/enc.onnx';
const DEC = 'https://models.example/dec.onnx';

describe('objectMatteModel', () => {
  it('lives under userData/models/object-matte', () => {
    expect(objectMatteUserDir('/u')).toBe(path.join('/u', 'models', 'object-matte'));
  });

  it('sniffs ONNX and refuses HTML', () => {
    expect(looksLikeOnnx(ONNX)).toBe(true);
    expect(looksLikeOnnx(HTML)).toBe(false);
  });

  it('installs both files and the metadata, then reads them back', async () => {
    stubFetch({ [ENC]: ONNX, [DEC]: ONNX });
    const dir = objectMatteUserDir(root);
    const res = await installObjectMatte(dir, ENC, DEC, new AbortController().signal, () => undefined);
    expect(res.ok).toBe(true);
    expect((await readdir(dir)).sort()).toEqual(['model.json', DECODER_FILE, ENCODER_FILE].sort());
    expect(await readObjectMatteInstall(dir)).toMatchObject({ encoderUrl: ENC, decoderUrl: DEC, bytes: ONNX.byteLength * 2 });
  });

  it('refuses a URL that answers HTML and writes nothing', async () => {
    stubFetch({ [ENC]: HTML, [DEC]: ONNX });
    const dir = objectMatteUserDir(root);
    const res = await installObjectMatte(dir, ENC, DEC, new AbortController().signal, () => undefined);
    expect(res).toMatchObject({ ok: false, message: expect.stringMatching(/encoder/) });
    expect(await readObjectMatteInstall(dir)).toBeNull();
  });

  it('refuses a non-https URL before any request', async () => {
    const spy = stubFetch({});
    const res = await installObjectMatte(objectMatteUserDir(root), 'http://models.example/a.onnx', DEC, new AbortController().signal, () => undefined);
    expect(res.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('remove empties the folder (the engine goes back to the bundled pair)', async () => {
    stubFetch({ [ENC]: ONNX, [DEC]: ONNX });
    const dir = objectMatteUserDir(root);
    await installObjectMatte(dir, ENC, DEC, new AbortController().signal, () => undefined);
    await removeObjectMatte(dir);
    expect(await readObjectMatteInstall(dir)).toBeNull();
    expect(await readdir(dir)).toEqual([]);
  });
});
