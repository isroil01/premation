/**
 * The import probe and its degradation tiers.
 *
 * The tiers are the contract, not an implementation detail: `resolveFfmpeg`
 * falls back to bare `ffmpeg` on PATH and may find nothing, so "no probe" is a
 * real desktop state, not just a browser one. An import must never fail or be
 * skipped because a codec tool is missing — the probe adds precision and its
 * absence returns the editor to the behaviour every existing project has.
 */

import { probeMedia, canProbe } from './mediaProbe';

/** jsdom's File has no `arrayBuffer()` (it landed in the spec after jsdom's
 *  Blob), so it is polyfilled here rather than worked around in the source —
 *  every real browser and Electron renderer has it. */
const file = (name = 'clip.mp4', type = 'video/mp4'): File => {
  const f = new File([new Uint8Array([1, 2, 3])], name, { type });
  if (typeof f.arrayBuffer !== 'function') {
    Object.defineProperty(f, 'arrayBuffer', {
      value: async () => new Uint8Array([1, 2, 3]).buffer,
    });
  }
  return f;
};

function setProbe(fn: unknown): void {
  (window as unknown as { motionEditor?: Record<string, unknown> }).motionEditor = {
    media: { probe: fn },
  };
}

afterEach(() => {
  delete (window as unknown as { motionEditor?: unknown }).motionEditor;
});

describe('tier: elementOnly (browser, or desktop without ffprobe)', () => {
  it('reports elementOnly when there is no bridge at all', async () => {
    expect(canProbe()).toBe(false);
    expect(await probeMedia(file())).toEqual({ tier: 'elementOnly' });
  });

  it('reports elementOnly when the probe ran but ffprobe was missing', async () => {
    // main resolves null rather than throwing when the binary is absent.
    setProbe(async () => null);
    expect(await probeMedia(file())).toEqual({ tier: 'elementOnly' });
  });

  it('never throws when the bridge itself fails', async () => {
    setProbe(async () => {
      throw new Error('IPC exploded');
    });
    expect(await probeMedia(file())).toEqual({ tier: 'none' });
  });
});

describe('tier: probed', () => {
  const full = {
    container: 'mov,mp4,m4a',
    durationSec: 12.5,
    video: { codec: 'h264', width: 3840, height: 2160, fps: 23.976, par: 1 },
    audio: { codec: 'aac', channels: 2, sampleRate: 48000 },
  };

  it('surfaces the real frame rate — the fact the browser cannot supply', async () => {
    setProbe(async () => full);
    const facts = await probeMedia(file());
    expect(facts).toMatchObject({ tier: 'probed', fps: 23.976, width: 3840, height: 2160, durationSec: 12.5 });
  });

  it('reports the audio stream, so the UI need not wait for a decode to fail', async () => {
    setProbe(async () => full);
    expect((await probeMedia(file())).audio).toEqual({ codec: 'aac', channels: 2, sampleRate: 48000 });
  });

  it('distinguishes "no audio stream" from "did not look"', async () => {
    setProbe(async () => ({ ...full, audio: null }));
    const facts = await probeMedia(file());
    // null = the container was read and has no audio. undefined would mean
    // nobody looked, and the audio UI treats the two differently.
    expect(facts.audio).toBeNull();

    setProbe(async () => null);
    expect((await probeMedia(file())).audio).toBeUndefined();
  });

  it('carries a non-square pixel aspect through', async () => {
    setProbe(async () => ({ ...full, video: { ...full.video, par: 1.4222 } }));
    expect((await probeMedia(file())).par).toBeCloseTo(1.4222, 4);
  });

  it('omits a square pixel aspect rather than writing an explicit 1', async () => {
    // Writing par: 1 would present "believe the file" as a user override, and
    // there would be nothing to reset back to.
    setProbe(async () => full);
    expect((await probeMedia(file())).par).toBeUndefined();
  });

  it('leaves fps undefined when the container does not report one', async () => {
    setProbe(async () => ({ ...full, video: { ...full.video, fps: null } }));
    expect((await probeMedia(file())).fps).toBeUndefined();
  });

  it('handles an audio-only file (no video stream)', async () => {
    setProbe(async () => ({ container: 'wav', durationSec: 4, video: null, audio: { codec: 'pcm_s16le', channels: 1, sampleRate: 44100 } }));
    const facts = await probeMedia(file('vo.wav', 'audio/wav'));
    expect(facts).toMatchObject({ tier: 'probed', durationSec: 4 });
    expect(facts.width).toBeUndefined();
    expect(facts.audio?.channels).toBe(1);
  });
});

describe('the temp-file extension handed to ffprobe', () => {
  it('comes from the file name so the right demuxer is chosen', async () => {
    const seen: string[] = [];
    setProbe(async (_b: Uint8Array, ext: string) => {
      seen.push(ext);
      return null;
    });
    await probeMedia(file('a.mov', 'video/quicktime'));
    await probeMedia(file('b.webm', 'video/webm'));
    expect(seen).toEqual(['mov', 'webm']);
  });

  it('falls back to the MIME subtype when the name has no extension', async () => {
    const seen: string[] = [];
    setProbe(async (_b: Uint8Array, ext: string) => {
      seen.push(ext);
      return null;
    });
    await probeMedia(file('noextension', 'video/mp4'));
    expect(seen).toEqual(['mp4']);
  });
});
