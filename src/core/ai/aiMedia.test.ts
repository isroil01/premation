/**
 * Media generation transport — mirrors `aiImage.test.ts`.
 */

import { setEdition } from '@core/config/edition';
import { generateVideoBytes, localMediaAvailable } from './aiMedia';
import { AiTransportError } from './aiTransport';
import { PREVIEW_VIDEO_MODEL } from '@motion/ai-tools';
import type { AiMediaResult } from '@app-types/motionEditor';

const generateVideo = jest.fn();

jest.mock('@core/api/client', () => ({
  api: {
    generateVideo: (...args: unknown[]) => generateVideo(...args),
    generateSpeech: jest.fn(),
    generate3d: jest.fn(),
  },
  isAuthenticated: () => true,
}));

function installShell(
  impl: (req: unknown) => Promise<AiMediaResult> = async () => ({
    ok: true,
    base64: 'dmlkZW8=',
    mime: 'video/mp4',
    extension: 'mp4',
  }),
): void {
  (globalThis.window as unknown as { motionEditor?: unknown }).motionEditor = {
    ai: {
      video: impl,
      speech: impl,
      model3d: impl,
    },
  };
}

function clearShell(): void {
  delete (globalThis.window as unknown as { motionEditor?: unknown }).motionEditor;
}

describe('generateVideoBytes', () => {
  beforeEach(() => {
    generateVideo.mockReset();
    clearShell();
  });

  it('answers the preview model locally in every edition — no backend, no shell, no key', async () => {
    for (const edition of ['server', 'local'] as const) {
      setEdition(edition);
      const res = await generateVideoBytes({ prompt: 'mist drifting over pines', model: PREVIEW_VIDEO_MODEL, durationSec: 4 });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.mime).toBe('video/mp4');
        // A real MP4: the 'ftyp' box sits at byte 4.
        expect(Buffer.from(res.base64, 'base64').subarray(4, 8).toString('latin1')).toBe('ftyp');
      }
    }
    expect(generateVideo).not.toHaveBeenCalled();
  });

  it('uses the backend on the server edition', async () => {
    setEdition('server');
    generateVideo.mockResolvedValue({ ok: true, base64: 'abc', mime: 'video/mp4', extension: 'mp4' });
    const res = await generateVideoBytes({ prompt: 'A calm ocean at dusk' });
    expect(generateVideo).toHaveBeenCalled();
    expect(res.ok).toBe(true);
  });

  it('uses IPC when local media is available', async () => {
    setEdition('local');
    installShell();
    expect(localMediaAvailable()).toBe(true);
    const res = await generateVideoBytes({ prompt: 'Neon city flythrough' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.extension).toBe('mp4');
  });

  it('fails closed when local shell lacks media IPC', async () => {
    setEdition('local');
    await expect(generateVideoBytes({ prompt: 'Test prompt long enough' })).rejects.toBeInstanceOf(AiTransportError);
  });
});
