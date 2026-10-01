/**
 * The hover preview must be cheap, cached and — above all — HONEST.
 *
 * "No preview" is a real answer: a GPU-only effect has no CSS-filter path, and
 * a canvas that does not implement `filter` (jsdom, some headless builds) would
 * otherwise draw the bare plate and pass it off as the effect. Both cases have
 * to come back as `null` so the panel can show the icon instead.
 */

import { effectPreviewFor, peekEffectPreview, resetEffectPreviewsForTest } from './effectPreviewThumbs';
import { effectPreviewFilter, type EffectDef } from '@core/inspector/effectCatalog';

/** A stand-in def. The `type` is deliberately NOT a catalog type: these are
 *  probes for the preview's own rules, not entries in the real registry. The
 *  CSS builder is the preview's second argument (the test seam). */
const asDef = (d: { type: string; gpuOnly?: boolean }): EffectDef =>
  ({ label: d.type, params: [], ...(d.gpuOnly ? { gpuOnly: true as const } : {}), type: d.type }) as EffectDef;

beforeEach(() => resetEffectPreviewsForTest());

it('refuses to invent a picture for a GPU-only effect', () => {
  expect(effectPreviewFor(asDef({ type: 'gpu-thing', gpuOnly: true }), () => 'blur(4px)')).toBeNull();
});

it('refuses one for an effect with no CSS filter at all', () => {
  expect(effectPreviewFor(asDef({ type: 'no-css' }), () => '   ')).toBeNull();
});

it('survives a css() that throws rather than taking the panel down with it', () => {
  expect(effectPreviewFor(asDef({ type: 'boom' }), () => { throw new Error('nope'); })).toBeNull();
});

it('answers each effect once and then from the cache', () => {
  let calls = 0;
  // An empty filter on purpose: jsdom has no real `toDataURL`, so the picture
  // half cannot be exercised here — the CACHING half can, and it is the half
  // that keeps a hover from re-rendering the same thumbnail forever.
  const def = asDef({ type: 'counted' });
  const css = (): string => { calls += 1; return ''; };

  expect(peekEffectPreview('counted')).toBeUndefined();
  const first = effectPreviewFor(def, css);
  expect(peekEffectPreview('counted')).toBe(first);
  effectPreviewFor(def, css);
  effectPreviewFor(def, css);
  // Cached even when the answer was "there is no preview" — the expensive
  // half is the attempt, not the picture.
  expect(calls).toBe(1);
});

it('knows the CSS-filter family and nothing else', () => {
  // The catalog carries no CSS builder, so the helper keeps the family that
  // had one: a scalar filter, and a GPU-only / pixel-pass effect has none.
  expect(effectPreviewFilter('blur', { amount: 4 })).toBe('blur(4px)');
  expect(effectPreviewFilter('hue-rotate', { amount: 90 })).toBe('hue-rotate(90deg)');
  expect(effectPreviewFilter('drop-shadow', { distance: 0, softness: 12, color: '#000000', opacity: 50 })).toContain('drop-shadow(');
  expect(effectPreviewFilter('gaussian-blur', { blurriness: 10 })).toBe('');
  expect(effectPreviewFilter('compound-blur', {})).toBe('');
});

it('forgets everything when the test seam resets it', () => {
  effectPreviewFor(asDef({ type: 'temp' }), () => '');
  expect(peekEffectPreview('temp')).not.toBeUndefined();
  resetEffectPreviewsForTest();
  expect(peekEffectPreview('temp')).toBeUndefined();
});
