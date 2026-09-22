/**
 * The memoised points term of the path raster key must be INVISIBLE: the same
 * bytes an unmemoised build produces, for the same inputs, every time — and
 * "same inputs" is judged by content, not by the array's identity.
 *
 * The second half is the one that matters. A static outline reaches the key as
 * the scene's own `Geometry.props.points` array, and the scene has write paths
 * that edit nested props arrays in place (snapshotSharing.ts refuses revision
 * counters for the same reason). A memo that trusted identity would serve the
 * pre-edit string after such a write and the shape's texture would freeze on
 * the old outline while the overlay showed the new one — nothing throws, the
 * cache just stops invalidating. So every test here that hits the memo then
 * mutates in place and checks the key moved.
 */

import { pointsSignature, pointsSignatureStats, resetPointsSignatureStats } from './pointsSignature';
import { pathRasterSignature } from '../AppTextureProvider';
import { layerSubpaths } from './subpaths';
import { effectsNeedCpuBake } from '@core/effects/effectBake';
import type { RenderLayer } from '../RenderBackend';
import type { BezierPoint } from '../../../../packages/workspace/src/math/BezierPoint';

/** The inline expression `pathRasterSignature` used before the memo, verbatim. */
function unmemoisedPathSignature(layer: RenderLayer, tier: number): string {
  const ptsSig = layerSubpaths(layer)
    .map((s) => `${s.open ? 'o' : 'c'}:${s.paint ? JSON.stringify(s.paint) : ''}:${s.points.map(p => `${p.x},${p.y},${p.inX},${p.inY},${p.outX},${p.outY}`).join('|')}`)
    .join('//');
  const strokeSig = layer.stroke ? `${layer.stroke.width},${layer.stroke.color},${layer.stroke.align}` : 'no-stroke';
  const paintSig = layer.fillPaint && layer.fillPaint.type !== 'solid' ? JSON.stringify(layer.fillPaint) : 'solid';
  const fillSig = layer.fillOpacity !== undefined && layer.fillOpacity < 1 ? `|fo${layer.fillOpacity}` : '';
  const fxSig = effectsNeedCpuBake(layer.effects)
    ? `|fx:${JSON.stringify(layer.effects)}|mask:${layer.mask ? JSON.stringify(layer.mask.paths) : 0}`
    : '';
  return `h:${layer.contentHash ?? ''}|${layer.width}x${layer.height}|${layer.primitive ?? 'path'}|r:${layer.cornerRadius ?? 0}|cr:${layer.cornerRadii ? layer.cornerRadii.join(',') : ''}|${ptsSig}|${layer.fill}|${paintSig}|${strokeSig}|${layer.pathOpen ? 'open' : 'closed'}${fxSig}${fillSig}|t${tier}`;
}

function pt(x: number, y: number, k = 0): BezierPoint {
  return { x, y, inX: x - k, inY: y, outX: x + k, outY: y };
}

function blob(r: number): BezierPoint[] {
  const k = r * 0.5523;
  return [
    { x: 0, y: -r, inX: -k, inY: -r, outX: k, outY: -r },
    { x: r, y: 0, inX: r, inY: -k, outX: r, outY: k },
    { x: 0, y: r, inX: k, inY: r, outX: -k, outY: r },
    { x: -r, y: 0, inX: -r, inY: k, outX: -r, outY: -k },
  ];
}

function shape(over: Partial<RenderLayer> = {}): RenderLayer {
  return {
    id: 's', kind: 'shape', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    width: 120, height: 120, fill: '#2b7eff', visible: true, primitive: 'path', contentHash: 'abcd1234',
    ...over,
  } as unknown as RenderLayer;
}

beforeEach(resetPointsSignatureStats);

describe('pointsSignature', () => {
  it('is byte-identical to the inline expression it replaced', () => {
    const pts = blob(60);
    const expected = pts.map((p) => `${p.x},${p.y},${p.inX},${p.inY},${p.outX},${p.outY}`).join('|');
    expect(pointsSignature(pts)).toBe(expected);
    // And on the hit path, which returns the stored string.
    expect(pointsSignature(pts)).toBe(expected);
    expect(pointsSignatureStats).toEqual({ hit: 1, miss: 1, stale: 0 });
  });

  it('serves the cached string for the same unchanged array', () => {
    const pts = blob(30);
    const a = pointsSignature(pts);
    for (let i = 0; i < 5; i++) expect(pointsSignature(pts)).toBe(a);
    expect(pointsSignatureStats.hit).toBe(5);
    expect(pointsSignatureStats.miss).toBe(1);
  });

  it('recomputes for an equal-content REPLACEMENT array, and the bytes still agree', () => {
    const a = blob(30);
    const b = blob(30);
    expect(pointsSignature(a)).toBe(pointsSignature(b));
    expect(pointsSignatureStats).toEqual({ hit: 0, miss: 2, stale: 0 });
  });

  it('does NOT return a stale string after an in-place vertex edit', () => {
    const pts = blob(30);
    const before = pointsSignature(pts);
    pts[1]!.x += 0.25; // the pen tool nudging one anchor, no array replacement
    const after = pointsSignature(pts);
    expect(after).not.toBe(before);
    expect(after).toBe(pts.map((p) => `${p.x},${p.y},${p.inX},${p.inY},${p.outX},${p.outY}`).join('|'));
    expect(pointsSignatureStats.stale).toBe(1);
  });

  it('sees an in-place edit to any of the six coordinates, and to length', () => {
    const fields: Array<'x' | 'y' | 'inX' | 'inY' | 'outX' | 'outY'> = ['x', 'y', 'inX', 'inY', 'outX', 'outY'];
    for (const f of fields) {
      const pts = blob(30);
      const before = pointsSignature(pts);
      pts[2]![f] = pts[2]![f] + 1;
      expect([f, pointsSignature(pts) === before]).toEqual([f, false]);
    }
    const pts = blob(30);
    const before = pointsSignature(pts);
    pts.push(pt(5, 5));
    expect(pointsSignature(pts)).not.toBe(before);
    pts.pop();
    // Back to the original content: the same bytes again, verified not assumed.
    expect(pointsSignature(pts)).toBe(before);
  });

  it('an in-place edit that is later reverted yields the original bytes', () => {
    const pts = blob(30);
    const before = pointsSignature(pts);
    const x = pts[0]!.x;
    pts[0]!.x = 999;
    pointsSignature(pts);
    pts[0]!.x = x;
    expect(pointsSignature(pts)).toBe(before);
  });

  it('handles an empty array', () => {
    expect(pointsSignature([])).toBe('');
    expect(pointsSignature([])).toBe('');
  });
});

describe('pathRasterSignature with the memo', () => {
  const cases: Array<[string, () => RenderLayer]> = [
    ['single-run blob', () => shape({ pathPoints: blob(60) })],
    ['open polyline with stroke', () => shape({ pathPoints: [pt(0, 0), pt(10, 4, 2), pt(30, -1.5)], pathOpen: true, stroke: { width: 3, color: '#fff', align: 'center' } as never })],
    ['two runs, one painted', () => shape({
      subpaths: [
        { points: blob(40), open: false, paint: { opacity: 0.5 } as never },
        { points: blob(20), open: true },
      ],
    })],
    ['gradient fill + corner radii', () => shape({
      pathPoints: blob(50), cornerRadii: [1, 2, 3, 4] as never,
      fillPaint: { type: 'linear', angle: 45, stops: [{ offset: 0, color: '#000' }, { offset: 1, color: '#fff' }] } as never,
    })],
    ['baked effects + mask', () => shape({
      pathPoints: blob(50), fillOpacity: 0.5,
      effects: [{ id: 'e1', type: 'sharpen', enabled: true, params: { amount: 2 }, maskId: 'm' }] as never,
      mask: { paths: [{ id: 'm', points: [pt(0, 0), pt(1, 1)], closed: true }] } as never,
    })],
    ['a primitive with no points at all', () => shape({ primitive: 'rect', cornerRadius: 8 })],
    ['exotic numbers', () => shape({ pathPoints: [pt(-0, 1e21), pt(1.5e-7, NaN), pt(Infinity, -Infinity)] })],
  ];

  it.each(cases)('%s: memoised === unmemoised, on the miss and on the hit', (_name, make) => {
    const layer = make();
    for (const tier of [1, 2]) {
      expect(pathRasterSignature(layer, tier)).toBe(unmemoisedPathSignature(layer, tier));
      expect(pathRasterSignature(layer, tier)).toBe(unmemoisedPathSignature(layer, tier));
    }
  });

  it('a second frame with the same point array hits the memo and matches the reference', () => {
    const pts = blob(60);
    const f1 = shape({ pathPoints: pts, x: 10 });
    const f2 = shape({ pathPoints: pts, x: 20, stroke: { width: 2, color: '#f00', align: 'inside' } as never });
    expect(pathRasterSignature(f1, 1)).toBe(unmemoisedPathSignature(f1, 1));
    expect(pathRasterSignature(f2, 1)).toBe(unmemoisedPathSignature(f2, 1));
    expect(pointsSignatureStats.hit).toBe(1);
  });

  it('an in-place edit of a nested point moves the whole key, exactly as the reference does', () => {
    const pts = blob(60);
    const layer = shape({ pathPoints: pts });
    const before = pathRasterSignature(layer, 1);
    pts[3]!.outY -= 2;
    const after = pathRasterSignature(layer, 1);
    expect(after).not.toBe(before);
    expect(after).toBe(unmemoisedPathSignature(layer, 1));
  });

  it('an in-place edit inside a subpath run moves the key too', () => {
    const inner = blob(20);
    const layer = shape({ subpaths: [{ points: blob(40), open: false }, { points: inner, open: false }] });
    const before = pathRasterSignature(layer, 1);
    inner[0]!.x += 1;
    expect(pathRasterSignature(layer, 1)).not.toBe(before);
    expect(pathRasterSignature(layer, 1)).toBe(unmemoisedPathSignature(layer, 1));
  });

  it('two different splits of the same points still sign differently', () => {
    const a = shape({ subpaths: [{ points: [pt(0, 0), pt(1, 0)] }, { points: [pt(2, 0), pt(3, 0)] }] });
    const b = shape({ subpaths: [{ points: [pt(0, 0)] }, { points: [pt(1, 0), pt(2, 0), pt(3, 0)] }] });
    expect(pathRasterSignature(a, 1)).not.toBe(pathRasterSignature(b, 1));
  });
});
