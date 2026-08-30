/**
 * Which layer in one composition is "the same element" as a layer in another.
 *
 * This is the whole problem behind Smart Animate. Given two boards a person
 * designed separately — a before and an after — the transition writes itself
 * ONCE you know that the title here is the title there. Get the correspondence
 * wrong and the app confidently animates a headline into a logo.
 *
 * ── Strong signals only, in priority order ─────────────────────────
 * Matching is deliberately conservative. Every rule below is something a
 * person would accept as identity if you pointed at it:
 *
 *   1. Same NAME in the same place. Two layers called "Title" both sitting
 *      directly under the root are the same title. Naming is how designers
 *      already express identity, and it is what Figma matches on.
 *   2. Same NAME anywhere. The element moved between groups but kept its name.
 *   3. Same SOURCE. An image or video layer that was renamed is still that
 *      piece of footage.
 *   4. Same TEXT. A text layer whose *content* is identical is the same words,
 *      whatever the layer got called.
 *
 * There is deliberately no geometric or visual similarity rule. "These are
 * both roughly square and roughly here" produces matches nobody asked for, and
 * a wrong match is far worse than no match: an unmatched layer just fades,
 * which reads as a deliberate cut, while a wrong one flies across the screen
 * and turns into something else.
 *
 * KIND MUST AGREE throughout. Morphing a text layer into a video is never what
 * was meant, however similar their names.
 *
 * Everything here is pure — descriptors in, pairs out — so the correspondence
 * can be tested exhaustively without a scene graph. `smartAnimate.ts` is what
 * turns pairs into keyframes.
 */

/** What matching needs to know about one layer. */
export interface LayerDescriptor {
  id: string;
  name: string;
  /** `readNodeKind` — text, video, image, shape, group… Must agree to match. */
  kind: string;
  /** Names from the composition root down to (not including) this layer. */
  path: readonly string[];
  /** Media layers: the asset behind them. */
  assetId?: string | undefined;
  /** Text layers: their content. */
  text?: string | undefined;
}

export type MatchReason = 'name-and-place' | 'name' | 'source' | 'text';

export interface LayerMatch {
  from: LayerDescriptor;
  to: LayerDescriptor;
  reason: MatchReason;
}

export interface MatchResult {
  pairs: LayerMatch[];
  /** In the first composition only — these leave. */
  onlyFrom: LayerDescriptor[];
  /** In the second only — these arrive. */
  onlyTo: LayerDescriptor[];
}

/** Case- and whitespace-insensitive: "Title " and "title" are one name. */
function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function samePlace(a: LayerDescriptor, b: LayerDescriptor): boolean {
  if (a.path.length !== b.path.length) return false;
  return a.path.every((segment, i) => normalize(segment) === normalize(b.path[i] ?? ''));
}

/**
 * One matching pass.
 *
 * `key` returns null for a layer the rule cannot speak about (a shape has no
 * asset, a video has no text), which is not the same as an empty string — two
 * layers that both "have no text" are not thereby the same layer, and an
 * earlier version that let empty keys collide happily matched every shape in
 * the board to the first shape in the other one.
 *
 * Ties are resolved by document order, which is stable and is also the order a
 * person reads the layer list in. Both sides consume greedily, so a layer can
 * take part in exactly one pair.
 */
function pass(
  from: readonly LayerDescriptor[],
  to: readonly LayerDescriptor[],
  reason: MatchReason,
  key: (layer: LayerDescriptor) => string | null,
  extra?: (a: LayerDescriptor, b: LayerDescriptor) => boolean,
): LayerMatch[] {
  const buckets = new Map<string, LayerDescriptor[]>();
  for (const layer of to) {
    const k = key(layer);
    if (k === null) continue;
    const bucket = buckets.get(k);
    if (bucket) bucket.push(layer);
    else buckets.set(k, [layer]);
  }

  const pairs: LayerMatch[] = [];
  for (const source of from) {
    const k = key(source);
    if (k === null) continue;
    const candidates = buckets.get(k);
    if (!candidates || candidates.length === 0) continue;
    const index = candidates.findIndex(
      (candidate) => candidate.kind === source.kind && (!extra || extra(source, candidate)),
    );
    if (index < 0) continue;
    // Removed from the bucket so a second source with the same key cannot
    // claim the same target.
    const target = candidates.splice(index, 1)[0]!;
    pairs.push({ from: source, to: target, reason });
  }
  return pairs;
}

/**
 * Pair up the layers of two compositions.
 *
 * The passes run in priority order and each consumes what it matched, so a
 * strong signal always wins over a weak one: a layer that matches by name in
 * the same place is never later re-matched to something else by text.
 *
 * The two sides are tracked separately. Ids are unique within a composition but
 * can collide ACROSS them — duplicating a comp keeps every layer name while
 * minting new ids, and hand-built scenes reuse ids freely — so one shared
 * "seen" set would let a source id block the target that happens to share it.
 */
export function matchLayers(
  from: readonly LayerDescriptor[],
  to: readonly LayerDescriptor[],
): MatchResult {
  const usedFrom = new Set<string>();
  const usedTo = new Set<string>();
  const pairs: LayerMatch[] = [];

  const run = (
    reason: MatchReason,
    key: (layer: LayerDescriptor) => string | null,
    extra?: (a: LayerDescriptor, b: LayerDescriptor) => boolean,
  ): void => {
    const found = pass(
      from.filter((l) => !usedFrom.has(l.id)),
      to.filter((l) => !usedTo.has(l.id)),
      reason,
      key,
      extra,
    );
    for (const pair of found) {
      usedFrom.add(pair.from.id);
      usedTo.add(pair.to.id);
      pairs.push(pair);
    }
  };

  run('name-and-place', (l) => normalize(l.name) || null, samePlace);
  run('name', (l) => normalize(l.name) || null);
  run('source', (l) => (l.assetId ? `asset:${l.assetId}` : null));
  run('text', (l) => (l.text && l.text.trim() ? `text:${normalize(l.text)}` : null));

  return {
    pairs,
    onlyFrom: from.filter((l) => !usedFrom.has(l.id)),
    onlyTo: to.filter((l) => !usedTo.has(l.id)),
  };
}
