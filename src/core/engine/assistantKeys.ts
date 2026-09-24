/**
 * Keyframe assistants off-document (B3z) — Bounce, the motion assistants'
 * previews, the timeline's key tools: legacy helpers that compute AND write
 * keyframes (often one member track at a time, reading back their own writes
 * to place the next key).
 *
 * The helper runs against a scratch state of the document (`offDocument`),
 * each touched property's keyframe list is read back through the API model
 * (one key per time for every member, ENGINE_API.md §3.3 — a lone member key
 * becomes a whole key holding the other members' values at that time), the
 * document is restored exactly, and the change is sent as `setKeyframes` per
 * property (or `setAnimated` off where the helper removed every key) — one
 * batch, one undo entry, replayable in both engines.
 *
 * Guarded like `buildLayerFragment`: a helper that changed anything but the
 * keyframes of the named layers (a node prop, an item, a timeline) is not a
 * keyframe assistant; the run throws `OffDocumentError` and nothing is sent.
 *
 * The ratchet (scripts/lint/engineWritesRule.mjs) treats writer calls lexically
 * inside the callback as scratch writes (OFF_DOCUMENT_BUILDERS).
 */

import type { Command, Keyframe } from '@motion/engine-api';
import { offDocument, OffDocumentError } from './offDocument';
import { keyframeSets } from './model';
import { catalogFor } from './props';
import { edit, reportEngineError, type EditOptions } from './uiEdits';

type KeyLists = Map<string, Keyframe[]>;

function keyLists(layer: string): KeyLists {
  try {
    return new Map(keyframeSets(layer).map((s) => [s.prop.path, s.keyframes]));
  } catch {
    return new Map();
  }
}

/** The key fields that make a list different (ids are the engine's to keep). */
function sameKeys(a: readonly Keyframe[] | undefined, b: readonly Keyframe[] | undefined): boolean {
  const strip = (l: readonly Keyframe[] | undefined): string => JSON.stringify((l ?? []).map(({ id: _id, ...k }) => k));
  return strip(a) === strip(b);
}

/**
 * One key per API time. Member tracks a helper keyed separately can sit a
 * float epsilon apart (0.73125 vs 0.7312500000000001 s); the API reports each
 * as a key, and both round to the same flick. The first wins — the values
 * differ by that epsilon's worth of motion.
 */
function onePerTime(keys: readonly Keyframe[]): Keyframe[] {
  const seen = new Set<number>();
  return keys.filter((k) => (seen.has(k.time) ? false : (seen.add(k.time), true)));
}

/** The API paths of a layer's properties that own any of `members`. */
function forcedPaths(layer: string, members: ReadonlySet<string> | undefined): Set<string> {
  const out = new Set<string>();
  if (!members || members.size === 0) return out;
  let props;
  try {
    props = catalogFor(layer).props;
  } catch {
    return out;
  }
  for (const b of props) if (b.members.some((m) => members.has(m))) out.add(b.path);
  return out;
}

export interface AssistantPlan<T> {
  /** What the helper returned (from the scratch run). */
  value: T;
  /** `setKeyframes` / `setAnimated` per changed property, in layer then path order. */
  cmds: Command[];
}

/**
 * Run `build` off-document and return the commands that make its keyframe
 * changes on `layers`. Throws `OffDocumentError` when it changed anything else.
 */
export interface AssistantKeyOptions {
  /**
   * Member tracks (stored names, e.g. 'x', 'scaleX') whose properties are
   * ALWAYS sent, changed or not — a live preview's sends must each be the
   * whole state (a gesture keeps only the latest queued send), not a diff
   * against whatever the previous preview left.
   */
  always?: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * Tolerate changes to the named layers' own nodes (a switch the helper also
   * flips): the caller sends those as their own commands — only the keyframes
   * are translated here.
   */
  allowNodeChanges?: boolean;
}

export function assistantKeyframeCommands<T>(layers: readonly string[], build: () => T, opts: AssistantKeyOptions = {}): AssistantPlan<T> {
  const ids = [...new Set(layers)];
  const before = new Map(ids.map((id) => [id, keyLists(id)]));
  return offDocument(build, ({ value, changed }) => {
    const allowed = new Set(ids.flatMap((id) => (opts.allowNodeChanges ? [`anim:${id}`, `node:${id}`] : [`anim:${id}`])));
    const stray = changed.filter((k) => !allowed.has(k));
    if (stray.length > 0) throw new OffDocumentError(`the assistant changed more than keyframes (${stray.slice(0, 3).join(', ')})`);
    const cmds: Command[] = [];
    for (const layer of ids) {
      const forced = forcedPaths(layer, opts.always?.get(layer));
      if (!changed.includes(`anim:${layer}`) && forced.size === 0) continue;
      const was = before.get(layer)!;
      const now = keyLists(layer);
      for (const path of new Set([...was.keys(), ...now.keys(), ...forced])) {
        const a = was.get(path);
        const b = now.get(path);
        if (!forced.has(path) && sameKeys(a, b)) continue;
        if (!b?.length && !a?.length) continue;
        if (b && b.length > 0) cmds.push({ type: 'setKeyframes', prop: { layer, path }, keys: onePerTime(b) });
        else cmds.push({ type: 'setAnimated', prop: { layer, path }, animated: false, time: a?.[0]?.time ?? 0 });
      }
    }
    return { value, cmds };
  });
}

/**
 * A keyframe assistant as ONE undo entry named `label`. Resolves to the
 * helper's value and whether the change was applied (`ok` is true and nothing
 * is sent when the helper changed no keyframe). A helper that changed more
 * than keyframes, or a refused batch, is toasted and applies nothing.
 */
export async function assistantKeyframesEdit<T>(
  label: string,
  layers: readonly string[],
  build: () => T,
  opts: EditOptions = {},
): Promise<{ value: T | undefined; ok: boolean }> {
  let plan: AssistantPlan<T>;
  try {
    plan = assistantKeyframeCommands(layers, build);
  } catch (err) {
    if (!opts.quiet) reportEngineError(label, { code: 'internal', message: err instanceof Error ? err.message : String(err) });
    return { value: undefined, ok: false };
  }
  if (plan.cmds.length === 0) return { value: plan.value, ok: true };
  const res = await edit(label, plan.cmds, opts);
  return { value: plan.value, ok: res.ok };
}
