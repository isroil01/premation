/**
 * A composition's clip BARS over the document mirror (B4) — the twin of the
 * TypeScript timeline controller's bars (`layersOfComp`, `getLayersForNode`).
 * Pure: takes a mirror reader, never touches the engine.
 *
 * The controller seeds one bar per layer (`syncFromScene`): every layer of the
 * composition, walked THROUGH parented layers but never INTO a group — a
 * group is the collapse unit, so its members have no bar of their own. A
 * layer's bar is its `LayerTiming` (`[inPoint, outPoint)`, comp time).
 */

import type { LayerInfo } from '@motion/engine-api';
import { framesOfTime } from './compFacts';
import { uiKindOf } from './layerKinds';

/** What these readers need from the mirror. `DocumentMirror` is one. */
export interface MirrorBarsRead {
  layer(id: string): LayerInfo | undefined;
  comp(id: string): { readonly layers: readonly string[] } | undefined;
}

/** One bar, in frames of its composition (`end` exclusive). */
export interface MirrorBar {
  /** The layer = the bar's scene node. */
  nodeId: string;
  start: number;
  end: number;
  locked: boolean;
}

const MAX_DEPTH = 64;

/** Whether a layer has a clip bar: it exists and no ancestor is a group. */
export function mirrorHasBar(m: Pick<MirrorBarsRead, 'layer'>, id: string): boolean {
  let l = m.layer(id);
  if (!l) return false;
  for (let i = 0; i < MAX_DEPTH && l.parent; i++) {
    const p = m.layer(l.parent);
    if (!p) break;
    if (uiKindOf(p) === 'group') return false;
    l = p;
  }
  return true;
}

/** A layer's bar in frames of `fps`, or null when it has none. */
export function mirrorBarOf(m: Pick<MirrorBarsRead, 'layer'>, id: string, fps: number): MirrorBar | null {
  const l = m.layer(id);
  if (!l || !mirrorHasBar(m, id)) return null;
  return {
    nodeId: id,
    start: framesOfTime(l.timing.inPoint, fps),
    end: framesOfTime(l.timing.outPoint, fps),
    locked: l.switches.locked,
  };
}

/** Every bar of `compId` (the stack's order, top first), in frames of `fps`. */
export function mirrorCompBars(m: MirrorBarsRead, compId: string | undefined, fps: number): MirrorBar[] {
  if (!compId) return [];
  const out: MirrorBar[] = [];
  for (const id of m.comp(compId)?.layers ?? []) {
    const bar = mirrorBarOf(m, id, fps);
    if (bar) out.push(bar);
  }
  return out;
}
