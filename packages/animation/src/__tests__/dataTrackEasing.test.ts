/**
 * Easing on NON-SCALAR tracks.
 *
 * Gradient stops, mask outlines and baked shape paths were interpolated
 * strictly linearly — the one family of animatable properties in the editor
 * that could not be eased at all. These pin that they now carry the same
 * temporal curve the scalar tracks do, and that an untouched track samples
 * exactly as it did before easing existed.
 */

import { sampleDataTrack, upsertDataKeyframe, type DataTrack, type GradientStop } from '../dataTracks';
import { AnimationEngine } from '../AnimationEngine';

const numTrack = (easing?: 'linear' | 'ease' | 'easeIn' | 'easeOut' | 'hold' | 'bezier'): DataTrack => ({
  nodeId: 'n',
  prop: 'p',
  kind: 'number',
  keyframes: [
    { t: 0, value: 0, ...(easing ? { easing } : {}) },
    { t: 1, value: 100 },
  ],
});

describe('data-track easing', () => {
  it('is linear by default — untouched tracks are unchanged', () => {
    const track = numTrack();
    expect(sampleDataTrack(track, 0.25)).toBeCloseTo(25, 6);
    expect(sampleDataTrack(track, 0.5)).toBeCloseTo(50, 6);
    expect(sampleDataTrack(track, 0.75)).toBeCloseTo(75, 6);
  });

  it('easeIn starts slow', () => {
    // t² at the midpoint is 0.25, not 0.5.
    expect(sampleDataTrack(numTrack('easeIn'), 0.5)).toBeCloseTo(25, 6);
  });

  it('easeOut starts fast', () => {
    expect(sampleDataTrack(numTrack('easeOut'), 0.5)).toBeCloseTo(75, 6);
  });

  it('hold stops interpolation outright', () => {
    const track = numTrack('hold');
    expect(sampleDataTrack(track, 0.01)).toBe(0);
    expect(sampleDataTrack(track, 0.99)).toBe(0);
    // The next keyframe still takes over at its own time.
    expect(sampleDataTrack(track, 1)).toBe(100);
  });

  it('honours explicit bezier handles', () => {
    const track: DataTrack = {
      nodeId: 'n', prop: 'p', kind: 'number',
      keyframes: [
        { t: 0, value: 0, easing: 'bezier', bezier: [0.42, 0, 0.58, 1] },
        { t: 1, value: 100 },
      ],
    };
    // A symmetric ease still passes through the midpoint...
    expect(sampleDataTrack(track, 0.5)).toBeCloseTo(50, 1);
    //...but lags a linear ramp early on.
    expect(sampleDataTrack(track, 0.25)!).toBeLessThan(25);
  });

  it('eases the ENDPOINTS identically to linear (the curve only bends between)', () => {
    for (const e of ['easeIn', 'easeOut', 'ease'] as const) {
      expect(sampleDataTrack(numTrack(e), 0)).toBe(0);
      expect(sampleDataTrack(numTrack(e), 1)).toBe(100);
    }
  });

  it('eases gradient stops — position AND colour follow the same curve', () => {
    const stops = (pos: number, color: string): GradientStop[] => [{ pos, color }];
    const track: DataTrack = {
      nodeId: 'n', prop: 'fill.stops', kind: 'gradientStops',
      keyframes: [
        { t: 0, value: stops(0, '#000000'), easing: 'easeIn' },
        { t: 1, value: stops(1, '#ffffff') },
      ],
    };
    const mid = sampleDataTrack(track, 0.5) as GradientStop[];
    expect(mid[0]!.pos).toBeCloseTo(0.25, 6);
    // 0.25 of the way from black to white ≈ 0x40.
    expect(mid[0]!.color.toLowerCase()).toBe('#404040');
  });

  it('eases path points', () => {
    const track: DataTrack = {
      nodeId: 'n', prop: 'path.points', kind: 'points',
      keyframes: [
        { t: 0, value: [{ x: 0, y: 0 }], easing: 'easeIn' },
        { t: 1, value: [{ x: 100, y: 0 }] },
      ],
    };
    const mid = sampleDataTrack(track, 0.5) as Array<{ x: number }>;
    expect(mid[0]!.x).toBeCloseTo(25, 6);
  });

  it('leaves text on hold regardless of easing — a string cannot tween', () => {
    const track: DataTrack = {
      nodeId: 'n', prop: 'text.source', kind: 'text',
      keyframes: [
        { t: 0, value: 'A', easing: 'easeOut' },
        { t: 1, value: 'B' },
      ],
    };
    expect(sampleDataTrack(track, 0.99)).toBe('A');
  });
});

describe('upsertDataKeyframe preserves the curve', () => {
  it('re-keying a value keeps the existing easing', () => {
    const kfs = upsertDataKeyframe([], { t: 0, value: 1, easing: 'easeIn' });
    const next = upsertDataKeyframe(kfs, { t: 0, value: 2 });
    expect(next[0]!.value).toBe(2);
    expect(next[0]!.easing).toBe('easeIn');
  });

  it('an explicit easing still wins', () => {
    const kfs = upsertDataKeyframe([], { t: 0, value: 1, easing: 'easeIn' });
    expect(upsertDataKeyframe(kfs, { t: 0, value: 1, easing: 'easeOut' })[0]!.easing).toBe('easeOut');
  });
});

describe('AnimationEngine — data easing survives the round trip', () => {
  it('setDataEasing changes how the track samples', () => {
    const e = new AnimationEngine();
    e.setDataKeyframe('n', 'p', 'number', 0, 0);
    e.setDataKeyframe('n', 'p', 'number', 1, 100);
    expect(e.sampleData('n', 'p', 0.5)).toBeCloseTo(50, 6);
    e.setDataEasing('n', 'p', 0, 'easeIn');
    expect(e.sampleData('n', 'p', 0.5)).toBeCloseTo(25, 6);
  });

  it('easing is carried through snapshot/restore (undo must not flatten it)', () => {
    const e = new AnimationEngine();
    e.setDataKeyframe('n', 'p', 'number', 0, 0, 'easeIn');
    e.setDataKeyframe('n', 'p', 'number', 1, 100);
    const snap = e.snapshot();

    const other = new AnimationEngine();
    other.restore(snap);
    expect(other.sampleData('n', 'p', 0.5)).toBeCloseTo(25, 6);
  });

  it('easing is carried through getDataTrack / setDataTrack', () => {
    const e = new AnimationEngine();
    e.setDataKeyframe('n', 'p', 'number', 0, 0, 'easeOut');
    e.setDataKeyframe('n', 'p', 'number', 1, 100);
    const copy = e.getDataTrack('n', 'p')!;
    const other = new AnimationEngine();
    other.setDataTrack('n', 'p', copy);
    expect(other.sampleData('n', 'p', 0.5)).toBeCloseTo(75, 6);
  });

  it('setDataKeyframe without easing does not flatten an existing curve', () => {
    const e = new AnimationEngine();
    e.setDataKeyframe('n', 'p', 'number', 0, 0, 'easeIn');
    e.setDataKeyframe('n', 'p', 'number', 1, 100);
    e.setDataKeyframe('n', 'p', 'number', 0, 10); // value edit only
    expect(e.sampleData('n', 'p', 0.5)).toBeCloseTo(10 + 0.25 * 90, 6);
  });
});
