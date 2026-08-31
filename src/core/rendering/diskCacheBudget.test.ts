/**
 * The disk budget is the user's, and it is persisted JSON.
 *
 * Which means it can come back as anything — a hand-edited store, a value from
 * a build that used different units, a `null` from a half-written write. The
 * clamp is what stands between that and a tier that either holds nothing (worse
 * than no cache: it pays every write and serves nothing) or asks for more than
 * the browser will grant and gets evicted wholesale by the quota manager.
 */

import {
  previewDiskCacheBytes,
  PREVIEW_DISK_MIN_GB,
  PREVIEW_DISK_MAX_GB,
  usePreferenceStore,
} from '@stores/preferenceStore';

const GB = 1024 * 1024 * 1024;
const setGb = (v: unknown): void => {
  usePreferenceStore.setState({ previewDiskCacheGb: v as number });
};

afterEach(() => setGb(4));

describe('previewDiskCacheBytes', () => {
  it('honours a sensible value', () => {
    setGb(8);
    expect(previewDiskCacheBytes()).toBe(8 * GB);
    setGb(1.5);
    expect(previewDiskCacheBytes()).toBe(Math.round(1.5 * GB));
  });

  it('defaults to the budget the tier used before it was configurable', () => {
    // Nobody's cache changes size by upgrading.
    setGb(4);
    expect(previewDiskCacheBytes()).toBe(4 * GB);
  });

  it('clamps below the floor rather than building a tier that cannot serve', () => {
    setGb(0);
    expect(previewDiskCacheBytes()).toBe(Math.round(PREVIEW_DISK_MIN_GB * GB));
    setGb(-100);
    expect(previewDiskCacheBytes()).toBe(Math.round(PREVIEW_DISK_MIN_GB * GB));
  });

  it('clamps above the ceiling rather than inviting a quota eviction', () => {
    setGb(10_000);
    expect(previewDiskCacheBytes()).toBe(PREVIEW_DISK_MAX_GB * GB);
  });

  it('survives a store that came back as nonsense', () => {
    for (const junk of [NaN, Infinity, undefined, null, 'lots']) {
      setGb(junk);
      const bytes = previewDiskCacheBytes();
      expect(Number.isFinite(bytes)).toBe(true);
      expect(bytes).toBeGreaterThanOrEqual(PREVIEW_DISK_MIN_GB * GB);
      expect(bytes).toBeLessThanOrEqual(PREVIEW_DISK_MAX_GB * GB);
    }
  });

  it('always returns a whole number of bytes', () => {
    for (const v of [0.75, 1.3, 7.7, 63.9]) {
      setGb(v);
      expect(Number.isInteger(previewDiskCacheBytes())).toBe(true);
    }
  });
});
