/**
 * Installing the Object Matte model through the desktop bridge.
 *
 * What is pinned here, none of it the download itself (electron/objectMatteModel.ts
 * owns that):
 *
 *  • It never fetches on its own: restore only asks main what is installed.
 *  • A wrong URL is refused before anything is asked of main.
 *  • Progress is filtered by the request's own id, and a Cancel lands as
 *    `absent` (the bundled model stays in use), not as an error.
 *  • Outside the desktop app there is nothing to install into, and it says so.
 */

import { useSamModelStore } from '@stores/samModelStore';
import { checkUrls } from './samModelInstall';

const ENCODER_URL = 'https://example.test/vision_encoder.onnx';
const DECODER_URL = 'https://example.test/decoder.onnx';
const MODEL = { encoderUrl: ENCODER_URL, decoderUrl: DECODER_URL, bytes: 1234, installedAt: 1_700_000_000_000 };

type Progress = (event: unknown) => void;

function mockBridge(opts: { installed?: typeof MODEL | null; install?: (req: { requestId: string }, progress: Progress) => Promise<unknown> } = {}) {
  let progress: Progress = () => undefined;
  const bridge = {
    status: jest.fn(async () => opts.installed ?? null),
    install: jest.fn(async (req: { encoderUrl: string; decoderUrl: string; requestId: string }) =>
      opts.install ? opts.install(req, progress) : { ok: true, model: MODEL }),
    remove: jest.fn(async () => true),
    cancelDownload: jest.fn(async () => true),
    onDownloadProgress: jest.fn((h: Progress) => {
      progress = h;
      return () => {
        progress = () => undefined;
      };
    }),
  };
  (window as unknown as { motionEditor?: unknown }).motionEditor = { objectMatte: bridge };
  return bridge;
}

afterEach(() => {
  delete (window as unknown as { motionEditor?: unknown }).motionEditor;
  useSamModelStore.setState({ status: { kind: 'absent' } });
});

describe('checkUrls', () => {
  it('accepts https and names the file that is wrong', () => {
    expect(checkUrls(ENCODER_URL, DECODER_URL)).toBeNull();
    expect(checkUrls('http://x.test/a.onnx', DECODER_URL)).toMatch(/encoder/);
    expect(checkUrls(ENCODER_URL, 'not a url')).toMatch(/decoder URL is not a valid URL/);
  });
});

describe('the Object Matte model store', () => {
  it('restore reports what main has installed, and installs nothing', async () => {
    const bridge = mockBridge({ installed: MODEL });
    await useSamModelStore.getState().restore();
    expect(useSamModelStore.getState().status).toEqual({ kind: 'ready', sourceUrl: ENCODER_URL, decoderUrl: DECODER_URL, bytes: 1234, installedAt: MODEL.installedAt });
    expect(bridge.install).not.toHaveBeenCalled();
  });

  it('install hands both URLs to main and reports its own progress only', async () => {
    const seen: unknown[] = [];
    const unsub = useSamModelStore.subscribe((s) => seen.push(s.status));
    const bridge = mockBridge({
      install: async (req, progress) => {
        progress({ requestId: 'someone-else', receivedBytes: 999, totalBytes: 1000 });
        progress({ requestId: req.requestId, receivedBytes: 10, totalBytes: 100 });
        return { ok: true, model: MODEL };
      },
    });
    await useSamModelStore.getState().install(` ${ENCODER_URL} `, DECODER_URL);
    unsub();
    expect(bridge.install).toHaveBeenCalledWith(expect.objectContaining({ encoderUrl: ENCODER_URL, decoderUrl: DECODER_URL }));
    expect(seen).toContainEqual({ kind: 'downloading', receivedBytes: 10, totalBytes: 100 });
    expect(seen).not.toContainEqual({ kind: 'downloading', receivedBytes: 999, totalBytes: 1000 });
    expect(useSamModelStore.getState().status.kind).toBe('ready');
  });

  it('refuses a non-https URL without asking main', async () => {
    const bridge = mockBridge();
    await useSamModelStore.getState().install('http://x.test/a.onnx', DECODER_URL);
    expect(bridge.install).not.toHaveBeenCalled();
    expect(useSamModelStore.getState().status).toMatchObject({ kind: 'failed' });
  });

  it("a failed install says why; a cancelled one goes back to absent", async () => {
    mockBridge({ install: async () => ({ ok: false, message: 'The host answered 404' }) });
    await useSamModelStore.getState().install(ENCODER_URL, DECODER_URL);
    expect(useSamModelStore.getState().status).toEqual({ kind: 'failed', message: 'The host answered 404' });

    let release: (v: unknown) => void = () => undefined;
    const bridge = mockBridge({ install: () => new Promise((r) => { release = r; }) });
    const done = useSamModelStore.getState().install(ENCODER_URL, DECODER_URL);
    await Promise.resolve();
    useSamModelStore.getState().cancel();
    expect(bridge.cancelDownload).toHaveBeenCalled();
    release({ ok: false, message: 'Cancelled.' });
    await done;
    expect(useSamModelStore.getState().status).toEqual({ kind: 'absent' });
  });

  it('remove asks main to delete the files', async () => {
    const bridge = mockBridge({ installed: MODEL });
    await useSamModelStore.getState().remove();
    expect(bridge.remove).toHaveBeenCalled();
    expect(useSamModelStore.getState().status).toEqual({ kind: 'absent' });
  });

  it('outside the desktop app there is nothing to install into', async () => {
    await useSamModelStore.getState().install(ENCODER_URL, DECODER_URL);
    expect(useSamModelStore.getState().status).toMatchObject({ kind: 'failed', message: expect.stringMatching(/desktop app/) });
  });
});
