/**
 * Rich text runs — per-character static styling within one text layer.
 *
 * Storage follows the `__animators` precedent in textAnimators.ts: a hidden,
 * `__`-prefixed JSON array on the Text component's props. The engine's
 * `buildComponents` spreads arbitrary JSON into props and `sceneProjectIO`
 * captures it by deep clone, so an array persists and round-trips for free —
 * and the `__` prefix keeps it out of the generic NodeInspector's prop list.
 *
 * Runs index the **code-point array** `[...text]`, the same index space
 * `unitPositions` uses, so a run and an animator selector mean the same thing
 * by "character 5". (Neither is grapheme-cluster aware — a ZWJ emoji still
 * splits. That is a pre-existing limit of the animator path, not a new one.)
 *
 * Invariant this module maintains: the stored runs are **disjoint, sorted, and
 * clamped** to the text. Layout tolerates violations (documents written by
 * older builds), but everything written from here is normalized.
 */

import type { SceneNode } from '@core/types';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { bumpScene } from '@stores/sceneStore';
import type { RichRun, TextStyle } from './textLayout';

export type { RichRun } from './textLayout';

/** The style fields a run may override. Paragraph settings (align, lineHeight,
 *  paragraphSpacing) are deliberately absent — they cannot vary per character. */
export const RUN_STYLE_KEYS = [
  'fontSize',
  'fontFamily',
  'fontWeight',
  'fontStyle',
  'letterSpacing',
  'fill',
] as const satisfies ReadonlyArray<keyof TextStyle>;

export type RunStyleKey = (typeof RUN_STYLE_KEYS)[number];

interface CompRef {
  id: string;
  props: Record<string, unknown>;
}

function textComponent(node: SceneNode): CompRef | undefined {
  return node.components.find((c) => c.type === 'Text') as CompRef | undefined;
}

/** Read a node's stored runs (empty when none). */
export function readRuns(node: SceneNode): RichRun[] {
  const t = textComponent(node);
  const raw = t?.props.__runs;
  if (!Array.isArray(raw)) return [];
  // A stored document is untrusted input: drop anything malformed rather than
  // letting a NaN index poison the pen arithmetic downstream.
  return (raw as unknown[]).filter(isRun);
}

function isRun(v: unknown): v is RichRun {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Partial<RichRun>;
  return (
    Number.isFinite(r.start) &&
    Number.isFinite(r.end) &&
    typeof r.style === 'object' &&
    r.style !== null
  );
}

/** True once a layer actually carries styling — the flag layout paths use to
 *  decide whether the cheap whole-string draw is still valid. */
export function hasRuns(node: SceneNode): boolean {
  return readRuns(node).length > 0;
}

function isEmptyStyle(style: Partial<TextStyle>): boolean {
  return RUN_STYLE_KEYS.every((k) => style[k] === undefined);
}

function sameStyle(a: Partial<TextStyle>, b: Partial<TextStyle>): boolean {
  return RUN_STYLE_KEYS.every((k) => a[k] === b[k]);
}

/**
 * Make runs disjoint, sorted, clamped to `length`, and free of empties.
 *
 * Overlaps resolve last-wins, matching `resolveGlyphStyle`'s fold order: where
 * runs collide, the later run's fields sit on top of the earlier one's rather
 * than replacing them wholesale, so bolding a word inside a red span leaves it
 * red *and* bold.
 */
export function normalizeRuns(
  runs: ReadonlyArray<RichRun>,
  length: number,
): RichRun[] {
  if (length <= 0) return [];

  // Resolve to a per-character style map — O(runs x length), but a text layer
  // is a headline, not a novel, and it makes overlap semantics obvious rather
  // than clever.
  const perChar: Array<Partial<TextStyle> | undefined> = new Array(length);
  for (const run of runs) {
    const start = Math.max(0, Math.floor(run.start));
    const end = Math.min(length, Math.floor(run.end));
    if (!(end > start) || isEmptyStyle(run.style)) continue;
    for (let i = start; i < end; i++) {
      perChar[i] = { ...(perChar[i] ?? {}), ...pickStyle(run.style) };
    }
  }

  // Coalesce adjacent identical styles back into spans.
  const out: RichRun[] = [];
  let i = 0;
  while (i < length) {
    const style = perChar[i];
    if (!style || isEmptyStyle(style)) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < length && perChar[j] && sameStyle(perChar[j]!, style)) j++;
    out.push({ start: i, end: j, style });
    i = j;
  }
  return out;
}

/** Keep only the fields a run is allowed to carry, dropping `undefined`s so
 *  `sameStyle` can compare by key without false negatives. */
function pickStyle(style: Partial<TextStyle>): Partial<TextStyle> {
  const out: Partial<TextStyle> = {};
  for (const k of RUN_STYLE_KEYS) {
    const v = style[k];
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/**
 * Apply `style` to `[start, end)` and return the normalized result.
 *
 * Passing `undefined` for a field clears it back to the layer default — that is
 * what "no override" means, and it is how the inspector removes a run style
 * without having to know whether a run exists.
 */
export function applyStyleToRange(
  runs: ReadonlyArray<RichRun>,
  start: number,
  end: number,
  style: Partial<TextStyle>,
  length: number,
): RichRun[] {
  const lo = Math.max(0, Math.min(start, end));
  const hi = Math.min(length, Math.max(start, end));
  if (!(hi > lo)) return normalizeRuns(runs, length);

  const cleared = new Set<RunStyleKey>();
  for (const k of RUN_STYLE_KEYS) {
    if (k in style && style[k] === undefined) cleared.add(k);
  }

  // Explicit clears must survive normalization, which drops `undefined`s — so
  // strip the field from any existing run over the range instead of layering an
  // `undefined` on top of it.
  const base = normalizeRuns(runs, length).flatMap((run): RichRun[] => {
    if (cleared.size === 0 || run.end <= lo || run.start >= hi) return [run];
    const kept = { ...run.style };
    for (const k of cleared) delete kept[k];
    const pieces: RichRun[] = [];
    if (run.start < lo) pieces.push({ start: run.start, end: lo, style: run.style });
    const midStart = Math.max(run.start, lo);
    const midEnd = Math.min(run.end, hi);
    if (midEnd > midStart && !isEmptyStyle(kept)) {
      pieces.push({ start: midStart, end: midEnd, style: kept });
    }
    if (run.end > hi) pieces.push({ start: hi, end: run.end, style: run.style });
    return pieces;
  });

  const added = pickStyle(style);
  if (isEmptyStyle(added)) return normalizeRuns(base, length);
  return normalizeRuns([...base, { start: lo, end: hi, style: added }], length);
}

/**
 * The style shared by every character in `[start, end)`.
 *
 * A field is reported only when every character agrees; where they differ the
 * key is absent from `style` and present in `mixed`. That is what lets the
 * inspector show a "Mixed" affordance instead of silently displaying the first
 * character's value and overwriting the rest on the next edit — the read-gap
 * pattern this codebase has been burned by before.
 */
export function styleOverRange(
  runs: ReadonlyArray<RichRun>,
  start: number,
  end: number,
  length: number,
): { style: Partial<TextStyle>; mixed: Set<RunStyleKey> } {
  const lo = Math.max(0, Math.min(start, end));
  const hi = Math.min(length, Math.max(start, end));
  const mixed = new Set<RunStyleKey>();
  if (!(hi > lo)) return { style: {}, mixed };

  const norm = normalizeRuns(runs, length);
  const styleAt = (i: number): Partial<TextStyle> => {
    for (const run of norm) if (i >= run.start && i < run.end) return run.style;
    return {};
  };

  const first = styleAt(lo);
  const style: Partial<TextStyle> = { ...first };
  for (let i = lo + 1; i < hi; i++) {
    const s = styleAt(i);
    for (const k of RUN_STYLE_KEYS) {
      if (s[k] !== first[k]) {
        mixed.add(k);
        delete style[k];
      }
    }
  }
  return { style, mixed };
}

/**
 * Re-index runs across a content edit.
 *
 * Without this, editing the text leaves runs pointing at whatever now occupies
 * those indices — type a word at the front and the whole layer's styling shifts
 * one word right. We can't know the true edit from before/after strings alone,
 * so we take the common prefix and suffix (which is the actual edit for
 * typing, pasting and deleting — every edit the overlay can produce) and
 * translate spans across the changed middle.
 */
export function reindexRuns(
  runs: ReadonlyArray<RichRun>,
  before: string,
  after: string,
): RichRun[] {
  const a = [...before];
  const b = [...after];
  if (a.length === 0) return [];

  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  ) {
    suf++;
  }

  const removedFrom = pre;
  const removedTo = a.length - suf;
  const delta = b.length - a.length;

  const map = (i: number): number => {
    if (i <= removedFrom) return i;
    if (i >= removedTo) return i + delta;
    // Inside the replaced span — collapse to its start. The old characters are
    // gone; their styling has nothing left to describe.
    return removedFrom;
  };

  return normalizeRuns(
    runs.map((r) => ({ start: map(r.start), end: map(r.end), style: r.style })),
    b.length,
  );
}

/** Persist runs through the graph so the rebuilt plain-view keeps them. */
export function writeRuns(nodeId: string, runs: ReadonlyArray<RichRun>): void {
  const node = defaultSceneGraph.getNode(nodeId);
  const t = node ? textComponent(node) : undefined;
  if (!node || !t) return;
  defaultSceneGraph.writeProp(nodeId, t.id, '__runs', [...runs]);
  bumpScene();
}
