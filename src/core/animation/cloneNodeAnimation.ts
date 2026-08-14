/**
 * Copy every animation belonging to one layer onto another: property
 * keyframes, data tracks (Source Text, puppet pin positions, mask shapes),
 * and expressions.
 *
 * Duplicate / paste used to copy only `tracksFor` (numeric property
 * keyframes). Effects themselves live on the node, but their *animation* is
 * those tracks — and Source Text / pin positions live on data tracks, which
 * a property-track copy silently dropped. The copy then looked like "just
 * the object, none of its motion".
 */

import { defaultAnimation, type DataTrack, type PropertyTrack } from '@motion/animation';

export interface NodeAnimationSnapshot {
  tracks: PropertyTrack[];
  dataTracks: DataTrack[];
  expressions: Array<{ prop: string; src: string; enabled: boolean; authoredBy?: string }>;
}

/** Freeze a node's animation so paste still works after the original is deleted. */
export function snapshotNodeAnimation(nodeId: string): NodeAnimationSnapshot {
  const dataTracks: DataTrack[] = [];
  for (const track of defaultAnimation.dataTracksFor(nodeId)) {
    const copy = defaultAnimation.getDataTrack(nodeId, track.prop);
    if (copy) dataTracks.push(copy);
  }
  const expressions: NodeAnimationSnapshot['expressions'] = [];
  for (const expr of defaultAnimation.allExpressions()) {
    if (expr.nodeId !== nodeId) continue;
    expressions.push({
      prop: expr.prop,
      src: expr.src,
      enabled: defaultAnimation.isExpressionEnabled(nodeId, expr.prop),
      ...(expr.authoredBy ? { authoredBy: expr.authoredBy } : {}),
    });
  }
  return {
    tracks: structuredClone(defaultAnimation.tracksFor(nodeId)),
    dataTracks,
    expressions,
  };
}

export function applyNodeAnimation(toId: string, snap: NodeAnimationSnapshot): void {
  for (const track of snap.tracks) {
    defaultAnimation.setKeyframes(toId, track.prop, track.keyframes);
  }
  for (const track of snap.dataTracks) {
    defaultAnimation.setDataTrack(toId, track.prop, track);
  }
  for (const expr of snap.expressions) {
    defaultAnimation.setExpressionState(toId, expr.prop, {
      src: expr.src,
      enabled: expr.enabled,
      ...(expr.authoredBy ? { authoredBy: expr.authoredBy } : {}),
    });
  }
}

export function copyNodeAnimation(fromId: string, toId: string): void {
  applyNodeAnimation(toId, snapshotNodeAnimation(fromId));
}
