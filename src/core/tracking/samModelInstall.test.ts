/**
 * Installing the Object Matte model.
 *
 * Three things here are worth pinning, and none of them is the download:
 *
 *  • It never fetches on its own. The local edition's claim is that it does not
 *    reach the network unless asked, and a boot-time restore that quietly
 *    fetched would break that claim while looking like a feature.
 *  • A wrong URL is caught as a wrong URL. Model hosts return HTML error pages
 *    with a 200, and handing one to the ONNX runtime produces an exception
 *    several layers down that says nothing useful.
 *  • Bytes that fail to load are NOT cached, or every future boot reports a
 *    failure over a file nothing can use.
 */

const registerFromBytes = jest.fn(async (_bytes: Uint8Array) => ({ status: 'ok' as const }));
const unregister = jest.fn();
jest.mock('./samOnnxLoader', () => ({
  tryRegisterSamOnnxFromBytes: (bytes: Uint8Array) => registerFromBytes(bytes),
  unregisterSamOnnx: () => unregister(),
}));

const cache = { get: jest.fn(), put: jest.fn(), remove: jest.fn() };
jest.mock('./samModelCache', () => ({
  SAM_MODEL_KEY: 'sam-object-matte',
  ModelCache: {
    get: (...args: unknown[]) => cache.get(...args),
    put: (...args: unknown[]) => cache.put(...args),
    remove: (...args: unknown[]) => cache.remove(...args),
  },
}));

import { looksLikeOnnx, restoreSamModelAtBoot, useSamModelStore } from './samModelInstall';

/** A minimal byte string that passes the ONNX sniff (protobuf field 1). */
const ONNX_BYTES = new Uint8Array([0x08, 0x07, ...new Array(30).fill(0)]);

/**
 * A Blob that can be read back.
 *
 * jsdom's Blob has no `arrayBuffer()` — the same gap `audioMixdown`'s tests
 * work around by reading `encodeWav` directly. The cache stores real Blobs in a
 * real browser; this is only the stub having to be honest about being one.
 */
function readableBlob(bytes: Uint8Array): Blob {
  const blob = new Blob([new Uint8Array(bytes).buffer as ArrayBuffer]);
  Object.defineProperty(blob, 'arrayBuffer', {
    value: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  });
  return blob;
}

/** A `fetch` that answers with `bytes`, optionally without a Content-Length. */
function stubFetch(bytes: Uint8Array, opts: { ok?: boolean; status?: number; length?: boolean } = {}): void {
  const { ok = true, status = 200, length = true } = opts;
  globalThis.fetch = jest.fn(async () => ({
    ok,
    status,
    statusText: ok ? 'OK' : 'Not Found',
    headers: { get: (name: string) => (name === 'content-length' && length ? String(bytes.byteLength) : null) },
    body: null,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  })) as unknown as typeof fetch;
}

beforeEach(() => {
  registerFromBytes.mockClear().mockResolvedValue({ status: 'ok' as const });
  unregister.mockClear();
  cache.get.mockReset().mockResolvedValue(null);
  cache.put.mockReset().mockResolvedValue(undefined);
  cache.remove.mockReset().mockResolvedValue(undefined);
  useSamModelStore.setState({ status: { kind: 'absent' } });
  globalThis.fetch = jest.fn(async () => { throw new Error('fetch should not have been called'); }) as unknown as typeof fetch;
});

describe('looksLikeOnnx', () => {
  it('accepts a protobuf that starts with field 1', () => {
    expect(looksLikeOnnx(ONNX_BYTES)).toBe(true);
  });

  it('rejects an HTML error page, which is what a wrong URL returns', () => {
    const html = new TextEncoder().encode('<!DOCTYPE html><html><body>404</body></html>');
    expect(looksLikeOnnx(html)).toBe(false);
  });

  it('rejects something far too short to be a model', () => {
    expect(looksLikeOnnx(new Uint8Array([0x08]))).toBe(false);
  });
});

describe('boot restore', () => {
  it('touches the network NEVER when nothing is cached', async () => {
    restoreSamModelAtBoot();
    await Promise.resolve();
    await Promise.resolve();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(useSamModelStore.getState().status.kind).toBe('absent');
  });

  it('registers a cached model without any request', async () => {
    cache.get.mockResolvedValue({
      id: 'sam-object-matte',
      data: readableBlob(ONNX_BYTES),
      sourceUrl: 'https://example.test/model.onnx',
      installedAt: 1_700_000_000_000,
      bytes: ONNX_BYTES.byteLength,
    });

    await useSamModelStore.getState().restore();

    expect(registerFromBytes).toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    const status = useSamModelStore.getState().status;
    expect(status.kind).toBe('ready');
    expect(status.kind === 'ready' && status.sourceUrl).toBe('https://example.test/model.onnx');
  });

  it('reports a cached model that no longer loads, and keeps the file', async () => {
    // Deleting someone's 40 MB download because it did not load today is not
    // this module's decision to make.
    cache.get.mockResolvedValue({
      id: 'sam-object-matte',
      data: readableBlob(ONNX_BYTES),
      sourceUrl: 'https://example.test/model.onnx',
      installedAt: 1,
      bytes: 32,
    });
    registerFromBytes.mockResolvedValue({ status: 'failed', reason: 'runtime missing' } as never);

    await useSamModelStore.getState().restore();

    expect(useSamModelStore.getState().status).toEqual({ kind: 'failed', message: 'runtime missing' });
    expect(cache.remove).not.toHaveBeenCalled();
  });
});

describe('install', () => {
  it('refuses a URL that is not a URL, without fetching', async () => {
    await useSamModelStore.getState().install('not a url');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(useSamModelStore.getState().status.kind).toBe('failed');
  });

  it('refuses plain http, which would let anything on the path swap the model', async () => {
    await useSamModelStore.getState().install('http://example.test/model.onnx');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    const status = useSamModelStore.getState().status;
    expect(status.kind === 'failed' && status.message).toMatch(/https/i);
  });

  it('downloads, registers and caches', async () => {
    stubFetch(ONNX_BYTES);
    await useSamModelStore.getState().install('https://example.test/model.onnx');

    expect(registerFromBytes).toHaveBeenCalled();
    expect(cache.put).toHaveBeenCalled();
    expect(useSamModelStore.getState().status.kind).toBe('ready');
  });

  it('reports an HTML page as a bad URL rather than as an ONNX failure', async () => {
    stubFetch(new TextEncoder().encode('<!DOCTYPE html><html>login</html>'));
    await useSamModelStore.getState().install('https://example.test/model.onnx');

    const status = useSamModelStore.getState().status;
    expect(status.kind === 'failed' && status.message).toMatch(/did not return an ONNX model/);
    expect(cache.put).not.toHaveBeenCalled();
  });

  it('does NOT cache bytes the runtime refused', async () => {
    stubFetch(ONNX_BYTES);
    registerFromBytes.mockResolvedValue({ status: 'failed', reason: 'bad graph' } as never);

    await useSamModelStore.getState().install('https://example.test/model.onnx');

    expect(cache.put).not.toHaveBeenCalled();
    expect(useSamModelStore.getState().status).toEqual({ kind: 'failed', message: 'bad graph' });
  });

  it('reports a refusing host by its status', async () => {
    stubFetch(ONNX_BYTES, { ok: false, status: 404 });
    await useSamModelStore.getState().install('https://example.test/model.onnx');
    const status = useSamModelStore.getState().status;
    expect(status.kind === 'failed' && status.message).toMatch(/404/);
  });

  it('refuses a file larger than the cap before downloading it', async () => {
    globalThis.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => String(2 * 1024 * 1024 * 1024) },
      body: null,
      arrayBuffer: async () => new ArrayBuffer(0),
    })) as unknown as typeof fetch;

    await useSamModelStore.getState().install('https://example.test/huge.onnx');
    const status = useSamModelStore.getState().status;
    expect(status.kind === 'failed' && status.message).toMatch(/larger than/);
  });
});

describe('remove', () => {
  it('unregisters the session as well as forgetting the file', async () => {
    // Forgetting the cache alone would leave the model running for the rest of
    // the session, so "Remove" would appear to do nothing until a restart.
    await useSamModelStore.getState().remove();
    expect(unregister).toHaveBeenCalled();
    expect(cache.remove).toHaveBeenCalled();
    expect(useSamModelStore.getState().status).toEqual({ kind: 'absent' });
  });
});
