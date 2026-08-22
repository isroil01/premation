/**
 * Unit tests for piecewise time-remap audio segments.
 */

import type { SceneNode } from '@core/types';

const layerTimes: Record<string, { stretch?: number; reverse?: boolean; freeze?: boolean; freezeTime?: number }> = {};
const remapTracks: Record<string, Array<{ t: number; value: number }>> = {};

jest.mock('@core/scene/layerTime', () => ({
  readNodeLayerTime: (n: SceneNode) => layerTimes[n.id],
  DEFAULT_LAYER_TIME: { stretch: 100, reverse: false, freeze: false, freezeTime: 0, frameBlend: 'none' },
  remapTime: (t: number, cfg: { freeze?: boolean; freezeTime?: number; stretch?: number; reverse?: boolean }, span: { start: number; end: number }) => {
    if (cfg.freeze) return cfg.freezeTime ?? 0;
    const stretch = cfg.stretch && cfg.stretch > 0 ? cfg.stretch : 100;
    let s = span.start + (t - span.start) * (100 / stretch);
    if (cfg.reverse) s = span.start + span.end - s;
    return s;
  },
}));

jest.mock('@motion/animation', () => ({
  defaultAnimation: {
    isAnimated: (id: string, prop: string) =>
      (prop === 'timeRemap' || prop === 'precompTime') && !!remapTracks[id]?.length,
    sample: (id: string, prop: string, t: number) => {
      const kfs = remapTracks[id];
      if (!kfs?.length || (prop !== 'timeRemap' && prop !== 'precompTime')) return undefined;
      if (t <= kfs[0]!.t) return kfs[0]!.value;
      for (let i = 0; i < kfs.length - 1; i++) {
        const a = kfs[i]!;
        const b = kfs[i + 1]!;
        if (t <= b.t) {
          const u = (t - a.t) / (b.t - a.t || 1);
          return a.value + (b.value - a.value) * u;
        }
      }
      return kfs[kfs.length - 1]!.value;
    },
    timeSpan: () => ({ start: 0, end: 10 }),
  },
}));

import { buildAudioRetimeSegments, videoSourceTimeAt } from './audioRetimeSegments';

function node(id: string): SceneNode {
  return { id, name: id, components: [] } as unknown as SceneNode;
}

beforeEach(() => {
  for (const k of Object.keys(layerTimes)) delete layerTimes[k];
  for (const k of Object.keys(remapTracks)) delete remapTracks[k];
});

describe('audioRetimeSegments', () => {
  it('returns null when there is no time-remap track', () => {
    expect(buildAudioRetimeSegments(node('a'), { startSec: 0, inSec: 0, outSec: 2 }, 30)).toBeNull();
  });

  it('returns [] for freeze (silence)', () => {
    layerTimes.a = { freeze: true, freezeTime: 1.5 };
    remapTracks.a = [{ t: 0, value: 0 }, { t: 2, value: 4 }];
    expect(buildAudioRetimeSegments(node('a'), { startSec: 0, inSec: 0, outSec: 2 }, 30)).toEqual([]);
    expect(videoSourceTimeAt(node('a'), 1)).toBe(1.5);
  });

  it('builds ~2× rate segments for a linear 0→4 remap over 2s', () => {
    remapTracks.a = [{ t: 0, value: 0 }, { t: 2, value: 4 }];
    const segs = buildAudioRetimeSegments(node('a'), { startSec: 0, inSec: 0, outSec: 2 }, 10)!;
    expect(segs.length).toBeGreaterThanOrEqual(1);
    const wall = segs.reduce((s, g) => s + g.durationSec, 0);
    expect(wall).toBeCloseTo(2, 1);
    const avg =
      segs.reduce((s, g) => s + g.rate * g.durationSec, 0) / wall;
    expect(avg).toBeCloseTo(2, 0);
  });

  it('folds ancestor precomp remaps before the leaf remap', () => {
    // Outer precomp maps 1s wall → 2s inner; leaf is identity.
    remapTracks.pc = [{ t: 0, value: 0 }, { t: 1, value: 2 }];
    expect(videoSourceTimeAt(node('leaf'), 1, { ancestorIds: ['pc'] })).toBeCloseTo(2, 5);
    const segs = buildAudioRetimeSegments(
      node('leaf'),
      { startSec: 0, inSec: 0, outSec: 1 },
      10,
      { ancestorIds: ['pc'] },
    )!;
    expect(segs.length).toBeGreaterThanOrEqual(1);
    const wall = segs.reduce((s, g) => s + g.durationSec, 0);
    const avg = segs.reduce((s, g) => s + g.rate * g.durationSec, 0) / wall;
    expect(avg).toBeCloseTo(2, 0);
  });
});
