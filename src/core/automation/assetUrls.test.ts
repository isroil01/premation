import { isAllowedAssetUrl, guessAssetKind } from './assetUrls';

describe('isAllowedAssetUrl', () => {
  it('accepts public https', () => {
    expect(isAllowedAssetUrl('https://cdn.example.com/anime.png')).toBe(true);
    expect(isAllowedAssetUrl('http://example.com/cooking.mp4')).toBe(true);
  });

  it('rejects private and loopback hosts', () => {
    expect(isAllowedAssetUrl('http://127.0.0.1/secret.png')).toBe(false);
    expect(isAllowedAssetUrl('http://localhost/x')).toBe(false);
    expect(isAllowedAssetUrl('http://10.0.0.4/x')).toBe(false);
    expect(isAllowedAssetUrl('http://192.168.1.9/x')).toBe(false);
    expect(isAllowedAssetUrl('http://169.254.169.254/latest/meta-data')).toBe(false);
    expect(isAllowedAssetUrl('http://172.16.0.1/x')).toBe(false);
  });

  it('rejects non-http schemes', () => {
    expect(isAllowedAssetUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedAssetUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedAssetUrl('not a url')).toBe(false);
  });
});

describe('guessAssetKind', () => {
  it('reads the path, not the query', () => {
    expect(guessAssetKind('https://x/a.png?token=1')).toBe('image');
    expect(guessAssetKind('https://x/a.mp4')).toBe('video');
    expect(guessAssetKind('https://x/a.mp3')).toBe('audio');
    expect(guessAssetKind('https://x/a')).toBe('unknown');
  });
});
