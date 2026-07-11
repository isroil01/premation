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
