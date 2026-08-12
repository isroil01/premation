/** A noop function. */
export const noop = (): void => {};

/** Stable identity function. */
export const identity = <T,>(x: T): T => x;

/** Generate a short id (not cryptographically secure). */
export function shortId(prefix = ''): string {
  const rand = Math.random().toString(36).slice(2, 8);
  const time = Date.now().toString(36).slice(-4);
  return `${prefix}${prefix ? '_' : ''}${time}${rand}`;
}

/** Clamp a number to [min, max]. */
export const clamp = (n: number, min: number, max: number): number =>
  Math.min(Math.max(n, min), max);

/**
 * Clamp to [0, 1]. Anything non-finite — NaN, `undefined`, `null`, a string —
 * becomes **0**.
 *
 * There were ~17 hand-written copies of this across `src/core`, nearly all
 * `v < 0 ? 0 : v > 1 ? 1 : v`. That expression is written for numbers and is
 * silently permissive for everything else: `undefined` satisfies neither
 * comparison, so it comes back **untouched**, and NaN does the same.
 *
 * That permissiveness was load-bearing exactly once, and expensively. In
 * `applyStrokeStyle`, `globalAlpha *= clamp01(undefined)` assigned NaN, which
 * the Canvas2D spec ignores — so the stroke drew opaque, correctly, for two
 * reasons nobody chose. Unifying on this stricter version without first fixing
 * that call site moved **112 render-test scenes** and lost fidelity on 49.
 * The call site now states its own default, so 0 here is safe.
 *
 * A non-finite value reaching a clamp is a defect upstream. 0 makes it visible
 * at the first opportunity instead of letting it travel as NaN into pixel data,
 * where it either blanks a layer or gets silently discarded by a canvas.
 */
export const clamp01 = (v: number): number => (v > 0 ? (v > 1 ? 1 : v) : 0);
