/**
 * AppTextureProvider (S2) — resolves image assets to real GPU textures, with a
 * white-placeholder fallback while a decode is in flight. Tested headlessly with
 * an injected loader (no real image decode) against a NullBackend-backed
 * ResourceManager, which records texture creation.
 */

import { ResourceManager, NullBackend } from '@motion/renderer';
import { AppTextureProvider, type ImageLoader, type VideoFactory } from './AppTextureProvider';

/** A fake decoded bitmap (only width/height matter to the provider). */
function fakeBitmap(w = 320, h = 240): ImageBitmap {
  return { width: w, height: h, close() {} } as unknown as ImageBitmap;
}

/** A fake video element (only the fields setVideo touches). */
function fakeVideo(over: Partial<HTMLVideoElement> = {}): HTMLVideoElement {
  return {
    readyState: 2,
    currentTime: 0,
    videoWidth: 640,
    videoHeight: 480,
    addEventListener: () => {},
    removeEventListener: () => {},
    ...over
  } as unknown as HTMLVideoElement;
}

/** Flush the microtask/timer queue so an injected async loader settles. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function setup(
  loader?: ImageLoader,
  videoFactory?: VideoFactory,
): { provider: AppTextureProvider; backend: NullBackend } {
  const backend = new NullBackend();
  const resources = new ResourceManager(backend);
  resources.beginFrame(1);
  const provider = new AppTextureProvider(resources, { loader, videoFactory });
  return { provider, backend };
}

describe('AppTextureProvider', () => {
  it('returns a ready white placeholder for an unknown key', () => {
    const { provider } = setup();
    const tex = provider.get('asset:missing');
    expect(tex).not.toBeNull();
    expect(tex!.ready).toBe(true);
  });

  it('shows the placeholder before a decode resolves, the real texture after', async () => {
    const loader: ImageLoader = async () => fakeBitmap();
    const { provider } = setup(loader);
    const placeholderId = provider.get('nope')!.texture.id;

    provider.setImage('asset:a', 'blob:photo');
    // Synchronously (decode still pending) → placeholder.
    expect(provider.get('asset:a')!.texture.id).toBe(placeholderId);

    await flush();
    // Decoded → a different, real texture handle.
    const after = provider.get('asset:a')!;
    expect(after.ready).toBe(true);
    expect(after.texture.id).not.toBe(placeholderId);
  });

  it('fires onChange when a decode completes (drives a re-render)', async () => {
    const { provider } = setup(async () => fakeBitmap());
    const onChange = jest.fn();
    provider.onChange = onChange;
    provider.setImage('asset:a', 'blob:photo');
    expect(onChange).not.toHaveBeenCalled();
    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('does not re-decode the same (key, src)', async () => {
    const loader = jest.fn<Promise<ImageBitmap>, [string]>(async () => fakeBitmap());
    const { provider } = setup(loader);
    provider.setImage('asset:a', 'blob:photo');
    provider.setImage('asset:a', 'blob:photo');
    await flush();
    provider.setImage('asset:a', 'blob:photo');
    await flush();
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('re-decodes when the src changes for a key', async () => {
    const loader = jest.fn<Promise<ImageBitmap>, [string]>(async () => fakeBitmap());
    const { provider } = setup(loader);
    provider.setImage('asset:a', 'blob:one');
    await flush();
    provider.setImage('asset:a', 'blob:two');
    await flush();
    expect(loader).toHaveBeenCalledTimes(2);
    expect(loader).toHaveBeenLastCalledWith('blob:two');
  });

  it('keeps showing the placeholder if a decode throws (broken source)', async () => {
    const { provider } = setup(async () => {
      throw new Error('404');
    });
    const placeholderId = provider.get('nope')!.texture.id;
    provider.setImage('asset:a', 'blob:broken');
    await flush();
    expect(provider.get('asset:a')!.texture.id).toBe(placeholderId);
  });

  it('retain() forgets keys no longer in the scene', async () => {
    const { provider } = setup(async () => fakeBitmap());
    provider.setImage('asset:a', 'blob:a');
    provider.setImage('asset:b', 'blob:b');
    await flush();
    const realA = provider.get('asset:a')!.texture.id;
    provider.retain(new Set(['asset:b']));
    // 'a' is forgotten → back to placeholder; 'b' still real.
    expect(provider.get('asset:a')!.texture.id).not.toBe(realA);
  });

  describe('text rasterization', () => {
    const spec = { text: 'Hello', fontSize: 48, color: '#ffffff', width: 300, height: 80 };

    it('rasterizes text synchronously to a real (non-placeholder) texture', () => {
      const { provider } = setup();
      const placeholderId = provider.get('nope')!.texture.id;
      provider.setText('text:t', spec);
      const tex = provider.get('text:t')!;
      expect(tex.ready).toBe(true);
      expect(tex.texture.id).not.toBe(placeholderId);
    });

    it('reuses the texture when the spec is unchanged (signature)', () => {
      const { provider } = setup();
      provider.setText('text:t', spec);
      const a = provider.get('text:t')!.texture.id;
      provider.setText('text:t', { ...spec });
      expect(provider.get('text:t')!.texture.id).toBe(a);
    });

    it('re-rasterizes when the string changes', () => {
      const { provider } = setup();
      provider.setText('text:t', { ...spec, text: 'A' });
      const a = provider.get('text:t')!.texture.id;
      provider.setText('text:t', { ...spec, text: 'B' });
      expect(provider.get('text:t')!.texture.id).not.toBe(a);
    });

    it('retain() forgets text keys, falling back to the placeholder', () => {
      const { provider } = setup();
      provider.setText('text:t', spec);
      const real = provider.get('text:t')!.texture.id;
      provider.retain(new Set());
      expect(provider.get('text:t')!.texture.id).not.toBe(real);
    });
  });

  describe('video frames', () => {
    it('shows the placeholder until the element has decoded a frame', () => {
      const notReady = fakeVideo({ readyState: 0 });
      const { provider } = setup(undefined, () => notReady);
      const placeholderId = provider.get('nope')!.texture.id;
      provider.setVideo('asset:v', 'blob:clip', 0);
      expect(provider.get('asset:v')!.texture.id).toBe(placeholderId);
    });

    it('uploads a real texture once the element is ready', () => {
      const video = fakeVideo();
      const { provider } = setup(undefined, () => video);
      const placeholderId = provider.get('nope')!.texture.id;
      provider.setVideo('asset:v', 'blob:clip', 0);
      const tex = provider.get('asset:v')!;
      expect(tex.ready).toBe(true);
      expect(tex.texture.id).not.toBe(placeholderId);
    });

    it('seeks the element toward the playhead when it drifts', () => {
      const video = fakeVideo({ currentTime: 0 });
      const { provider } = setup(undefined, () => video);
      provider.setVideo('asset:v', 'blob:clip', 3);
      expect(video.currentTime).toBe(3);
    });

    it('reuses one element per source, swapping only when the src changes', () => {
      const made: string[] = [];
      const factory: VideoFactory = (src) => {
        made.push(src);
        return fakeVideo();
      };
      const { provider } = setup(undefined, factory);
      provider.setVideo('asset:v', 'blob:one', 0);
      provider.setVideo('asset:v', 'blob:one', 0.1);
      expect(made).toEqual(['blob:one']); // reused
      provider.setVideo('asset:v', 'blob:two', 0);
      expect(made).toEqual(['blob:one', 'blob:two']); // swapped
    });

    it('retain() forgets video keys', () => {
      const video = fakeVideo();
      const { provider } = setup(undefined, () => video);
      provider.setVideo('asset:v', 'blob:clip', 0);
      const real = provider.get('asset:v')!.texture.id;
      provider.retain(new Set());
      expect(provider.get('asset:v')!.texture.id).not.toBe(real);
    });
  });
});
