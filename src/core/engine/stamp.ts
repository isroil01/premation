/**
 * Stable-id normalisation after every engine edit: any keyframe in the edited
 * scope that has no id yet (a key written by a pre-API helper the handler used,
 * e.g. `setKeyframe`, `setRetimeMode`) gets one, deterministically (tracks and
 * keys in engine order). It happens INSIDE the command, so it is part of the
 * command's inverse and of every replay.
 */

import { defaultAnimation } from '@motion/animation';
import { readNodeMaskAnim } from '@core/effects/mask';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import type { Scope } from './state';

export function stampMissingKeyIds(scope: Scope, mint: () => string): void {
  const nodes = new Set<string>();
  const rows = new Set<string>();
  if (scope.document) {
    const snap = defaultAnimation.snapshot();
    for (const id of Object.keys(snap.tracks)) nodes.add(id);
    for (const id of Object.keys(snap.data ?? {})) nodes.add(id);
    defaultSceneGraph.traverse((n) => { if (readNodeMaskAnim(n).length > 0) rows.add(n.id); });
  }
  for (const k of scope.keys) {
    if (k.startsWith('anim:')) nodes.add(k.slice(5));
    else if (k.startsWith('node:')) rows.add(k.slice(5));
  }
  for (const id of nodes) stampTracks(id, mint);
  for (const id of rows) stampMaskKeys(id, mint);
}

function stampTracks(id: string, mint: () => string): void {
  const snap = defaultAnimation.snapshotNode(id);
  if (snap) {
    let changed = false;
    for (const kfs of Object.values(snap.tracks)) for (const k of kfs) if (!k.id) { k.id = mint(); changed = true; }
    for (const t of Object.values(snap.data)) for (const k of t.keyframes) if (!k.id) { k.id = mint(); changed = true; }
    if (changed) defaultAnimation.restoreNode(id, snap);
  }
}

function stampMaskKeys(id: string, mint: () => string): void {
  const node = defaultSceneGraph.getNode(id);
  if (!node) return;
  const anim = readNodeMaskAnim(node);
  if (anim.some((k) => !(k as { id?: string }).id)) {
    defaultSceneGraph.setMaskAnim(id, anim.map((k) => ((k as { id?: string }).id ? k : { ...k, id: mint() })));
  }
}
