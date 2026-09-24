/**
 * Analysis results as keyframes, through the engine API (B3z).
 *
 * Audio envelopes (fades, ducking, the noise gate, audio drivers, Convert
 * Audio to Keyframes) and tracker solves are ANALYSIS: computing them is not a
 * document write, their RESULT is (ENGINE_API.md §1 rule 7). The result is a
 * list of keys per property plus a rule for the keys already there:
 *
 *   replace 'all'   the track becomes exactly the new keys (ducking, gate,
 *                   driver bake, Convert Audio to Keyframes)
 *   replace 'span'  keys strictly inside the new keys' first…last span are
 *                   dropped, keys outside survive (Motion Sketch's
 *                   `spliceRecordedRange`: the tracker, fades)
 *
 * Sent as ONE undo entry — an engine gesture of three steps, because step two
 * needs step one's answer:
 *
 *   1. `before` (a json record, `setExpression ''`, a created layer…) and
 *      `addKeyframes` for the new keys. A new key landing on an existing key's
 *      time REPLACES it and keeps its id (the addKeyframes contract).
 *   2. `deleteKeyframes` for the existing keys the rule drops, minus the ids
 *      step one reused — so the track is never empty in between (an emptied
 *      track would leave its static value at the last key's, which the legacy
 *      `setKeyframes` never did).
 *   3. `after`.
 *
 * New keys that fall on one keyframe time of the layer (a retimed layer maps
 * two composition frames onto one key time) keep the FIRST, as the legacy
 * writers did (`seen.has(t)`).
 */

import type { Command, CommandResult, EngineClient, KeyframeInsert, PropRef, Value } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';
import { reportEngineError } from '@core/engine/uiEdits';
import { compTime } from '@core/engine/propRefs';
import { keyAxisTimeForDisplay } from '@core/engine/displayTime';
import { secondsToFlicks } from '@motion/engine-api';
import { catalogFor, readStatic } from '@core/engine/props';
import { trackRefIn } from '@core/mirror/trackIndex';
import { documentMirror } from '@stores/documentMirror';

/** One new key: composition seconds + the API value. */
export interface SpliceKey {
  seconds: number;
  value: Value;
}

export interface KeySplice {
  prop: PropRef;
  keys: readonly SpliceKey[];
  replace: 'all' | 'span';
  /**
   * The legacy track the key-time dedupe measures on (the time-remap track has
   * its own axis); default = the layer's ordinary keyframe axis.
   */
  axisTrack?: string;
}

/** A step: the commands to send now, given every earlier step's results. */
export type EntryStep = (earlier: ReadonlyArray<CommandResult[]>) => Command[] | Promise<Command[]>;

/**
 * Run `steps` in order inside ONE engine gesture (one undo entry named
 * `label`). Each step sees the document as the previous one left it. Any
 * refusal is toasted (unless `quiet`) and the whole gesture reverted.
 * Resolves to every step's results, or null on failure.
 */
export async function inOneEntry(
  label: string,
  steps: readonly EntryStep[],
  opts: { quiet?: boolean; client?: EngineClient } = {},
): Promise<CommandResult[][] | null> {
  const client = opts.client ?? engine();
  const opened = await client.beginGesture(label);
  if (!opened.ok) {
    if (!opts.quiet) reportEngineError(label, opened.error);
    return null;
  }
  const results: CommandResult[][] = [];
  let ok = true;
  for (const step of steps) {
    let cmds: Command[];
    try {
      cmds = await step(results);
    } catch (e) {
      if (!opts.quiet) reportEngineError(label, { code: 'internal', message: e instanceof Error ? e.message : String(e) } as never);
      ok = false;
      break;
    }
    if (cmds.length === 0) {
      results.push([]);
      continue;
    }
    const res = await client.batch(label, cmds);
    if (!res.ok) {
      if (!opts.quiet) reportEngineError(label, res.error);
      ok = false;
      break;
    }
    results.push(res.value);
  }
  const closed = await client.endGesture(opened.value.gesture, ok);
  if (!closed.ok && !opts.quiet) reportEngineError(label, closed.error);
  return ok ? results : null;
}

/** The new keys of one splice, deduped on the layer's keyframe axis (first wins), in time order. */
function uniqueKeys(s: KeySplice): SpliceKey[] {
  const seen = new Set<number>();
  const out: SpliceKey[] = [];
  for (const k of [...s.keys].sort((a, b) => a.seconds - b.seconds)) {
    const t = keyAxisTimeForDisplay(s.prop.layer, k.seconds, s.axisTrack);
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(k);
  }
  return out;
}

/** Half a microsecond, in flicks: "this key is at that time". */
const EPS = secondsToFlicks(1e-6);

/**
 * The steps of a splice (see the module header). `before` goes with the adds,
 * `after` with the deletes. Splices with no keys only drop what their rule
 * says (a `'all'` splice with no keys is refused by the caller, not here).
 */
export function spliceSteps(
  splices: readonly KeySplice[] | ((earlier: ReadonlyArray<CommandResult[]>) => readonly KeySplice[]),
  before: readonly Command[] | ((earlier: ReadonlyArray<CommandResult[]>) => readonly Command[]) = [],
  after: readonly Command[] | ((earlier: ReadonlyArray<CommandResult[]>) => Command[]) = [],
  client: () => EngineClient = engine,
): EntryStep[] {
  let planned: Array<{ s: KeySplice; keys: SpliceKey[] }> = [];
  let doomed: string[] = [];
  let addStep = 0;
  return [
    async (earlier) => {
      // The splices may depend on an earlier step (a layer it created), so
      // they are planned here, against the document as it now stands.
      planned = (typeof splices === 'function' ? splices(earlier) : splices).map((s) => ({ s, keys: uniqueKeys(s) }));
      addStep = earlier.length;
      // What is there now, and which of it the rule drops.
      doomed = [];
      const props = planned.filter((p) => p.keys.length > 0 || p.s.replace === 'all').map((p) => p.s.prop);
      if (props.length > 0) {
        const res = await client().query({ type: 'getKeyframes', props });
        if (!res.ok) throw new Error(res.error.message);
        for (const p of planned) {
          const set = res.value.sets.find((x) => x.prop.layer === p.s.prop.layer && x.prop.path === p.s.prop.path);
          if (!set) continue;
          const times = p.keys.map((k) => compTime(k.seconds));
          const lo = Math.min(...times) - EPS;
          const hi = Math.max(...times) + EPS;
          for (const k of set.keyframes) {
            if (p.s.replace === 'all' || (times.length > 0 && k.time >= lo && k.time <= hi)) doomed.push(k.id);
          }
        }
      }
      const inserts: KeyframeInsert[] = planned.flatMap((p) => p.keys.map((k) => ({
        prop: p.s.prop, time: compTime(k.seconds), value: k.value, easing: 'linear' as const, spatialIn: [], spatialOut: [],
      })));
      const pre = typeof before === 'function' ? before(earlier) : before;
      return [...pre, ...(inserts.length > 0 ? [{ type: 'addKeyframes', keys: inserts } as Command] : [])];
    },
    (earlier) => {
      const added = earlier[addStep]?.find((r) => r.type === 'addKeyframes') as { ids?: string[] } | undefined;
      const kept = new Set(added?.ids ?? []);
      const ids = doomed.filter((id) => !kept.has(id));
      const tail = typeof after === 'function' ? after(earlier) : after;
      return [...(ids.length > 0 ? [{ type: 'deleteKeyframes', ids } as Command] : []), ...tail];
    },
  ];
}

/**
 * "Remove the track" (the legacy `removeTrack`): every key of `prop` goes and
 * the static value underneath stays what it was. `deleteKeyframes` alone would
 * leave the property at the last key's value (its AE contract), so the static
 * value read before is written back. Empty when the property has no keys.
 */
export async function removeAnimationCommands(prop: PropRef, client: EngineClient = engine()): Promise<Command[]> {
  const b = catalogFor(prop.layer).byPath.get(prop.path);
  if (!b) return [];
  const res = await client.query({ type: 'getKeyframes', props: [prop] });
  if (!res.ok) return [];
  const ids = res.value.sets.flatMap((s) => s.keyframes.map((k) => k.id));
  if (ids.length === 0) return [];
  const before = readStatic(prop.layer, b);
  return [{ type: 'deleteKeyframes', ids }, { type: 'setProperty', prop, value: before }];
}

/**
 * `setExpression ''` on `prop` when one of `tracks` carries an expression (the
 * bake rule: a baked track under a live expression matches neither). B4: read
 * from the document mirror at call time — the property's expression, or, on an
 * unseparated vector whose dimensions differ, the member the track names.
 */
export function clearExpressionCommands(prop: PropRef, tracks: readonly string[]): Command[] {
  const m = documentMirror();
  const info = m.property(prop.layer, prop.path);
  if (!info) return [];
  const tree = m.tree(prop.layer);
  // An engine that does not report per-member expressions yet sends none.
  const perMember = info.memberExpressions ?? [];
  const has = (track: string): boolean => {
    const ref = trackRefIn(tree, track);
    const member = ref && ref.path === prop.path && perMember.length > 0 ? ref.member : undefined;
    if (member === undefined) return info.expression !== '' || perMember.some((e) => e.source !== '');
    return perMember.some((e) => e.member === member && e.source !== '');
  };
  return tracks.some(has)
    ? [{ type: 'setExpression', prop, source: '', enabled: true }]
    : [];
}

/** A splice (plus `before` / `after`) as one undo entry. Resolves true when it landed. */
export async function spliceKeysEdit(
  label: string,
  splices: readonly KeySplice[],
  before: readonly Command[] = [],
  after: readonly Command[] = [],
): Promise<boolean> {
  return (await inOneEntry(label, spliceSteps(splices, before, after))) !== null;
}
