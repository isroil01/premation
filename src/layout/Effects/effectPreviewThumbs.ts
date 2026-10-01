/**
 * effectPreviewThumbs — a 96×54 picture of what an effect DOES, made cheaply.
 *
 * The CSS-filter family of effects (blur, hue-rotate, drop-shadow,
 * brightness…) has a CSS `filter` function string — `effectPreviewFilter` in
 * the catalog helper. Canvas2D honours the same grammar through `ctx.filter`,
 * so a synchronous preview is one `drawImage` of a standard plate with that
 * filter set — no engine, no snapshot, no async. Effects that are `gpuOnly`,
 * or that have no CSS form, get `null` here; the panel shows their icon and
 * category instead of pretending.
 *
 * The plate is deliberately busy — a gradient, a saturated disc, a hard-edged
 * bar and "Aa" — because a blur on a flat colour looks like nothing, and the
 * same plate under every effect is what makes the row of thumbnails
 * COMPARABLE rather than merely decorative.
 *
 * Cached per effect type for the session; a preview that has been made once
 * is a string lookup afterwards. Never throws: a Canvas2D that does not
 * support `filter` (jsdom, some headless builds) yields `null`, which the
 * caller treats the same as "no cheap preview".
 */

import { defaultParams, effectPreviewFilter, type EffectDef, type EffectParams } from '@core/inspector/effectCatalog';

/** The CSS `filter` previewing an effect at `params` ('' = none). */
export type PreviewFilter = (type: string, params: EffectParams) => string;

export const EFFECT_PREVIEW_W = 96;
export const EFFECT_PREVIEW_H = 54;

const cache = new Map<string, string | null>();
let plate: HTMLCanvasElement | null = null;

function makePlate(): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = EFFECT_PREVIEW_W;
  c.height = EFFECT_PREVIEW_H;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  const g = ctx.createLinearGradient(0, 0, EFFECT_PREVIEW_W, EFFECT_PREVIEW_H);
  g.addColorStop(0, '#1e3a8a');
  g.addColorStop(0.55, '#7c3aed');
  g.addColorStop(1, '#f59e0b');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, EFFECT_PREVIEW_W, EFFECT_PREVIEW_H);
  // A saturated disc — hue and saturation effects need a colour to move.
  ctx.fillStyle = '#22d3ee';
  ctx.beginPath();
  ctx.arc(30, 27, 15, 0, Math.PI * 2);
  ctx.fill();
  // A hard-edged white bar — blur, sharpen and edge effects need an edge.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(56, 12, 28, 8);
  // Type — the thing most effects are applied to.
  ctx.fillStyle = '#0f172a';
  ctx.font = '700 18px sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText('Aa', 56, 38);
  return c;
}

/** The cached preview: a data URL, `null` = no cheap preview, `undefined` =
 *  not made yet. Synchronous. */
export function peekEffectPreview(type: string): string | null | undefined {
  return cache.get(type);
}

/** Make (or fetch) the preview for one effect. Synchronous and cheap. `css` is a test seam. */
export function effectPreviewFor(def: EffectDef, css: PreviewFilter = effectPreviewFilter): string | null {
  const known = cache.get(def.type);
  if (known !== undefined) return known;
  const url = render(def, css);
  cache.set(def.type, url);
  return url;
}

function render(def: EffectDef, css: PreviewFilter): string | null {
  if (def.gpuOnly) return null;
  let filter = '';
  try {
    filter = css(def.type, defaultParams(def)).trim();
  } catch {
    return null;
  }
  if (!filter) return null;
  if (typeof document === 'undefined') return null;
  plate ??= makePlate();
  if (!plate) return null;
  const c = document.createElement('canvas');
  c.width = EFFECT_PREVIEW_W;
  c.height = EFFECT_PREVIEW_H;
  const ctx = c.getContext('2d') as (CanvasRenderingContext2D & { filter?: string }) | null;
  if (!ctx || !('filter' in ctx)) return null;
  try {
    ctx.filter = filter;
    // A filter the engine rejects silently resets to "none", which would
    // draw the bare plate as if it were the effect. Refuse that.
    if (ctx.filter === 'none' && filter !== 'none') return null;
    ctx.drawImage(plate, 0, 0);
    return c.toDataURL('image/webp', 0.85);
  } catch {
    return null;
  }
}

/** Test seam. */
export function resetEffectPreviewsForTest(): void {
  cache.clear();
  plate = null;
}
