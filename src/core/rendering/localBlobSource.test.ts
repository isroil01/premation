/**
 * localBlobSource — the `motion-blob:<hash>` render reference resolves to an
 * object URL via the injected byte resolver, and is a no-op when unset.
 */

import {
  isLocalBlobRef,
  localBlobRef,
  loadLocalBlobObjectUrl,
  setLocalBlobResolver,
  LOCAL_BLOB_SCHEME,
} from './localBlobSource';

afterEach(() => setLocalBlobResolver(null));

describe('ref helpers', () => {
  it('builds and recognizes a local blob ref', () => {
    const ref = localBlobRef('deadbeef');
    expect(ref).toBe(`${LOCAL_BLOB_SCHEME}deadbeef`);
    expect(isLocalBlobRef(ref)).toBe(true);
    expect(isLocalBlobRef('https://x/y.png')).toBe(false);
    expect(isLocalBlobRef('data:image/png;base64,AAA')).toBe(false);
  });
});

describe('loadLocalBlobObjectUrl', () => {
  it('returns null without a resolver', async () => {
    expect(await loadLocalBlobObjectUrl(localBlobRef('abc'))).toBeNull();
  });

  it('returns null for a non-blob ref', async () => {
    setLocalBlobResolver(async () => new Uint8Array([1]));
    expect(await loadLocalBlobObjectUrl('https://x/y.png')).toBeNull();
  });

  it('resolves bytes to an object URL and passes the hash through', async () => {
    const seen: string[] = [];
    setLocalBlobResolver(async (hash) => {
      seen.push(hash);
      return new Uint8Array([1, 2, 3]);
    });
    const created: string[] = [];
    const origCreate = URL.createObjectURL;
    (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => {
      const u = 'blob:mock-url';
      created.push(u);
      return u;
    };
    try {
      const url = await loadLocalBlobObjectUrl(localBlobRef('cafef00d'));
      expect(url).toBe('blob:mock-url');
      expect(seen).toEqual(['cafef00d']);
      expect(created).toHaveLength(1);
    } finally {
      (URL as unknown as { createObjectURL: typeof origCreate }).createObjectURL = origCreate;
    }
  });

  it('returns null when the resolver has no such blob', async () => {
    setLocalBlobResolver(async () => null);
    expect(await loadLocalBlobObjectUrl(localBlobRef('missing'))).toBeNull();
  });
});
