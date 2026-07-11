/**
 * Id generation. Deterministic-friendly: a monotonic counter mixed with a short
 * random suffix. No crypto dependency so it runs anywhere (Node, browser,
 * worker). Ids are opaque strings.
 */

let counter = 0;

export function uid(prefix = 'id'): string {
  counter += 1;
  const rand = Math.floor(Math.random() * 0xfffff).toString(36);
  return `${prefix}_${counter.toString(36)}${rand}`;
}

/** Reset the internal counter (tests only). */
export function __resetIdCounter(): void {
  counter = 0;
}
