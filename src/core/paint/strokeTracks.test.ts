/**
 * Per-stroke keyframe tracks — the names, and the fold that lays them over
 * EVERY stroke of a stack (not only strokes[0], which is all the inline fold
 * this replaced could reach).
 *
 * ## What a clean fixture would hide
 *
 *   • a ONE-stroke stack cannot tell "index 1 reads its own tracks" from "every
 *     index reads the primary's" — so the stack fixtures have three strokes with
 *     different stored values;
 *   • stored values equal to the defaults cannot tell "fell back to the stored
 *     value" from "fell back to a constant" — so the stored stroke is non-default
 *     on every field a track can touch;
 *   • a symmetric dash [10, 10] cannot show which slot a track wrote.
 */

import {
  STROKE_TRACK_PARAMS,
  parseStrokeTrackPath,
  resolveStrokeStack,
  resolveStrokeTracks,
  strokeColorChannelPaths,
  strokeGradientGeometryFor,
  strokeTrackPath,
  strokeTrackPathsFor,
} from './strokeTracks';
import type { Stroke } from '@core/paint/stroke';

const stroke = (extra: Partial<Stroke> = {}): Stroke => ({
  enabled: true, color: '#336699', width: 6, opacity: 0.8,
  align: 'center', dash: [], cap: 'butt', join: 'miter', ...extra,
});

const map = (entries: Record<string, number>): Map<string, number> => new Map(Object.entries(entries));

describe('track paths', () => {
  it('strokes[0] keeps the ORIGINAL flat names — no migration for keyed documents', () => {
    expect({
      width: strokeTrackPath(0, 'width'),
      offset: strokeTrackPath(0, 'dashOffset'),
      taper: strokeTrackPath(0, 'taperStartWidth'),
      wave: strokeTrackPath(0, 'wavePhase'),
      color: strokeColorChannelPaths(0),
    }).toEqual({
      width: 'strokeWidth',
      offset: 'strokeDashOffset',
      taper: 'strokeTaperStartWidth',
      wave: 'strokeWavePhase',
      color: ['stroke_r', 'stroke_g', 'stroke_b', 'stroke_a'],
    });
  });

  it('strokes 2+ are index-scoped', () => {
    expect(strokeTrackPath(2, 'width')).toBe('stroke.2.width');
    expect(strokeTrackPath(1, 'dash3')).toBe('stroke.1.dash3');
    expect(strokeColorChannelPaths(1)).toEqual(['stroke.1.color_r', 'stroke.1.color_g', 'stroke.1.color_b', 'stroke.1.color_a']);
  });

  it('every parameter parses back to its index and name, at index 0 and index 3', () => {
    for (const param of STROKE_TRACK_PARAMS.filter((p) => p !== 'color')) {
      expect(parseStrokeTrackPath(strokeTrackPath(0, param))).toEqual({ index: 0, param });
      expect(parseStrokeTrackPath(strokeTrackPath(3, param))).toEqual({ index: 3, param });
    }
    expect(parseStrokeTrackPath('stroke_g')).toEqual({ index: 0, param: 'color', channel: '_g' });
    expect(parseStrokeTrackPath('stroke.4.color_a')).toEqual({ index: 4, param: 'color', channel: '_a' });
  });

  it('rejects paths that name no stroke track', () => {
    for (const bad of ['stroke.0.width', 'stroke.1.bogus', 'stroke.1.width_r', 'stroke.1.color', 'strokeAngle', 'fill_r', 'stroke']) {
      expect({ bad, parsed: parseStrokeTrackPath(bad) }).toEqual({ bad, parsed: null });
    }
  });

  it('a stroke owns a DISTINCT path per parameter and channel — what a re-key moves', () => {
    const paths = strokeTrackPathsFor(1);
    expect(paths).toHaveLength(STROKE_TRACK_PARAMS.length - 1 + 4);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe('resolveStrokeTracks', () => {
  it('no tracks returns the SAME object — the byte-identity property', () => {
    const s = stroke();
    expect(resolveStrokeTracks(s, 0, undefined, 100, 100)).toBe(s);
    expect(resolveStrokeTracks(s, 0, new Map(), 100, 100)).toBe(s);
    // Tracks for ANOTHER stroke are not tracks for this one.
    const other = map({ 'stroke.1.width': 30 });
    expect(JSON.stringify(resolveStrokeTracks(s, 0, other, 100, 100))).toBe(JSON.stringify(s));
  });

  it('keeps the inline fold’s ORDER for the original tracks (raster cache key)', () => {
    // Re-derived from the fold buildSnapshot used to run inline: dash offset,
    // then width, then colour, each spreading the previous result.
    const s = stroke({ dash: [4, 2] });
    const a = map({ strokeDashOffset: 7, strokeWidth: 11, stroke_r: 1, stroke_g: 0, stroke_b: 0, stroke_a: 1 });
    let old: Stroke = { ...s, dashOffset: 7 };
    old = { ...old, width: 11 };
    old = { ...old, color: '#ff0000ff' };
    const resolved = resolveStrokeTracks(s, 0, a, 100, 100);
    expect(Object.keys(resolved)).toEqual(Object.keys(old));
    expect(resolved.width).toBe(11);
    expect(resolved.dashOffset).toBe(7);
  });

  it('each index reads ONLY its own tracks', () => {
    const a = map({ strokeWidth: 20, 'stroke.1.width': 30, 'stroke.2.opacity': 0.25 });
    expect(resolveStrokeTracks(stroke(), 0, a, 100, 100).width).toBe(20);
    expect(resolveStrokeTracks(stroke(), 1, a, 100, 100).width).toBe(30);
    expect(resolveStrokeTracks(stroke(), 1, a, 100, 100).opacity).toBe(0.8);
    expect(resolveStrokeTracks(stroke(), 2, a, 100, 100).opacity).toBe(0.25);
  });

  it('opacity is a real track, clamped to 0..1', () => {
    expect(resolveStrokeTracks(stroke(), 0, map({ strokeOpacity: 0.3 }), 1, 1).opacity).toBe(0.3);
    expect(resolveStrokeTracks(stroke(), 0, map({ strokeOpacity: 1.4 }), 1, 1).opacity).toBe(1);
    expect(resolveStrokeTracks(stroke(), 0, map({ strokeOpacity: -2 }), 1, 1).opacity).toBe(0);
  });

  it('miter limit folds, floored at 1', () => {
    expect(resolveStrokeTracks(stroke(), 0, map({ strokeMiterLimit: 9.5 }), 1, 1).miterLimit).toBe(9.5);
    expect(resolveStrokeTracks(stroke(), 0, map({ strokeMiterLimit: 0.2 }), 1, 1).miterLimit).toBe(1);
  });

  it('each dash SLOT takes its own track; a slot the pattern lacks is ignored', () => {
    const s = stroke({ dash: [10, 5, 3] });
    const a = map({ strokeGap1: 8, strokeDash2: -4, strokeGap3: 99 });
    expect(resolveStrokeTracks(s, 0, a, 1, 1).dash).toEqual([10, 8, 0]);
    // A pattern with no tracks on its slots is untouched — the same array.
    expect(resolveStrokeTracks(s, 0, map({ strokeWidth: 6 }), 1, 1).dash).toBe(s.dash);
  });

  it('taper and wave fall back to the STORED profile, units included', () => {
    const s = stroke({
      taper: { startWidth: 0.3, endWidth: 0.7, startLength: 40, endLength: 25, startEase: -0.5, endEase: 0.6, lengthUnits: 'pixels' },
      wave: { amount: 7, wavelength: 3, phase: 20, units: 'cycles' },
    });
    const r = resolveStrokeTracks(s, 0, map({ strokeTaperStartWidth: 0.05, strokeWavePhase: 90 }), 1, 1);
    expect(r.taper).toEqual({ ...s.taper, startWidth: 0.05 });
    expect(r.wave).toEqual({ ...s.wave, phase: 90 });
  });

  describe('gradient points', () => {
    const linear = { type: 'linear' as const, angle: 0, stops: [{ id: 'a', offset: 0, color: '#000' }, { id: 'b', offset: 1, color: '#fff' }] };

    it('derive from the angle model exactly where makeCanvasGradient puts the ramp', () => {
      // angle 0 on a 200×100 box spans the box horizontally: x −100 → 100.
      expect(strokeGradientGeometryFor(linear, 200, 100)).toEqual({ startX: 0, startY: 0.5, endX: 1, endY: 0.5 });
      const radial = { type: 'radial' as const, cx: 0.25, cy: 0.75, radius: 0.5, stops: linear.stops };
      const g = strokeGradientGeometryFor(radial, 200, 100);
      expect(g.startX).toBe(0.25);
      expect(g.endX).toBeCloseTo(0.25 + (0.5 * Math.hypot(200, 100)) / 2 / 200, 9);
      expect(g.endY).toBe(0.75);
    });

    it('one keyed coordinate keeps the other three where the stroke shows them', () => {
      const r = resolveStrokeTracks(stroke({ paint: linear }), 0, map({ strokeGradientEndY: 0.9 }), 200, 100);
      expect(r.gradient).toEqual({ startX: 0, startY: 0.5, endX: 1, endY: 0.9 });
    });

    it('keyed highlight lands on stored points; a SOLID stroke ignores point tracks', () => {
      const withPoints = stroke({
        paint: { ...linear, type: 'radial', cx: 0.5, cy: 0.5, radius: 0.5 } as never,
        gradient: { startX: 0.1, startY: 0.2, endX: 0.3, endY: 0.4 },
      });
      const r = resolveStrokeTracks(withPoints, 0, map({ strokeHighlightLength: 0.5, strokeHighlightAngle: 45 }), 1, 1);
      expect(r.gradient).toEqual({ startX: 0.1, startY: 0.2, endX: 0.3, endY: 0.4, highlightLength: 0.5, highlightAngle: 45 });
      const solid = stroke();
      expect(resolveStrokeTracks(solid, 0, map({ strokeGradientStartX: 0.9 }), 1, 1)).not.toHaveProperty('gradient');
    });
  });
});

describe('resolveStrokeStack', () => {
  it('a single stroke resolves to `stroke` alone, as before', () => {
    const out = resolveStrokeStack([stroke()], map({ strokeWidth: 9 }), 1, 1);
    expect(out.stroke?.width).toBe(9);
    expect(out).not.toHaveProperty('strokes');
  });

  it('every stroke of the stack animates, bound by STORED index', () => {
    const stack = [stroke({ width: 1 }), stroke({ width: 2, enabled: false }), stroke({ width: 3 })];
    const out = resolveStrokeStack(stack, map({ strokeWidth: 10, 'stroke.1.width': 20, 'stroke.2.width': 30 }), 1, 1);
    // The disabled stroke 2 is dropped AFTER resolving, so stroke 3 keeps its
    // own `stroke.2.*` keyframes rather than inheriting stroke 2's.
    expect(out.strokes?.map((s) => s.width)).toEqual([10, 30]);
    expect(out.stroke?.width).toBe(10);
  });

  it('a primary that is off no longer takes the one enabled stroke with it', () => {
    const out = resolveStrokeStack([stroke({ enabled: false }), stroke({ width: 4 })], undefined, 1, 1);
    expect(out.stroke).toBeUndefined();
    expect(out.strokes?.map((s) => s.width)).toEqual([4]);
  });

  it('nothing renderable resolves to nothing', () => {
    expect(resolveStrokeStack([stroke({ width: 0 }), stroke({ enabled: false })], undefined, 1, 1)).toEqual({});
  });
});
