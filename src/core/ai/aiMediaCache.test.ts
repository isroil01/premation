/**
 * The generation cache: the same request reuses its asset while the library
 * still holds it, and only the parts that decide the pixels make the key.
 */

import { cachedAsset, clearGenerationCache, generationKey, rememberAsset } from './aiMediaCache';

beforeEach(() => clearGenerationCache());

describe('aiMediaCache', () => {
  it('answers the same request with the same asset', () => {
    const k = generationKey({ kind: 'video', prompt: 'mist over pines', model: 'preview/placeholder', aspect: 'landscape', durationSec: 5 });
    rememberAsset(k, 'asset_1');
    expect(cachedAsset(generationKey({ kind: 'video', prompt: '  mist over pines ', model: 'preview/placeholder', aspect: 'landscape', durationSec: 5 }), () => true)).toBe('asset_1');
  });

  it('treats a different model, length, aspect or kind as a different request', () => {
    rememberAsset(generationKey({ kind: 'video', prompt: 'p', model: 'a', durationSec: 5 }), 'x');
    for (const other of [
      { kind: 'video' as const, prompt: 'p', model: 'b', durationSec: 5 },
      { kind: 'video' as const, prompt: 'p', model: 'a', durationSec: 6 },
      { kind: 'video' as const, prompt: 'p', model: 'a', durationSec: 5, aspect: 'portrait' },
      { kind: 'image' as const, prompt: 'p', model: 'a', durationSec: 5 },
    ]) expect(cachedAsset(generationKey(other), () => true)).toBeUndefined();
  });

  it('forgets an asset the library no longer has', () => {
    const k = generationKey({ kind: 'image', prompt: 'p' });
    rememberAsset(k, 'gone');
    expect(cachedAsset(k, () => false)).toBeUndefined();
    expect(cachedAsset(k, () => true)).toBeUndefined();
  });

  it('keeps the most recent entries when it is full', () => {
    for (let i = 0; i < 210; i++) rememberAsset(generationKey({ kind: 'image', prompt: `p${i}` }), `a${i}`);
    expect(cachedAsset(generationKey({ kind: 'image', prompt: 'p0' }), () => true)).toBeUndefined();
    expect(cachedAsset(generationKey({ kind: 'image', prompt: 'p209' }), () => true)).toBe('a209');
  });
});
