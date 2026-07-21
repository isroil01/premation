/**
 * The setup catalog is the only thing standing between a user and an
 * unauthorable composition — the duration dropdown it replaced stopped at 60
 * seconds, so a two-minute video was literally impossible to create.
 */

import {
  SIZE_PRESETS, SIZE_GROUPS, FPS_PRESETS, DURATION_PRESETS,
  MAX_DURATION, MAX_DIMENSION, MIN_DIMENSION,
  clampDimension, clampFps, clampDuration,
  describeSize, describeDuration, findSizePreset,
} from './presets';

describe('size presets', () => {
  it('covers the platforms people actually publish to', () => {
    const labels = SIZE_PRESETS.map((p) => p.label.toLowerCase()).join(' ');
    for (const platform of ['instagram', 'tiktok', 'youtube', 'linkedin']) {
      expect(labels).toContain(platform);
    }
  });

  it('offers a big-screen tier beyond 1080p', () => {
    const big = SIZE_PRESETS.filter((p) => p.group === 'Big screen');
    expect(big.some((p) => p.width === 3840 && p.height === 2160)).toBe(true); // 4K
    expect(big.some((p) => p.width >= 4096)).toBe(true);                        // cinema/8K
  });

  it('every preset belongs to a declared group and is within the render limits', () => {
    for (const p of SIZE_PRESETS) {
      expect(SIZE_GROUPS).toContain(p.group);
      expect(p.width).toBeGreaterThanOrEqual(MIN_DIMENSION);
      expect(p.height).toBeGreaterThanOrEqual(MIN_DIMENSION);
      expect(p.width).toBeLessThanOrEqual(MAX_DIMENSION);
      expect(p.height).toBeLessThanOrEqual(MAX_DIMENSION);
    }
  });

  it('has no duplicate ids', () => {
    const ids = SIZE_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('matches a size back to its preset, and reports custom sizes as unknown', () => {
    expect(findSizePreset(1080, 1920)?.group).toBe('Social');
    expect(findSizePreset(1234, 567)).toBeUndefined();
  });
});

describe('frame rates', () => {
  it('keeps the fractional broadcast rates exact — rounding them is a sync bug', () => {
    const values = FPS_PRESETS.map((f) => f.value);
    expect(values).toContain(23.976);
    expect(values).toContain(29.97);
  });

  it('accepts a rate that is not in the list', () => {
    expect(clampFps(48)).toBe(48);
  });

  it('clamps nonsense instead of producing a broken comp', () => {
    expect(clampFps(0)).toBe(1);
    expect(clampFps(9999)).toBe(240);
    expect(clampFps(NaN)).toBe(30);
  });
});

describe('duration', () => {
  it('allows far past the old 60-second ceiling', () => {
    expect(MAX_DURATION).toBeGreaterThanOrEqual(3600);
    expect(clampDuration(600)).toBe(600);   // a 10-minute piece
    expect(clampDuration(3600)).toBe(3600); // an hour
  });

  it('offers presets on both sides of a minute', () => {
    const secs = DURATION_PRESETS.map((d) => d.seconds);
    expect(secs.some((s) => s < 60)).toBe(true);
    expect(secs.some((s) => s > 60)).toBe(true);
  });

  it('clamps to a sane range', () => {
    expect(clampDuration(0)).toBe(0.1);
    expect(clampDuration(999999)).toBe(MAX_DURATION);
  });
});

describe('dimensions', () => {
  it('clamps and rounds to whole pixels', () => {
    expect(clampDimension(1920.4)).toBe(1920);
    expect(clampDimension(0)).toBe(MIN_DIMENSION);
    expect(clampDimension(99999)).toBe(MAX_DIMENSION);
  });
});

describe('human-readable summaries', () => {
  it('reduces a size to its aspect ratio', () => {
    expect(describeSize(1920, 1080)).toBe('1920×1080 · 16:9');
    expect(describeSize(1080, 1920)).toBe('1080×1920 · 9:16');
  });

  it('reads long timelines in minutes, not raw seconds', () => {
    expect(describeDuration(45)).toBe('45s');
    expect(describeDuration(90)).toBe('1m 30s');
    expect(describeDuration(600)).toBe('10m');
  });
});
