/**
 * The shape STROKE STACK over the engine API (B3z, ENGINE_API.md §15.9):
 *
 *   layer/strokes   json field — the whole stack (`readNodeStrokes`: normalised,
 *                   disabled entries included). A write replaces it (each entry
 *                   renormalised, `normalizeStroke`; the stack kept only when > 1
 *                   and strokes[0] mirrored into `fx.stroke`, stroke.ts
 *                   `setNodeStrokes`). Keyframe tracks bind by stack INDEX
 *                   (strokeTracks.ts), so a write keeps index i's tracks on
 *                   entry i, and drops the tracks of the strokes past the new
 *                   end and of the dash slots a stroke's pattern lost.
 *   removeStroke    command — delete stroke N: its tracks go, and the tracks
 *                   (keys AND expressions) of every stroke above move down one
 *                   index (stroke.ts `removeNodeStrokeAt`).
 *
 * The C++ engine ports this file (native/engine/src/core/strokes.cpp).
 */

import { defaultAnimation, type NodeAnimSnapshot } from '@motion/animation';
import type { Value } from '@motion/engine-api';
import type { SceneNode } from '@core/types';
import { readNodeStrokes, storeNodeStrokes, normalizeStroke, type Stroke } from '@core/paint/stroke';
import { dashParamAt, strokeTrackPath, strokeTrackPathsFor } from '@core/rendering/strokeTracks';
import { fail } from './errors';

/** A stack entry: an object with a numeric width (stroke.ts `isStroke`). */
const isStrokeLike = (v: unknown): boolean =>
  !!v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { width?: unknown }).width === 'number';

export function readStrokeStack(node: SceneNode): Value {
  return { kind: 'json', value: JSON.stringify(readNodeStrokes(node)) };
}

/** The layer carries a stroke stack, or can (a paint host: Style / Text, a fill or stroke on its fx). */
export function hasStrokeHost(node: SceneNode, paintHost: boolean): boolean {
  const fx = node.components.find((c) => c.type === 'fx')?.props as Record<string, unknown> | undefined;
  return paintHost || fx?.stroke !== undefined || fx?.strokes !== undefined;
}

/** Drop every track / expression / data track named in `props`. */
function dropProps(layerId: string, props: ReadonlySet<string>): void {
  if (props.size === 0) return;
  const snap = defaultAnimation.snapshotNode(layerId);
  if (!snap) return;
  const keep = <V>(section: Record<string, V>): { out: Record<string, V>; dropped: boolean } => {
    const out: Record<string, V> = {};
    let dropped = false;
    for (const [p, v] of Object.entries(section)) {
      if (props.has(p)) dropped = true;
      else out[p] = v;
    }
    return { out, dropped };
  };
  const t = keep(snap.tracks);
  const e = keep(snap.expressions);
  const d = keep(snap.data);
  if (!t.dropped && !e.dropped && !d.dropped) return;
  defaultAnimation.restoreNode(layerId, { tracks: t.out, expressions: e.out, data: d.out });
}

/** `layer/strokes` := `value` (json array of strokes; null = none). */
export function writeStrokeStack(layerId: string, node: SceneNode, path: string, value: Value): void {
  if (value.kind !== 'json') fail('typeMismatch', `'${path}' takes json, got ${value.kind}`, { path, detail: JSON.stringify({ expected: 'json' }) });
  let v: unknown;
  try {
    v = JSON.parse(value.value) as unknown;
  } catch {
    fail('invalidArgument', 'invalid json', { path });
  }
  if (v === null) v = [];
  if (!Array.isArray(v) || !v.every(isStrokeLike)) {
    fail('invalidArgument', `'${path}' takes null or an array of strokes {width: number, …}`, { path });
  }
  const before = readNodeStrokes(node);
  const after = (v as unknown[]).map(normalizeStroke);
  // Tracks bind by index: the strokes past the new end, and the dash slots a
  // kept stroke's pattern lost, take their keyframes with them.
  const drop = new Set<string>();
  for (let i = after.length; i < before.length; i++) for (const p of strokeTrackPathsFor(i)) drop.add(p);
  for (let i = 0; i < Math.min(before.length, after.length); i++) {
    for (let k = after[i]!.dash.length; k < before[i]!.dash.length; k++) {
      const slot = dashParamAt(k);
      if (slot) drop.add(strokeTrackPath(i, slot));
    }
  }
  dropProps(layerId, drop);
  storeNodeStrokes(layerId, after);
}

/** `removeStroke`: validate, then apply (the handler's plan). */
export function planRemoveStroke(layerId: string, node: SceneNode, index: number): () => void {
  const stack: Stroke[] = readNodeStrokes(node);
  if (!Number.isInteger(index) || index < 0 || index >= stack.length) {
    fail('outOfRange', `layer '${layerId}' has no stroke ${index}`, { layer: layerId, detail: JSON.stringify({ strokes: stack.length }) });
  }
  return () => {
    const snap = defaultAnimation.snapshotNode(layerId);
    if (snap) {
      const next: NodeAnimSnapshot = { tracks: { ...snap.tracks }, expressions: { ...snap.expressions }, data: { ...snap.data } };
      let changed = false;
      for (const section of [next.tracks, next.expressions] as Array<Record<string, unknown>>) {
        for (const p of strokeTrackPathsFor(index)) {
          if (p in section) { delete section[p]; changed = true; }
        }
        for (let j = index + 1; j < stack.length; j++) {
          const from = strokeTrackPathsFor(j);
          const to = strokeTrackPathsFor(j - 1);
          from.forEach((p, k) => {
            if (!(p in section)) return;
            section[to[k]!] = section[p];
            delete section[p];
            changed = true;
          });
        }
      }
      if (changed) defaultAnimation.restoreNode(layerId, next);
    }
    storeNodeStrokes(layerId, stack.filter((_, i) => i !== index));
  };
}
