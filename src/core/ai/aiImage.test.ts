/**
 * Image generation picks the same transport as chat — by capability, not by
 * edition name. A build with a backend must never fall through to IPC, and a
 * local shell without `ai.image` must fail closed rather than call the API.
 */

import { setEdition } from '@core/config/edition';
import { generateImageBytes, localImageAvailable } from './aiImage';
import { AiTransportError } from './aiTransport';
import type { AiImageResult } from '@app-types/motionEditor';

const generateImage = jest.fn();

jest.mock('@core/api/client', () => ({
  api: {
    generateImage: (...args: unknown[]) => generateImage(...args),
  },
  isAuthenticated: () => true,
}));

function installShellImage(
  impl: (req: unknown) => Promise<AiImageResult> = async () => ({
    ok: true,
    base64: 'shell-bytes',
    mime: 'image/png',
  }),
): { calls: unknown[] } {
  const calls: unknown[] = [];
  (globalThis.window as unknown as { motionEditor?: unknown }).motionEditor = {
    ai: {
      image: async (req: unknown) => {
        calls.push(req);
        return impl(req);
      },
    },
  };
  return { calls };
}

function clearShell(): void {
  delete (globalThis.window as unknown as { motionEditor?: unknown }).motionEditor;
}

beforeEach(() => {
  generateImage.mockReset();
  clearShell();
  setEdition('server');
});

afterEach(() => {
  clearShell();
  setEdition('server');
});

describe('generateImageBytes', () => {
  it('uses the backend gateway in the server edition', async () => {
    setEdition('server');
    generateImage.mockResolvedValue({ ok: true, base64: 'backend-bytes', mime: 'image/png' });

    const res = await generateImageBytes({
      provider: 'openai',
      prompt: 'a soft product shot on linen',
      width: 1024,
      height: 1024,
    });

    expect(res).toEqual({ ok: true, base64: 'backend-bytes', mime: 'image/png' });
    expect(generateImage).toHaveBeenCalledWith({
      provider: 'openai',
      prompt: 'a soft product shot on linen',
      width: 1024,
      height: 1024,
    });
  });

  it('uses the shell IPC in the local edition when the bridge exists', async () => {
    setEdition('local');
    const { calls } = installShellImage();

    const res = await generateImageBytes({
      provider: 'gemini',
      prompt: 'a soft product shot on linen',
      width: 1536,
      height: 1024,
    });

    expect(res).toEqual({ ok: true, base64: 'shell-bytes', mime: 'image/png' });
    expect(generateImage).not.toHaveBeenCalled();
    expect(calls).toEqual([
      {
        provider: 'gemini',
        prompt: 'a soft product shot on linen',
        width: 1536,
        height: 1024,
      },
    ]);
  });

  it('fails closed in local edition without an image bridge', async () => {
    setEdition('local');
    clearShell();
    expect(localImageAvailable()).toBe(false);

    await expect(
      generateImageBytes({ provider: 'openai', prompt: 'a soft product shot on linen' }),
    ).rejects.toMatchObject({ code: 'unsupported' } satisfies Partial<AiTransportError>);
    expect(generateImage).not.toHaveBeenCalled();
  });

  it('surfaces a shell refusal rather than inventing success', async () => {
    setEdition('local');
    installShellImage(async () => ({
      ok: false,
      code: 'unsupported',
      message: 'Anthropic does not generate images.',
    }));

    const res = await generateImageBytes({
      provider: 'anthropic',
      prompt: 'a soft product shot on linen',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('unsupported');
  });
});
