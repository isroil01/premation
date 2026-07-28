/**
 * Keyframe glyphs — reading interpolation off the timeline without opening the
 * graph editor.
 *
 * The diamond used to encode three states (diamond / circle-if-roving /
 * square-if-hold), so linear, bezier, easy-ease, ease-in, ease-out and
 * auto-bezier were all the SAME diamond. Half of why AE's timeline works is
 * that a glance tells you what every keyframe is doing.
 *
 * Each keyframe is drawn as TWO HALVES, because its two sides are genuinely
 * independent: the engine stores `easing` on the segment that STARTS at a
 * keyframe, so a keyframe's OUTGOING curve is its own `easing` and its INCOMING
 * curve is the PREVIOUS keyframe's. A key that eases out of one segment and
 * holds into the next is a real thing and now looks like one.
 *
 * Shape families, matching AE:
 *   linear  → half diamond   (straight outer edge to a point)
 *   ease    → half hourglass (pinched toward the centre)
 *   auto    → half circle
 *   hold    → half square
 */

import type { EasingKind } from '@motion/animation';

export type KeyframeShape = 'linear' | 'ease' | 'auto' | 'hold';

/** Which glyph family an easing kind belongs to. */
export function shapeOfEasing(easing: EasingKind | undefined): KeyframeShape {
  switch (easing) {
    case 'hold':
    case 'step':
      return 'hold';
    case 'autoBezier':
    case 'continuousBezier':
      return 'auto';
    case 'ease':
    case 'easeIn':
    case 'easeOut':
    case 'easeInOut':
    case 'bezier':
      return 'ease';
    case 'linear':
    default:
      // Absent easing is linear — the engine's own default.
      return 'linear';
  }
}

/**
 * The two halves of a keyframe's glyph.
 *
 * `incoming` is the easing of the PREVIOUS keyframe (the segment arriving here)
 * and `outgoing` is this keyframe's own. Pass `undefined` for the first
 * keyframe's incoming side and the last one's outgoing side — an end has no
 * segment on that side, so it takes the other half's shape rather than
 * inventing a difference the track does not have.
 */
export function keyframeShapes(
  incoming: EasingKind | undefined,
  outgoing: EasingKind | undefined,
  opts: { isFirst?: boolean; isLast?: boolean } = {},
): { left: KeyframeShape; right: KeyframeShape } {
  const right = shapeOfEasing(outgoing);
  const left = opts.isFirst ? right : shapeOfEasing(incoming);
  return { left, right: opts.isLast ? left : right };
}

// ── Glyph geometry ─────────────────────────────────────────────────
// One 12×12 viewBox, centred on (6,6). Halves meet on the vertical centre line
// so any left/right pair composes into a coherent glyph.

const LEFT: Record<KeyframeShape, string> = {
  linear: 'M6 1 L1 6 L6 11 Z',
  ease: 'M1 1 L6 6 L1 11 Z',
  auto: 'M6 1 A5 5 0 0 0 6 11 Z',
  hold: 'M6 1 L1 1 L1 11 L6 11 Z',
};

const RIGHT: Record<KeyframeShape, string> = {
  linear: 'M6 1 L11 6 L6 11 Z',
  ease: 'M11 1 L6 6 L11 11 Z',
  auto: 'M6 1 A5 5 0 0 1 6 11 Z',
  hold: 'M6 1 L11 1 L11 11 L6 11 Z',
};

/** SVG path data for each half of a keyframe glyph. */
export function keyframePaths(left: KeyframeShape, right: KeyframeShape): { left: string; right: string } {
  return { left: LEFT[left], right: RIGHT[right] };
}

/** A human-readable description, for the diamond's tooltip. */
export function describeShapes(left: KeyframeShape, right: KeyframeShape): string {
  const name: Record<KeyframeShape, string> = {
    linear: 'Linear',
    ease: 'Eased',
    auto: 'Auto Bezier',
    hold: 'Hold',
  };
  return left === right ? name[left] : `${name[left]} in · ${name[right]} out`;
}
