/**
 * The proxy resolution rule and the substitution decision.
 *
 * `resolveMediaSrc` is the one function that can damage output rather than just
 * speed up the editor, so every state it can be in is enumerated here rather
 * than sampled.
 */

import {
  proxyResolution,
  proxyCodec,
  proxyEncodeArgs,
  resolveMediaSrc,
  isProxyInUse,
  isPersistableProxy,
  PROXY_MIN_SOURCE_LONG_EDGE,
  PROXY_TARGET_LONG_EDGE,
  type ProxyRecord,
} from './proxy';

describe('proxyResolution — the rule', () => {
  it('halves 4K to 1080p', () => {
    expect(proxyResolution(3840, 2160)).toEqual({ width: 1920, height: 1080 });
  });

  it('keeps halving until the long edge is at or below the target', () => {
    expect(proxyResolution(7680, 4320)).toEqual({ width: 1920, height: 1080 });
    expect(proxyResolution(15360, 8640)).toEqual({ width: 1920, height: 1080 });
  });

  it('halves a source that is already at the target, because 1080p still seeks 2.2x slower than 540p', () => {
    expect(proxyResolution(1920, 1080)).toEqual({ width: 960, height: 540 });
  });

  it('never returns odd dimensions — H.264 yuv420p and VP9 yuva420p both reject them', () => {
    for (const [w, h] of [[2048, 858], [3841, 2161], [2049, 1153], [4000, 1687]] as const) {
      const r = proxyResolution(w, h);
      expect(r).not.toBeNull();
      expect(r!.width % 2).toBe(0);
      expect(r!.height % 2).toBe(0);
    }
  });

  it('declines when the source is already cheap to seek', () => {
    // Measured: a 540p source seeks in ~17ms, inside a 30fps frame budget.
    expect(proxyResolution(1280, 720)).toBeNull();
    expect(proxyResolution(640, 360)).toBeNull();
    expect(proxyResolution(PROXY_MIN_SOURCE_LONG_EDGE, 720)).toBeNull();
  });

  it('measures the LONG edge, so a tall source is treated like a wide one', () => {
    expect(proxyResolution(2160, 3840)).toEqual({ width: 1080, height: 1920 });
  });

  it('keeps a degenerate aspect ratio from rounding an axis to zero', () => {
    // 4096x2 halves twice (2048 is still over the 1920 target), which would put
    // the short axis at 0.5px. The floor clamps it to 2 — so the aspect is NOT
    // preserved here, deliberately: a 0-height encode fails outright, and no
    // real footage has a 2048:1 aspect. The property that matters is that the
    // rule always returns something ffmpeg can encode.
    const r = proxyResolution(4096, 2);
    expect(r).toEqual({ width: 1024, height: 2 });
  });

  it('never returns a zero or odd axis for any plausible video shape', () => {
    for (const [w, h] of [[4096, 2], [2, 4096], [8192, 8], [3840, 6], [1281, 2]] as const) {
      const r = proxyResolution(w, h);
      if (!r) continue;
      expect(r.width).toBeGreaterThanOrEqual(2);
      expect(r.height).toBeGreaterThanOrEqual(2);
      expect(r.width % 2).toBe(0);
      expect(r.height % 2).toBe(0);
    }
  });

  it('returns null for degenerate and non-finite input rather than throwing', () => {
    expect(proxyResolution(0, 0)).toBeNull();
    expect(proxyResolution(-1920, 1080)).toBeNull();
    expect(proxyResolution(1920, -1)).toBeNull();
    expect(proxyResolution(NaN, 1080)).toBeNull();
    expect(proxyResolution(Infinity, 1080)).toBeNull();
  });

  it('always lands at or below the target long edge when it returns anything', () => {
    for (let w = PROXY_MIN_SOURCE_LONG_EDGE + 1; w <= 16000; w += 137) {
      const r = proxyResolution(w, Math.round(w * 9 / 16));
      if (r) expect(Math.max(r.width, r.height)).toBeLessThanOrEqual(PROXY_TARGET_LONG_EDGE);
    }
  });

  it('preserves aspect ratio within a pixel of rounding', () => {
    for (const [w, h] of [[3840, 2160], [4096, 1716], [2560, 1440], [6000, 4000]] as const) {
      const r = proxyResolution(w, h)!;
      expect(r.width / r.height).toBeCloseTo(w / h, 1);
    }
  });
});

describe('proxyCodec — alpha decides the container', () => {
  it('uses H.264 in mp4 for opaque footage', () => {
    expect(proxyCodec(false)).toEqual({ ext: 'mp4', mime: 'video/mp4' });
  });

  it('uses VP9 in WebM for alpha footage, because yuv420p would flatten the matte', () => {
    expect(proxyCodec(true)).toEqual({ ext: 'webm', mime: 'video/webm' });
  });
});

describe('proxyEncodeArgs — time alignment is a property of the encode', () => {
  const args = proxyEncodeArgs('in.mov', 'out.mp4', { width: 1920, height: 1080 }, false);

  it('carries NO timing flags, so the proxy is a 1:1 transcode', () => {
    // This is what makes "proxy and source stay time-aligned" structural. A -ss,
    // -t or -r here would silently shift or resample every frame.
    for (const flag of ['-ss', '-t', '-to', '-r', '-vsync', '-itsscale', '-filter:v']) {
      expect(args).not.toContain(flag);
    }
  });

  it('scales to exactly the requested size', () => {
    expect(args).toContain('scale=1920:1080');
  });

  it('uses a short GOP — seek cost is decode-from-keyframe cost', () => {
    expect(args[args.indexOf('-g') + 1]).toBe('12');
  });

  it('drops audio, because the AudioEngine always reads the original', () => {
    expect(args).toContain('-an');
  });

  it('encodes alpha sources to VP9 yuva420p instead', () => {
    const a = proxyEncodeArgs('in.mov', 'out.webm', { width: 960, height: 540 }, true);
    expect(a).toContain('libvpx-vp9');
    expect(a).toContain('yuva420p');
    expect(a).not.toContain('libx264');
  });

  it('writes the output path last, where ffmpeg expects it', () => {
    expect(args[args.length - 1]).toBe('out.mp4');
  });
});

describe('resolveMediaSrc — every state, because this one can damage output', () => {
  const ORIGINAL = 'blob:original';
  const PROXY = 'blob:proxy';
  const ready: ProxyRecord = { status: 'ready', src: PROXY, width: 960, height: 540 };

  it('returns the proxy only when opted in AND ready', () => {
    expect(resolveMediaSrc({ src: ORIGINAL, proxy: ready }, true)).toBe(PROXY);
  });

  it('returns the ORIGINAL when not opted in, even with a ready proxy — the export invariant', () => {
    expect(resolveMediaSrc({ src: ORIGINAL, proxy: ready }, false)).toBe(ORIGINAL);
  });

  it('falls back to the original while a proxy is still generating', () => {
    expect(resolveMediaSrc({ src: ORIGINAL, proxy: { status: 'generating' } }, true)).toBe(ORIGINAL);
  });

  it('falls back to the original when generation failed', () => {
    const failed: ProxyRecord = { status: 'failed', error: 'ffmpeg exited 1' };
    expect(resolveMediaSrc({ src: ORIGINAL, proxy: failed }, true)).toBe(ORIGINAL);
  });

  it("falls back when the record says ready but the src is gone — a deleted proxy file must not render black", () => {
    expect(resolveMediaSrc({ src: ORIGINAL, proxy: { status: 'ready' } }, true)).toBe(ORIGINAL);
    expect(resolveMediaSrc({ src: ORIGINAL, proxy: { status: 'ready', src: '' } }, true)).toBe(ORIGINAL);
  });

  it('falls back when there is no proxy record at all', () => {
    expect(resolveMediaSrc({ src: ORIGINAL }, true)).toBe(ORIGINAL);
  });

  it('passes an absent original through rather than inventing one', () => {
    expect(resolveMediaSrc({}, true)).toBeUndefined();
    expect(resolveMediaSrc({}, false)).toBeUndefined();
  });

  it('NEVER returns the proxy with useProxies false, across every record shape', () => {
    const records: (ProxyRecord | undefined)[] = [
      undefined,
      { status: 'generating' },
      { status: 'failed', error: 'x' },
      { status: 'ready', src: PROXY },
      { status: 'ready', src: PROXY, userSupplied: true },
    ];
    for (const proxy of records) {
      expect(resolveMediaSrc({ src: ORIGINAL, ...(proxy ? { proxy } : {}) }, false)).toBe(ORIGINAL);
    }
  });
});

describe('isProxyInUse — what the UI badges', () => {
  it('is true only when a proxy is actually being decoded', () => {
    const ready: ProxyRecord = { status: 'ready', src: 'blob:p' };
    expect(isProxyInUse({ src: 'blob:o', proxy: ready }, true)).toBe(true);
    expect(isProxyInUse({ src: 'blob:o', proxy: ready }, false)).toBe(false);
    expect(isProxyInUse({ src: 'blob:o', proxy: { status: 'generating' } }, true)).toBe(false);
    expect(isProxyInUse({ src: 'blob:o' }, true)).toBe(false);
  });

  it('agrees with resolveMediaSrc — a badge that disagrees with the pixels is worse than none', () => {
    const cases: ProxyRecord[] = [
      { status: 'ready', src: 'blob:p' },
      { status: 'ready' },
      { status: 'generating' },
      { status: 'failed', error: 'x' },
    ];
    for (const proxy of cases) {
      for (const on of [true, false]) {
        const asset = { src: 'blob:o', proxy };
        expect(isProxyInUse(asset, on)).toBe(resolveMediaSrc(asset, on) !== 'blob:o');
      }
    }
  });
});

describe('isPersistableProxy — only records that survive a reload are stored', () => {
  it('a blob-backed ready proxy is NOT persistable (the blob url dies with the session)', () => {
    // Both generated and user-attached proxies use URL.createObjectURL, so this
    // is every ready proxy the app makes today. Persisting one restores a dead
    // url that resolveMediaSrc would hand to the decoder instead of falling back.
    expect(isPersistableProxy({ status: 'ready', src: 'blob:proxy' })).toBe(false);
    expect(isPersistableProxy({ status: 'ready', src: 'blob:proxy', userSupplied: true })).toBe(false);
    expect(isPersistableProxy({ status: 'ready', src: 'data:video/mp4;base64,AAAA' })).toBe(false);
  });

  it('a ready proxy on a durable url (e.g. cloud-hosted) IS persistable', () => {
    expect(isPersistableProxy({ status: 'ready', src: 'https://cdn/x.mp4' })).toBe(true);
  });

  it('a ready record with no src at all is not persistable', () => {
    expect(isPersistableProxy({ status: 'ready' })).toBe(false);
  });

  it('generating is never persistable — its ffmpeg child dies with the app', () => {
    expect(isPersistableProxy({ status: 'generating' })).toBe(false);
  });

  it('failed is persistable — it is just an error, no url to go stale', () => {
    expect(isPersistableProxy({ status: 'failed', error: 'x' })).toBe(true);
  });

  it('absent record is not persistable', () => {
    expect(isPersistableProxy(undefined)).toBe(false);
    expect(isPersistableProxy(null)).toBe(false);
  });

  it('a restored dead-blob ready record would mis-decode — which is why it is dropped', () => {
    // If a blob-ready record HAD been persisted, resolveMediaSrc(on) returns the
    // dead blob rather than the original. This is the exact damage the drop
    // prevents; asserting it here pins WHY the persistence gate exists.
    const dead: ProxyRecord = { status: 'ready', src: 'blob:dead' };
    expect(resolveMediaSrc({ src: 'blob:original', proxy: dead }, true)).toBe('blob:dead');
    expect(isPersistableProxy(dead)).toBe(false); // ...so it never reaches storage
  });
});
