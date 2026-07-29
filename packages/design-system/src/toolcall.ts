/**
 * `ToolCall` — the only thing any of the three libraries ever produces.
 *
 * Design templates, motion techniques and product-motion techniques all emit
 * arrays of these and execute nothing. That is what lets the same emitters run in
 * three places that share no runtime: the renderer (against the live document),
 * the backend planner (to cost and validate a plan before it is executed), and a
 * test (to snapshot output byte-for-byte with no engine at all).
 *
 * It is deliberately the same shape the agent loop already receives from a
 * provider, so a library-emitted call and a model-emitted call are
 * indistinguishable downstream — the registry validates and executes both
 * through one path, and one prompt stays one undo entry either way.
 */

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

/** Terse constructor, because an emitter is mostly a list of these. */
export function mk(name: string, args: Record<string, unknown>): ToolCall {
  return { name, args };
}

/**
 * Deterministic PRNG (mulberry32).
 *
 * Every emitter takes a seed and draws all its variation from here. Two
 * consequences, both load-bearing:
 *
 *  • **Same seed → byte-identical output**, which is the project's determinism
 *    acceptance criterion and is snapshot-testable.
 *  • **Different seed → a genuinely different result** from the *same* technique,
 *    which is how 20 techniques cover more ground than 20 shapes.
 *
 * `Math.random()` would break both. Nothing in these packages may call it.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pick one item deterministically. */
export function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length) % items.length]!;
}

/** A deterministic integer in [min, max]. */
export function pickInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/**
 * Fisher–Yates, seeded.
 *
 * Used for things like which line of a headline gets the accent — an ordering
 * that must vary between runs but be reproducible within one.
 */
export function shuffled<T>(rng: () => number, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
