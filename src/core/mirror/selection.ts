/**
 * The Inspector's multi-selection reads over the document MIRROR (B4) — the
 * mirror twins of core/inspector/multiSelection.ts's readers (aggregate a
 * property across the selection, keyframe navigation, kinds). Pure: they take
 * a `MirrorRead` (the app passes the document mirror) and never touch the
 * engine.
 *
 * Values are in STORED units (what a row's `displayScale` has always been
 * applied to), converted from API units with the track's factor. Times are
 * composition SECONDS on the way in and out; the mirror speaks flicks.
 */

import { flicksToSeconds, secondsToFlicks, type Keyframe, type LayerInfo, type Value } from '@motion/engine-api';
import type { SceneKind } from '@core/scene/seedDefaultScene';
import { uiKindOf } from './layerKinds';
import { numbersOfValue, storedNumber, trackRefIn, type MirrorTreeLike, type TrackRef } from './trackIndex';

/** What these readers need from the mirror. `DocumentMirror` is one. */
export interface MirrorRead {
  layer(id: string): LayerInfo | undefined;
  tree(id: string): MirrorTreeLike | undefined;
  keyframes(layer: string, path: string): readonly Keyframe[];
  valueAt(layer: string, path: string, time: number): Value | undefined;
}

/** Values closer than this are "the same" (matches multiSelection.ts). */
export const MIXED_EPSILON = 1e-6;
/** Seconds within which the playhead is "on" a keyframe (matches multiSelection.ts). */
export const KEYFRAME_EPS = 1e-4;

export interface MultiValue {
  value: number;
  mixed: boolean;
  present: number;
  nodeIds: string[];
  animated: boolean;
  allAnimated: boolean;
}

export function trackRef(m: MirrorRead, nodeId: string, track: string): TrackRef | null {
  if (!m.layer(nodeId)) return null;
  return trackRefIn(m.tree(nodeId), track);
}

export function isTrackAnimated(m: MirrorRead, nodeId: string, track: string): boolean {
  const r = trackRef(m, nodeId, track);
  return !!r && m.keyframes(nodeId, r.path).length > 0;
}

/** Whether the track's property carries an expression (and whether it is on). */
export function trackExpression(m: MirrorRead, nodeId: string, track: string): { source: string; enabled: boolean; error: string } | null {
  const r = trackRef(m, nodeId, track);
  if (!r || r.info.expression === '') return null;
  return { source: r.info.expression, enabled: r.info.expressionEnabled, error: r.info.expressionError };
}

/** The value one layer's track HAS at comp time `seconds` (stored units), or undefined when it has no such track. */
export function readTrack(m: MirrorRead, nodeId: string, track: string, seconds: number): number | undefined {
  const r = trackRef(m, nodeId, track);
  if (!r) return undefined;
  return storedNumber(r, m.valueAt(nodeId, r.path, secondsToFlicks(seconds)));
}

/** A track across the selection (the mirror twin of `aggregateProperty`). */
export function aggregateTrack(m: MirrorRead, nodeIds: ReadonlyArray<string>, track: string, seconds: number, fallback = 0): MultiValue {
  const present: string[] = [];
  const values: number[] = [];
  let animatedCount = 0;
  for (const id of nodeIds) {
    const v = readTrack(m, id, track, seconds);
    if (v === undefined) continue;
    present.push(id);
    values.push(v);
    if (isTrackAnimated(m, id, track)) animatedCount += 1;
  }
  const value = values[0] ?? fallback;
  return {
    value,
    mixed: values.some((v) => Math.abs(v - value) > MIXED_EPSILON),
    present: present.length,
    nodeIds: present,
    animated: animatedCount > 0,
    allAnimated: present.length > 0 && animatedCount === present.length,
  };
}

/** Key times of a track, composition seconds, sorted. */
export function trackKeyTimes(m: MirrorRead, nodeId: string, track: string): number[] {
  const r = trackRef(m, nodeId, track);
  if (!r) return [];
  return m.keyframes(nodeId, r.path).map((k) => flicksToSeconds(k.time));
}

export interface NavState { hasPrev: boolean; hasNext: boolean; atKeyframe: boolean; prevT: number | null; nextT: number | null }

/** Keyframe navigation across the selection (the twin of `navigatorState`). */
export function navigatorFor(m: MirrorRead, nodeIds: ReadonlyArray<string>, track: string, seconds: number): NavState {
  let hasPrev = false;
  let hasNext = false;
  let animated = 0;
  let at = 0;
  let prevT: number | null = null;
  let nextT: number | null = null;
  for (const id of nodeIds) {
    const times = trackKeyTimes(m, id, track);
    if (times.length === 0) continue;
    animated += 1;
    if (times.some((t) => Math.abs(t - seconds) < KEYFRAME_EPS)) at += 1;
    for (let i = times.length - 1; i >= 0; i--) {
      if (times[i]! < seconds - KEYFRAME_EPS) {
        hasPrev = true;
        if (prevT === null || times[i]! > prevT) prevT = times[i]!;
        break;
      }
    }
    const next = times.find((t) => t > seconds + KEYFRAME_EPS);
    if (next !== undefined) {
      hasNext = true;
      if (nextT === null || next < nextT) nextT = next;
    }
  }
  return { hasPrev, hasNext, atKeyframe: animated > 0 && at === animated, prevT, nextT };
}

/** Group navigator over several tracks (the twin of `groupNavigatorState`). */
export function groupNavigatorFor(m: MirrorRead, nodeIds: ReadonlyArray<string>, tracks: ReadonlyArray<string>, seconds: number): NavState {
  const out: NavState = { hasPrev: false, hasNext: false, atKeyframe: false, prevT: null, nextT: null };
  for (const t of tracks) {
    if (!nodeIds.some((id) => isTrackAnimated(m, id, t))) continue;
    const n = navigatorFor(m, nodeIds, t, seconds);
    if (n.atKeyframe) out.atKeyframe = true;
    if (n.hasPrev) out.hasPrev = true;
    if (n.hasNext) out.hasNext = true;
    if (n.prevT !== null && (out.prevT === null || n.prevT > out.prevT)) out.prevT = n.prevT;
    if (n.nextT !== null && (out.nextT === null || n.nextT < out.nextT)) out.nextT = n.nextT;
  }
  return out;
}

/** The editor kind of a mirror layer. */
export function kindOf(m: MirrorRead, nodeId: string): SceneKind | null {
  return uiKindOf(m.layer(nodeId));
}

/** Kind breakdown of the selection — "2 shapes, 1 text". */
export function selectionKindsOf(m: MirrorRead, nodeIds: ReadonlyArray<string>): Array<{ kind: string; count: number }> {
  const counts = new Map<string, number>();
  for (const id of nodeIds) {
    const k = kindOf(m, id);
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count);
}

/** The numbers of a whole property value at a time (API units) — colours, vectors. */
export function valueNumbersAt(m: MirrorRead, nodeId: string, path: string, seconds: number): number[] {
  return numbersOfValue(m.valueAt(nodeId, path, secondsToFlicks(seconds)));
}

/** A layer flag across the selection (the twin of `aggregateFlag`). */
export function aggregateLayerFlag<T>(m: MirrorRead, nodeIds: ReadonlyArray<string>, read: (layer: LayerInfo) => T): { value: T | undefined; mixed: boolean; present: number } {
  const live = nodeIds.map((id) => m.layer(id)).filter((l): l is LayerInfo => !!l);
  if (live.length === 0) return { value: undefined, mixed: false, present: 0 };
  const first = read(live[0]!);
  return { value: first, mixed: live.some((l) => read(l) !== first), present: live.length };
}
