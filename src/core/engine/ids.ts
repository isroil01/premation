/**
 * Deterministic id minting for everything the engine creates (layers, comps,
 * folders, effects, masks, groups, markers, render items, keyframes).
 *
 * Replay (§12) must reproduce a document EXACTLY, so no id the engine writes may
 * come from `Math.random`, a clock, or a module counter that other code also
 * advances. One allocator per engine: `<prefix><n>` with a counter per prefix,
 * skipping any id the document already uses (`taken`), never reusing one within
 * a session. The counters are part of the command log header, so a replay
 * started mid-session continues from the same numbers.
 */

import { defaultAnimation, stableKeyframeId, stableKeyframeIdSeq } from '@motion/animation';

export type IdCounters = Record<string, number>;

export class IdAllocator {
  private counters: IdCounters = {};

  /** Next unused `<prefix><n>`; `taken` says whether an id is already in the document. */
  next(prefix: string, taken: (id: string) => boolean): string {
    let n = this.counters[prefix] ?? 0;
    let id: string;
    do {
      n += 1;
      id = `${prefix}${n}`;
    } while (taken(id));
    this.counters[prefix] = n;
    return id;
  }

  /**
   * The next stable keyframe id (`k<n>`, the shape the 1.9.0 migration writes).
   * Counter-based and uniqueness-checked against every id the animation engine
   * currently holds; the counter is seeded from the document on reset.
   */
  nextKeyframe(taken: (id: string) => boolean): string {
    let n = this.counters.k ?? 0;
    let id: string;
    do {
      n += 1;
      id = stableKeyframeId(n);
    } while (taken(id));
    this.counters.k = n;
    return id;
  }

  /** Seed the keyframe counter past every `k<n>` the document holds. */
  seedKeyframes(ids: Iterable<string>): void {
    let max = this.counters.k ?? 0;
    for (const id of ids) max = Math.max(max, stableKeyframeIdSeq(id));
    this.counters.k = max;
  }

  state(): IdCounters {
    return { ...this.counters };
  }

  restore(state: IdCounters): void {
    this.counters = { ...state };
  }

  reset(): void {
    this.counters = {};
  }
}

/** Every keyframe id the animation engine holds right now (scalar and data tracks). */
export function allKeyframeIds(): Set<string> {
  const out = new Set<string>();
  const snap = defaultAnimation.snapshot();
  for (const byProp of Object.values(snap.tracks)) {
    for (const track of Object.values(byProp)) for (const k of track.keyframes) if (k.id) out.add(k.id);
  }
  for (const byProp of Object.values(snap.data ?? {})) {
    for (const track of Object.values(byProp)) for (const k of track.keyframes) if (k.id) out.add(k.id);
  }
  return out;
}
