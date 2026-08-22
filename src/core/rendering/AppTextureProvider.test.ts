/**
 * AppTextureProvider (S2) — resolves image assets to real GPU textures, with a
 * TRANSPARENT placeholder while a decode is in flight. Tested headlessly with an
 * injected loader (no real image decode) against a NullBackend-backed
 * ResourceManager, which records texture creation.
 *
 * The placeholder used to be opaque WHITE, which made every layer whose clip
 * starts partway into the timeline flash a white rectangle on the frame it
 * appeared — such a layer is absent from the snapshot until then, so its decode
 * only begins once it is already on screen. The `placeholder` block below
 * asserts the actual pixel bytes, not just which key was asked for.
 */

import { ResourceManager, NullBackend } from '@motion/renderer';
import { AppTextureProvider, textCssFont, spotConeFactor, type ImageLoader, type VideoFactory } from './AppTextureProvider';
import type { RenderLayer } from './RenderBackend';

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

/**
 * A backend that records what was actually written into each texture, so the
 * placeholder can be asserted by its PIXEL rather than by the key it asked for.
 * `NullBackend.writeTexture` is a no-op, so nothing else can see the bytes —
 * and the bytes are the entire bug.
 */
class RecordingBackend extends NullBackend {
  readonly writes: Array<{ label?: string; data?: Uint8Array }> = [];
  private labels = new Map<number, string | undefined>();

  override createTexture(desc: Parameters<NullBackend['createTexture']>[0]): ReturnType<NullBackend['createTexture']> {
    const h = super.createTexture(desc);
    this.labels.set(h.id, (desc as { label?: string }).label);
    return h;
  }

  override writeTexture(
    texture: Parameters<NullBackend['writeTexture']>[0],
    source: Parameters<NullBackend['writeTexture']>[1],
  ): void {
    const s = source as { type?: string; data?: Uint8Array };
    this.writes.push({
      label: this.labels.get(texture.id),
      ...(s.type === 'buffer' && s.data ? { data: s.data } : {}),
    });
  }
}

describe('the loading placeholder', () => {
  /**
   * The regression guard for the white flash.
   *
   * A layer starting at, say, 2s is not in the snapshot before then, so it
   * registers its source and begins decoding on the frame it becomes visible.
   * Whatever this returns is therefore drawn full-size, in place of the picture,
   * for as long as the decode takes. Opaque white made that a visible flash;
   * transparent makes it nothing.
   */
  it('writes a fully TRANSPARENT pixel, never an opaque one', () => {
    const backend = new RecordingBackend();
    const resources = new ResourceManager(backend);
    resources.beginFrame(1);
    const provider = new AppTextureProvider(resources, {});

    provider.get('asset:not-decoded-yet');

    const write = backend.writes.find((w) => w.data?.length === 4);
    expect(write).toBeDefined();
    // RGBA, premultiplied — zero coverage is all four channels zero.
    expect(Array.from(write!.data!)).toEqual([0, 0, 0, 0]);
    // Specifically NOT the old opaque white.
    expect(Array.from(write!.data!)).not.toEqual([255, 255, 255, 255]);
  });

  it('does not reuse `texture:white`, which solid layers need opaque', () => {
    // That key is CompositionPass's identity texture for solid layers, where the
    // solid's colour is multiplied against it. Recolouring it to fix this bug
    // would have multiplied every solid layer to nothing. Two roles, two
    // textures — asserted by label so a future merge cannot quietly re-collapse
    // them.
    const backend = new RecordingBackend();
    const resources = new ResourceManager(backend);
    resources.beginFrame(1);
    const provider = new AppTextureProvider(resources, {});

    provider.get('asset:not-decoded-yet');

    const labels = backend.writes.map((w) => w.label);
    expect(labels).toContain('transparent');
    expect(labels).not.toContain('white');
  });
});

describe('AppTextureProvider', () => {
  it('returns a placeholder for an unknown key, reported as NOT ready', () => {
    const { provider } = setup();
    const tex = provider.get('asset:missing');
    expect(tex).not.toBeNull();
    // Not ready, because it genuinely is not. This claimed `true` before; no
    // renderer pass reads the flag today, so the lie was free — right up until
    // something starts reading it.
    expect(tex!.ready).toBe(false);
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
    const loader = jest.fn<Promise<ImageBitmap>, [string, string?]>(async () => fakeBitmap());
    const { provider } = setup(loader);
    provider.setImage('asset:a', 'blob:photo');
    provider.setImage('asset:a', 'blob:photo');
    await flush();
    provider.setImage('asset:a', 'blob:photo');
    await flush();
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('re-decodes when the src changes for a key', async () => {
    const loader = jest.fn<Promise<ImageBitmap>, [string, string?, boolean?]>(async () => fakeBitmap());
    const { provider } = setup(loader);
    provider.setImage('asset:a', 'blob:one');
    await flush();
    provider.setImage('asset:a', 'blob:two');
    await flush();
    expect(loader).toHaveBeenCalledTimes(2);
    expect(loader).toHaveBeenLastCalledWith('blob:two', undefined, undefined);
  });

  it('re-decodes when the FILE’s alpha mode changes, and tells the loader', async () => {
    // The alpha mode is baked into the texture by the decode (see `decodeOptions`
    // — a straight file is multiplied, a premultiplied one is passed through), so
    // it has to be part of the cache identity. Without that, toggling Interpret
    // Footage ▸ Alpha would keep serving the bitmap decoded under the old setting
    // and the inspector would appear to do nothing.
    const loader = jest.fn<Promise<ImageBitmap>, [string, string?, boolean?]>(async () => fakeBitmap());
    const { provider } = setup(loader);
    provider.setImage('asset:a', 'blob:clip');
    await flush();
    expect(loader).toHaveBeenLastCalledWith('blob:clip', undefined, undefined);
    provider.setImage('asset:a', 'blob:clip', undefined, true);
    await flush();
    expect(loader).toHaveBeenCalledTimes(2);
    expect(loader).toHaveBeenLastCalledWith('blob:clip', undefined, true);
  });

  it('does NOT re-decode when the alpha mode is unchanged', async () => {
    const loader = jest.fn<Promise<ImageBitmap>, [string, string?, boolean?]>(async () => fakeBitmap());
    const { provider } = setup(loader);
    provider.setImage('asset:a', 'blob:clip', undefined, true);
    await flush();
    provider.setImage('asset:a', 'blob:clip', undefined, true);
    await flush();
    expect(loader).toHaveBeenCalledTimes(1);
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

  /**
   * `retain` gives IMAGES a grace period, and that is load-bearing rather than
   * an optimisation.
   *
   * The active set is the layers visible on THIS FRAME, which is not the same
   * question as "still in the project". Freeing on that basis meant a layer
   * whose clip starts at 2s was evicted whenever the playhead sat before 2s and
   * re-decoded from scratch every time it crossed — so the loading placeholder
   * reappeared on every pass and every scrub, not just on first load.
   */
  describe('retain()', () => {
    it('KEEPS a briefly-inactive image, so scrubbing over a clip start does not re-decode', async () => {
      const { provider } = setup(async () => fakeBitmap());
      provider.setImage('asset:a', 'blob:a');
      provider.setImage('asset:b', 'blob:b');
      await flush();
      const realA = provider.get('asset:a')!.texture.id;

      // The playhead moves off 'a' — one frame without it, as when scrubbing
      // back before its clip starts.
      provider.retain(new Set(['asset:b']));

      // Still the real texture, NOT the placeholder: coming back is free.
      expect(provider.get('asset:a')!.texture.id).toBe(realA);
    });

    it('still frees it once enough other images have displaced it', async () => {
      const { provider } = setup(async () => fakeBitmap());
      provider.setImage('asset:a', 'blob:a');
      await flush();
      const realA = provider.get('asset:a')!.texture.id;

      // Push 'a' out of the bounded grace cache. The bound is what keeps this a
      // cache rather than a leak — a long timeline of stills has a ceiling.
      for (let i = 0; i < 40; i++) {
        provider.setImage(`asset:filler${i}`, `blob:filler${i}`);
      }
      await flush();
      for (let i = 0; i < 40; i++) {
        provider.retain(new Set([`asset:filler${i}`]));
      }

      expect(provider.get('asset:a')!.texture.id).not.toBe(realA);
    });

    it('dispose() releases the parked images too', async () => {
      // Otherwise the grace cache becomes the very leak retain() was written to
      // fix: on teardown there is no later frame to park for.
      const { provider } = setup(async () => fakeBitmap());
      provider.setImage('asset:a', 'blob:a');
      await flush();
      const realA = provider.get('asset:a')!.texture.id;

      provider.retain(new Set()); // parked, not freed
      provider.dispose();

      expect(provider.get('asset:a')!.texture.id).not.toBe(realA);
    });

    it('still forgets non-image entries immediately', async () => {
      // Video owns a decoder pipeline and live listeners; text/mask/path are
      // cheap to rebuild. Only images are worth parking.
      const { provider } = setup();
      provider.setText('text:t', { text: 'Hello', fontSize: 48, color: '#ffffff', width: 300, height: 80 });
      const realText = provider.get('text:t')!.texture.id;
      provider.retain(new Set());
      expect(provider.get('text:t')!.texture.id).not.toBe(realText);
    });
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

    // The font is now part of the raster (was hardcoded 600 Inter). Each font
    // field must invalidate the signature so the GPU text re-rasterizes — else a
    // weight/family/alignment change would silently keep the old texture.
    it.each([
      ['fontFamily', { fontFamily: 'Roboto' }],
      ['fontWeight', { fontWeight: '300' }],
      ['fontStyle', { fontStyle: 'italic' }],
      ['align', { align: 'right' }],
      ['letterSpacing', { letterSpacing: 4 }],
      ['lineHeight', { lineHeight: 2 }],
    ])('re-rasterizes when %s changes', (_label, override) => {
      const { provider } = setup();
      provider.setText('text:t', spec);
      const a = provider.get('text:t')!.texture.id;
      provider.setText('text:t', { ...spec, ...override });
      expect(provider.get('text:t')!.texture.id).not.toBe(a);
    });

    it('reuses the texture when all font fields are identical', () => {
      const styled = { ...spec, fontFamily: 'Roboto', fontWeight: '700', fontStyle: 'italic', align: 'center', letterSpacing: 2, lineHeight: 1.5 };
      const { provider } = setup();
      provider.setText('text:t', styled);
      const a = provider.get('text:t')!.texture.id;
      provider.setText('text:t', { ...styled });
      expect(provider.get('text:t')!.texture.id).toBe(a);
    });
  });

  describe('textCssFont (Canvas2D parity)', () => {
    it('matches Canvas2DBackend\'s font shorthand', () => {
      expect(textCssFont({ fontSize: 24, fontFamily: 'Roboto', fontWeight: '700', fontStyle: 'italic' }))
        .toBe('italic 700 24px "Roboto", Inter, system-ui, sans-serif');
    });
    it('defaults weight 600 / Inter / upright, like Canvas2D', () => {
      expect(textCssFont({ fontSize: 48 }))
        .toBe('600 48px "Inter", Inter, system-ui, sans-serif');
    });
  });

  describe('light textures', () => {
    const wash = (color: string, extra: Partial<NonNullable<RenderLayer['light']>> = {}) =>
      ({ color, intensity: 100, radius: 200, type: 'point' as const, ...extra });

    it('rasterizes a light to a real (non-placeholder) texture', () => {
      const { provider } = setup();
      const placeholderId = provider.get('nope')!.texture.id;
      provider.setLight('light:l', wash('#ffffff'));
      const tex = provider.get('light:l')!;
      expect(tex.ready).toBe(true);
      expect(tex.texture.id).not.toBe(placeholderId);
    });

    it('reuses the texture for the same colour, re-rasterizes on colour change', () => {
      const { provider } = setup();
      provider.setLight('light:l', wash('#ffffff'));
      const a = provider.get('light:l')!.texture.id;
      provider.setLight('light:l', wash('#ffffff'));
      expect(provider.get('light:l')!.texture.id).toBe(a);
      provider.setLight('light:l', wash('#ff8800'));
      expect(provider.get('light:l')!.texture.id).not.toBe(a);
    });

    /**
     * The colour-only key was a COLLISION, not merely a narrow key: two spots
     * differing only in cone hashed to one entry, so the second silently reused
     * the first's gradient. A correct rasterizer would still have drawn the
     * wrong cone, which is why this is asserted at the cache and not only at
     * the pixels.
     */
    it('re-rasterizes when a spot cone changes, not just its colour', () => {
      const { provider } = setup();
      const spot = (extra: Partial<NonNullable<RenderLayer['light']>>) =>
        wash('#ffffff', { type: 'spot', angle: 0, cone: 60, coneFeather: 50, ...extra });

      provider.setLight('light:s', spot({}));
      const base = provider.get('light:s')!.texture.id;

      provider.setLight('light:s', spot({ cone: 20 }));
      expect(provider.get('light:s')!.texture.id).not.toBe(base);

      provider.setLight('light:s', spot({ angle: 90 }));
      const angled = provider.get('light:s')!.texture.id;
      expect(angled).not.toBe(base);

      provider.setLight('light:s', spot({ coneFeather: 0 }));
      expect(provider.get('light:s')!.texture.id).not.toBe(angled);
    });

    it('ambient / point / parallel of one colour still share a texture', () => {
      // Their washes ARE the same image, so this is reuse rather than a
      // collision — the cone params are keyed only where they change pixels.
      const { provider } = setup();
      provider.setLight('light:a', wash('#ffffff', { type: 'point' }));
      const id = provider.get('light:a')!.texture.id;
      provider.setLight('light:a', wash('#ffffff', { type: 'ambient' }));
      expect(provider.get('light:a')!.texture.id).toBe(id);
    });

    it('retain() forgets light keys, falling back to the placeholder', () => {
      const { provider } = setup();
      provider.setLight('light:l', wash('#ffffff'));
      const real = provider.get('light:l')!.texture.id;
      provider.retain(new Set());
      expect(provider.get('light:l')!.texture.id).not.toBe(real);
    });

    /**
     * The cone shape itself. `rasterizeLight` needs a real 2D canvas, which
     * jsdom has not got, so without extracting this the maths would be
     * verifiable only through the GPU harness — and it is the whole point of
     * the change.
     */
    describe('spot cone coverage', () => {
      const D = Math.PI / 180;
      const half = 30 * D; // a 60° cone
      const feather = half * 0.5;

      it('is fully lit along the aim and dark outside the cone', () => {
        expect(spotConeFactor(1, 0, 0, half, feather)).toBe(1);
        expect(spotConeFactor(0, 1, 0, half, feather)).toBe(0); // 90° off-axis
      });

      it('ramps across the feather band instead of stepping', () => {
        // 25° off a 30° half-cone sits inside the 15° feather band.
        const k = spotConeFactor(Math.cos(25 * D), Math.sin(25 * D), 0, half, feather);
        expect(k).toBeGreaterThan(0);
        expect(k).toBeLessThan(1);
        // Further out is dimmer — the direction of the ramp, not just its range.
        const further = spotConeFactor(Math.cos(28 * D), Math.sin(28 * D), 0, half, feather);
        expect(further).toBeLessThan(k);
      });

      it('a zero feather is a hard edge', () => {
        expect(spotConeFactor(Math.cos(29 * D), Math.sin(29 * D), 0, half, 0)).toBe(1);
        expect(spotConeFactor(Math.cos(31 * D), Math.sin(31 * D), 0, half, 0)).toBe(0);
      });

      it('wraps at ±180°, so a cone aimed left is not cut in half', () => {
        // Aim 180°; ±10° either side must both be lit. Without the wrap one
        // side measures ~350° away and goes dark.
        const aim = Math.PI;
        expect(spotConeFactor(Math.cos(170 * D), Math.sin(170 * D), aim, half, 0)).toBe(1);
        expect(spotConeFactor(Math.cos(-170 * D), Math.sin(-170 * D), aim, half, 0)).toBe(1);
      });

      it('the light centre is lit rather than undefined', () => {
        expect(spotConeFactor(0, 0, 0, half, feather)).toBe(1);
      });
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

    it('seeks before the first upload even when the time already matches', () => {
      // THE BLACK-VIDEO-AT-TIME-ZERO BUG. A loaded but never-seeked <video>
      // presents an all-black surface even at readyState 4 (measured in Chromium:
      // drawImage at currentTime 0 yields zeroed pixels; the same element after a
      // seek yields the real frame). At comp time 0 the target and currentTime are
      // both 0, so a drift-only check declined to seek and uploaded that black
      // surface — every video layer read as a black rectangle at the start of a
      // composition, which is exactly where the playhead sits when a preview opens.
      const video = fakeVideo({ currentTime: 0 });
      const { provider } = setup(undefined, () => video);
      provider.setVideo('asset:v', 'blob:clip', 0);
      expect(video.currentTime).toBeGreaterThan(0);
      // ...and still within the same frame, so the picture is the right one.
      expect(video.currentTime).toBeLessThan(0.001);
    });

    it('does not re-seek on later renders of the same time', () => {
      // The first-decode seek must fire ONCE. `seeked` triggers onChange →
      // re-render → setVideo, so a seek that re-arms itself is a render loop at
      // rAF rate with playback paused.
      const video = fakeVideo({ currentTime: 0 });
      const { provider } = setup(undefined, () => video);
      provider.setVideo('asset:v', 'blob:clip', 0);
      const afterFirst = video.currentTime;
      // Simulate the decoder landing exactly on target, as it does for short GOPs.
      (video as { currentTime: number }).currentTime = 0;
      provider.setVideo('asset:v', 'blob:clip', 0);
      expect(video.currentTime).toBe(0);
      expect(afterFirst).toBeGreaterThan(0);
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

  describe('CPU-bake rebakes do not blink', () => {
    it('keeps the last texture on screen while a new bake spec is decoding', async () => {
      const loader = jest.fn<Promise<ImageBitmap>, [string, string?, boolean?]>(async () => fakeBitmap());
      const { provider } = setup(loader);
      const placeholderId = provider.get('nope')!.texture.id;

      provider.setImage('asset:a', 'blob:photo');
      await flush();
      const first = provider.get('asset:a')!;
      expect(first.ready).toBe(true);
      expect(first.texture.id).not.toBe(placeholderId);

      // Same file, different bake — this used to replace the entry with
      // ready:false / texture:null, so get() returned the transparent
      // placeholder until the bake landed (the image "blink").
      const bake = { effects: [], width: 320, height: 240 };
      provider.setImage('asset:a', 'blob:photo', undefined, undefined, bake);
      const during = provider.get('asset:a')!;
      expect(during.texture.id).toBe(first.texture.id);
      expect(during.texture.id).not.toBe(placeholderId);
      // The file was already decoded; don't hit the network/loader again.
      expect(loader).toHaveBeenCalledTimes(1);

      await flush();
      expect(provider.get('asset:a')!.ready).toBe(true);
    });
  });
});
