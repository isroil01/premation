/**
 * Binary-search helpers for keeping sorted arrays (markers by frame, layers by
 * start) fast to query and insert into — the backbone of the engine's O(log n)
 * seeking and range queries at scale.
 */

/** First index whose key is >= `value` (a.k.a. lower_bound). */
export function lowerBound<T>(items: readonly T[], value: number, key: (item: T) => number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (key(items[mid]!) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index whose key is > `value` (a.k.a. upper_bound). */
export function upperBound<T>(items: readonly T[], value: number, key: (item: T) => number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (key(items[mid]!) <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Insert `item` into a sorted array, preserving order by `key`. */
export function insertSorted<T>(items: T[], item: T, key: (item: T) => number): number {
  const idx = lowerBound(items, key(item), key);
  items.splice(idx, 0, item);
  return idx;
}
