/**
 * Typed, reversible keyframe-editing commands.
 *
 * Every user- or AI-authored change to the AnimationEngine flows through here
 * so it becomes a single, undoable transaction on the CommandSystem history —
 * the promise the app makes ("everything AI generates stays editable and
 * reversible") made literal.
 *
 * Reversibility model: a command captures the affected property tracks' keyframe
 * arrays *before* and *after* the mutation and swaps between them. This is
 * precise (only the touched tracks move) — the opposite of the coarse
 * whole-document history snapshot in `stores/historyStore`. It covers the whole
 * mutation surface with one command shape:
 *
 *   • add / set keyframe        (SetKeyframe)
 *   • move keyframe (time)      (MoveKeyframe)
 *   • delete keyframe           (RemoveKeyframe)
 *   • change value / easing / bezier (UpdateKeyframe, SetEasing)
 *   • remove a whole track      (RemoveTrack)
 *   • composite AI presets      (many tracks in one command)
 *
 * Authoring helpers:
 *   • runAnimEdit(label, mutate) — snapshot → mutate → diff → record one command.
 *   • beginAnimEdit/commit — for pointer drags that mutate live on every
 *     move; records a single command on release.
 */

import { asCommandId } from '@app-types/common';
import type { Command } from '@core/commands/Command';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { defaultAnimation, AnimationEngine, type AnimSnapshot, type Keyframe, type PropPath, type DataTrack } from '@motion/animation';

/** One track's before/after keyframes (`null` = the track is absent). */
export interface TrackChange {
  nodeId: string;
  prop: PropPath;
  before: Keyframe[] | null;
  after: Keyframe[] | null;
  expressionBefore?: string | null;
  expressionAfter?: string | null;
  /** Non-scalar (data) track states — text/points/gradient keyframes. */
  dataBefore?: DataTrack | null;
  dataAfter?: DataTrack | null;
}

/** Shared command id — instances are parametric, created per edit. */
export const ANIM_EDIT_COMMAND = asCommandId('anim.edit');

/**
 * A reversible animation edit spanning one or more property tracks. `execute`
 * applies every change's `after`; `undo` applies every `before`. Both are pure
 * state swaps, so redo (which re-runs `execute`) is deterministic.
 */
export class AnimEditCommand implements Command {
  readonly id = ANIM_EDIT_COMMAND;
  readonly label: string;
  /** Coalescing tag: consecutive commands with the same key merge (scrubbing). */
  readonly mergeKey: string | undefined;

  private readonly engine: AnimationEngine;
  private readonly changes: TrackChange[];

  constructor(engine: AnimationEngine, changes: TrackChange[], label: string, mergeKey?: string) {
    this.engine = engine;
    this.changes = changes;
    this.label = label;
    this.mergeKey = mergeKey;
  }

  /** Number of tracks this edit touches (0 = a no-op that should not record). */
  get size(): number {
    return this.changes.length;
  }

  execute(): void {
    for (const c of this.changes) {
      if (c.after !== undefined) this.engine.setTrackKeyframes(c.nodeId, c.prop, c.after);
      if (c.expressionAfter !== undefined) {
        if (c.expressionAfter === null) this.engine.removeExpression(c.nodeId, c.prop);
        else this.engine.setExpression(c.nodeId, c.prop, c.expressionAfter);
      }
      if (c.dataAfter !== undefined) this.engine.setDataTrack(c.nodeId, c.prop, c.dataAfter);
    }
  }

  undo(): void {
    for (const c of this.changes) {
      if (c.before !== undefined) this.engine.setTrackKeyframes(c.nodeId, c.prop, c.before);
      if (c.expressionBefore !== undefined) {
        if (c.expressionBefore === null) this.engine.removeExpression(c.nodeId, c.prop);
        else this.engine.setExpression(c.nodeId, c.prop, c.expressionBefore);
      }
      if (c.dataBefore !== undefined) this.engine.setDataTrack(c.nodeId, c.prop, c.dataBefore);
    }
  }

  /**
   * Fold a follow-up edit into this one, keeping this command's original
   * `before` but adopting the newer `after` (used to collapse a scrub-drag's
   * stream of edits into a single undo step). Assumes the same merge key.
   */
  mergeFrom(next: AnimEditCommand): void {
    for (const nc of next.changes) {
      const existing = this.changes.find((c) => c.nodeId === nc.nodeId && c.prop === nc.prop);
      if (existing) {
        existing.after = nc.after;
        if (nc.expressionAfter !== undefined) existing.expressionAfter = nc.expressionAfter;
      } else {
        this.changes.push({ ...nc });
      }
    }
  }
}

/** Diff two engine snapshots into the set of tracks that actually changed. */
export function diffTracks(before: AnimSnapshot, after: AnimSnapshot): TrackChange[] {
  const changes: TrackChange[] = [];
  const keys = new Set<string>();
  const nodeIds = new Set<string>([
    ...Object.keys(before.tracks),
    ...Object.keys(after.tracks),
    ...Object.keys(before.expressions || {}),
    ...Object.keys(after.expressions || {}),
    ...Object.keys(before.data || {}),
    ...Object.keys(after.data || {}),
  ]);
  for (const nodeId of nodeIds) {
    const bProps = before.tracks[nodeId] ?? {};
    const aProps = after.tracks[nodeId] ?? {};
    const bExprs = before.expressions?.[nodeId] ?? {};
    const aExprs = after.expressions?.[nodeId] ?? {};
    const bData = before.data?.[nodeId] ?? {};
    const aData = after.data?.[nodeId] ?? {};
    for (const prop of new Set([
      ...Object.keys(bProps), ...Object.keys(aProps),
      ...Object.keys(bExprs), ...Object.keys(aExprs),
      ...Object.keys(bData), ...Object.keys(aData),
    ])) {
      keys.add(`${nodeId} ${prop}`);
    }
  }
  for (const key of keys) {
    const sep = key.indexOf(' ');
    const nodeId = key.slice(0, sep);
    const prop = key.slice(sep + 1);
    const b = before.tracks[nodeId]?.[prop]?.keyframes ?? null;
    const a = after.tracks[nodeId]?.[prop]?.keyframes ?? null;
    const eb = before.expressions?.[nodeId]?.[prop] ?? null;
    const ea = after.expressions?.[nodeId]?.[prop] ?? null;
    const db = before.data?.[nodeId]?.[prop] ?? null;
    const da = after.data?.[nodeId]?.[prop] ?? null;
    if (kfEqual(b, a) && eb === ea && dataEqual(db, da)) continue;
    const change: TrackChange = {
      nodeId,
      prop,
      before: b ? b.map((k) => ({ ...k })) : null,
      after: a ? a.map((k) => ({ ...k })) : null,
      expressionBefore: eb,
      expressionAfter: ea,
    };
    if (!dataEqual(db, da)) {
      change.dataBefore = db;
      change.dataAfter = da;
    }
    changes.push(change);
  }
  return changes;
}

/** Structural equality for data tracks (values are JSON-safe by contract). */
function dataEqual(a: DataTrack | null, b: DataTrack | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a.keyframes) === JSON.stringify(b.keyframes) && a.kind === b.kind;
}

function kfEqual(a: Keyframe[] | null, b: Keyframe[] | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (!x || !y) return false;
    if (x.t !== y.t || x.value !== y.value || x.easing !== y.easing) return false;
    if (x.si !== y.si || x.so !== y.so) return false; // spatial tangents
    const bx = x.bezier;
    const by = y.bezier;
    if (bx || by) {
      if (!bx || !by) return false;
      if (bx[0] !== by[0] || bx[1] !== by[1] || bx[2] !== by[2] || bx[3] !== by[3]) return false;
    }
  }
  return true;
}

/**
 * Run `mutate` against `engine`, capturing the change as a reversible command.
 * Returns the (already-applied) command, or `null` when nothing changed.
 */
export function captureAnimEdit(
  label: string,
  mutate: () => void,
  opts: { engine?: AnimationEngine; mergeKey?: string } = {},
): AnimEditCommand | null {
  const engine = opts.engine ?? defaultAnimation;
  const before = engine.snapshot();
  mutate();
  const after = engine.snapshot();
  const changes = diffTracks(before, after);
  if (changes.length === 0) return null;
  return new AnimEditCommand(engine, changes, label, opts.mergeKey);
}

/**
 * A live-drag transaction: snapshot now, let the caller mutate the engine
 * directly on every pointer move, then `commit` on release to record one
 * command covering the whole drag.
 */
export function beginAnimEdit(engine: AnimationEngine = defaultAnimation): {
  commit: (label: string, mergeKey?: string) => AnimEditCommand | null;
} {
  const before = engine.snapshot();
  return {
    commit(label, mergeKey) {
      const after = engine.snapshot();
      const changes = diffTracks(before, after);
      if (changes.length === 0) return null;
      return new AnimEditCommand(engine, changes, label, mergeKey);
    },
  };
}

/**
 * Record a captured command on the CommandSystem history — merging into the
 * previous command when their merge keys match (so a scrub collapses to one
 * undo step). No-op for `null` (nothing changed).
 */
export function recordAnimEdit(command: AnimEditCommand | null): void {
  if (!command) return;
  const history = getCommandSystem().getHistory();
  const top = history.peek();
  if (
    command.mergeKey !== undefined &&
    top instanceof AnimEditCommand &&
    top.mergeKey === command.mergeKey
  ) {
    top.mergeFrom(command);
    return;
  }
  history.push(command);
}

/** Convenience: capture a mutation on the default engine and record it. */
export function runAnimEdit(label: string, mutate: () => void, mergeKey?: string): void {
  recordAnimEdit(captureAnimEdit(label, mutate, { mergeKey }));
}
