/**
 * Installing the Object Matte model.
 *
 * Four things here are worth pinning, and none of them is the download:
 *
 *  • It never fetches on its own. The local edition's claim is that it does not
 *    reach the network unless asked, and a boot-time restore that quietly
 *    fetched would break that claim while looking like a feature.
 *  • A wrong URL is caught as a wrong URL. Model hosts return HTML error pages
 *    with a 200, and handing one to the ONNX runtime produces an exception
 *    several layers down that says nothing useful.
 *  • Bytes that fail to load are NOT cached, or every future boot reports a
 *    failure over files nothing can use.
 *  • In the desktop app the bytes travel through the MAIN process (the page
 *    CSP names no model host); the renderer's own fetch is only the fallback
 *    for a plain browser tab.
 */

const registerPipeline = jest.fn(async (_enc: Uint8Array, _dec: Uint8Array) => ({ status: 'ok' as const }));
const unregister = jest.fn();
jest.mock('./samOnnxLoader', () => ({
  tryRegisterSamPipeline: (enc: Uint8Array, dec: Uint8Array) => registerPipeline(enc, dec),
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

import { looksLikeOnnx } from './samModelInstall';
import { restoreSamModelAtBoot, useSamModelStore } from '@stores/samModelStore';

/** A minimal byte string that passes the ONNX sniff (protobuf field 1). */
const ONNX_BYTES = new Uint8Array([0x08, 0x07, ...new Array(30).fill(0)]);

const ENCODER_URL = 'https://example.test/vision_encoder.onnx';
const DECODER_URL = 'https://example.test/decoder.onnx';

const install = (enc: string = ENCODER_URL, dec: string = DECODER_URL): Promise<void> =>
  useSamModelStore.getState().install(enc, dec);

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

/** A cached encoder/decoder record, as install() writes them. */
function pairRecord(): Record<string, unknown> {
  return {
    id: 'sam-object-matte',
    data: readableBlob(ONNX_BYTES),
    sourceUrl: ENCODER_URL,
    decoderData: readableBlob(ONNX_BYTES),
    decoderUrl: DECODER_URL,
    installedAt: 1_700_000_000_000,
    bytes: ONNX_BYTES.byteLength * 2,
  };
}

/** A `fetch` that answers every call with `bytes`, optionally without a Content-Length. */
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
  registerPipeline.mockClear().mockResolvedValue({ status: 'ok' as const });
  unregister.mockClear();
  cache.get.mockReset().mockResolvedValue(null);
  cache.put.mockReset().mockResolvedValue(undefined);
  cache.remove.mockReset().mockResolvedValue(undefined);
  useSamModelStore.setState({ status: { kind: 'absent' } });
  globalThis.fetch = jest.fn(async () => { throw new Error('fetch should not have been called'); }) as unknown as typeof fetch;
  delete (window as { motionEditor?: unknown }).motionEditor;
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

  it('registers a cached pair without any request', async () => {
    cache.get.mockResolvedValue(pairRecord());

    await useSamModelStore.getState().restore();

    expect(registerPipeline).toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    const status = useSamModelStore.getState().status;
    expect(status.kind).toBe('ready');
    expect(status.kind === 'ready' && status.sourceUrl).toBe(ENCODER_URL);
    expect(status.kind === 'ready' && status.decoderUrl).toBe(DECODER_URL);
  });

  it('treats a legacy single-file record as stale rather than registering it', async () => {
    // The legacy naive wrapper "loads" such a file, but no published SAM export
    // answers it — registering would look like success while every click fell
    // through, AND would take precedence over the bundled pair that works.
    cache.get.mockResolvedValue({
      id: 'sam-object-matte',
      data: readableBlob(ONNX_BYTES),
      sourceUrl: 'https://example.test/model.onnx',
      installedAt: 1,
      bytes: 32,
    });

    await useSamModelStore.getState().restore();

    expect(registerPipeline).not.toHaveBeenCalled();
    const status = useSamModelStore.getState().status;
    expect(status.kind === 'failed' && status.message).toMatch(/earlier version/);
    // Reported, not deleted: discarding someone's download is not this
    // module's decision to make.
    expect(cache.remove).not.toHaveBeenCalled();
  });

  it('reports a cached pair that no longer loads, and keeps the files', async () => {
    cache.get.mockResolvedValue(pairRecord());
    registerPipeline.mockResolvedValue({ status: 'failed', reason: 'runtime missing' } as never);

    await useSamModelStore.getState().restore();

    expect(useSamModelStore.getState().status).toEqual({ kind: 'failed', message: 'runtime missing' });
    expect(cache.remove).not.toHaveBeenCalled();
  });
});

describe('install', () => {
  it('refuses a URL that is not a URL, without fetching', async () => {
    await install('not a url', DECODER_URL);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(useSamModelStore.getState().status.kind).toBe('failed');
  });

  it('refuses plain http, naming which of the two URLs is wrong', async () => {
    await install(ENCODER_URL, 'http://example.test/decoder.onnx');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    const status = useSamModelStore.getState().status;
    expect(status.kind === 'failed' && status.message).toMatch(/https/i);
    expect(status.kind === 'failed' && status.message).toMatch(/decoder/i);
  });

  it('downloads both files, registers the pair and caches it', async () => {
    stubFetch(ONNX_BYTES);
    await install();

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(registerPipeline).toHaveBeenCalledTimes(1);
    expect(cache.put).toHaveBeenCalledTimes(1);
    const record = cache.put.mock.calls[0]![0] as { decoderUrl?: string; bytes?: number };
    expect(record.decoderUrl).toBe(DECODER_URL);
    expect(record.bytes).toBe(ONNX_BYTES.byteLength * 2);
    expect(useSamModelStore.getState().status.kind).toBe('ready');
  });

  it('prefers the main-process downloader when the desktop bridge offers one', async () => {
    // In the desktop app the page CSP names no model host, so the renderer
    // fetch would be refused — the bytes must come over IPC.
    const download = jest.fn(async () => ({ ok: true as const, bytes: ONNX_BYTES }));
    (window as { motionEditor?: unknown }).motionEditor = {
      objectMatte: {
        download,
        cancelDownload: jest.fn(async () => true),
        onDownloadProgress: jest.fn(() => () => undefined),
      },
    };

    await install();

    expect(download).toHaveBeenCalledTimes(2);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(useSamModelStore.getState().status.kind).toBe('ready');
  });

  it('surfaces the main-process downloader refusal as the failure message', async () => {
    (window as { motionEditor?: unknown }).motionEditor = {
      objectMatte: {
        download: jest.fn(async () => ({ ok: false as const, message: 'The host answered 404' })),
        cancelDownload: jest.fn(async () => true),
        onDownloadProgress: jest.fn(() => () => undefined),
      },
    };

    await install();

    const status = useSamModelStore.getState().status;
    expect(status.kind === 'failed' && status.message).toMatch(/404/);
    expect(cache.put).not.toHaveBeenCalled();
  });

  it('reports an HTML page as a bad URL rather than as an ONNX failure', async () => {
    stubFetch(new TextEncoder().encode('<!DOCTYPE html><html>login</html>'));
    await install();

    const status = useSamModelStore.getState().status;
    expect(status.kind === 'failed' && status.message).toMatch(/did not return an ONNX model/);
    expect(cache.put).not.toHaveBeenCalled();
  });

  it('does NOT cache bytes the runtime refused', async () => {
    stubFetch(ONNX_BYTES);
    registerPipeline.mockResolvedValue({ status: 'failed', reason: 'bad graph' } as never);

    await install();

    expect(cache.put).not.toHaveBeenCalled();
    expect(useSamModelStore.getState().status).toEqual({ kind: 'failed', message: 'bad graph' });
  });

  it('reports a refusing host by its status', async () => {
    stubFetch(ONNX_BYTES, { ok: false, status: 404 });
    await install();
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

    await install(ENCODER_URL, 'https://example.test/huge.onnx');
    const status = useSamModelStore.getState().status;
    expect(status.kind === 'failed' && status.message).toMatch(/larger than/);
  });
});

describe('remove', () => {
  it('unregisters the session as well as forgetting the files', async () => {
    // Forgetting the cache alone would leave the model running for the rest of
    // the session, so "Remove" would appear to do nothing until a restart.
    await useSamModelStore.getState().remove();
    expect(unregister).toHaveBeenCalled();
    expect(cache.remove).toHaveBeenCalled();
    expect(useSamModelStore.getState().status).toEqual({ kind: 'absent' });
  });
});
