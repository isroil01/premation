import { trackSpan, reverseTracks, easeTracks, stretchTracks, shiftTracks } from './keyframeAssistants';
import { resolveRelativeTracks, type PresetTrack } from './animationPresets';
import { EASY_EASE_BEZIER } from '@motion/animation';

const tracks: PresetTrack[] = [
  { prop: 'x', keyframes: [{ t: 1, value: 0 }, { t: 2, value: 100 }] },
  { prop: 'opacity', keyframes: [{ t: 1.5, value: 0 }, { t: 3, value: 100 }] },
];

describe('trackSpan', () => {
  it('finds the overall min/max across tracks', () => {
    expect(trackSpan(tracks)).toEqual({ min: 1, max: 3 });
  });

  it('is null for empty tracks', () => {
    expect(trackSpan([])).toBeNull();
    expect(trackSpan([{ prop: 'x', keyframes: [] }])).toBeNull();
  });
});

describe('reverseTracks', () => {
  it('mirrors times within the overall span and re-sorts', () => {
    const r = reverseTracks(tracks);
    // span [1,3]: t'=1+3-t → x: 1→3, 2→2; opacity: 1.5→2.5, 3→1
    expect(r[0]!.keyframes.map((k) => k.t)).toEqual([2, 3]);
    expect(r[0]!.keyframes.map((k) => k.value)).toEqual([100, 0]); // order flipped
    expect(r[1]!.keyframes.map((k) => k.t)).toEqual([1, 2.5]);
  });

  it('a double reverse restores the original', () => {
    const twice = reverseTracks(reverseTracks(tracks));
    expect(twice[0]!.keyframes.map((k) => [k.t, k.value])).toEqual([[1, 0], [2, 100]]);
  });
});

describe('easeTracks', () => {
  it('sets easy-ease bezier on every keyframe', () => {
    const e = easeTracks(tracks);
    for (const t of e) {
      for (const k of t.keyframes) {
        expect(k.easing).toBe('bezier');
        expect(k.bezier).toEqual(EASY_EASE_BEZIER);
      }
    }
  });
});

describe('stretchTracks', () => {
  it('scales timing around the span start', () => {
    const s = stretchTracks(tracks, 2);
    // span starts at 1: t'=1+(t-1)*2 → x: 1,3; opacity: 2,5
    expect(s[0]!.keyframes.map((k) => k.t)).toEqual([1, 3]);
    expect(s[1]!.keyframes.map((k) => k.t)).toEqual([2, 5]);
  });

  it('ignores non-positive factors', () => {
    expect(stretchTracks(tracks, 0)[0]!.keyframes.map((k) => k.t)).toEqual([1, 2]);
  });
});

describe('shiftTracks', () => {
  it('offsets every keyframe time', () => {
    const s = shiftTracks(tracks, 0.5);
    expect(s[0]!.keyframes.map((k) => k.t)).toEqual([1.5, 2.5]);
  });
});

describe('resolveRelativeTracks', () => {
  it('adds the layer base to relative keyframe values', () => {
    const rel: PresetTrack[] = [
      { prop: 'x', relative: true, keyframes: [{ t: 0, value: -400 }, { t: 0.6, value: 0 }] },
    ];
    const r = resolveRelativeTracks(rel, () => 960);
    expect(r[0]!.keyframes.map((k) => k.value)).toEqual([560, 960]);
  });

  it('leaves absolute tracks untouched and uses defaults when base unknown', () => {
    const mixed: PresetTrack[] = [
      { prop: 'opacity', keyframes: [{ t: 0, value: 0 }] },
      { prop: 'scale', relative: true, keyframes: [{ t: 0, value: 0.5 }] },
    ];
    const r = resolveRelativeTracks(mixed, () => undefined);
    expect(r[0]!.keyframes[0]!.value).toBe(0); // absolute untouched
    expect(r[1]!.keyframes[0]!.value).toBe(1.5); // default scale base 1 + 0.5
  });
});
