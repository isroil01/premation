import { fetchAssetSrc, localBlobRef, setLocalBlobResolver } from './localBlobSource';

/**
 * A `motion-blob:<hash>` ref is an identity, not a URL. The audio engine, the
 * beat grid, the proxy generator and four analysis features fetched it raw: the
 * CSP refused it, and footage inside a saved `.motion` bundle came back SILENT
 * after a reopen (seen in the desktop app on the 60 s film's score).
 */
describe('fetchAssetSrc', () => {
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  beforeEach(() => {
    calls.length = 0;
    globalThis.fetch = (async (u: string) => { calls.push(String(u)); return { ok: true } as Response; }) as typeof fetch;
    URL.createObjectURL = (() => 'blob:resolved') as typeof URL.createObjectURL;
  });
  afterEach(() => { globalThis.fetch = realFetch; setLocalBlobResolver(null); });

  it('resolves a bundle ref to its object URL and never fetches the ref itself', async () => {
    setLocalBlobResolver(async () => new Uint8Array([1, 2, 3]));
    await fetchAssetSrc(localBlobRef('a'.repeat(64)));
    expect(calls).toEqual(['blob:resolved']);
  });

  it('passes an ordinary URL straight through', async () => {
    await fetchAssetSrc('https://example.com/clip.mp4');
    expect(calls).toEqual(['https://example.com/clip.mp4']);
  });

  it('fails loudly when the bundle has no such blob, rather than fetching the ref', async () => {
    setLocalBlobResolver(async () => null);
    await expect(fetchAssetSrc(localBlobRef('b'.repeat(64)))).rejects.toThrow(/local blob not found/);
    expect(calls).toEqual([]);
  });
});
