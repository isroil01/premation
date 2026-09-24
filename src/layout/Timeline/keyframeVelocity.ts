/**
 * Keyframe velocity — reading and writing a keyframe's incoming/outgoing
 * speed and influence.
 *
 * Split out of the dialog because the interesting part is not the form: it is
 * WHICH keyframe owns which half of the answer, and that is worth a test that
 * does not need a modal.
 *
 * ── Which keyframe owns which bezier ─────────────────────────────────
 * A keyframe's `easing`/`bezier` shapes the segment that STARTS at it. So for
 * the keyframe under the cursor:
 *
 *   • OUTGOING lives on THIS keyframe's bezier, against the segment to the
 *     next keyframe.
 *   • INCOMING lives on the PREVIOUS keyframe's bezier, against the segment
 *     arriving here.
 *
 * Writing the incoming half onto this keyframe is the obvious wrong version,
 * and it silently reshapes the other side of the curve — the half the user was
 * not looking at.
 *
 * A merged Position row expands to its real x/y/z tracks (`expandKeyframeProp`,
 * as the rest of the keyframe menu does), and each track solves its OWN bezier
 * for the requested speed. The axes have different value ranges, so one shared
 * bezier would mean a different speed per axis — the opposite of what was
 * asked for. Influence, being a ratio, is genuinely shared.
 */

import { expandKeyframeProp } from '@motion/animation';
import type { KeyframePatch } from '@motion/engine-api';
import { edit } from '@core/engine/uiEdits';
import { memberKeysOf, type MemberKey } from '@core/mirror/memberKeys';
import { documentMirror } from '@stores/documentMirror';
import { memberKeyPatches, toCubic } from './keyframeEdits';
import { storedTimeOf } from '@core/mirror/keySelection';
import {
  effectiveBezier,
  incomingSpeed,
  influences,
  outgoingSpeed,
  withIncomingInfluence,
  withIncomingSpeed,
  withOutgoingInfluence,
  withOutgoingSpeed,
  type Bezier,
} from './speedGraph';

/** How close (seconds) a keyframe must be to count as the one clicked. */
const EPS = 1e-3;

/** Speeds in value units per second; influences as fractions of the segment. */
export interface KeyframeVelocity {
  inSpeed: number;
  inInfluence: number;
  outSpeed: number;
  outInfluence: number;
}

export interface VelocityReading {
  velocity: KeyframeVelocity;
  /** False at the first keyframe of every affected track — nothing arrives. */
  hasIncoming: boolean;
  /** False at the last keyframe of every affected track — nothing leaves. */
  hasOutgoing: boolean;
  /** The real tracks this keyframe expands to. */
  props: string[];
}

interface Neighbourhood {
  prop: string;
  index: number;
  /** The property's keys seen from this member track (stored units and times). */
  keyframes: MemberKey[];
}

interface Segment {
  bezier: Bezier;
  dv: number;
  dt: number;
}

/**
 * The expanded tracks that carry a keyframe at `t` (stored time), with its
 * index in each — read from the document MIRROR (B4): each track's view of its
 * property's keys (`memberKeysOf`).
 */
function neighbourhoods(nodeId: string, prop: string, t: number): Neighbourhood[] {
  const m = documentMirror();
  const storedT = storedTimeOf(nodeId);
  const out: Neighbourhood[] = [];
  for (const p of expandKeyframeProp(prop)) {
    const kfs = memberKeysOf(m, nodeId, p, storedT)?.keys;
    if (!kfs || kfs.length === 0) continue;
    const index = kfs.findIndex((k) => Math.abs(k.t - t) < EPS);
    if (index === -1) continue;
    out.push({ prop: p, index, keyframes: kfs });
  }
  return out;
}

/** The segment leaving keyframe `i`, or null at the last keyframe. */
function outgoingSegment(kfs: ReadonlyArray<MemberKey>, i: number): Segment | null {
  const cur = kfs[i];
  const next = kfs[i + 1];
  if (!cur || !next) return null;
  return { bezier: effectiveBezier(cur), dv: next.value - cur.value, dt: next.t - cur.t };
}

/** The segment arriving at keyframe `i`, or null at the first keyframe. */
function incomingSegment(kfs: ReadonlyArray<MemberKey>, i: number): Segment | null {
  const prev = kfs[i - 1];
  const cur = kfs[i];
  if (!prev || !cur) return null;
  return { bezier: effectiveBezier(prev), dv: cur.value - prev.value, dt: cur.t - prev.t };
}

/** AE's default handle reach — a third of the segment on each side. */
const DEFAULT_INFLUENCE = 1 / 3;

/**
 * What the dialog opens showing. `null` when the keyframe has no segment on
 * either side — a lone keyframe has no velocity to speak of.
 *
 * Seeded from the FIRST track that has each segment: on a merged Position that
 * is x, which is also the axis the speed graph draws first.
 */
export function readKeyframeVelocity(nodeId: string, prop: string, t: number): VelocityReading | null {
  const tracks = neighbourhoods(nodeId, prop, t);
  if (tracks.length === 0) return null;

  const velocity: KeyframeVelocity = {
    inSpeed: 0,
    inInfluence: DEFAULT_INFLUENCE,
    outSpeed: 0,
    outInfluence: DEFAULT_INFLUENCE,
  };
  let hasIncoming = false;
  let hasOutgoing = false;

  for (const n of tracks) {
    const seg = incomingSegment(n.keyframes, n.index);
    if (!seg) continue;
    if (!hasIncoming) {
      velocity.inSpeed = incomingSpeed(seg.bezier, seg.dv, seg.dt);
      velocity.inInfluence = influences(seg.bezier).in;
    }
    hasIncoming = true;
  }
  for (const n of tracks) {
    const seg = outgoingSegment(n.keyframes, n.index);
    if (!seg) continue;
    if (!hasOutgoing) {
      velocity.outSpeed = outgoingSpeed(seg.bezier, seg.dv, seg.dt);
      velocity.outInfluence = influences(seg.bezier).out;
    }
    hasOutgoing = true;
  }

  if (!hasIncoming && !hasOutgoing) return null;
  return { velocity, hasIncoming, hasOutgoing, props: tracks.map((n) => n.prop) };
}

/**
 * Write `v` to every expanded track, as ONE undo entry.
 *
 * Influence is set before speed on each side deliberately: `withOutgoingSpeed`
 * solves y against the CURRENT x, so changing the reach afterwards would move
 * the speed the user just typed (`withOutgoingInfluence` preserves speed, which
 * is the property that makes this order safe and the reverse order wrong).
 */
export function applyKeyframeVelocity(
  nodeId: string,
  prop: string,
  t: number,
  v: KeyframeVelocity,
): boolean {
  const tracks = neighbourhoods(nodeId, prop, t);
  if (tracks.length === 0) return false;

  // The writes, solved per track against the CURRENT curves.
  const writes: Array<{ prop: string; t: number; bezier: Bezier }> = [];
  for (const n of tracks) {
    const incoming = incomingSegment(n.keyframes, n.index);
    const prev = n.keyframes[n.index - 1];
    if (incoming && prev) {
      let b = withIncomingInfluence(incoming.bezier, incoming.dv, incoming.dt, v.inInfluence);
      b = withIncomingSpeed(b, incoming.dv, incoming.dt, v.inSpeed);
      // The incoming half belongs to the PREVIOUS keyframe.
      writes.push({ prop: n.prop, t: prev.t, bezier: b });
    }
    const outgoing = outgoingSegment(n.keyframes, n.index);
    if (outgoing) {
      let b = withOutgoingInfluence(outgoing.bezier, outgoing.dv, outgoing.dt, v.outInfluence);
      b = withOutgoingSpeed(b, outgoing.dv, outgoing.dt, v.outSpeed);
      writes.push({ prop: n.prop, t: n.keyframes[n.index]!.t, bezier: b });
    }
  }
  if (writes.length === 0) return false;

  // Through the engine: each track's handles are its dimension's ease
  // (`KeyframePatch.dim` on a merged Position / Scale — AE's per-dimension
  // temporal ease); one `updateKeyframes`, one undo entry.
  void (async () => {
    const patches: KeyframePatch[] = [];
    for (const n of tracks) {
      const mine = writes.filter((w) => w.prop === n.prop);
      const p = await memberKeyPatches(nodeId, n.prop, mine.map((w) => ({ t: w.t, easing: 'bezier' as const, bezier: toCubic(w.bezier) })));
      if (!p) return;
      patches.push(...p);
    }
    if (patches.length > 0) await edit('Keyframe velocity', { type: 'updateKeyframes', patches });
  })();
  return true;
}
