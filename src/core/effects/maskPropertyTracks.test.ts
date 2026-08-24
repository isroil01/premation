/**
 * Mask Feather / Opacity / Expansion as independent tracks, layered over the
 * whole-shape mask track at render.
 */

import { applyMaskPropertyTracks, maskPropPath, parseMaskPropPath, rectangleMask, type LayerMask } from './mask';

const mask = (): LayerMask => ({ paths: [{ ...rectangleMask(10, 10), id: 'm1', feather: 4, opacity: 1, expansion: 0 }] });

it('round-trips the path id through the prop path', () => {
  expect(parseMaskPropPath(maskPropPath('m1', 'feather'))).toEqual({ pathId: 'm1', key: 'feather' });
  expect(parseMaskPropPath('mask.m1.points')).toBeNull();
});

it('returns the SAME object when nothing is tracked, so the raster cache keeps hitting', () => {
  const m = mask();
  expect(applyMaskPropertyTracks(m, new Map([['x', 5]]))).toBe(m);
  expect(applyMaskPropertyTracks(m, undefined)).toBe(m);
});

it('overrides only the tracked settings, scaling opacity 0..100 → 0..1', () => {
  const out = applyMaskPropertyTracks(mask(), new Map([
    [maskPropPath('m1', 'feather'), 12],
    [maskPropPath('m1', 'opacity'), 25],
  ]))!;
  expect(out.paths[0]!.feather).toBe(12);
  expect(out.paths[0]!.opacity).toBeCloseTo(0.25);
  expect(out.paths[0]!.expansion).toBe(0);
});

it('ignores a track for a path that is not on this mask', () => {
  const m = mask();
  expect(applyMaskPropertyTracks(m, new Map([[maskPropPath('other', 'feather'), 9]]))).toBe(m);
});
