/**
 * Data tracks — non-scalar keyframes (Source Text, path points, gradient
 * stops). Pins the per-kind interpolation rules, the engine CRUD surface, the
 * undo seam (get/setDataTrack round-trip) and snapshot/restore back-compat.
 */

import { AnimationEngine } from '../AnimationEngine';
import { sampleDataTrack, type DataTrack, type GradientStop, type DataPoint } from '../dataTracks';

describe('sampleDataTrack', () => {
  it('text holds (never tweens) and clamps at the ends', () => {
    const track: DataTrack = {
      nodeId: 'n', prop: 'text.source', kind: 'text',
      keyframes: [
        { t: 1, value: 'Hello' },
        { t: 2, value: 'World' },
      ],
    };
    expect(sampleDataTrack(track, 0)).toBe('Hello');
    expect(sampleDataTrack(track, 1)).toBe('Hello');
    expect(sampleDataTrack(track, 1.999)).toBe('Hello'); // hold — no tween
    expect(sampleDataTrack(track, 2)).toBe('World');
    expect(sampleDataTrack(track, 99)).toBe('World');
  });

  it('points lerp pairwise, including bezier handles', () => {
    const a: DataPoint[] = [{ x: 0, y: 0, outX: 10, outY: 0 }, { x: 100, y: 0 }];
    const b: DataPoint[] = [{ x: 100, y: 100, outX: 20, outY: 10 }, { x: 200, y: 100 }];
    const track: DataTrack = {
      nodeId: 'n', prop: 'mask.path', kind: 'points',
      keyframes: [{ t: 0, value: a }, { t: 1, value: b }],
    };
    const mid = sampleDataTrack(track, 0.5) as DataPoint[];
    expect(mid[0]).toEqual({ x: 50, y: 50, outX: 15, outY: 5 });
    expect(mid[1]).toEqual({ x: 150, y: 50 });
  });

  it('points snap (hold) on degenerate (single-vertex) mismatch', () => {
    const track: DataTrack = {
      nodeId: 'n', prop: 'p', kind: 'points',
      keyframes: [
        { t: 0, value: [{ x: 0, y: 0 }] },
        { t: 1, value: [{ x: 10, y: 0 }, { x: 20, y: 0 }] },
      ],
    };
    expect((sampleDataTrack(track, 0.9) as DataPoint[]).length).toBe(1);
    expect((sampleDataTrack(track, 1) as DataPoint[]).length).toBe(2);
  });

  it('free-count morph: grows the shorter outline (shape-preserving) then lerps', () => {
    // A: 2 vertices (one straight segment). B: 3 vertices. Both >= 2 → morph.
    const a: DataPoint[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
    const b: DataPoint[] = [{ x: 0, y: 0 }, { x: 50, y: 50 }, { x: 100, y: 0 }];
    const track: DataTrack = {
      nodeId: 'n', prop: 'p', kind: 'points',
      keyframes: [{ t: 0, value: a }, { t: 1, value: b }],
    };
    // At u=0 the grown A must still describe A's straight line: the inserted
    // midpoint sits exactly halfway (de Casteljau split of a line), so count=3
    // but geometry is unchanged.
    const start = sampleDataTrack(track, 0) as DataPoint[]; // clamps to first kf (raw A)
    expect(start.length).toBe(2);
    const mid = sampleDataTrack(track, 0.5) as DataPoint[];
    expect(mid.length).toBe(3); // grown to match B
    // Grown-A midpoint = (50,0); B midpoint = (50,50); halfway = (50,25).
    expect(mid[1]!.x).toBeCloseTo(50);
    expect(mid[1]!.y).toBeCloseTo(25);
    // Endpoints are shared, so they interpolate to themselves.
    expect(mid[0]!.x).toBeCloseTo(0);
    expect(mid[2]!.x).toBeCloseTo(100);
  });

  it('gradient stops lerp positions and colors', () => {
    const a: GradientStop[] = [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ff0000' }];
    const b: GradientStop[] = [{ pos: 0.2, color: '#ffffff' }, { pos: 0.8, color: '#0000ff' }];
    const track: DataTrack = {
      nodeId: 'n', prop: 'fill.stops', kind: 'gradientStops',
      keyframes: [{ t: 0, value: a }, { t: 2, value: b }],
    };
    const mid = sampleDataTrack(track, 1) as GradientStop[];
    expect(mid[0]!.pos).toBeCloseTo(0.1);
    expect(mid[0]!.color).toBe('#808080');
    expect(mid[1]!.pos).toBeCloseTo(0.9);
    expect(mid[1]!.color).toBe('#800080');
  });
});

describe('AnimationEngine data-track surface', () => {
  let engine: AnimationEngine;
  beforeEach(() => {
    engine = new AnimationEngine();
  });

  it('set/sample/move/remove round-trips', () => {
    engine.setDataKeyframe('n1', 'text.source', 'text', 0, 'One');
    engine.setDataKeyframe('n1', 'text.source', 'text', 2, 'Two');
    expect(engine.isDataAnimated('n1', 'text.source')).toBe(true);
    expect(engine.sampleData('n1', 'text.source', 1)).toBe('One');
    engine.moveDataKeyframe('n1', 'text.source', 2, 0.5);
    expect(engine.sampleData('n1', 'text.source', 1)).toBe('Two');
    engine.removeDataKeyframe('n1', 'text.source', 0.5);
    engine.removeDataKeyframe('n1', 'text.source', 0);
    expect(engine.isDataAnimated('n1', 'text.source')).toBe(false);
    expect(engine.sampleData('n1', 'text.source', 1)).toBeUndefined();
  });

  it('keyframed values are deep-copied in (later mutation cannot corrupt)', () => {
    const stops: GradientStop[] = [{ pos: 0, color: '#000' }, { pos: 1, color: '#fff' }];
    engine.setDataKeyframe('n1', 'fill.stops', 'gradientStops', 0, stops);
    stops[0]!.pos = 0.9;
    expect((engine.sampleData('n1', 'fill.stops', 0) as GradientStop[])[0]!.pos).toBe(0);
  });

  it('getDataTrack/setDataTrack round-trip (the undo seam)', () => {
    engine.setDataKeyframe('n1', 'text.source', 'text', 0, 'A');
    const copy = engine.getDataTrack('n1', 'text.source')!;
    engine.setDataKeyframe('n1', 'text.source', 'text', 1, 'B');
    engine.setDataTrack('n1', 'text.source', copy);
    expect(engine.sampleData('n1', 'text.source', 5)).toBe('A');
    engine.setDataTrack('n1', 'text.source', null);
    expect(engine.isDataAnimated('n1', 'text.source')).toBe(false);
  });

  it('snapshot/restore carries data tracks; pre-data snapshots restore clean', () => {
    engine.setDataKeyframe('n1', 'text.source', 'text', 0, 'Persisted');
    const snap = engine.snapshot();
    expect(snap.data).toBeDefined();

    const fresh = new AnimationEngine();
    fresh.restore(snap);
    expect(fresh.sampleData('n1', 'text.source', 0)).toBe('Persisted');

    // Back-compat: a snapshot without `data` restores without throwing.
    fresh.restore({ tracks: {}, expressions: {} });
    expect(fresh.isDataAnimated('n1', 'text.source')).toBe(false);
  });

  it('clearNode drops data tracks with the rest', () => {
    engine.setDataKeyframe('n1', 'text.source', 'text', 0, 'X');
    engine.clearNode('n1');
    expect(engine.isDataAnimated('n1', 'text.source')).toBe(false);
  });

  it('scalar-only snapshots omit the data field entirely', () => {
    engine.setKeyframe('n1', 'x', 0, 5);
    expect(engine.snapshot().data).toBeUndefined();
  });
});
