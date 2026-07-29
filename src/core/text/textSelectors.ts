/**
 * Text SELECTORS — the half of AE's text-animation design that actually does
 * the work.
 *
 * The counterintuitive bit, and the reason this file exists on its own: you do
 * not animate an animator's properties. You animate its SELECTOR. An animator
 * says "affected characters move up 100px" as a *static* value; a range
 * selector says *which* characters are affected and *how much*, and keyframing
 * that selector's Offset sweeps the window across the string so every character
 * animates in turn. Two keyframes on one property produce a full per-character
 * stagger — that's the whole trick, and it's why this is a mechanism rather
 * than a pile of presets.
 *
 * Everything here is pure: unit index in, weight out. No scene graph, no
 * canvas, no time source beyond the `time` argument. `textAnimators.ts` owns
 * the storage/commands and calls into this.
 *
 * Three selector kinds, matching AE:
 *   • range — a window over the string with a falloff shape. The workhorse.
 *   • wiggly — auto-animated per-unit noise, no keyframes needed.
 *   • expression — an arbitrary per-character function returning an amount.
 *
 * Multiple selectors on one animator combine by each selector's `mode`
 * (add / subtract / intersect / min / max / difference), which is how you build
 * "these characters but not those" without a second animator.
 */

import { cubicBezierEase } from '@motion/animation';

export type RangeBasedOn =
  | 'characters'
  | 'charactersExcludingSpaces'
  | 'words'
  | 'lines';

export type SelectorShape =
  | 'square'
  | 'rampUp'
  | 'rampDown'
  | 'triangle'
  | 'round'
  | 'smooth';

/** Percentage = start/end/offset are 0..100 of the string. Index = raw unit
 *  numbers, which is what you want when the string length is fixed and you are
 *  addressing "character 3" rather than "30% of the way in". */
export type SelectorUnits = 'percentage' | 'index';

/** How a selector folds into the ones before it. */
export type SelectorCombineMode =
  | 'add'
  | 'subtract'
  | 'intersect'
  | 'min'
  | 'max'
  | 'difference';

export type SelectorKind = 'range' | 'wiggly' | 'expression';

export interface RangeSelectorData {
  kind: 'range';
  id: string;
  enabled?: boolean;
  basedOn: RangeBasedOn;
  units: SelectorUnits;
  mode: SelectorCombineMode;
  /** Window bounds, in `units`. */
  start: number;
  end: number;
  /** Shifts the whole window. THIS is the one you keyframe. */
  offset: number;
  /** Global multiplier on the selector's output, percent. */
  amount: number;
  shape: SelectorShape;
  /** Softens a square shape's edges, in percent of one unit. Ignored by the
   *  other shapes, which are soft by construction. */
  smoothness: number;
  /** Easing at the top / bottom of the falloff, -100..100. */
  easeHigh: number;
  easeLow: number;
  /** Scramble which unit maps to which position in the range. */
  randomizeOrder: boolean;
  randomSeed: number;
}

export interface WigglySelectorData {
  kind: 'wiggly';
  id: string;
  enabled?: boolean;
  basedOn: RangeBasedOn;
  mode: SelectorCombineMode;
  /** Output swings between these, percent. */
  maxAmount: number;
  minAmount: number;
  wigglesPerSecond: number;
  /** How similarly neighbouring units move, percent. 100 = they move as one
   *  (a wave); 0 = independent noise. */
  correlation: number;
  /** Phase offsets in degrees — shift the noise in time / across the string
   *  without changing its character. */
  temporalPhase: number;
  spatialPhase: number;
  /** When false, X and Y get independent noise so the wiggle is 2D. */
  lockDimensions: boolean;
  randomSeed: number;
}

export interface ExpressionSelectorData {
  kind: 'expression';
  id: string;
  enabled?: boolean;
  basedOn: RangeBasedOn;
  mode: SelectorCombineMode;
  amount: number;
  /** Returns 0..100 for the character. Sees `textIndex`, `textTotal`,
   *  `selectorValue`, `time` and `Math`. */
  expression: string;
}

export type SelectorData =
  | RangeSelectorData
  | WigglySelectorData
  | ExpressionSelectorData;

/**
 * A selector's output for one unit. Two channels because an unlocked wiggly
 * selector wiggles X and Y independently — every other selector sets both to
 * the same number, and the combine modes work componentwise either way.
 */
export interface SelectorWeight {
  x: number;
  y: number;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

// ── Defaults ────────────────────────────────────────────────────────

let selectorSeq = 0;
const nextId = (): string =>
  `sel_${(selectorSeq += 1).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function defaultRangeSelector(): RangeSelectorData {
  return {
    kind: 'range',
    id: nextId(),
    basedOn: 'characters',
    units: 'percentage',
    mode: 'add',
    start: 0,
    end: 100,
    offset: 0,
    amount: 100,
    shape: 'square',
    smoothness: 100,
    easeHigh: 0,
    easeLow: 0,
    randomizeOrder: false,
    randomSeed: 0,
  };
}

export function defaultWigglySelector(): WigglySelectorData {
  return {
    kind: 'wiggly',
    id: nextId(),
    basedOn: 'characters',
    mode: 'intersect',
    maxAmount: 100,
    minAmount: -100,
    wigglesPerSecond: 2,
    correlation: 50,
    temporalPhase: 0,
    spatialPhase: 0,
    lockDimensions: false,
    randomSeed: 0,
  };
}

export function defaultExpressionSelector(): ExpressionSelectorData {
  return {
    kind: 'expression',
    id: nextId(),
    basedOn: 'characters',
    mode: 'intersect',
    amount: 100,
    expression: 'selectorValue',
  };
}

export function defaultSelector(kind: SelectorKind): SelectorData {
  if (kind === 'wiggly') return defaultWigglySelector();
  if (kind === 'expression') return defaultExpressionSelector();
  return defaultRangeSelector();
}

// ── Unit mapping ────────────────────────────────────────────────────

export interface UnitMap {
  /** How many units the string has under this `basedOn`. */
  count: number;
  /** Unit index per character of `[...text]`. -1 = the character belongs to no
   *  unit (a space under `charactersExcludingSpaces`) and is never selected. */
  unitOfChar: number[];
}

/**
 * Map each character to the unit it belongs to. Whitespace takes the unit of
 * the word or line it sits inside; under `charactersExcludingSpaces` it takes
 * no unit at all, so a selector sweeping "characters" versus "characters
 * excluding spaces" staggers at a visibly different rate.
 */
export function unitPositions(text: string, basedOn: RangeBasedOn): UnitMap {
  const chars = [...text];
  if (basedOn === 'characters') {
    return { count: chars.length, unitOfChar: chars.map((_, i) => i) };
  }
  if (basedOn === 'charactersExcludingSpaces') {
    const unitOfChar: number[] = [];
    let unit = 0;
    for (const c of chars) {
      if (/\s/.test(c)) unitOfChar.push(-1);
      else unitOfChar.push(unit++);
    }
    return { count: unit, unitOfChar };
  }
  if (basedOn === 'lines') {
    const unitOfChar: number[] = [];
    let unit = 0;
    for (const c of chars) {
      unitOfChar.push(unit);
      if (c === '\n') unit++;
    }
    return { count: unit + 1, unitOfChar };
  }
  // words: a new word starts on the first non-space after a space.
  const unitOfChar: number[] = [];
  let wordIdx = -1;
  let prevSpace = true;
  for (const c of chars) {
    const space = /\s/.test(c);
    if (!space && prevSpace) wordIdx++;
    unitOfChar.push(wordIdx < 0 ? 0 : wordIdx);
    prevSpace = space;
  }
  return {
    count: wordIdx < 0 ? Math.max(1, chars.length) : wordIdx + 1,
    unitOfChar,
  };
}

// ── Randomize Order ─────────────────────────────────────────────────

/** Integer lattice hash → [0, 1). Deterministic: nothing here may boil between
 *  two renders of the same frame. */
export function hash01(a: number, b = 0): number {
  let n = ((a | 0) + 1) * 374761393 + ((b | 0) + 1) * 668265263;
  n = (n ^ (n >>> 13)) * 1274126177;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

const permCache = new Map<string, number[]>();

/**
 * A seeded permutation of `[0, count)` — Randomize Order's scramble. Cached
 * because it is rebuilt for every glyph of every frame otherwise, and it is a
 * pure function of (count, seed).
 */
export function orderPermutation(count: number, seed: number): number[] {
  const key = `${count}:${seed}`;
  const hit = permCache.get(key);
  if (hit) return hit;
  const perm = Array.from({ length: Math.max(0, count) }, (_, i) => i);
  // Fisher-Yates driven by the seeded hash, so it is stable across sessions.
  for (let i = perm.length - 1; i > 0; i--) {
    const j = Math.floor(hash01(i, seed) * (i + 1));
    const tmp = perm[i]!;
    perm[i] = perm[j]!;
    perm[j] = tmp;
  }
  if (permCache.size > 256) permCache.clear();
  permCache.set(key, perm);
  return perm;
}

// ── Falloff ─────────────────────────────────────────────────────────

/**
 * The falloff curve across the window, `t` in 0..1.
 *
 * Shape is the property that decides whether an animation reads as fluid or
 * mechanical: `square` gives a hard on/off per character, which is what
 * amateurish kinetic type looks like. `smooth` and the ramps let a character
 * animate *partially* as the window passes it, which is the whole point.
 */
export function shapeFalloff(t: number, shape: SelectorShape): number {
  const u = clamp01(t);
  switch (shape) {
    case 'square':
      return 1;
    case 'rampUp':
      return u;
    case 'rampDown':
      return 1 - u;
    case 'triangle':
      return 1 - Math.abs(2 * u - 1);
    case 'round':
      return Math.sqrt(Math.max(0, 1 - (2 * u - 1) ** 2));
    case 'smooth': {
      const tri = 1 - Math.abs(2 * u - 1);
      return tri * tri * (3 - 2 * tri);
    }
    default:
      return 1;
  }
}

/**
 * Remap a falloff value through Ease High / Ease Low.
 *
 * Both are -100..100. Positive eases (flattens) that end of the curve, negative
 * sharpens it. 0/0 is the identity, which matters: an untouched selector must
 * behave exactly as it did before easing existed.
 */
export function applyEase(v: number, easeHigh: number, easeLow: number): number {
  const el = clamp(easeLow / 100, -1, 1);
  const eh = clamp(easeHigh / 100, -1, 1);
  if (el === 0 && eh === 0) return clamp01(v);
  // Control points chosen so (0, 0) lands on the identity cubic (1/3, 1/3,
  // 2/3, 2/3) and ±1 swings each end fully flat or fully sharp.
  const x1 = 1 / 3 + el / 3;
  const y1 = 1 / 3 - el / 3;
  const x2 = 2 / 3 - eh / 3;
  const y2 = 2 / 3 + eh / 3;
  return clamp01(cubicBezierEase([x1, y1, x2, y2], clamp01(v)));
}

/**
 * Coverage of a unit centred at `centre` by the window `[lo, hi]`, with soft
 * edges `edge` units wide. `edge` 0 is a hard cut. Units, not percent — a
 * one-unit-wide edge means the transition takes exactly one character, which is
 * what AE's Smoothness 100% does.
 */
export function softWindow(
  centre: number,
  lo: number,
  hi: number,
  edge: number,
): number {
  if (hi <= lo) return 0;
  if (edge <= 0) return centre >= lo && centre <= hi ? 1 : 0;
  const rise = clamp01((centre - lo) / edge + 0.5);
  const fall = clamp01((hi - centre) / edge + 0.5);
  return Math.min(rise, fall);
}

// ── Range selector ──────────────────────────────────────────────────

/**
 * Weight for one unit under a range selector.
 *
 * `unit` is the unit's index; `count` the total. Window bounds are converted to
 * unit space first so `units: 'index'` and `units: 'percentage'` share one code
 * path.
 */
export function rangeSelectorAt(
  sel: RangeSelectorData,
  unit: number,
  count: number,
): number {
  if (count <= 0 || unit < 0) return 0;
  const effUnit = sel.randomizeOrder
    ? orderPermutation(count, sel.randomSeed)[unit] ?? unit
    : unit;
  const centre = effUnit + 0.5;

  const toUnits = (v: number): number =>
    sel.units === 'index' ? v : (v / 100) * count;
  const off = toUnits(sel.offset);
  const a = toUnits(sel.start) + off;
  const b = toUnits(sel.end) + off;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  if (hi <= lo) return 0;

  let w: number;
  if (sel.shape === 'square') {
    // Smoothness is the only edge softening a square has; without it the
    // selector is a hard per-character on/off.
    w = softWindow(centre, lo, hi, Math.max(0, sel.smoothness) / 100);
  } else {
    if (centre < lo || centre > hi) return 0;
    w = shapeFalloff((centre - lo) / (hi - lo), sel.shape);
  }

  w = applyEase(w, sel.easeHigh, sel.easeLow);
  return w * (sel.amount / 100);
}

// ── Wiggly selector ─────────────────────────────────────────────────

/** Value noise on a 2D lattice (unit, time-step), smoothstep-interpolated in
 *  time so scrubbing is continuous rather than steppy. */
function smoothNoise(unit: number, ts: number, channel: number): number {
  const i = Math.floor(ts);
  const f = ts - i;
  const s = f * f * (3 - 2 * f);
  const a = hash01(unit * 2654435761 + channel * 40503, i);
  const b = hash01(unit * 2654435761 + channel * 40503, i + 1);
  return a + (b - a) * s;
}

/**
 * Weight for one unit under a wiggly selector at `time`.
 *
 * Correlation blends each unit's own noise toward a noise value shared by the
 * whole string: at 100% every character moves as one, at 0% they are
 * independent. That single control is the difference between a wave and static.
 */
export function wigglySelectorAt(
  sel: WigglySelectorData,
  unit: number,
  time: number,
  channel = 0,
): number {
  if (unit < 0) return 0;
  const freq = Math.max(0.001, sel.wigglesPerSecond);
  const ts = time * freq + sel.temporalPhase / 360;
  const spatial = unit + sel.spatialPhase / 360;
  const own = smoothNoise(spatial + sel.randomSeed * 977, ts, channel);
  const shared = smoothNoise(sel.randomSeed * 977, ts, channel);
  const corr = clamp01(sel.correlation / 100);
  const n = own + (shared - own) * corr;
  const lo = sel.minAmount / 100;
  const hi = sel.maxAmount / 100;
  return lo + (hi - lo) * n;
}

// ── Expression selector ─────────────────────────────────────────────

/**
 * Compiled expression-selector body. Compilation is delegated (see
 * `setExpressionSelectorCompiler`) so this module keeps no dependency on the
 * expression language — and so the app can hand in the CSP-safe parser rather
 * than `new Function`, which the app's `script-src 'self'` refuses.
 */
export type ExpressionSelectorFn = (scope: {
  textIndex: number;
  textTotal: number;
  selectorValue: number;
  time: number;
}) => number;

type Compiler = (src: string) => ExpressionSelectorFn | null;

let compiler: Compiler = () => null;

/** Install the expression compiler. Called once at boot by textAnimators.ts. */
export function setExpressionSelectorCompiler(fn: Compiler): void {
  compiler = fn;
}

const exprCache = new Map<string, ExpressionSelectorFn | null>();

export function compileSelectorExpression(src: string): ExpressionSelectorFn | null {
  if (exprCache.has(src)) return exprCache.get(src) ?? null;
  let fn: ExpressionSelectorFn | null = null;
  try {
    fn = compiler(src);
  } catch {
    fn = null;
  }
  if (exprCache.size > 128) exprCache.clear();
  exprCache.set(src, fn);
  return fn;
}

/** Drop compiled expressions — call when the compiler changes. */
export function clearSelectorExpressionCache(): void {
  exprCache.clear();
}

export function expressionSelectorAt(
  sel: ExpressionSelectorData,
  unit: number,
  count: number,
  time: number,
  incoming: number,
): number {
  if (unit < 0) return 0;
  const fn = compileSelectorExpression(sel.expression);
  if (!fn) return 0;
  let v: number;
  try {
    v = fn({
      textIndex: unit,
      textTotal: count,
      selectorValue: incoming * 100,
      time,
    });
  } catch {
    return 0;
  }
  if (!Number.isFinite(v)) return 0;
  return (v / 100) * (sel.amount / 100);
}

// ── Combination ─────────────────────────────────────────────────────

/**
 * Fold `v` into `acc` under `mode`. The first selector in a stack initialises
 * the accumulator directly (see `evaluateSelectors`) — starting an `intersect`
 * or `min` chain from 0 would zero the whole stack, which is never what the
 * author meant.
 */
export function combineWeights(
  acc: number,
  v: number,
  mode: SelectorCombineMode,
): number {
  switch (mode) {
    case 'add':
      return acc + v;
    case 'subtract':
      return acc - v;
    case 'intersect':
      return acc * v;
    case 'min':
      return Math.min(acc, v);
    case 'max':
      return Math.max(acc, v);
    case 'difference':
      return Math.abs(acc - v);
    default:
      return acc + v;
  }
}

/**
 * Evaluate a whole selector stack for one character.
 *
 * `unitOf` resolves the character to a unit under each selector's own
 * `basedOn`, so one animator can hold a range selector working on words and a
 * wiggly selector working on characters — which is how you get a per-word
 * reveal that also jitters per letter.
 */
export function evaluateSelectors(
  selectors: readonly SelectorData[],
  charIndex: number,
  unitsFor: (basedOn: RangeBasedOn) => UnitMap,
  time: number,
): SelectorWeight {
  const active = selectors.filter((s) => s.enabled !== false);
  if (active.length === 0) return { x: 1, y: 1 };

  let accX = 0;
  let accY = 0;
  let started = false;

  for (const sel of active) {
    const map = unitsFor(sel.basedOn);
    const unit = map.unitOfChar[charIndex] ?? -1;
    let vx: number;
    let vy: number;

    if (sel.kind === 'range') {
      vx = rangeSelectorAt(sel, unit, map.count);
      vy = vx;
    } else if (sel.kind === 'wiggly') {
      vx = wigglySelectorAt(sel, unit, time, 0);
      vy = sel.lockDimensions ? vx : wigglySelectorAt(sel, unit, time, 1);
    } else {
      // The expression sees the stack so far as `selectorValue`, which is how
      // AE's Text Bounce and Inch Worm presets shape an incoming range.
      vx = expressionSelectorAt(sel, unit, map.count, time, started ? accX : 1);
      vy = vx;
    }

    if (!started) {
      accX = vx;
      accY = vy;
      started = true;
    } else {
      accX = combineWeights(accX, vx, sel.mode);
      accY = combineWeights(accY, vy, sel.mode);
    }
  }

  // Clamped to [0,1], which is a DELIBERATE divergence from AE — it allows a
  // stack to overshoot, so two additive selectors can drive a property past its
  // stated value and `subtract` can drive it negative (inverted motion).
  //
  // Kept clamped because the overshoot is unreachable from a single selector
  // anyway (falloff ≤ 1 × amount ≤ 100% never exceeds 1), so it would only
  // change multi-selector stacks — and the one shipped preset that stacks,
  // Spotlight, depends on `subtract` bottoming out at 0 to mean "not dimmed"
  // rather than "brightened past full". Unclamping is a real power feature, but
  // it is a behaviour change looking for a use case rather than the reverse.
  return { x: clamp01(accX), y: clamp01(accY) };
}
