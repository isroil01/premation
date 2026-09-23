/**
 * Cut transitions (B3z, ENGINE_API.md §4.5): `addTransition`, `setTransition`,
 * `removeTransitions`.
 *
 * The record model is `core/timeline/transitions.ts`'s: a small declarative
 * record per cut, MATERIALISED into the two layers (bars overlapped into their
 * source handles, opacity / effect ramps), with a verbatim snapshot of what it
 * overwrote (`before`) stored inside the record so removal — even after a
 * save/reload — puts the cut back exactly. The legacy helpers worked on the
 * ACTIVE composition's timeline and pushed two histories; this is the same
 * rule set on the layers' own composition, written silently inside one engine
 * entry whose parts (the layers, their comp's timeline and the `tx` store part)
 * are the exact inverse. Validation that needs the cut WITHOUT the current
 * transition (a change, a re-add) runs inside `apply` after the peel: a refusal
 * there throws and the engine rolls the command back.
 *
 * Mirrored by native/engine/src/core/handlers_transitions.cpp — every rule, key
 * order and message here has a twin there (the saved records are compared byte
 * for byte by the cross-engine replay).
 */

import { defaultAnimation, type Keyframe } from '@motion/animation';
import { useTransitionStore } from '@stores/transitionStore';
import { addEffect, updateEffectParam, getNodeEffects, writeNodeEffects, effectPropPath } from '@core/effects/effects';
import { compToKeyframeTime } from '@core/timeline/TimelineController';
import {
  TRANSITION_LABEL,
  type TransitionRecord,
  type TransitionKind,
  type TransitionAlignment,
  type TransitionSnapshot,
} from '@core/timeline/transitionModel';
import type { ClipGeometry } from '@core/commands/snapshotSharing';
import { fail } from '../errors';
import { graph, compOfLayer, requireLayer, isCompItem } from '../doc';
import { K, newScope, type Scope } from '../state';
import { compFps, flicksToFrames } from '../time';
import type { HandlerTable, HandlerCtx } from '../handler';
import { ensureTimeline, geomsOf, writeGeoms, layersScope, requireLayersInOneComp } from './common';


// ── The record model (transitions.ts, comp-aware) ────────────────────

function overlaps(kind: TransitionKind): boolean {
  return kind === 'crossDissolve' || kind === 'wipe';
}

function region(durationFrames: number, alignment: TransitionAlignment): { before: number; after: number } {
  const n = Math.max(1, Math.round(durationFrames));
  if (alignment === 'startAtCut') return { before: 0, after: n };
  if (alignment === 'endAtCut') return { before: n, after: 0 };
  const before = Math.floor(n / 2);
  return { before, after: n - before };
}

function fxId(rec: Pick<TransitionRecord, 'id'>, side: 'l' | 'r'): string {
  return `tx_${rec.id}_${side}`;
}

function propsOf(rec: TransitionRecord): Array<{ nodeId: string; prop: string }> {
  switch (rec.kind) {
    case 'crossDissolve':
    case 'dipToBlack':
      return [{ nodeId: rec.leftNodeId, prop: 'opacity' }, { nodeId: rec.rightNodeId, prop: 'opacity' }];
    case 'dipToWhite':
      return [
        { nodeId: rec.leftNodeId, prop: effectPropPath(fxId(rec, 'l'), 'opacity') },
        { nodeId: rec.rightNodeId, prop: effectPropPath(fxId(rec, 'r'), 'opacity') },
      ];
    case 'wipe':
      return [{ nodeId: rec.rightNodeId, prop: effectPropPath(fxId(rec, 'r'), 'completion') }];
  }
}

interface Pair { left: ClipGeometry[]; right: ClipGeometry[]; li: number; ri: number }

/** `rollPair`: the two bars meeting at the cut (one-frame seam tolerance, nearest wins). */
function cutPair(comp: string, left: string, right: string): Pair | null {
  if (left === right) return null;
  const lefts = geomsOf(left, comp);
  const rights = geomsOf(right, comp);
  let best: Pair | null = null;
  let bestGap = Infinity;
  lefts.forEach((l, li) => {
    rights.forEach((r, ri) => {
      const gap = Math.abs(l.start + l.duration - r.start);
      if (gap > 1 || gap >= bestGap) return;
      best = { left: lefts, right: rights, li, ri };
      bestGap = gap;
    });
  });
  return best;
}

const plural = (n: number): string => (n === 1 ? '1 frame' : `${n} frames`);

/** `checkTransition`: may this record be materialised on the cut as it is now? */
function check(comp: string, rec: TransitionRecord): Pair {
  const pair = cutPair(comp, rec.leftNodeId, rec.rightNodeId);
  if (!pair) fail('invalidArgument', 'Those two layers no longer meet at a cut.');
  if (graph.getNode(rec.leftNodeId)?.locked || graph.getNode(rec.rightNodeId)?.locked) fail('locked', 'One of the two layers is locked.');
  if (!overlaps(rec.kind)) return pair;
  const l = pair.left[pair.li]!;
  const r = pair.right[pair.ri]!;
  const leftTail = l.sourceDuration === null ? Infinity : Math.max(0, l.sourceDuration - (l.sourceIn + l.duration));
  const rightHead = Math.min(r.sourceDuration === null ? Infinity : Math.max(0, r.sourceIn), r.start);
  const { before, after } = region(rec.durationFrames, rec.alignment);
  const label = TRANSITION_LABEL[rec.kind];
  const n = plural(Math.round(rec.durationFrames));
  if (after > leftTail) {
    fail('outOfRange', `Not enough handle for a ${n} ${label}: the outgoing clip has ${plural(leftTail)} of source after its out-point and needs ${plural(after)}. Trim it shorter, shorten the transition, or align it to end at the cut.`);
  }
  if (before > rightHead) {
    fail('outOfRange', `Not enough handle for a ${n} ${label}: the incoming clip has ${plural(rightHead)} of source before its in-point and needs ${plural(before)}. Trim it shorter, shorten the transition, or align it to start at the cut.`);
  }
  return pair;
}

/**
 * A keyframe in the canonical key order both engines write (anim_json.cpp
 * `key_to_json`), so a saved record is byte-identical across engines.
 */
function canonicalKey(k: Keyframe): Keyframe {
  const src = k as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { t: src.t, value: src.value };
  for (const f of ['id', 'easing', 'bezier', 'continuous', 'roving', 'spatialInterp', 'si', 'so', 'label']) {
    if (src[f] !== undefined) out[f] = structuredClone(src[f]);
  }
  for (const f of Object.keys(src)) if (!(f in out) && src[f] !== undefined) out[f] = structuredClone(src[f]);
  return out as unknown as Keyframe;
}

function captureBefore(comp: string, rec: TransitionRecord): TransitionSnapshot {
  const nodes = [rec.leftNodeId, rec.rightNodeId];
  return {
    bars: nodes.flatMap((nodeId) => geomsOf(nodeId, comp).map((clip, index) => ({ nodeId, index, clip: { ...clip } }))),
    tracks: propsOf(rec).map(({ nodeId, prop }) => ({
      nodeId,
      prop,
      keyframes: (defaultAnimation.getTrackKeyframes(nodeId, prop) ?? []).map(canonicalKey),
    })),
    effects: nodes.map((nodeId) => ({ nodeId, stack: structuredClone(getNodeEffects(nodeId)) })),
  };
}

/** Comp frame → the node's keyframe axis; `atBarEnd` for an exclusive bar end (transitions.ts kfTime). */
function kfTime(nodeId: string, frame: number, fps: number, atBarEnd = false): number {
  if (!atBarEnd) return compToKeyframeTime(nodeId, frame / fps);
  return compToKeyframeTime(nodeId, (frame - 1) / fps) + 1 / fps;
}

function trimEnd(g: ClipGeometry, newEnd: number): ClipGeometry {
  let end = Math.max(newEnd, g.start + 1);
  if (g.sourceDuration !== null) end = Math.min(end, g.start + (g.sourceDuration - g.sourceIn));
  return { ...g, duration: end - g.start };
}

function trimStart(g: ClipGeometry, newStart: number): ClipGeometry {
  const tail = g.start + g.duration;
  let start = Math.min(newStart, tail - 1);
  if (g.sourceDuration !== null) start = Math.max(start, g.start - g.sourceIn);
  const delta = start - g.start;
  return { ...g, start, duration: tail - start, sourceIn: g.sourceIn + delta };
}

/** `materializeTransition` on `comp`: returns the record with its `before` snapshot. */
function materialize(comp: string, rec: TransitionRecord): TransitionRecord {
  const pair = check(comp, rec);
  const fps = compFps(comp);
  const cutFrame = pair.left[pair.li]!.start + pair.left[pair.li]!.duration;
  const { before, after } = region(rec.durationFrames, rec.alignment);
  const snapshot = captureBefore(comp, rec);
  const startFrame = cutFrame - before;
  const endFrame = cutFrame + after;
  const L = rec.leftNodeId;
  const R = rec.rightNodeId;
  if (overlaps(rec.kind)) {
    const left = pair.left.slice();
    const right = pair.right.slice();
    if (after > 0) left[pair.li] = trimEnd(left[pair.li]!, left[pair.li]!.start + left[pair.li]!.duration + after);
    if (before > 0) right[pair.ri] = trimStart(right[pair.ri]!, right[pair.ri]!.start - before);
    writeGeoms(comp, L, left);
    writeGeoms(comp, R, right);
  }
  const key = (node: string, prop: string, frame: number, value: number, atEnd = false): void => {
    defaultAnimation.setKeyframe(node, prop, kfTime(node, frame, fps, atEnd), value);
  };
  switch (rec.kind) {
    case 'crossDissolve':
      key(L, 'opacity', startFrame, 100);
      key(L, 'opacity', endFrame, 0, true);
      key(R, 'opacity', startFrame, 0);
      key(R, 'opacity', endFrame, 100);
      break;
    case 'dipToBlack':
      if (before > 0) {
        key(L, 'opacity', startFrame, 100);
        key(L, 'opacity', cutFrame, 0, true);
      }
      if (after > 0) {
        key(R, 'opacity', cutFrame, 0);
        key(R, 'opacity', endFrame, 100);
      }
      break;
    case 'dipToWhite': {
      const lf = fxId(rec, 'l');
      const rf = fxId(rec, 'r');
      if (before > 0) {
        addEffect(L, 'fill', lf);
        updateEffectParam(L, lf, 'color', '#ffffff');
        updateEffectParam(L, lf, 'opacity', 0);
      }
      if (after > 0) {
        addEffect(R, 'fill', rf);
        updateEffectParam(R, rf, 'color', '#ffffff');
        updateEffectParam(R, rf, 'opacity', 0);
      }
      if (before > 0) {
        key(L, effectPropPath(lf, 'opacity'), startFrame, 0);
        key(L, effectPropPath(lf, 'opacity'), cutFrame, 100, true);
      }
      if (after > 0) {
        key(R, effectPropPath(rf, 'opacity'), cutFrame, 100);
        key(R, effectPropPath(rf, 'opacity'), endFrame, 0);
      }
      break;
    }
    case 'wipe': {
      const rf = fxId(rec, 'r');
      addEffect(R, 'linear-wipe', rf);
      updateEffectParam(R, rf, 'completion', 100);
      key(R, effectPropPath(rf, 'completion'), startFrame, 100);
      key(R, effectPropPath(rf, 'completion'), endFrame, 0);
      break;
    }
  }
  return { ...rec, before: snapshot };
}

/** `dematerializeTransition`: effects, then tracks, then bars (geometry last). */
function dematerialize(comp: string, rec: TransitionRecord): void {
  const snap = rec.before;
  if (!snap) return;
  for (const e of snap.effects ?? []) {
    if (graph.getNode(e.nodeId)) writeNodeEffects(e.nodeId, structuredClone(e.stack));
  }
  for (const t of snap.tracks ?? []) {
    if (!graph.getNode(t.nodeId)) continue;
    defaultAnimation.setTrackKeyframes(t.nodeId, t.prop, t.keyframes.length ? t.keyframes.map((k) => ({ ...k })) : null);
  }
  const byNode = new Map<string, ClipGeometry[]>();
  for (const b of snap.bars ?? []) {
    if (!graph.getNode(b.nodeId)) continue;
    const geoms = byNode.get(b.nodeId) ?? geomsOf(b.nodeId, comp);
    if (!geoms[b.index]) continue;
    geoms[b.index] = { ...b.clip };
    byNode.set(b.nodeId, geoms);
  }
  for (const [nodeId, geoms] of byNode) writeGeoms(comp, nodeId, geoms);
}

// ── Store access ─────────────────────────────────────────────────────

function findRecord(id: string): { comp: string; rec: TransitionRecord } {
  const byComp = useTransitionStore.getState().byComp;
  for (const comp of Object.keys(byComp)) {
    const rec = (byComp[comp] ?? []).find((t) => t.id === id);
    if (rec) return { comp, rec };
  }
  return fail('notFound', `no transition '${id}'`);
}

function transitionTaken(id: string): boolean {
  const byComp = useTransitionStore.getState().byComp;
  return Object.values(byComp).some((list) => (list ?? []).some((t) => t.id === id));
}

function durationFrames(flicks: number, comp: string): number {
  const f = flicksToFrames(flicks, compFps(comp));
  if (!Number.isFinite(f) || f < 1) fail('outOfRange', 'a transition lasts at least one frame');
  return Math.max(1, Math.round(f));
}

function scopeFor(comp: string, recs: ReadonlyArray<Pick<TransitionRecord, 'leftNodeId' | 'rightNodeId'>>, s: Scope = newScope()): Scope {
  ensureTimeline(comp);
  const ids = [...new Set(recs.flatMap((r) => [r.leftNodeId, r.rightNodeId]))].filter((id) => !!graph.getNode(id));
  layersScope(ids, comp, s);
  s.keys.add(K.tx);
  return s;
}

// ── Handlers ─────────────────────────────────────────────────────────

export const transitionHandlers: HandlerTable = {
  addTransition: (cmd, ctx: HandlerCtx) => {
    const comp = requireLayersInOneComp([cmd.left, cmd.right]);
    const frames = durationFrames(cmd.duration, comp);
    const existing = (useTransitionStore.getState().byComp[comp] ?? []).find((t) => t.leftNodeId === cmd.left && t.rightNodeId === cmd.right);
    const id = ctx.mintGroupId('tx_', transitionTaken);
    const draft: TransitionRecord = {
      id,
      leftNodeId: cmd.left,
      rightNodeId: cmd.right,
      kind: cmd.kind,
      durationFrames: frames,
      alignment: cmd.alignment,
    };
    return {
      scope: scopeFor(comp, [draft]),
      label: `Add ${TRANSITION_LABEL[cmd.kind]}`,
      apply: () => {
        const store = useTransitionStore.getState();
        if (existing) {
          dematerialize(comp, existing);
          store.drop(comp, existing.id);
        }
        useTransitionStore.getState().put(comp, materialize(comp, draft));
        return { transition: id };
      },
    };
  },

  setTransition: (cmd) => {
    const { comp, rec } = findRecord(cmd.transition);
    if (!compOfLayer(rec.leftNodeId) || compOfLayer(rec.leftNodeId) !== comp) fail('invalidArgument', 'Those two layers no longer meet at a cut.');
    requireLayer(rec.rightNodeId);
    const next: TransitionRecord = {
      ...rec,
      ...(cmd.kind !== undefined ? { kind: cmd.kind } : {}),
      ...(cmd.duration !== undefined ? { durationFrames: durationFrames(cmd.duration, comp) } : {}),
      ...(cmd.alignment !== undefined ? { alignment: cmd.alignment } : {}),
    };
    delete next.before;
    return {
      scope: scopeFor(comp, [rec]),
      label: `Change ${TRANSITION_LABEL[next.kind] ?? 'Transition'}`,
      apply: () => {
        dematerialize(comp, rec);
        useTransitionStore.getState().put(comp, materialize(comp, next));
        return {};
      },
    };
  },

  removeTransitions: (cmd) => {
    if (cmd.transitions.length === 0) fail('invalidArgument', 'no transitions given');
    if (new Set(cmd.transitions).size !== cmd.transitions.length) fail('invalidArgument', 'a transition is listed twice');
    const found = cmd.transitions.map(findRecord);
    const scope = newScope();
    for (const f of found) {
      if (!isCompItem(f.comp)) fail('notFound', `no composition '${f.comp}'`);
      scopeFor(f.comp, [f.rec], scope);
    }
    const first = found[0]!.rec;
    return {
      scope,
      label: found.length === 1 ? `Remove ${TRANSITION_LABEL[first.kind] ?? 'Transition'}` : `Remove ${found.length} Transitions`,
      apply: () => {
        // Newest first (store order, per comp): a later transition's snapshot was
        // taken over an earlier one's output.
        const pos = (f: { comp: string; rec: TransitionRecord }): number =>
          (useTransitionStore.getState().byComp[f.comp] ?? []).findIndex((t) => t.id === f.rec.id);
        const ordered = found.map((f) => ({ f, p: pos(f) })).sort((a, b) => b.p - a.p).map((x) => x.f);
        for (const f of ordered) {
          dematerialize(f.comp, f.rec);
          useTransitionStore.getState().drop(f.comp, f.rec.id);
        }
        return {};
      },
    };
  },
};
