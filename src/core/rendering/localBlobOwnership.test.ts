/**
 * Object-URL ownership for `motion-blob:` refs.
 *
 * The audit that prompted this found NO leak at the original call site — the
 * one caller revoked in a `finally`. What it found instead was a contract that
 * could not serve more than one consumer: a fresh URL per call re-read the
 * whole file every time, and a URL the caller must revoke "once decoded" is
 * unusable by a `<video>` element, which holds its URL for as long as it lives.
 *
 * So these tests pin the two properties that replaced it: one URL per content
 * hash, and a revoke that waits for the last holder.
 */

import {
  localBlobRef,
  setLocalBlobResolver,
  resolveLocalBlobObjectUrl,
  peekLocalBlobObjectUrl,
  retainLocalBlobObjectUrl,
  releaseLocalBlobObjectUrl,
  resetLocalBlobObjectUrls,
  localBlobUrlStats,
  attachVideoSrc,
  detachVideoSrc,
} from './localBlobSource';

let created: string[];
let revoked: string[];
let origCreate: typeof URL.createObjectURL;
let origRevoke: typeof URL.revokeObjectURL;

beforeEach(() => {
  created = [];
  revoked = [];
  origCreate = URL.createObjectURL;
  origRevoke = URL.revokeObjectURL;
  let n = 0;
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => {
    const u = `blob:mock-${++n}`;
    created.push(u);
    return u;
  };
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = (u) => {
    revoked.push(u);
  };
});

afterEach(() => {
  resetLocalBlobObjectUrls();
  setLocalBlobResolver(null);
  (URL as unknown as { createObjectURL: typeof origCreate }).createObjectURL = origCreate;
  (URL as unknown as { revokeObjectURL: typeof origRevoke }).revokeObjectURL = origRevoke;
});

describe('one URL per content hash', () => {
  it('resolving the same ref twice mints ONE object URL', async () => {
    let reads = 0;
    setLocalBlobResolver(async () => { reads += 1; return new Uint8Array([1, 2, 3]); });
    const ref = localBlobRef('cafef00d');

    const a = await resolveLocalBlobObjectUrl(ref);
    const b = await resolveLocalBlobObjectUrl(ref);

    expect(a).toBe(b);
    expect(created).toHaveLength(1);
    // And the bytes are read off disk once, not once per consumer.
    expect(reads).toBe(1);
  });

  it('two SIMULTANEOUS resolves still mint one', async () => {
    setLocalBlobResolver(async () => new Uint8Array([1]));
    const ref = localBlobRef('abc');
    const [a, b] = await Promise.all([
      resolveLocalBlobObjectUrl(ref),
      resolveLocalBlobObjectUrl(ref),
    ]);
    expect(a).toBe(b);
    expect(created).toHaveLength(1);
  });

  it('different hashes get different URLs', async () => {
    setLocalBlobResolver(async () => new Uint8Array([1]));
    const a = await resolveLocalBlobObjectUrl(localBlobRef('one'));
    const b = await resolveLocalBlobObjectUrl(localBlobRef('two'));
    expect(a).not.toBe(b);
    expect(created).toHaveLength(2);
  });

  it('a missing blob resolves to null and mints nothing', async () => {
    setLocalBlobResolver(async () => null);
    expect(await resolveLocalBlobObjectUrl(localBlobRef('gone'))).toBeNull();
    expect(created).toEqual([]);
  });
});

describe('release waits for the last holder', () => {
  it('eviction revokes exactly once per resolved ref', async () => {
    setLocalBlobResolver(async () => new Uint8Array([1]));
    const ref = localBlobRef('abc');
    await resolveLocalBlobObjectUrl(ref, 'exact:abc');

    expect(releaseLocalBlobObjectUrl(ref, 'exact:abc')).toBe(true);
    expect(revoked).toEqual(['blob:mock-1']);

    // A second eviction of the same ref must not revoke a URL that no longer
    // exists — a double revoke is silent, and silent is how this class of bug
    // survives.
    expect(releaseLocalBlobObjectUrl(ref, 'exact:abc')).toBe(false);
    expect(revoked).toHaveLength(1);
  });

  it('never revokes a ref a live element still holds', async () => {
    setLocalBlobResolver(async () => new Uint8Array([1]));
    const ref = localBlobRef('abc');
    await resolveLocalBlobObjectUrl(ref, 'exact:abc');
    retainLocalBlobObjectUrl(ref, 'element:abc');

    // The exact decoder is idle-evicted at 90s while the fallback element is
    // still seeking through the same asset.
    expect(releaseLocalBlobObjectUrl(ref, 'exact:abc')).toBe(false);
    expect(revoked).toEqual([]);
    expect(peekLocalBlobObjectUrl(ref)).toBe('blob:mock-1');

    // Only when the element goes too.
    expect(releaseLocalBlobObjectUrl(ref, 'element:abc')).toBe(true);
    expect(revoked).toEqual(['blob:mock-1']);
  });

  it('re-resolving after a revoke mints a fresh URL', async () => {
    setLocalBlobResolver(async () => new Uint8Array([1]));
    const ref = localBlobRef('abc');
    await resolveLocalBlobObjectUrl(ref, 'h');
    releaseLocalBlobObjectUrl(ref, 'h');
    const again = await resolveLocalBlobObjectUrl(ref, 'h');
    // A revoked URL is dead; handing it back would be a black frame.
    expect(again).toBe('blob:mock-2');
    expect(created).toHaveLength(2);
  });

  it('reports its holders', async () => {
    setLocalBlobResolver(async () => new Uint8Array([1]));
    await resolveLocalBlobObjectUrl(localBlobRef('abc'), 'exact:abc');
    retainLocalBlobObjectUrl(localBlobRef('abc'), 'element:abc');
    const stats = localBlobUrlStats();
    expect(stats.urls).toBe(1);
    expect(stats.holders.abc!.slice().sort()).toEqual(['element:abc', 'exact:abc']);
  });
});

/** Let every queued microtask AND the resolve chain's `.finally` run. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('attachVideoSrc', () => {
  const el = (): HTMLVideoElement =>
    ({ src: '', load: () => undefined } as unknown as HTMLVideoElement);

  it('assigns an ordinary URL synchronously', () => {
    const v = el();
    attachVideoSrc(v, 'https://example.test/clip.mp4');
    expect(v.src).toBe('https://example.test/clip.mp4');
  });

  it('resolves a motion-blob ref instead of assigning it verbatim', async () => {
    setLocalBlobResolver(async () => new Uint8Array([1]));
    const v = el();
    const ref = localBlobRef('abc');
    attachVideoSrc(v, ref);
    // Assigning the ref itself is what made every bundled clip fire `error`.
    expect(v.src).toBe('');
    await settle();
    expect(v.src).toBe('blob:mock-1');
    expect(localBlobUrlStats().holders.abc).toHaveLength(1);
  });

  it('does not re-arm an element torn down while the resolve was in flight', async () => {
    let release: (b: Uint8Array) => void = () => undefined;
    setLocalBlobResolver(() => new Promise((r) => { release = r as (b: Uint8Array) => void; }));
    const v = el();
    const ref = localBlobRef('abc');
    attachVideoSrc(v, ref);
    detachVideoSrc(v);
    release(new Uint8Array([1]));
    await settle();
    expect(v.src).toBe('');
  });

  it('reuses the cached URL synchronously once one exists', async () => {
    setLocalBlobResolver(async () => new Uint8Array([1]));
    const ref = localBlobRef('abc');
    await resolveLocalBlobObjectUrl(ref);
    const v = el();
    attachVideoSrc(v, ref);
    // No await: a warm asset must not make the element wait a microtask.
    expect(v.src).toBe('blob:mock-1');
    expect(created).toHaveLength(1);
  });
});

describe('the exact decoder tier owns its claim', () => {
  it('resolves a motion-blob ref rather than fetching it, and releases on teardown', async () => {
    setLocalBlobResolver(async () => new Uint8Array([1]));
    const ref = localBlobRef('abc');

    // The real loader is not reachable under jsdom (no WebCodecs, no fetch of
    // a blob: URL), so this exercises the same two calls the loader makes.
    const url = await resolveLocalBlobObjectUrl(ref, `exact:${ref}`);
    expect(url).toBe('blob:mock-1');
    // Before this, `fetch('motion-blob:…')` threw and the source went sticky
    // `unavailable` — with the element tier unable to open the ref either, a
    // clip carried inside a .motion bundle had no working tier at all.

    // A live element holds it too; the decoder's teardown must not revoke.
    const v = { src: '', load: () => undefined } as unknown as HTMLVideoElement;
    attachVideoSrc(v, ref);
    releaseLocalBlobObjectUrl(ref, `exact:${ref}`);
    expect(revoked).toEqual([]);

    detachVideoSrc(v);
    expect(revoked).toEqual(['blob:mock-1']);
  });
});

describe('two elements on the same source hold independently', () => {
  it('releasing one does not revoke the URL the other is still using', async () => {
    setLocalBlobResolver(async () => new Uint8Array([1]));
    const ref = localBlobRef('shared');
    const mk = (): HTMLVideoElement =>
      ({ src: '', load: () => undefined } as unknown as HTMLVideoElement);

    // Two layers pointing at the same footage. A holder label derived from the
    // SRC would be one shared claim, and the first teardown would revoke the
    // URL out from under the second element.
    const a = mk();
    const b = mk();
    attachVideoSrc(a, ref);
    attachVideoSrc(b, ref);
    await settle();
    expect(a.src).toBe('blob:mock-1');
    expect(b.src).toBe('blob:mock-1');
    expect(localBlobUrlStats().holders.shared).toHaveLength(2);

    detachVideoSrc(a);
    expect(revoked).toEqual([]);
    expect(b.src).toBe('blob:mock-1');

    detachVideoSrc(b);
    expect(revoked).toEqual(['blob:mock-1']);
  });
});
