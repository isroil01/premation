/**
 * Multi-selection editing model for the inspector.
 *
 * ## The one rule
 *
 * A property row in the inspector describes the SELECTION, not the first
 * selected layer. With three layers selected, "Position X" is one of two
 * things: a number every layer agrees on, or MIXED — and both are still
 * editable. Typing a value sets every layer to it; dragging a mixed field
 * moves every layer by the same delta from where each one was; `+10` and
 * `*2` are evaluated per layer against that layer's own value. The stopwatch,
 * the keyframe toggle and the reset act on all of them.
 *
 * ## Why this is a module and not a hook
 *
 * Every write here has to be ONE undo entry across every selected node, and
 * history is fed from two places: the command a keyframe edit pushes, and the
 * debounced scene snapshot a static write schedules. The order below is what
 * makes them collapse into one:
 *
 *   1. static writes first, grouped under one `batchHistory` key, so the
 *      debounced snapshot cannot split on a change of node;
 *   2. keyframe writes last, in ONE `runAnimEdit` around ONE engine batch.
 *      The command push refreshes history's baseline (`attachHistoryBaselineSync`),
 *      so when the debounced snapshot fires it compares equal and records
 *      nothing.
 *
 * Reversing the order — keyframes first — would leave the static writes
 * outside the baseline and record a second entry. `writeTransformProps` makes
 * the same choice for the same reason.
 *
 * ## Readers and writers are pluggable
 *
 * The default read/write path is the property-value seam
 * (`readStaticPropertyValue` / `writeStaticPropertyValue`), which covers
 * transform, effect, mask, path-op and text-animator paths. A caller whose
 * value lives somewhere that seam cannot see — stroke width inside the paint
 * stack, a material percentage — supplies its own `read`/`writeStatic`, and
 * the mixed detection, relative apply and undo grouping are unchanged.
 */

import { defaultAnimation } from '@motion/animation';
import type { Command } from '@motion/engine-api';
import { runAnimEdit } from '@core/animation/animationCommands';
import { compToKeyframeTime } from '@core/timeline/TimelineController';
import { batchHistory } from '@stores/historyStore';
import { applyValueExpression } from '@utils/evalMath';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeKind } from '@core/scene/sceneDerive';
import { getNodeEffects, type Effect } from '@core/effects/effects';
import { resolvePropertyMeta } from './propertyMeta';
import { readStaticPropertyValue, writeStaticPropertyValue } from './propertyValue';

/** Values closer than this are "the same" — sub-display-precision noise. */
export const MIXED_EPSILON = 1e-6;

export interface MultiValue {
  /** The primary (first) node's value; what the field shows when not mixed. */
  value: number;
  /** True when at least two nodes disagree. */
  mixed: boolean;
  /** How many of the nodes actually HAVE this property. */
  present: number;
  /** Nodes whose value could be read, in selection order. */
  nodeIds: string[];
  /** True when the property is animated on ANY node. */
  animated: boolean;
  /** True when animated on EVERY node that has it. */
  allAnimated: boolean;
}

export interface PropertyAccess {
  /** Static (un-keyframed) value on one node; `undefined` = node lacks it. */
  read?: (nodeId: string) => number | undefined;
  /** Static write on one node. Return false when nothing could take it. */
  writeStatic?: (nodeId: string, value: number) => boolean;
  /**
   * B3z: the ENGINE route of a property the catalog may not list yet (a plugin
   * panel's param before its panel group exists — layout/Inspector/
   * pluginParamEdits.ts): the commands for per-layer values (stored units) and
   * for the stopwatch ON, addressed by path and self-seeding.
   */
  engine?: {
    commands: (writes: ReadonlyArray<{ nodeId: string; value: number }>, opts: { seconds: number; autoKeyframe: boolean }) => Command[];
    stopwatchOn: (nodeIds: ReadonlyArray<string>, seconds: number) => Command[];
  };
}

export interface ApplyOptions extends PropertyAccess {
  /** Composition time — each node's keyframe axis is derived from it. */
  compTime: number;
  /** Auto-keyframe preference: an unanimated node still gets a keyframe. */
  autoKeyframe?: boolean;
  /** History label. */
  label?: string;
  /** Coalesces consecutive edits (a drag) into one undo step. */
  mergeKey?: string;
}

/** The property's own time axis on one node, at the given comp time. */
export function layerTimeFor(nodeId: string, prop: string, compTime: number): number {
  return compToKeyframeTime(nodeId, compTime, prop);
}

/**
 * The value a property currently HAS on one node: the sampled track when it
 * is animated, else the static value.
 *
 * `undefined` means the node has no such property at all — the row is
 * counted as absent, not as zero.
 */
export function readPropertyValue(
  nodeId: string,
  prop: string,
  compTime: number,
  access: PropertyAccess = {},
): number | undefined {
  if (!defaultSceneGraph.getNode(nodeId)) return undefined;
  if (defaultAnimation.isAnimated(nodeId, prop)) {
    const sampled = defaultAnimation.sample(nodeId, prop, layerTimeFor(nodeId, prop, compTime));
    if (typeof sampled === 'number' && Number.isFinite(sampled)) return sampled;
  }
  const read = access.read ?? ((id: string) => readStaticPropertyValue(id, prop));
  return read(nodeId);
}

/** Aggregate one property across the selection. */
export function aggregateProperty(
  nodeIds: ReadonlyArray<string>,
  prop: string,
  compTime: number,
  access: PropertyAccess = {},
): MultiValue {
  const present: string[] = [];
  const values: number[] = [];
  for (const id of nodeIds) {
    const v = readPropertyValue(id, prop, compTime, access);
    if (v === undefined) continue;
    present.push(id);
    values.push(v);
  }
  const first = values[0];
  const value = first === undefined
    ? (() => {
        const def = resolvePropertyMeta(prop, nodeIds[0]).defaultValue;
        return typeof def === 'number' ? def : 0;
      })()
    : first;
  const mixed = values.some((v) => Math.abs(v - value) > MIXED_EPSILON);
  const animatedCount = present.filter((id) => defaultAnimation.isAnimated(id, prop)).length;
  return {
    value,
    mixed,
    present: present.length,
    nodeIds: present,
    animated: animatedCount > 0,
    allAnimated: present.length > 0 && animatedCount === present.length,
  };
}

/**
 * Write per-node values as ONE undo entry.
 *
 * Nodes that are animated (or every node, under auto-keyframe) receive a
 * keyframe at their own layer time; the rest receive a static write. See the
 * module header for why the static half goes first.
 */
export function applyValues(
  prop: string,
  writes: ReadonlyArray<{ nodeId: string; value: number }>,
  opts: ApplyOptions,
): void {
  const writeStatic = opts.writeStatic ?? ((id: string, v: number) => writeStaticPropertyValue(id, prop, v));
  const keyed: Array<{ nodeId: string; t: number; value: number }> = [];
  const statics: Array<{ nodeId: string; value: number }> = [];
  for (const w of writes) {
    if (!Number.isFinite(w.value)) continue;
    if (!defaultSceneGraph.getNode(w.nodeId)) continue;
    if (defaultAnimation.isAnimated(w.nodeId, prop) || opts.autoKeyframe) {
      keyed.push({ nodeId: w.nodeId, t: layerTimeFor(w.nodeId, prop, opts.compTime), value: w.value });
    } else {
      statics.push(w);
    }
  }
  const label = opts.label ?? `Set ${resolvePropertyMeta(prop, writes[0]?.nodeId).label}`;
  const key = opts.mergeKey ?? `multi:${prop}:${writes.map((w) => w.nodeId).join(',')}`;

  if (statics.length > 0) {
    batchHistory(key, () => {
      for (const s of statics) writeStatic(s.nodeId, s.value);
    });
  }
  if (keyed.length > 0) {
    runAnimEdit(
      label,
      () => defaultAnimation.batch(() => {
        for (const k of keyed) defaultAnimation.setKeyframe(k.nodeId, prop, k.t, k.value);
      }),
      key,
    );
  }
}

/** Set every node to the SAME value. */
export function applyAbsolute(
  nodeIds: ReadonlyArray<string>,
  prop: string,
  value: number,
  opts: ApplyOptions,
): void {
  applyValues(prop, nodeIds.map((nodeId) => ({ nodeId, value })), opts);
}

/**
 * Move every node by the same delta from its START value.
 *
 * `starts` are the values each node had when the gesture began — a drag is
 * relative to where things were, never to where the previous move left them,
 * or the delta would compound on every pointer event.
 */
export function applyRelative(
  prop: string,
  starts: ReadonlyMap<string, number>,
  delta: number,
  opts: ApplyOptions & { min?: number; max?: number },
): void {
  const min = opts.min ?? -Infinity;
  const max = opts.max ?? Infinity;
  const writes: Array<{ nodeId: string; value: number }> = [];
  for (const [nodeId, start] of starts) {
    writes.push({ nodeId, value: Math.min(max, Math.max(min, start + delta)) });
  }
  applyValues(prop, writes, opts);
}

/** Snapshot every node's current value — what a relative gesture starts from. */
export function snapshotStarts(
  nodeIds: ReadonlyArray<string>,
  prop: string,
  compTime: number,
  access: PropertyAccess = {},
): Map<string, number> {
  const out = new Map<string, number>();
  for (const id of nodeIds) {
    const v = readPropertyValue(id, prop, compTime, access);
    if (v !== undefined) out.set(id, v);
  }
  return out;
}

/**
 * Apply typed text PER NODE: `+10` adds ten to each, `*2` doubles each,
 * `100` sets each to 100. Returns false when the text is not an expression
 * the field understands (the caller flashes the field and keeps the values).
 */
export function applyTextExpression(
  nodeIds: ReadonlyArray<string>,
  prop: string,
  raw: string,
  opts: ApplyOptions & { min?: number; max?: number },
): boolean {
  const min = opts.min ?? -Infinity;
  const max = opts.max ?? Infinity;
  const writes: Array<{ nodeId: string; value: number }> = [];
  for (const nodeId of nodeIds) {
    const current = readPropertyValue(nodeId, prop, opts.compTime, opts);
    if (current === undefined) continue;
    const next = applyValueExpression(current, raw);
    if (next === null) return false;
    writes.push({ nodeId, value: Math.min(max, Math.max(min, next)) });
  }
  if (writes.length === 0) return false;
  applyValues(prop, writes, opts);
  return true;
}

/**
 * The stopwatch across the selection: if ANY node is animated, every node's
 * track is removed; otherwise every node gets a first keyframe at its
 * current value. One command either way.
 */
export function toggleAnimationAll(
  nodeIds: ReadonlyArray<string>,
  prop: string,
  compTime: number,
  access: PropertyAccess = {},
): void {
  const ids = nodeIds.filter((id) => defaultSceneGraph.getNode(id));
  if (ids.length === 0) return;
  const label = resolvePropertyMeta(prop, ids[0]).label;
  const anyAnimated = ids.some((id) => defaultAnimation.isAnimated(id, prop));
  if (anyAnimated) {
    runAnimEdit(`Remove ${label} animation`, () => defaultAnimation.batch(() => {
      for (const id of ids) defaultAnimation.removeTrack(id, prop);
    }));
    return;
  }
  const seeds = ids
    .map((id) => ({ id, v: readPropertyValue(id, prop, compTime, access) }))
    .filter((s): s is { id: string; v: number } => typeof s.v === 'number');
  if (seeds.length === 0) return;
  runAnimEdit(`Animate ${label}`, () => defaultAnimation.batch(() => {
    for (const s of seeds) defaultAnimation.setKeyframe(s.id, prop, layerTimeFor(s.id, prop, compTime), s.v);
  }));
}

/**
 * The GROUP stopwatch — Position's x/y/z, Scale's x/y — across the selection,
 * as one command. Any track on any node lit → every track on every node is
 * removed; otherwise every node gets a first keyframe on every prop it has.
 */
export function toggleAnimationGroup(
  nodeIds: ReadonlyArray<string>,
  props: ReadonlyArray<string>,
  compTime: number,
  groupLabel: string,
  access: PropertyAccess = {},
): void {
  const ids = nodeIds.filter((id) => defaultSceneGraph.getNode(id));
  if (ids.length === 0 || props.length === 0) return;
  const anyAnimated = ids.some((id) => props.some((p) => defaultAnimation.isAnimated(id, p)));
  if (anyAnimated) {
    runAnimEdit(`Remove ${groupLabel} animation`, () => defaultAnimation.batch(() => {
      for (const id of ids) for (const p of props) if (defaultAnimation.isAnimated(id, p)) defaultAnimation.removeTrack(id, p);
    }));
    return;
  }
  const seeds: Array<{ id: string; prop: string; v: number }> = [];
  for (const id of ids) {
    for (const p of props) {
      const v = readPropertyValue(id, p, compTime, access);
      if (typeof v === 'number') seeds.push({ id, prop: p, v });
    }
  }
  if (seeds.length === 0) return;
  runAnimEdit(`Animate ${groupLabel}`, () => defaultAnimation.batch(() => {
    for (const s of seeds) defaultAnimation.setKeyframe(s.id, s.prop, layerTimeFor(s.id, s.prop, compTime), s.v);
  }));
}

/**
 * Write a BAG of properties onto every node — a section preset — as one undo
 * entry. Same split as `applyValues`, extended across props: every static
 * write under one history key first, then every keyframe write in one
 * engine batch. Props a node lacks are skipped on that node.
 */
export function applyPropertyBag(
  nodeIds: ReadonlyArray<string>,
  values: Readonly<Record<string, number>>,
  opts: ApplyOptions,
): void {
  // A bag spans props, so the per-prop `writeStatic` seam does not apply: every
  // static write goes through the property-value seam.
  const keyed: Array<{ nodeId: string; prop: string; t: number; value: number }> = [];
  const statics: Array<{ nodeId: string; prop: string; value: number }> = [];
  for (const nodeId of nodeIds) {
    if (!defaultSceneGraph.getNode(nodeId)) continue;
    for (const [prop, value] of Object.entries(values)) {
      if (!Number.isFinite(value)) continue;
      if (readPropertyValue(nodeId, prop, opts.compTime, opts) === undefined) continue;
      if (defaultAnimation.isAnimated(nodeId, prop) || opts.autoKeyframe) {
        keyed.push({ nodeId, prop, t: layerTimeFor(nodeId, prop, opts.compTime), value });
      } else {
        statics.push({ nodeId, prop, value });
      }
    }
  }
  const label = opts.label ?? 'Apply preset';
  const key = opts.mergeKey ?? `preset:${label}:${nodeIds.join(',')}:${Date.now()}`;
  if (statics.length > 0) {
    batchHistory(key, () => {
      for (const s of statics) writeStaticPropertyValue(s.nodeId, s.prop, s.value);
    });
  }
  if (keyed.length > 0) {
    runAnimEdit(
      label,
      () => defaultAnimation.batch(() => {
        for (const k of keyed) defaultAnimation.setKeyframe(k.nodeId, k.prop, k.t, k.value);
      }),
      key,
    );
  }
}

/** How close (seconds) the playhead must be to count as "on" a keyframe. */
export const KEYFRAME_EPS = 1e-4;

/** Keyframe navigation state, aggregated: prev/next exist on any node, "at" on all animated ones. */
export function navigatorState(
  nodeIds: ReadonlyArray<string>,
  prop: string,
  compTime: number,
): { hasPrev: boolean; hasNext: boolean; atKeyframe: boolean; prevT: number | null; nextT: number | null } {
  let hasPrev = false;
  let hasNext = false;
  let animatedCount = 0;
  let atCount = 0;
  let prevT: number | null = null;
  let nextT: number | null = null;
  for (const id of nodeIds) {
    if (!defaultAnimation.isAnimated(id, prop)) continue;
    animatedCount += 1;
    const lt = layerTimeFor(id, prop, compTime);
    const kfs = defaultAnimation.getTrackKeyframes(id, prop) ?? [];
    if (kfs.some((k) => Math.abs(k.t - lt) < KEYFRAME_EPS)) atCount += 1;
    const prev = [...kfs].reverse().find((k) => k.t < lt - KEYFRAME_EPS);
    const next = kfs.find((k) => k.t > lt + KEYFRAME_EPS);
    if (prev) {
      hasPrev = true;
      // Nearest previous across nodes, expressed on the COMP axis so the seek
      // lands where the diamond is, whichever layer it belongs to.
      const dt = lt - prev.t;
      if (prevT === null || compTime - dt > prevT) prevT = compTime - dt;
    }
    if (next) {
      hasNext = true;
      const dt = next.t - lt;
      if (nextT === null || compTime + dt < nextT) nextT = compTime + dt;
    }
  }
  return { hasPrev, hasNext, atKeyframe: animatedCount > 0 && atCount === animatedCount, prevT, nextT };
}

/**
 * The navigator's diamond across the selection: on a keyframe on every
 * animated node → remove those keyframes; otherwise add one at the current
 * value on every animated node (the un-animated stay static, as in AE).
 */
export function toggleKeyframeAll(
  nodeIds: ReadonlyArray<string>,
  prop: string,
  compTime: number,
  access: PropertyAccess = {},
): void {
  const animated = nodeIds.filter((id) => defaultAnimation.isAnimated(id, prop));
  if (animated.length === 0) return;
  const label = resolvePropertyMeta(prop, animated[0]).label;
  const { atKeyframe } = navigatorState(animated, prop, compTime);
  if (atKeyframe) {
    runAnimEdit(`Remove ${label} keyframe`, () => defaultAnimation.batch(() => {
      for (const id of animated) {
        const lt = layerTimeFor(id, prop, compTime);
        const at = (defaultAnimation.getTrackKeyframes(id, prop) ?? []).find((k) => Math.abs(k.t - lt) < KEYFRAME_EPS);
        if (at) defaultAnimation.removeKeyframe(id, prop, at.t);
      }
    }));
    return;
  }
  runAnimEdit(`Add ${label} keyframe`, () => defaultAnimation.batch(() => {
    for (const id of animated) {
      const v = readPropertyValue(id, prop, compTime, access);
      if (v !== undefined) defaultAnimation.setKeyframe(id, prop, layerTimeFor(id, prop, compTime), v);
    }
  }));
}

// ── Sections and summary ────────────────────────────────────────────

/** Kind breakdown of the selection — "2 shapes, 1 text". */
export function selectionKinds(nodeIds: ReadonlyArray<string>): Array<{ kind: string; count: number }> {
  const counts = new Map<string, number>();
  for (const id of nodeIds) {
    const node = defaultSceneGraph.getNode(id);
    if (!node) continue;
    const kind = readNodeKind(node);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return [...counts].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count);
}

/**
 * Effects the whole selection shares: the same effect TYPE at the same stack
 * index on every node. Only those are safe to edit as one — an index that
 * holds a blur on one layer and a glow on another is two different parameter
 * sets under one row.
 */
export function sharedEffectSlots(nodeIds: ReadonlyArray<string>): Array<{ index: number; type: string; effects: Effect[] }> {
  const stacks = nodeIds.map((id) => (defaultSceneGraph.getNode(id) ? getNodeEffects(id) : []));
  if (stacks.length === 0) return [];
  const depth = Math.min(...stacks.map((s) => s.length));
  const out: Array<{ index: number; type: string; effects: Effect[] }> = [];
  for (let i = 0; i < depth; i++) {
    const type = stacks[0]![i]!.type;
    if (stacks.every((s) => s[i]!.type === type)) {
      out.push({ index: i, type, effects: stacks.map((s) => s[i]!) });
    }
  }
  return out;
}

/* ── Non-animatable flags (the layer switches) ──────────────────────────────
 *
 * Adjustment, Motion Blur and Draft Quality are booleans on the node, not
 * animation tracks, so none of the machinery above reaches them: there is no
 * property path, no keyframe, no relative drag. What they DO share with every
 * other row is the two promises that make a multi-selection usable — the
 * control tells you when the selected layers disagree, and flipping it is one
 * undo entry however many layers it touches.
 *
 * These two functions are that, and nothing more. They take the reader and the
 * writer from the call site because each switch has its own pair
 * (`getNodeAdjustment`/`setAdjustmentWithFeedback`, …) and some of them have
 * to run side effects (the feedback toasts) that this module must not know
 * about.
 */

/** A flag read across the selection: the PRIMARY's value, plus whether they agree. */
export function aggregateFlag<T>(
  nodeIds: ReadonlyArray<string>,
  read: (nodeId: string) => T,
): { value: T; mixed: boolean; present: number } {
  const live = nodeIds.filter((id) => defaultSceneGraph.getNode(id));
  if (live.length === 0) return { value: read(nodeIds[0] ?? ''), mixed: false, present: 0 };
  const first = read(live[0]!);
  let mixed = false;
  for (let i = 1; i < live.length; i += 1) if (read(live[i]!) !== first) { mixed = true; break; }
  return { value: first, mixed, present: live.length };
}

/**
 * Run `write` for every live node under ONE history entry.
 *
 * `batchHistory` renames the debounce target for the whole loop, so the
 * snapshot cannot split partway through — the same guarantee
 * `applyComponentPropsPreset` relies on. Returns how many nodes were written.
 */
export function applyFlagAll(
  nodeIds: ReadonlyArray<string>,
  label: string,
  write: (nodeId: string) => void,
): number {
  let n = 0;
  batchHistory(`flag:${label}:${nodeIds.join(',')}`, () => {
    for (const id of nodeIds) {
      if (!defaultSceneGraph.getNode(id)) continue;
      write(id);
      n += 1;
    }
  });
  return n;
}
