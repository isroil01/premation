/**
 * MODIFIER STACKS — an ordered, editable pipeline per animatable property.
 *
 * The Cavalry idea, and the thing a behaviour preset cannot be: a behaviour
 * installs an expression, and from that moment the user's only handle on it is
 * the formula text. "Make the drift a bit slower" means reading someone else's
 * `wiggle(0.35, thisComp.width * 0.02)` and editing a number inside it. A stack
 * is the same motion held as DATA — a list of typed rows with parameters, an
 * order, and an enable switch each — so the same edit is a slider.
 *
 * ## THE SHAPE, AND WHY IT COSTS THE ENGINE NOTHING
 *
 * The stack is stored on the node (`__modifiers`, a hidden prop on Transform,
 * the same convention `__audioDriver` and `__animators` use) and COMPILED to a
 * single expression that is attached to the property. The render path, the
 * exporter, undo, the render cache and `convertExpressionToKeyframes` see an
 * ordinary expression and need no change at all. Editing any row recompiles and
 * re-attaches; the stack is the source of truth and the expression is its
 * output, never the other way round.
 *
 * ## WHAT `previous` IS FOR
 *
 * Installing a stack OVERWRITES whatever expression the property had. Without a
 * record of it, "Remove stack" could only delete — turning an undo-able
 * operation into a destructive one for anybody who had hand-written a formula
 * first. So the expression state that was there before the stack was created is
 * kept in the record (source AND enabled bit: "present but off" is a state, and
 * a bare string cannot express it — see `TrackChange.expressionBefore`), and
 * removing the stack restores it exactly.
 *
 * It is captured ONCE, when the stack is created, and carried forward through
 * every later edit. Re-capturing on each edit would immediately capture the
 * stack's own compiled output and make removal a no-op.
 */

import { defaultAnimation, type ExpressionState } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { bumpScene } from '@stores/sceneStore';
import { batchHistory } from '@stores/historyStore';
import {
  convertExpressionToKeyframes,
  type BakeResult,
} from '@core/animation/convertExpressionToKeyframes';
import type { SceneNode } from '@core/types';
import { compileModifierStack } from './modifierCompile';

// ── The model ───────────────────────────────────────────────────────

export type ModifierKind =
  | 'offset'
  | 'multiply'
  | 'clamp'
  | 'wiggle'
  | 'smooth'
  | 'spring'
  | 'loop'
  | 'delay'
  | 'oscillate'
  | 'audio'
  | 'expression';

/** Ordered as the "Add modifier" menu presents them: arithmetic, then noise,
 *  then time, then the escape hatch last. */
export const MODIFIER_KINDS: readonly ModifierKind[] = [
  'offset', 'multiply', 'clamp',
  'wiggle', 'oscillate', 'spring', 'smooth',
  'delay', 'loop', 'audio',
  'expression',
];

export const MODIFIER_LABELS: Record<ModifierKind, string> = {
  offset: 'Offset',
  multiply: 'Multiply',
  clamp: 'Clamp',
  wiggle: 'Wiggle',
  oscillate: 'Oscillate',
  spring: 'Overshoot',
  smooth: 'Smooth',
  delay: 'Delay',
  loop: 'Loop',
  audio: 'Audio',
  expression: 'Expression',
};

/** One line each, shown under the row — what it DOES, not what it is called. */
export const MODIFIER_HINTS: Record<ModifierKind, string> = {
  offset: 'Adds a constant.',
  multiply: 'Scales by a factor.',
  clamp: 'Holds the value between two limits.',
  wiggle: 'Seeded smooth noise — identical on every run.',
  oscillate: 'A sine wave, forever.',
  spring: 'Velocity-driven overshoot after the last keyframe.',
  smooth: 'Averages the value with its own past and future.',
  delay: 'Reads the value from earlier in time.',
  loop: 'Repeats the keyframes past the last one.',
  audio: 'Adds an amount driven by the live audio level.',
  expression: 'Raw expression text. `value` is the running value.',
};

interface ModifierCommon {
  /** Stable across reorders, so React keys and the row being edited survive. */
  id: string;
  enabled: boolean;
}

export interface OffsetModifier extends ModifierCommon { kind: 'offset'; amount: number }
export interface MultiplyModifier extends ModifierCommon { kind: 'multiply'; factor: number }
export interface ClampModifier extends ModifierCommon { kind: 'clamp'; min: number; max: number }
export interface WiggleModifier extends ModifierCommon {
  kind: 'wiggle';
  freq: number;
  amp: number;
  octaves: number;
  /** Phase offset into the noise field — see `baseRelativeForm` for why the
   *  engine's real seed is not reachable from expression text. */
  seed: number;
}
export interface SmoothModifier extends ModifierCommon { kind: 'smooth'; windowSec: number }
export interface SpringModifier extends ModifierCommon { kind: 'spring'; frequency: number; decay: number }
export interface OscillateModifier extends ModifierCommon {
  kind: 'oscillate';
  freq: number;
  amp: number;
  /** Radians. Two oscillators a quarter turn apart trace a circle. */
  phase: number;
}

/** `loopOut`'s modes, minus `continue` — which extrapolates rather than loops
 *  and belongs with the overshoot family, not here. */
export type LoopModeName = 'cycle' | 'pingpong' | 'offset';
export const LOOP_MODES: readonly LoopModeName[] = ['cycle', 'pingpong', 'offset'];

export interface LoopModifier extends ModifierCommon { kind: 'loop'; mode: LoopModeName }
export interface DelayModifier extends ModifierCommon { kind: 'delay'; seconds: number }

export type AudioBandName = 'full' | 'low' | 'mid' | 'high';
export const AUDIO_BANDS: readonly AudioBandName[] = ['full', 'low', 'mid', 'high'];

export interface AudioModifier extends ModifierCommon {
  kind: 'audio';
  /** Kept in the model so the row can SAY the band is not expressible; only
   *  `full` compiles. See `modifierWarning`. */
  band: AudioBandName;
  min: number;
  max: number;
}
export interface RawExpressionModifier extends ModifierCommon { kind: 'expression'; src: string }

export type Modifier =
  | OffsetModifier
  | MultiplyModifier
  | ClampModifier
  | WiggleModifier
  | SmoothModifier
  | SpringModifier
  | OscillateModifier
  | LoopModifier
  | DelayModifier
  | AudioModifier
  | RawExpressionModifier;

/**
 * A modifier without its id — what a recipe declares.
 *
 * DISTRIBUTIVE on purpose. Plain `Omit<Modifier, 'id'>` collapses a union to
 * the keys its members SHARE (`keyof (A | B)` is the intersection), which here
 * is `{ kind, enabled }` — every parameter would silently vanish from the type
 * and every recipe literal would fail as an excess property. The conditional
 * distributes the Omit across each member instead.
 */
export type ModifierSpec = Modifier extends infer M
  ? M extends Modifier ? Omit<M, 'id'> : never
  : never;

/** One property's stack, as stored on the node. */
export interface ModifierStack {
  modifiers: Modifier[];
  /** The expression that was on the property before the stack existed. */
  previous: ExpressionState | null;
}

// ── Construction ────────────────────────────────────────────────────

let idCounter = 0;

/** Unique within a session, and readable in a snapshot. */
export function nextModifierId(kind: ModifierKind): string {
  idCounter += 1;
  return `${kind}-${idCounter}`;
}

export function defaultModifier(kind: ModifierKind): Modifier {
  const base = { id: nextModifierId(kind), enabled: true };
  switch (kind) {
    case 'offset': return { ...base, kind, amount: 10 };
    case 'multiply': return { ...base, kind, factor: 1.5 };
    case 'clamp': return { ...base, kind, min: 0, max: 100 };
    case 'wiggle': return { ...base, kind, freq: 2, amp: 30, octaves: 1, seed: 0 };
    case 'oscillate': return { ...base, kind, freq: 1, amp: 20, phase: 0 };
    case 'spring': return { ...base, kind, frequency: 3, decay: 6 };
    case 'smooth': return { ...base, kind, windowSec: 0.1 };
    case 'delay': return { ...base, kind, seconds: 0.2 };
    case 'loop': return { ...base, kind, mode: 'cycle' };
    case 'audio': return { ...base, kind, band: 'full', min: 0, max: 50 };
    case 'expression': return { ...base, kind, src: 'value' };
  }
}

/** A one-line summary for the collapsed row — the numbers, not the label. */
export function describeModifier(m: Modifier): string {
  switch (m.kind) {
    case 'offset': return `${m.amount >= 0 ? '+' : ''}${m.amount}`;
    case 'multiply': return `× ${m.factor}`;
    case 'clamp': return `${m.min} – ${m.max}`;
    case 'wiggle': return `${m.freq} Hz · ${m.amp}`;
    case 'oscillate': return `${m.freq} Hz · ${m.amp}`;
    case 'spring': return `${m.frequency} Hz · decay ${m.decay}`;
    case 'smooth': return `± ${m.windowSec}s`;
    case 'delay': return `${m.seconds}s`;
    case 'loop': return m.mode;
    case 'audio': return `${m.min} – ${m.max}`;
    case 'expression': return m.src.length > 28 ? `${m.src.slice(0, 27)}…` : m.src;
  }
}

// ── Pure list edits ─────────────────────────────────────────────────
//
// Separate from the writes below so reordering logic is testable without a
// scene, a node or a history stack — and so the UI has exactly one place that
// knows what "move up" means.

/** `from` → `to`, clamped. Out-of-range indices return the list unchanged. */
export function moveModifier(list: readonly Modifier[], from: number, to: number): Modifier[] {
  const next = [...list];
  if (from < 0 || from >= next.length) return next;
  const clamped = Math.max(0, Math.min(next.length - 1, to));
  const [moved] = next.splice(from, 1);
  if (!moved) return [...list];
  next.splice(clamped, 0, moved);
  return next;
}

/**
 * Patch one row's parameters.
 *
 * Takes the ROW, not its id, so `M` is a single member of the union at the call
 * site and `patch` is checked against that kind's own parameters — `{ freq }`
 * on an offset row is a compile error rather than a field that silently lands
 * in the record and is dropped on the next normalize.
 */
export function patchModifier<M extends Modifier>(
  list: readonly Modifier[],
  target: M,
  patch: Partial<Omit<M, 'id' | 'kind'>>,
): Modifier[] {
  return list.map((m) => (m.id === target.id ? ({ ...m, ...patch } as Modifier) : m));
}

export function removeModifier(list: readonly Modifier[], id: string): Modifier[] {
  return list.filter((m) => m.id !== id);
}

// ── Persistence ─────────────────────────────────────────────────────

/** Hidden prop holding `{ [propPath]: ModifierStack }` on the node's Transform. */
export const MODIFIERS_PROP = '__modifiers';

/**
 * Where the map lives: the Transform component, which every node has. The `__`
 * prefix is what keeps the generic NodeInspector's property list from showing
 * it — the same convention `__audioDriver` and `__animators` follow.
 */
function stackHost(node: SceneNode): SceneNode['components'][number] | undefined {
  return node.components.find((c) => c.type === 'Transform') ?? node.components[0];
}

const numOr = (v: unknown, fb: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fb;

/**
 * Rebuild one modifier from stored JSON, filling anything missing or garbled
 * from the kind's defaults.
 *
 * A saved project outlives the shape that wrote it, and a stack that throws on
 * open takes the whole Inspector with it. Unknown kinds are DROPPED rather than
 * coerced: a row nobody can render is worse than a row that is not there.
 */
function normalizeModifier(raw: unknown, index: number): Modifier | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const kind = r.kind;
  if (typeof kind !== 'string' || !MODIFIER_KINDS.includes(kind as ModifierKind)) return null;
  const d = defaultModifier(kind as ModifierKind);
  const id = typeof r.id === 'string' && r.id !== '' ? r.id : `${kind}-r${index}`;
  const enabled = r.enabled !== false;
  switch (d.kind) {
    case 'offset': return { ...d, id, enabled, amount: numOr(r.amount, d.amount) };
    case 'multiply': return { ...d, id, enabled, factor: numOr(r.factor, d.factor) };
    case 'clamp': return { ...d, id, enabled, min: numOr(r.min, d.min), max: numOr(r.max, d.max) };
    case 'wiggle': return {
      ...d, id, enabled,
      freq: numOr(r.freq, d.freq),
      amp: numOr(r.amp, d.amp),
      octaves: Math.max(1, Math.round(numOr(r.octaves, d.octaves))),
      seed: numOr(r.seed, d.seed),
    };
    case 'oscillate': return {
      ...d, id, enabled,
      freq: numOr(r.freq, d.freq), amp: numOr(r.amp, d.amp), phase: numOr(r.phase, d.phase),
    };
    case 'spring': return {
      ...d, id, enabled,
      frequency: numOr(r.frequency, d.frequency), decay: numOr(r.decay, d.decay),
    };
    case 'smooth': return { ...d, id, enabled, windowSec: Math.max(0, numOr(r.windowSec, d.windowSec)) };
    case 'delay': return { ...d, id, enabled, seconds: numOr(r.seconds, d.seconds) };
    case 'loop': return {
      ...d, id, enabled,
      mode: LOOP_MODES.includes(r.mode as LoopModeName) ? (r.mode as LoopModeName) : d.mode,
    };
    case 'audio': return {
      ...d, id, enabled,
      band: AUDIO_BANDS.includes(r.band as AudioBandName) ? (r.band as AudioBandName) : d.band,
      min: numOr(r.min, d.min), max: numOr(r.max, d.max),
    };
    case 'expression': return { ...d, id, enabled, src: typeof r.src === 'string' ? r.src : d.src };
  }
}

function normalizeStack(raw: unknown): ModifierStack | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const list = Array.isArray(r.modifiers) ? r.modifiers : [];
  const modifiers: Modifier[] = [];
  for (let i = 0; i < list.length; i++) {
    const m = normalizeModifier(list[i], i);
    if (m) modifiers.push(m);
  }
  const prevRaw = r.previous;
  let previous: ExpressionState | null = null;
  if (prevRaw && typeof prevRaw === 'object') {
    const p = prevRaw as Record<string, unknown>;
    if (typeof p.src === 'string' && p.src.trim() !== '') {
      previous = { src: p.src, enabled: p.enabled !== false };
    }
  }
  return { modifiers, previous };
}

/** Every stack remembered on a node, keyed by property path. */
export function readModifierStacks(node: SceneNode): Record<string, ModifierStack> {
  const raw = stackHost(node)?.props[MODIFIERS_PROP];
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, ModifierStack> = {};
  for (const [prop, value] of Object.entries(raw as Record<string, unknown>)) {
    const stack = normalizeStack(value);
    if (stack) out[prop] = stack;
  }
  return out;
}

/** The stack on one property, or null. */
export function readModifierStack(node: SceneNode, prop: string): ModifierStack | null {
  return readModifierStacks(node)[prop] ?? null;
}

function writeStacks(nodeId: string, next: Record<string, ModifierStack>): boolean {
  const node = defaultSceneGraph.getNode(nodeId);
  const host = node ? stackHost(node) : undefined;
  if (!node || !host) return false;
  defaultSceneGraph.writeProp(nodeId, host.id, MODIFIERS_PROP, next);
  bumpScene();
  return true;
}

/** The property's current expression state, or null — what `previous` stores. */
function currentExpressionState(nodeId: string, prop: string): ExpressionState | null {
  const src = defaultAnimation.getExpressionSrc(nodeId, prop);
  if (src === undefined || src.trim() === '') return null;
  return { src, enabled: defaultAnimation.isExpressionEnabled(nodeId, prop) };
}

// ── Apply / remove / bake ───────────────────────────────────────────

/**
 * Install (or update) the stack on `prop` and attach its compiled expression.
 *
 * ONE undo step covers the expression change; the stack record itself rides on
 * the scene-graph write beside it. The expression is explicitly ENABLED:
 * `setExpression` preserves an existing enabled bit, so a stack landing on a
 * property whose previous expression the user had switched off would otherwise
 * be born switched off and appear to do nothing.
 *
 * `mergeKey` coalesces consecutive edits to the same property's stack, so
 * dragging one parameter is one undo step rather than forty.
 */
export function applyModifierStack(
  nodeId: string,
  prop: string,
  modifiers: readonly Modifier[],
): boolean {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return false;
  const stacks = readModifierStacks(node);
  const existing = stacks[prop];
  // Captured ONCE — see the module header. Re-capturing here would capture the
  // stack's own output and make "Remove stack" a no-op.
  const previous = existing ? existing.previous : currentExpressionState(nodeId, prop);
  const src = compileModifierStack(modifiers);

  // The expression write and the record write are ONE edit. Neither goes
  // through `runAnimEdit`: that pushes its own command entry, and the record
  // write then lands as a second (snapshot) entry — two undos for one gesture,
  // which `inspectorHistoryGranularity` refuses. Instead both ride the debounced
  // {scene, anim} snapshot, grouped under one key so they cannot split.
  return batchHistory(`modifiers:${nodeId}:${prop}`, () => {
    defaultAnimation.setExpression(nodeId, prop, src);
    defaultAnimation.setExpressionEnabled(nodeId, prop, true);
    return writeStacks(nodeId, { ...stacks, [prop]: { modifiers: [...modifiers], previous } });
  });
}

/**
 * Forget the stack and put the property's previous expression back — including
 * "there wasn't one", which removes the compiled expression entirely.
 */
export function removeModifierStack(nodeId: string, prop: string): boolean {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return false;
  const stacks = readModifierStacks(node);
  const existing = stacks[prop];
  if (!existing) return false;

  return batchHistory(`modifiers:${nodeId}:${prop}`, () => {
    defaultAnimation.setExpressionState(nodeId, prop, existing.previous);
    const next = { ...stacks };
    delete next[prop];
    return writeStacks(nodeId, next);
  });
}

/**
 * Bake the compiled stack to keyframes.
 *
 * Straight through `convertExpressionToKeyframes`, which already owns the hard
 * parts (the layer's extent as the range, the time axis, sample-everything-then-
 * write) and disables the expression rather than deleting it. The stack RECORD
 * is deliberately kept: the rows are still the description of that motion, and
 * a user who bakes and then wants one more octave should find their stack where
 * they left it rather than a bare keyframe track.
 */
export function bakeModifierStack(nodeId: string, prop: string): BakeResult {
  return convertExpressionToKeyframes(nodeId, [prop]);
}

// ── Behaviour recipes ───────────────────────────────────────────────

/**
 * Behaviours, re-expressed as stacks.
 *
 * `behaviorPresets.ts` is untouched — every existing preset entry still applies
 * its expression exactly as before, and anything that enumerates
 * `BEHAVIOR_PRESETS` (the preset browser, the preset bundle format) is
 * unaffected. What this adds is a SECOND way in: applying the same motion as an
 * editable stack, from the "Add behaviour…" menu, for the two behaviours whose
 * mechanism decomposes into typed rows with no fudging.
 *
 * The other four do not, and are not listed rather than being listed
 * dishonestly: `Fade In+Out` is a `Math.min` of two `linear` ramps against comp
 * duration, `Auto-Scroll` and `Orbit` are parametric functions of `time` that
 * ignore `value`, and `Audio Throb` is MULTIPLICATIVE (`value * (1 + …)`) where
 * the `audio` modifier is additive. Each of them can be carried by a raw
 * `expression` row, which is what the menu's Expression modifier is for — but
 * putting a formula in a box and calling it a stack would be the opaque thing
 * this feature exists to replace.
 *
 * `behaviorStackRecipes.test.ts`'s first assertion is that every `preset` name
 * here names a real entry in `BEHAVIOR_PRESETS`, so a rename over there cannot
 * leave a menu item pointing at nothing.
 */
export interface BehaviorRecipe {
  /** The `AnimationPreset.name` in `behaviorPresets.ts` this reproduces. */
  preset: string;
  label: string;
  description: string;
  /** One stack per property. */
  props: ReadonlyArray<{ prop: string; modifiers: readonly ModifierSpec[] }>;
}

export const BEHAVIOR_RECIPES: readonly BehaviorRecipe[] = [
  {
    preset: 'Drift',
    label: 'Drift',
    description: 'Slow continuous wander on both axes — now two wiggle rows you can retune.',
    props: [
      // The preset's amplitude is `thisComp.width * 0.02`, which a numeric
      // parameter cannot be. 1920 × 0.02 = 38.4 is that value at the default
      // comp size, and unlike the preset it is now a number on a slider — which
      // is the entire trade this feature makes.
      { prop: 'x', modifiers: [{ kind: 'wiggle', enabled: true, freq: 0.35, amp: 38.4, octaves: 1, seed: 0 }] },
      // A different seed, because both rows are on the same node and the
      // engine's own per-(node, prop) seed already separates x from y — this
      // keeps them separate if a user copies one row onto the other axis.
      { prop: 'y', modifiers: [{ kind: 'wiggle', enabled: true, freq: 0.35, amp: 21.6, octaves: 1, seed: 13 }] },
    ],
  },
  {
    preset: 'Pendulum',
    label: 'Pendulum',
    description: 'Endless pendulum rotation — an oscillator row, so amplitude and rate are sliders.',
    props: [
      // The preset is `value + Math.sin(time * 1.8) * 6`. The oscillate row
      // takes frequency in Hz — the unit a person briefs in — so 1.8 rad/s is
      // stored as 1.8 / 2π Hz. The compiler multiplies the STORED number back
      // by 2π before rounding, so what lands in the expression is `time * 1.8`
      // exactly, not a rounded frequency scaled up.
      { prop: 'rotation', modifiers: [{ kind: 'oscillate', enabled: true, freq: 1.8 / (2 * Math.PI), amp: 6, phase: 0 }] },
    ],
  },
];

/** Instantiate a recipe's rows with fresh ids. */
export function instantiateRecipe(entry: { modifiers: readonly ModifierSpec[] }): Modifier[] {
  return entry.modifiers.map((m) => ({ ...m, id: nextModifierId(m.kind) }) as Modifier);
}

/** Apply every property stack a recipe defines. Returns the props it touched. */
export function applyBehaviorRecipe(nodeId: string, recipe: BehaviorRecipe): string[] {
  const done: string[] = [];
  for (const entry of recipe.props) {
    if (applyModifierStack(nodeId, entry.prop, instantiateRecipe(entry))) done.push(entry.prop);
  }
  return done;
}
