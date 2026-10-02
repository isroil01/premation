/**
 * Onion skinning — which neighbouring frames to ghost, how strongly, in what
 * colour, and in what ORDER.
 *
 * Kept as a pure plan rather than inlined into the render loop because every
 * interesting decision here is arithmetic that is easy to get subtly wrong and
 * impossible to eyeball afterwards: an off-by-one that ghosts the current frame
 * over itself (which just looks like a contrast change), a falloff that reaches
 * zero so the outermost ghost is invisible and the control appears to do
 * nothing past 3, or a draw order that puts the FARTHEST ghost on top so the
 * motion reads backwards.
 *
 * The convention for the tint is the animation-industry one, shared by AE,
 * TVPaint and Blender: **past is warm, future is cool.** It is worth matching
 * exactly — someone who has drawn frame-by-frame anywhere else already reads
 * red as "where it came from" without being told, and inverting it silently
 * makes every ghost mean the opposite thing.
 */

/** Past ghosts. Warm — "where it came from". */
export const ONION_PAST_TINT = '#ff5a3c';
/** Future ghosts. Cool — "where it is going". */
export const ONION_FUTURE_TINT = '#3ca0ff';

export interface OnionSkinSettings {
  enabled: boolean;
  /** Ghosts to show before the playhead. */
  before: number;
  /** Ghosts to show after the playhead. */
  after: number;
  /** Frame stride between ghosts — 2 shows every other frame. */
  step: number;
  /** Alpha of the NEAREST ghost; the rest fall off from here. */
  opacity: number;
  /** Tint past/future, rather than drawing plain desaturated ghosts. */
  colorize: boolean;
}

export const DEFAULT_ONION_SKIN: OnionSkinSettings = {
  enabled: false,
  before: 2,
  after: 2,
  step: 1,
  opacity: 0.35,
  colorize: true,
};

export interface OnionSkinFrame {
  frame: number;
  /** 0..1 alpha this ghost draws at. */
  opacity: number;
  /** Colour to tint with, or null when `colorize` is off. */
  tint: string | null;
  side: 'before' | 'after';
}

/**
 * The ghosts to draw for `currentFrame`, **in draw order — farthest first**.
 *
 * Draw order is part of the contract, not an accident of iteration: ghosts are
 * translucent and overlap, so painting nearest-first buries the frame closest
 * to the playhead under the ones furthest from it and the sense of direction
 * inverts. Callers should draw the array front to back exactly as returned.
 *
 * Frames outside `bounds` are dropped rather than clamped. Clamping would stack
 * several ghosts on the first frame of the comp, which reads as one very solid
 * ghost — a completely different picture from "there is nothing before this".
 */
export function onionSkinPlan(
  currentFrame: number,
  settings: OnionSkinSettings,
  bounds: { min: number; max: number },
): OnionSkinFrame[] {
  if (!settings.enabled) return [];
  const step = Math.max(1, Math.floor(settings.step) || 1);
  const before = Math.max(0, Math.floor(settings.before) || 0);
  const after = Math.max(0, Math.floor(settings.after) || 0);
  if (before === 0 && after === 0) return [];
  const peak = Math.min(1, Math.max(0, settings.opacity));
  if (peak === 0) return [];

  const out: OnionSkinFrame[] = [];

  // Farthest first on each side, so the array is already in draw order once the
  // two sides are concatenated furthest-out to nearest-in.
  const side = (count: number, dir: -1 | 1, name: 'before' | 'after'): OnionSkinFrame[] => {
    const list: OnionSkinFrame[] = [];
    for (let i = count; i >= 1; i--) {
      const frame = currentFrame + dir * i * step;
      if (frame < bounds.min || frame > bounds.max) continue;
      list.push({
        frame,
        // Linear falloff that never reaches zero: the outermost ghost is
        // `peak/count`, still visible. A falloff to 0 makes the last ghost a
        // no-op and the count control appear capped.
        opacity: peak * ((count - i + 1) / count),
        tint: settings.colorize ? (name === 'before' ? ONION_PAST_TINT : ONION_FUTURE_TINT) : null,
        side: name,
      });
    }
    return list;
  };

  // Interleave by distance so the two sides fall off together rather than one
  // side sitting entirely on top of the other.
  const past = side(before, -1, 'before');
  const future = side(after, 1, 'after');
  const maxLen = Math.max(past.length, future.length);
  for (let i = 0; i < maxLen; i++) {
    if (past[i]) out.push(past[i]!);
    if (future[i]) out.push(future[i]!);
  }
  return out;
}

/**
 * A signature for a plan plus the view it was drawn under.
 *
 * The ghosts cost a full comp render EACH, so they must not be redrawn on
 * repaints that cannot change them — a hover, a selection change, a chrome
 * toggle. Anything that WOULD change them (the playhead, the settings, an edit,
 * the view transform) belongs in here.
 */
export function onionSkinSignature(
  currentFrame: number,
  settings: OnionSkinSettings,
  invalidationKey: string,
): string {
  if (!settings.enabled) return '';
  return [
    invalidationKey,
    currentFrame,
    settings.before,
    settings.after,
    settings.step,
    settings.opacity,
    settings.colorize ? 1 : 0,
  ].join(':');
}
