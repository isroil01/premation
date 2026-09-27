/**
 * A layer's stored MEMBER keyframe lists as the engine reports them
 * (`getMemberKeyframes`, ENGINE_API.md §15.12) — every keyed track, in the
 * catalog or not (`x` keyed apart from `y` on an unseparated Position, an
 * effect param, a legacy track), with its keyframe records in the stored form
 * the keyframe assistants (The Smoother, The Wiggler, the motion editor)
 * transform. The API's own key lists are per PROPERTY (§3.3); these are the
 * assistants' input.
 *
 *   • `memberTracksNow(layer)` — render / menu code: this revision's answer,
 *     else the last known one while a fetch is in flight (undefined before
 *     the first). `useMemberTracks(layer)` re-renders when it lands.
 *   • `fetchMemberTracks(layer)` — a callback's exact answer.
 */

import type { Keyframe as StoredKeyframe, PropPath } from '@motion/animation';
import type { MemberTrack } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';
import { documentMirror } from './documentMirror';

/** One member track with its keyframe records parsed. */
export interface MemberKeys {
  /** The stored track name (`x`, `scaleX`, `opacity`, `effect.<id>.<param>`, …). */
  member: PropPath;
  /** The API property that owns it ('' outside the catalog) and the member's index in it. */
  path: string;
  index: number;
  keyframes: StoredKeyframe[];
  hasExpression: boolean;
}

interface Entry {
  rev: number;
  tracks: MemberKeys[];
}

const MAX_LAYERS = 256;
const entries = new Map<string, Entry>();
const inFlight = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function parse(t: MemberTrack): MemberKeys {
  let keyframes: StoredKeyframe[] = [];
  try {
    const raw = JSON.parse(t.keyframes) as unknown;
    if (Array.isArray(raw)) keyframes = raw as StoredKeyframe[];
  } catch {
    keyframes = [];
  }
  return { member: t.member as PropPath, path: t.path, index: t.index, keyframes, hasExpression: t.hasExpression };
}

/** The layer's member tracks asked of the engine now (callbacks); [] when it has none or is gone. */
export async function fetchMemberTracks(layer: string, members: ReadonlyArray<string> = []): Promise<MemberKeys[]> {
  const res = await engine().query({ type: 'getMemberKeyframes', layer, members: [...members] });
  return res.ok ? res.value.tracks.map(parse) : [];
}

/**
 * The layer's member tracks: this revision's answer, else the last known one
 * (undefined before the first) while it is fetched.
 */
export function memberTracksNow(layer: string): readonly MemberKeys[] | undefined {
  const e = entries.get(layer);
  const rev = documentMirror().revision;
  if (e && e.rev === rev) return e.tracks;
  if (!inFlight.has(layer)) {
    inFlight.add(layer);
    void fetchMemberTracks(layer).then((tracks) => {
      inFlight.delete(layer);
      if (entries.size > MAX_LAYERS) entries.clear();
      entries.set(layer, { rev, tracks });
      version += 1;
      for (const l of listeners) l();
    });
  }
  return e?.tracks;
}

/** Subscribe to answers landing (useMemberTracks). */
export function subscribeMemberTracks(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Bumps when any answer lands. */
export function memberTracksVersion(): number {
  return version;
}
