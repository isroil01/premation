/**
 * A property's keyframes seen from ONE of its member tracks, over the document
 * MIRROR (B4, docs/B4_MIRROR.md) — what the graph editor, the Keyframe
 * Velocity dialog, the keyframe nudge and the diamond tooltip compute with.
 * Pure: they take a mirror reader and never touch the engine.
 *
 * The API keeps ONE keyframe per time for a whole vector / colour property
 * (ENGINE_API.md §3.3) in API units, at comp-time flicks; the timeline's
 * curves and its selection are still drawn per MEMBER track (Scale X,
 * `fill_r`) in STORED units on the key's stored time. A `MemberKey` is that
 * projection of one mirror keyframe:
 *
 *   value       the member's number in stored units (`storedNumber`: the API
 *               value ÷ the track's factor — Scale's percent back to a multiplier)
 *   easing …    the member's temporal ease: `Keyframe.dims[member]` when the
 *               dimensions differ, else the key's own easing / bezier / continuous
 *   tAbs        comp seconds (where the diamond is drawn)
 *   t           the STORED time the selection names the key by — given by the
 *               caller (`StoredTimeOf`), because only the TS engine's storage
 *               knows it (keySelection.ts `storedKeyIndex`); without
 *               one it is the comp time (the C++ engine's layer axis)
 */

import { SOURCE_TEXT_PROP, type EasingKind } from '@motion/animation';
import { flicksToSeconds, type Keyframe } from '@motion/engine-api';
import { storedNumber, trackRefIn, type MirrorTreeLike, type TrackRef } from './trackIndex';

/**
 * Data tracks the timeline names a row by whose property the tree lists under
 * another match name (the inverse of buildPropertyRows `timelineTracksOf`).
 */
const DATA_TRACK_PATHS: Readonly<Record<string, string>> = {
  [SOURCE_TEXT_PROP]: 'text/sourceText',
  'fill.stops': 'layer/fillStops',
};

/** `trackRefIn`, plus the data tracks named by a TS track rather than a match name. */
export function memberTrackRef(tree: MirrorTreeLike | undefined, track: string): TrackRef | null {
  const r = trackRefIn(tree, track);
  if (r) return r;
  const alias = DATA_TRACK_PATHS[track];
  return alias ? trackRefIn(tree, alias) : null;
}

/** What these readers need from the mirror. `DocumentMirror` is one. */
export interface MemberKeyRead {
  tree(layer: string): MirrorTreeLike | undefined;
  keyframes(layer: string, path: string): readonly Keyframe[];
}

/** One mirror keyframe as one member track sees it. */
export interface MemberKey {
  /** The engine's keyframe (its id addresses writes). */
  readonly key: Keyframe;
  /** Stored time (seconds) — the selection's positional axis. */
  readonly t: number;
  /** Comp seconds. */
  readonly tAbs: number;
  /** This member's number, STORED units (0 for a non-numeric value). */
  readonly value: number;
  /** This member's temporal ease on the segment that starts at the key. */
  readonly easing: EasingKind;
  readonly bezier?: [number, number, number, number];
  readonly continuous: boolean;
  readonly roving: boolean;
}

/** A key's stored time (seconds). */
export type StoredTimeOf = (key: Keyframe) => number;

/** The default: a key's stored time is its comp time (no TS-engine storage to consult). */
export const compSecondsOf: StoredTimeOf = (k) => flicksToSeconds(k.time);

/** Project one mirror keyframe onto the member track `ref` names. */
export function memberKeyOf(ref: TrackRef, key: Keyframe, storedT: StoredTimeOf = compSecondsOf): MemberKey {
  const dim = key.dims.length > 0 ? key.dims[ref.member] ?? key.dims[0] : undefined;
  const easing = (dim?.easing ?? key.easing) as EasingKind;
  const b = dim ? dim.bezier : key.bezier;
  return {
    key,
    t: storedT(key),
    tAbs: flicksToSeconds(key.time),
    value: storedNumber(ref, key.value) ?? 0,
    easing,
    ...(b ? { bezier: [b.x1, b.y1, b.x2, b.y2] as [number, number, number, number] } : {}),
    continuous: dim ? dim.continuous : key.continuous,
    roving: key.roving,
  };
}

/**
 * The keys of the property `track` lives in on `layer`, seen from that member
 * (time order), with the track's reference — or null when the layer's tree has
 * no such track (not loaded, or not a property of the layer).
 */
export function memberKeysOf(
  m: MemberKeyRead,
  layer: string,
  track: string,
  storedT: StoredTimeOf = compSecondsOf,
): { ref: TrackRef; keys: MemberKey[] } | null {
  const ref = memberTrackRef(m.tree(layer), track);
  if (!ref) return null;
  return { ref, keys: m.keyframes(layer, ref.path).map((k) => memberKeyOf(ref, k, storedT)) };
}

/** The index of the key at stored time `t` (±`eps`), or -1. */
export function memberKeyIndexAt(keys: ReadonlyArray<{ t: number }>, t: number, eps = 1e-9): number {
  return keys.findIndex((k) => Math.abs(k.t - t) < eps);
}
