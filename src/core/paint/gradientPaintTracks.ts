/**
 * Keyframed gradient GEOMETRY laid over a stored gradient paint.
 *
 * A layer's FILL gradient (`fx.fill` — shapes, and text, whose gradient fill is
 * stored there too) animates through `fillAngle`, `fillCenterX|Y` and
 * `fillRadius`, sampled in buildSnapshot's paint block. A text layer's STROKE
 * gradient (`strokePaint` on the Text component, painted across the text block
 * by textGradient.ts) animates the same way under the mirrored names below —
 * the gradient gizmo's grips keyframe them when the track is live or
 * Auto-Keyframe is on. One resolver, so what a track overrides cannot differ
 * between the two.
 *
 * `a` is the frame's sampled-value map for the layer (buildSnapshot's `a`).
 */

import type { LinearFill, RadialFill } from '@core/paint/fill';

export interface GradientTrackNames {
  angle: string;
  centerX: string;
  centerY: string;
  radius: string;
}

export const FILL_GRADIENT_TRACKS: GradientTrackNames = {
  angle: 'fillAngle',
  centerX: 'fillCenterX',
  centerY: 'fillCenterY',
  radius: 'fillRadius',
};

export const TEXT_STROKE_GRADIENT_TRACKS: GradientTrackNames = {
  angle: 'strokeAngle',
  centerX: 'strokeCenterX',
  centerY: 'strokeCenterY',
  radius: 'strokeRadius',
};

export function applyGradientTracks(
  paint: LinearFill | RadialFill | undefined,
  a: ReadonlyMap<string, number> | undefined,
  names: GradientTrackNames,
): LinearFill | RadialFill | undefined {
  if (!paint || !a || a.size === 0) return paint;
  if (paint.type === 'linear') {
    const angle = a.get(names.angle);
    return angle === undefined ? paint : { ...paint, angle };
  }
  const cx = a.get(names.centerX);
  const cy = a.get(names.centerY);
  const radius = a.get(names.radius);
  if (cx === undefined && cy === undefined && radius === undefined) return paint;
  return { ...paint, cx: cx ?? paint.cx, cy: cy ?? paint.cy, radius: radius ?? paint.radius };
}
