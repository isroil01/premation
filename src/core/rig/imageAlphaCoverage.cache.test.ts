/**
 * The puppet coverage-mask cache is bounded (LRU).
 *
 * It was keyed by asset id OR src with no ceiling, and an image sequence or a
 * relink mints a new src per frame / per relink — so every image ever meshed
 * stayed in memory for the session. An evicted mask costs one cheap 64² decode
 * next time; until it lands the mesh uses the bbox grid, exactly as on first
 * sight, so eviction never changes a settled frame.
 */

import {
  primeImageCoverageCache,
  getImageCoverageMask,
  clearImageCoverageCache,
  imageCoverageCacheSize,
} from './imageAlphaCoverage';
import type { PuppetCoverageMask } from './puppet';

const masks = Array.from({ length: 257 }, (_, i) => ({ tag: i }) as unknown as PuppetCoverageMask);

describe('image coverage cache', () => {
  beforeEach(() => clearImageCoverageCache());

  it('holds at most 256 masks, evicting the least recently used', () => {
    for (let i = 0; i < 256; i++) primeImageCoverageCache(`k${i}`, masks[i]!);
    expect(imageCoverageCacheSize()).toBe(256);
    // A hit refreshes recency, so k0 outlives k1. (An empty src never starts a
    // decode, so a miss here is a pure cache question.)
    expect(getImageCoverageMask('k0', '')).toBe(masks[0]);
    primeImageCoverageCache('k256', masks[256]!);
    expect(imageCoverageCacheSize()).toBe(256);
    expect(getImageCoverageMask('k0', '')).toBe(masks[0]);
    expect(getImageCoverageMask('k1', '')).toBeUndefined();
    expect(getImageCoverageMask('k256', '')).toBe(masks[256]);
  });
});
