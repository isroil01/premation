/** Monotonic id generators — deterministic within a process, no global crypto. */

let counter = 0;

/** A process-unique numeric id (fast, used for resource handles). */
export function nextId(): number {
  counter += 1;
  return counter;
}

/** A stable string key from parts (used for resource-cache dedup keys). */
export function makeKey(...parts: Array<string | number | boolean | null | undefined>): string {
  return parts.map((p) => (p === null || p === undefined ? '~' : String(p))).join('|');
}

/** FNV-1a 32-bit hash of a string — cheap, stable content key for shaders. */
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
