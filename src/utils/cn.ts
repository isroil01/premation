/**
 * Class-name composition helper. Filters out falsy values and joins with spaces.
 *
 *   cn('btn', isActive && 'btn--active', size && `btn--${size}`)
 *
 * Does not depend on any library. Used everywhere instead of classnames/clsx.
 */

export type ClassValue = string | number | false | null | undefined;

export function cn(...values: ReadonlyArray<ClassValue>): string {
  let out = '';
  for (const v of values) {
    if (!v && v !== 0) continue;
    if (out) out += ' ';
    out += String(v);
  }
  return out;
}
