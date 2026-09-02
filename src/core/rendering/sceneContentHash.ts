/**
 * A content-derived fingerprint of everything that can change pixels.
 *
 * ── What this replaces, and why ─────────────────────────────────────────────
 *
 * The frame cache's invalidation key was built from `sceneRevision` and the
 * animation revision — MONOTONIC COUNTERS. That is a fine "did anything
 * change?" signal and a poor identity, and the difference costs in two places:
 *
 *  • **Undo throws the cache away for nothing.** Undo bumps the revision, so the
 *    key moves, so every cached frame is discarded — even though the scene is
 *    now bit-identical to a state whose frames were just evicted. Round-tripping
 *    an edit is the single most common thing anyone does in an editor, and it
 *    was the most expensive.
 *  • **Nothing can be cached across a restart.** A counter resets to 0 each
 *    launch, so a persisted frame from a previous session is indistinguishable
 *    from a *different project's* frame at its own rev 0. That is why
 *    `frameDiskCache` purges on open, and it is the prerequisite that has to
 *    land before it can stop doing so.
 *
 * ── The safety property ─────────────────────────────────────────────────────
 *
 * A counter is CONSERVATIVE: any change invalidates. A content hash is precise,
 * which means an omission is no longer harmless — a field that affects pixels
 * and is not hashed produces a cache that serves a stale frame after a real
 * edit, silently.
 *
 * So this hashes node state WHOLESALE rather than cherry-picking the fields it
 * believes matter: every component's props, in full, plus the node flags the
 * renderer reads. Adding a new prop to a component therefore cannot be
 * forgotten here, because nothing here enumerates props by name. That is the
 * whole design: be exhaustive by construction rather than by vigilance.
 *
 * ── Cost ────────────────────────────────────────────────────────────────────
 *
 * Linear in scene size, and intended to run ONCE PER EDIT — memoize it on the
 * revision counters (see {@link memoizedSceneContentHash}), never per frame.
 * The counters remain the cheap "did anything change?" signal they were always
 * good at; this turns that signal into an identity.
 */

import type { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';

/** Minimal graph surface, so this is testable without the real scene graph. */
export interface HashableGraph {
  traverse(visit: (node: SceneNode) => void): void;
}

/**
 * 64-bit-ish FNV-1a, as two interleaved 32-bit lanes.
 *
 * One 32-bit lane collides at around 77k distinct inputs (birthday bound), and
 * a scene edit history reaches that in an afternoon — a collision there means
 * showing a stale frame, so the extra lane is not paranoia.
 */
class Hasher {
  private a = 0x811c9dc5;
  private b = 0x01000193;

  push(s: string): void {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      this.a ^= c;
      this.a = Math.imul(this.a, 0x01000193) >>> 0;
      this.b = (this.b + c) >>> 0;
      this.b = Math.imul(this.b, 0x85ebca6b) >>> 0;
      this.b ^= this.b >>> 13;
    }
    // A separator, so ['ab','c'] and ['a','bc'] cannot hash alike — the field
    // boundaries are part of the content.
    this.a = (this.a ^ 0x1f) >>> 0;
  }

  digest(): string {
    return `${(this.a >>> 0).toString(36)}${(this.b >>> 0).toString(36)}`;
  }
}

/**
 * Stable JSON for a props bag.
 *
 * Keys are SORTED, because object key order is insertion order in JS and a prop
 * rewritten to the same value in a different order would otherwise read as a
 * change — which would reintroduce exactly the spurious invalidation this
 * exists to remove.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** Fingerprint of the scene graph and every animation track on it. */
export function sceneContentHash(graph: HashableGraph, anim: AnimationEngine): string {
  const h = new Hasher();

  // ── Scene ────────────────────────────────────────────────────────
  // Collected then SORTED by id, so the hash is independent of how the walk
  // happens to be implemented.
  //
  // Which is why each node carries its own CHILD ORDER into the row. This used
  // to claim sibling order "arrives via each node's own `parent`", and that is
  // false: stacking order lives in the PARENT's child array and nowhere else.
  // A Bring Forward / Send Backward / drag-reorder changes no node's parent, no
  // transform and no prop, so every row came out byte-identical and the hash
  // did not move — the viewport frame cache then blitted the pre-reorder frame
  // and the canvas kept the old stacking order while the Scene tree and the
  // timeline (which read the graph directly) showed the new one. Reported as
  // "I selected the layer underneath and Bring Forward does nothing".
  const rows: string[] = [];
  graph.traverse((n) => {
    const parts: string[] = [
      n.id,
      String(n.parent ?? ''),
      // Z-ORDER. Back-to-front, the scene graph's one authority for stacking.
      stableStringify([...((n as unknown as { children?: string[] }).children ?? [])]),
      n.visible === false ? '0' : '1',
      n.locked ? '1' : '0',
      (n as unknown as { solo?: boolean }).solo ? '1' : '0',
      stableStringify((n as unknown as { transform?: unknown }).transform),
    ];
    // Components in ARRAY order — that order is meaningful (`readBase` is
    // last-write-wins, `transformComponent` is first-match), so a reorder is a
    // pixel change.
    for (const c of n.components ?? []) {
      parts.push(c.id, c.type, stableStringify(c.props));
    }
    rows.push(parts.join(''));
  });
  rows.sort();
  for (const r of rows) h.push(r);

  // ── Animation ────────────────────────────────────────────────────
  h.push('anim');
  const nodeIds = [...anim.getAnimatedNodeIds()].sort();
  for (const id of nodeIds) {
    h.push(id);
    for (const prop of [...anim.getAnimatedPropPaths(id)].sort()) {
      h.push(prop);
      const kfs = anim.getTrackKeyframes(id, prop);
      if (kfs) for (const k of kfs) h.push(stableStringify(k));
      // Expressions change pixels without touching a keyframe, and a DISABLED
      // one changes them back — so both the source and the flag are hashed.
      const src = anim.getExpressionSrc?.(id, prop);
      if (src !== undefined) h.push(src);
      h.push(anim.isExpressionEnabled?.(id, prop) ? '1' : '0');
    }
    // Data tracks (puppet pins, gradient stops, text) live in a separate store
    // and are just as capable of moving pixels.
    for (const prop of [...(anim.getDataAnimatedPropPaths?.(id) ?? [])].sort()) {
      h.push(prop);
      h.push(stableStringify(anim.getDataTrack?.(id, prop)));
    }
  }

  return h.digest();
}

/**
 * `sceneContentHash`, computed at most once per (sceneRev, animRev).
 *
 * The counters are still the right "did anything change?" signal — they are
 * O(1) and always correct about that. What they cannot do is say WHAT the scene
 * is, so they are used here as the memo key and the hash supplies the identity.
 * Recomputing per frame would put a full scene walk in the render loop.
 */
let memo: { sceneRev: number; animRev: number; hash: string } | null = null;

export function memoizedSceneContentHash(
  graph: HashableGraph,
  anim: AnimationEngine,
  sceneRev: number,
  animRev: number,
): string {
  if (memo && memo.sceneRev === sceneRev && memo.animRev === animRev) return memo.hash;
  const hash = sceneContentHash(graph, anim);
  memo = { sceneRev, animRev, hash };
  return hash;
}

/** Drop the memo. For tests, and for a hard scene reset. */
export function resetSceneContentHashMemo(): void {
  memo = null;
}
