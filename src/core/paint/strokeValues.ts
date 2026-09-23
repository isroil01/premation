/**
 * The STATIC value of a shape stroke's keyframeable parameter — read out of,
 * and written into, the stroke stack entry (`fx.stroke` / `fx.strokes`) that
 * owns it. The property seam (`propertyValue.ts`) routes every stroke track
 * (`strokeWidth`, `stroke.<i>.<param>`, strokeTracks.ts) here when the layer
 * has a stroke at that index, mirroring how `resolveStrokeTracks` folds the
 * tracks over the stored stroke: every fallback is the stored value, then the
 * identity (taper widths 1, lengths 0, wave 0, miter limit 4, dash offset 0).
 *
 * Before this the seam's flat component scan found nothing (the stroke is an
 * object inside fx), so the static value read as the registry default and a
 * static write landed on the Transform where nothing reads it — in both
 * engines (ENGINE_API.md §15.9). The C++ engine ports this file
 * (native/engine/src/core/strokes.cpp).
 *
 * Unstored gradient points read as the points the paint's angle/centre model
 * implies (`strokeGradientGeometryFor`) at the layer's STATIC width/height —
 * deterministic, unlike the inspector's time-dependent `readGeometry`.
 */

import type { SceneNode } from '@core/types';
import { IDENTITY_TAPER, IDENTITY_WAVE, type StrokeTaper, type StrokeWave } from '@core/scene/strokeProfile';
import {
  STROKE_DASH_PARAMS,
  strokeGradientGeometryFor,
  type StrokeTrackParam,
} from '@core/rendering/strokeTracks';
import { normalizeStroke, readNodeStrokes, type Stroke, type StrokeGradientGeometry } from './stroke';

const TAPER_FIELD: Partial<Record<StrokeTrackParam, keyof StrokeTaper>> = {
  taperStartLength: 'startLength', taperEndLength: 'endLength',
  taperStartWidth: 'startWidth', taperEndWidth: 'endWidth',
  taperStartEase: 'startEase', taperEndEase: 'endEase',
};
const WAVE_FIELD: Partial<Record<StrokeTrackParam, keyof StrokeWave>> = {
  waveAmount: 'amount', waveWavelength: 'wavelength', wavePhase: 'phase',
};
const GRADIENT_FIELD: Partial<Record<StrokeTrackParam, keyof StrokeGradientGeometry>> = {
  gradientStartX: 'startX', gradientStartY: 'startY', gradientEndX: 'endX', gradientEndY: 'endY',
  highlightLength: 'highlightLength', highlightAngle: 'highlightAngle',
};

/** The layer's static box: the first numeric `width` / `height` any component stores (0 when none). */
export function staticLayerSize(node: SceneNode): { w: number; h: number } {
  let w: number | undefined;
  let h: number | undefined;
  for (const c of node.components) {
    const p = c.props as Record<string, unknown>;
    if (w === undefined && typeof p.width === 'number') w = p.width;
    if (h === undefined && typeof p.height === 'number') h = p.height;
  }
  return { w: w ?? 0, h: h ?? 0 };
}

/** The stored stroke at `index` (normalised, disabled included), or undefined. */
export function strokeEntryAt(node: SceneNode, index: number): Stroke | undefined {
  return readNodeStrokes(node)[index];
}

function gradientOf(node: SceneNode, s: Stroke): StrokeGradientGeometry {
  if (s.gradient) return s.gradient;
  const { w, h } = staticLayerSize(node);
  return strokeGradientGeometryFor(s.paint, w, h);
}

/** The static value of `param` on stroke `s`, or undefined when the stroke has no such value. */
export function readStrokeParam(node: SceneNode, s: Stroke, param: StrokeTrackParam): number | undefined {
  switch (param) {
    case 'color': return undefined;
    case 'opacity': return s.opacity;
    case 'width': return s.width;
    case 'miterLimit': return s.miterLimit ?? 4;
    case 'dashOffset': return s.dashOffset ?? 0;
    default: break;
  }
  const dash = (STROKE_DASH_PARAMS as readonly string[]).indexOf(param);
  if (dash >= 0) return s.dash[dash];
  const tf = TAPER_FIELD[param];
  if (tf) return (s.taper?.[tf] as number | undefined) ?? (IDENTITY_TAPER[tf] as number);
  const wf = WAVE_FIELD[param];
  if (wf) return (s.wave?.[wf] as number | undefined) ?? (IDENTITY_WAVE[wf] as number);
  const gf = GRADIENT_FIELD[param];
  if (gf) {
    if (!s.paint || s.paint.type === 'solid') return undefined;
    return gradientOf(node, s)[gf] ?? 0;
  }
  return undefined;
}

/**
 * Stroke `s` with `param` set to `value` (normalised), or undefined when the
 * stroke cannot take it (a dash slot it does not have, gradient points on a
 * solid paint, a non-finite value).
 */
export function withStrokeParam(node: SceneNode, s: Stroke, param: StrokeTrackParam, value: number): Stroke | undefined {
  if (!Number.isFinite(value)) return undefined;
  let patch: Partial<Stroke> | undefined;
  switch (param) {
    case 'color': return undefined;
    case 'opacity': patch = { opacity: value }; break;
    case 'width': patch = { width: value }; break;
    case 'miterLimit': patch = { miterLimit: value }; break;
    case 'dashOffset': patch = { dashOffset: value }; break;
    default: break;
  }
  if (!patch) {
    const dash = (STROKE_DASH_PARAMS as readonly string[]).indexOf(param);
    const tf = TAPER_FIELD[param];
    const wf = WAVE_FIELD[param];
    const gf = GRADIENT_FIELD[param];
    if (dash >= 0) {
      if (dash >= s.dash.length) return undefined;
      const next = [...s.dash];
      // A negative slot would be FILTERED by normalisation, shifting the pattern.
      next[dash] = Math.max(0, value);
      patch = { dash: next };
    } else if (tf) {
      patch = { taper: { ...IDENTITY_TAPER, ...s.taper, [tf]: value } };
    } else if (wf) {
      patch = { wave: { ...IDENTITY_WAVE, ...s.wave, [wf]: value } };
    } else if (gf) {
      if (!s.paint || s.paint.type === 'solid') return undefined;
      patch = { gradient: { ...gradientOf(node, s), [gf]: value } };
    }
  }
  return patch ? normalizeStroke({ ...s, ...patch }) : undefined;
}
