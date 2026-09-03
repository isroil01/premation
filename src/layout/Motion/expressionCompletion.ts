/**
 * Expression autocomplete — the pure part.
 *
 * WHY THIS FILE EXISTS. The editor used to present the whole API as a strip of
 * ~50 chips: every name the language has, all the time, in the order they were
 * added, none of them related to what the caret is actually next to. That is a
 * list, not a completion — it costs a round trip to the mouse, it inserts at
 * the caret without regard to the word already half-typed (`wig` + a click on
 * `wiggle()` produced `wigwiggle(2, 30)`), and it scales the wrong way: every
 * function added to the language made the panel worse.
 *
 * Everything here is a pure function of (text, caret, api) so the behaviour can
 * be pinned without a DOM — `expressionCompletion.test.ts` is the guard, and
 * the React component is left with nothing but presentation and key handling.
 *
 * The API table itself lives in `packages/animation/src/expressions.ts` and is
 * the authority on what exists (see the §2·0 note there — `scope`, `API_NAMES`
 * and `EXPRESSION_API` are held together by `expressionApi.test.ts`). This file
 * adds ONE thing that table cannot express: which names live *inside* the
 * container objects (`thisComp`, `thisLayer`, `thisProperty`, `marker`,
 * `Math`), because the table is flat and models `thisComp` as a single entry
 * whose example happens to read `thisComp.width`.
 */

import { EXPRESSION_API } from '@motion/animation';

/** One entry of the language reference — the shape `EXPRESSION_API` holds. */
export interface ApiItem {
  /** Text inserted into the source (usually a filled-in example). */
  insert: string;
  /** Display name, e.g. `wiggle()`. */
  label: string;
  /** One line of plain-language documentation. */
  hint: string;
}

/** How a candidate matched the typed prefix — drives ranking, and nothing else. */
export type MatchKind = 'exact' | 'prefix' | 'substring' | 'fuzzy';

export interface CompletionItem extends ApiItem {
  /** The example form, shown under the list so the shape is visible before accepting. */
  signature: string;
  match: MatchKind;
}

/** The identifier run the caret sits in, split at its final dot. */
export interface CaretWord {
  /** Everything from `start` to the caret, e.g. `thisLayer.na`. */
  word: string;
  /** Index in the source where the run begins. */
  start: number;
  /** Always the (clamped) caret. */
  end: number;
  /** Text before the final dot — `''` when the run has no dot. */
  object: string;
  /** The fragment after the final dot; equals `word` when there is no dot. */
  member: string;
}

export interface CompletionContext {
  /** Object whose members to offer, i.e. `CaretWord.object`. */
  object?: string;
  /** Maximum items returned. Defaults to `MAX_COMPLETIONS`. */
  limit?: number;
}

/** The popup shows at most this many rows; ranking decides which. */
export const MAX_COMPLETIONS = 8;

const IDENT = /[A-Za-z0-9_$]/;

/**
 * The identifier (possibly dotted) immediately left of the caret.
 *
 * Runs that begin with a digit are NUMBERS, not identifiers — `wiggle(2, 3`
 * and `time - 0.5` must not open a completion list, and the naive "scan back
 * over word characters" does exactly that, since `.` is in the run.
 */
export function wordAtCaret(text: string, caret: number): CaretWord {
  const end = Math.max(0, Math.min(caret, text.length));
  let start = end;
  while (start > 0) {
    const ch = text[start - 1];
    if (ch === undefined) break;
    if (!IDENT.test(ch) && ch !== '.') break;
    start--;
  }
  const word = text.slice(start, end);
  const none: CaretWord = { word: '', start: end, end, object: '', member: '' };
  if (word === '' || /^[0-9]/.test(word) || /^\.[0-9]/.test(word)) return none;

  const dot = word.lastIndexOf('.');
  return dot === -1
    ? { word, start, end, object: '', member: word }
    : { word, start, end, object: word.slice(0, dot), member: word.slice(dot + 1) };
}

/**
 * Members of the container objects the evaluator binds.
 *
 * Kept beside the completion rather than in the API table because the table is
 * flat by design: it answers "what names exist at the top level", and these are
 * one level in. Sourced from the objects built in `expressions.ts` `run()` —
 * `thisComp`, `thisLayer`, `thisProperty`, the marker scope — so nothing here
 * is invented. A member that stopped existing would still be offered; that is
 * the cost of the table being one-way, and it is the same cost the reference
 * chips already carried.
 */
interface MemberDef {
  /** Display name after the dot, e.g. `valueAtTime()`. */
  name: string;
  /** Inserted text after the dot; defaults to `name` for plain properties. */
  insert?: string;
  hint: string;
}

const OBJECT_MEMBERS: Readonly<Record<string, readonly MemberDef[]>> = {
  thisComp: [
    { name: 'width', hint: 'composition width in pixels' },
    { name: 'height', hint: 'composition height in pixels' },
    { name: 'duration', hint: 'composition duration in seconds' },
    { name: 'frameDuration', hint: 'seconds per frame (1 / fps)' },
    { name: 'fps', hint: 'composition frame rate' },
    { name: 'numLayers', hint: 'how many layers the comp holds' },
    { name: 'layer()', insert: "layer('Layer 1', 'x')", hint: "another layer's value, or the layer object without a property" },
    { name: 'marker', insert: 'marker.nearestKey(time).time', hint: 'COMP markers — .numKeys .key(n|"name") .nearestKey(t)' },
  ],
  thisLayer: [
    { name: 'name', hint: "this layer's name" },
    { name: 'width', hint: "this layer's width" },
    { name: 'height', hint: "this layer's height" },
    { name: 'toComp()', insert: 'toComp([0, 0])', hint: 'layer point → composition coords' },
    { name: 'fromComp()', insert: 'fromComp([960, 540])', hint: 'composition point → layer coords' },
    { name: 'toWorld()', insert: 'toWorld([0, 0])', hint: 'layer point → world coords' },
    { name: 'fromWorld()', insert: 'fromWorld([960, 540])', hint: 'world point → layer coords' },
    { name: 'marker', insert: 'marker.nearestKey(time).time', hint: 'THIS LAYER’s markers' },
  ],
  thisProperty: [
    { name: 'value', hint: 'the keyframed value' },
    { name: 'valueAtTime()', insert: 'valueAtTime(time - 0.5)', hint: 'own keyframed value at any time' },
    { name: 'velocity', hint: 'rate of change per second' },
    { name: 'speed', hint: 'magnitude of rate of change' },
    { name: 'velocityAtTime()', insert: 'velocityAtTime(time - 0.1)', hint: 'rate of change at a time' },
    { name: 'loopOut()', insert: "loopOut('cycle')", hint: 'repeat keyframes after the last' },
    { name: 'loopIn()', insert: "loopIn('cycle')", hint: 'repeat keyframes before the first' },
  ],
  marker: [
    { name: 'numKeys', hint: 'how many markers this layer has' },
    { name: 'key()', insert: "key('Beat')", hint: 'marker by 1-based index or name' },
    { name: 'nearestKey()', insert: 'nearestKey(time)', hint: 'marker closest to a time' },
  ],
  Math: [
    { name: 'abs()', insert: 'abs(value)', hint: 'absolute value' },
    { name: 'min()', insert: 'min(value, 100)', hint: 'smaller of two' },
    { name: 'max()', insert: 'max(value, 0)', hint: 'larger of two' },
    { name: 'round()', insert: 'round(value)', hint: 'nearest integer' },
    { name: 'floor()', insert: 'floor(value)', hint: 'round down' },
    { name: 'ceil()', insert: 'ceil(value)', hint: 'round up' },
    { name: 'sign()', insert: 'sign(value)', hint: '−1, 0 or 1' },
    { name: 'sqrt()', insert: 'sqrt(value)', hint: 'square root' },
    { name: 'pow()', insert: 'pow(value, 2)', hint: 'raise to a power' },
    { name: 'sin()', insert: 'sin(time * 2)', hint: 'sine — oscillate' },
    { name: 'cos()', insert: 'cos(time * 2)', hint: 'cosine — oscillate, quarter phase ahead of sine' },
    { name: 'tan()', insert: 'tan(time)', hint: 'tangent' },
    { name: 'atan2()', insert: 'atan2(1, 0)', hint: 'angle of a vector, in radians' },
    { name: 'hypot()', insert: 'hypot(3, 4)', hint: 'length of a right triangle’s hypotenuse' },
    { name: 'PI', hint: '3.14159…' },
    { name: 'E', hint: '2.71828…' },
  ],
};

/** `wiggle()` → `wiggle`. What ranking actually compares. */
function bareName(label: string): string {
  return label.replace(/\(\)$/, '');
}

/**
 * Candidates for a dotted access, or `[]` when the metadata models no members
 * for that object — which is the signal to fall back to the whole API.
 *
 * Two sources are merged: the curated table above, and any API entry whose own
 * label is dotted (`Math.sin()`), so a member added to the shared table appears
 * here without being written twice.
 */
function membersOf(object: string, api: readonly ApiItem[]): ApiItem[] {
  const out: ApiItem[] = [];
  const seen = new Set<string>();
  const push = (item: ApiItem): void => {
    if (seen.has(item.label)) return;
    seen.add(item.label);
    out.push(item);
  };
  for (const def of OBJECT_MEMBERS[object] ?? []) {
    push({
      label: `${object}.${def.name}`,
      insert: `${object}.${def.insert ?? def.name}`,
      hint: def.hint,
    });
  }
  for (const a of api) {
    if (a.label.startsWith(`${object}.`)) push(a);
  }
  return out;
}

function isSubsequence(haystack: string, needle: string): boolean {
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return needle.length === 0;
}

/**
 * Where `name` places against `prefix`, or `null` for no match.
 *
 * Lower score sorts first: an exact hit, then a case-sensitive prefix, then a
 * case-insensitive one, then a substring (earlier is better), then a
 * subsequence. The tiers matter more than the numbers — `ea` must offer
 * `ease()` before `nearestKey()`, which substring-only ranking gets wrong.
 */
function rank(name: string, prefix: string): { match: MatchKind; score: number } | null {
  if (prefix === '') return { match: 'prefix', score: 0 };
  if (name === prefix) return { match: 'exact', score: 0 };
  if (name.startsWith(prefix)) return { match: 'prefix', score: 1 };
  const n = name.toLowerCase();
  const p = prefix.toLowerCase();
  if (n === p) return { match: 'exact', score: 1.5 };
  if (n.startsWith(p)) return { match: 'prefix', score: 2 };
  const idx = n.indexOf(p);
  if (idx > 0) return { match: 'substring', score: 3 + Math.min(idx, 40) / 100 };
  if (isSubsequence(n, p)) return { match: 'fuzzy', score: 6 };
  return null;
}

/**
 * Ranked completions for a typed prefix.
 *
 * `context.object` is the text before the final dot. When the metadata models
 * that object, only its members are offered; when it does not (`foo.ba`), the
 * whole API is offered and `applyCompletion` keeps the `foo.` the user typed —
 * an unknown object is far more likely to be a real value than a typo of one
 * of ours, so silently rewriting it away would be the worse guess.
 */
export function completions(
  prefix: string,
  api: readonly ApiItem[] = EXPRESSION_API,
  context: CompletionContext = {},
): CompletionItem[] {
  const object = context.object ?? '';
  const scoped = object ? membersOf(object, api) : [];
  const pool: readonly ApiItem[] = object ? (scoped.length > 0 ? scoped : api) : api;
  // Members match on the part AFTER the dot: having typed `thisComp.wi`, the
  // prefix is `wi` and comparing it against the label `thisComp.width` would
  // score every member identically.
  const scopedNames = scoped.length > 0;

  const ranked: { item: CompletionItem; score: number; name: string }[] = [];
  for (const a of pool) {
    const name = bareName(scopedNames ? a.label.slice(object.length + 1) : a.label);
    const r = rank(name, prefix);
    if (!r) continue;
    ranked.push({
      score: r.score,
      name,
      item: { ...a, signature: a.insert, match: r.match },
    });
  }

  ranked.sort((a, b) =>
    a.score - b.score ||
    a.name.length - b.name.length ||
    a.name.localeCompare(b.name));

  return ranked.slice(0, context.limit ?? MAX_COMPLETIONS).map((r) => r.item);
}

/** What `applyCompletion` produces: the new source and where the caret lands. */
export interface CompletionEdit {
  text: string;
  caret: number;
}

/**
 * Accept `item` at the caret, replacing the half-typed word.
 *
 * The replaced RANGE depends on whether the item spells the object itself:
 * accepting `thisComp.width` over `thisComp.wi` replaces the whole run, while
 * accepting `wiggle()` over `foo.wig` replaces only `wig` and keeps `foo.`.
 *
 * A trailing `()` means the example took no arguments, so the caret lands
 * between the parens — ready to type the first one rather than one keystroke
 * away from it.
 */
export function applyCompletion(text: string, caret: number, item: Pick<ApiItem, 'insert'>): CompletionEdit {
  const w = wordAtCaret(text, caret);
  const objectPrefix = w.object ? `${w.object}.` : '';
  const from = objectPrefix && item.insert.startsWith(objectPrefix)
    ? w.start
    : w.start + objectPrefix.length;
  const next = text.slice(0, from) + item.insert + text.slice(w.end);
  const after = from + item.insert.length;
  return { text: next, caret: item.insert.endsWith('()') ? after - 1 : after };
}

/** Convenience for the editor: the caret's word plus its ranked completions. */
export function completionsAt(
  text: string,
  caret: number,
  api: readonly ApiItem[] = EXPRESSION_API,
  limit: number = MAX_COMPLETIONS,
): { word: CaretWord; items: CompletionItem[] } {
  const word = wordAtCaret(text, caret);
  if (word.word === '') return { word, items: [] };
  return { word, items: completions(word.member, api, { object: word.object, limit }) };
}
