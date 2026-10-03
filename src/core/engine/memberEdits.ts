/**
 * Keyframe assistants on a SCRATCH animation engine (block 3) — Bounce, the
 * choreography writers, anything that computes member keyframes with the
 * pre-API helpers (`setKeyframe`, `setBezier`, reading back its own keys).
 *
 * The layers' stored member tracks come from the engine (`getMemberKeyframes`),
 * are laid into a fresh `AnimationEngine`, the helper runs there, and every
 * member whose list changed is sent back as `setMemberKeyframes` (one command
 * per layer) — one batch, one undo entry, replayable in both engines. The page
 * replica is never read or written. A helper that needs a member's STATIC
 * value (no keys) reads the document mirror (`nodeBaseValue`), so the layers'
 * property trees are loaded first.
 */

import { AnimationEngine, type Keyframe } from '@motion/animation';
import type { Command } from '@motion/engine-api';
import { fetchMemberTracks } from '@stores/memberTracks';
import { documentMirror } from '@stores/documentMirror';
import { edit, reportEngineError, type EditOptions } from './uiEdits';

export interface MemberScratch {
  /** The layers' keyframes as stored, ready for the helper to transform. */
  engine: AnimationEngine;
  /** The member lists as fetched (the "before"), per layer. */
  before: ReadonlyMap<string, ReadonlyMap<string, ReadonlyArray<Keyframe>>>;
}

function seeded(before: MemberScratch['before']): AnimationEngine {
  const engine = new AnimationEngine();
  for (const [layer, members] of before) {
    for (const [member, keys] of members) engine.setTrackKeyframes(layer, member, keys.map((k) => ({ ...k })));
  }
  return engine;
}

/** The layers' member tracks in a scratch engine; their property trees loaded on the mirror. */
export async function scratchMembers(layers: readonly string[]): Promise<MemberScratch> {
  const m = documentMirror();
  const ids = [...new Set(layers)];
  const before = new Map<string, Map<string, Keyframe[]>>();
  for (const layer of ids) {
    const members = new Map<string, Keyframe[]>();
    for (const t of await fetchMemberTracks(layer)) if (t.keyframes.length > 0) members.set(t.member, t.keyframes);
    before.set(layer, members);
  }
  let missing = false;
  for (const layer of ids) if (!m.tree(layer)) missing = true;
  if (missing) await m.whenIdle();
  return { engine: seeded(before), before };
}

/** A fresh scratch over the same "before" (a second run of a deterministic helper). */
export function rescratch(s: MemberScratch): MemberScratch {
  return { engine: seeded(s.before), before: s.before };
}

const listKey = (l: ReadonlyArray<Keyframe> | undefined): string => JSON.stringify(l ?? []);

/** `setMemberKeyframes` per layer, for every member the scratch run changed. */
export function memberKeyframeCommands(s: MemberScratch): Command[] {
  const out: Command[] = [];
  for (const [layer, before] of s.before) {
    const members = new Set([...before.keys(), ...s.engine.animatedProps(layer)]);
    const tracks: Array<{ member: string; keyframes: string }> = [];
    for (const member of members) {
      const now = s.engine.getTrackKeyframes(layer, member) ?? [];
      if (listKey(now) === listKey(before.get(member))) continue;
      tracks.push({ member, keyframes: JSON.stringify(now) });
    }
    if (tracks.length > 0) out.push({ type: 'setMemberKeyframes', layer, tracks });
  }
  return out;
}

/**
 * Run `build` on the layer's scratch keyframes and send what it changed as ONE
 * undo entry named `label`. Resolves to the helper's value and whether the
 * change was applied (`ok` and nothing sent when the helper changed no key).
 */
export async function memberKeysEdit<T>(
  label: string,
  layer: string,
  build: (engine: AnimationEngine) => T,
  opts: EditOptions = {},
): Promise<{ value: T | undefined; ok: boolean }> {
  let value: T;
  let cmds: Command[];
  try {
    const s = await scratchMembers([layer]);
    value = build(s.engine);
    cmds = memberKeyframeCommands(s);
  } catch (err) {
    if (!opts.quiet) reportEngineError(label, { code: 'internal', message: err instanceof Error ? err.message : String(err) });
    return { value: undefined, ok: false };
  }
  if (cmds.length === 0) return { value, ok: true };
  const res = await edit(label, cmds, opts);
  return { value, ok: res.ok };
}
