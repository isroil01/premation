/**
 * The LATENT numeric bindings of one layer (latentPropSpecs.ts, ENGINE_API.md
 * §15.9): which table rows hold on this layer, expanded to member tracks.
 * The C++ engine ports this (native/engine/src/core/fields.cpp `latent_members`).
 */

import type { SceneNode } from '@core/types';
import { readNodeKind } from '@core/scene/sceneDerive';
import { is3DEnabled } from '@core/scene/threeD';
import { readNodeStrokes } from '@core/paint/stroke';
import { strokeTrackPath, type StrokeTrackParam } from '@core/rendering/strokeTracks';
import { nodeMorphTargetCount, MORPH_PROP_PREFIX } from '@core/scene/modelMorph';
import { LATENT_PROPS, type LatentWhen } from './latentPropSpecs';

export interface LatentMember {
  member: string;
  home: readonly string[];
}

function fxOf(node: SceneNode): Record<string, unknown> | undefined {
  return node.components.find((c) => c.type === 'fx')?.props as Record<string, unknown> | undefined;
}

function holds(node: SceneNode, w: LatentWhen | undefined): boolean {
  if (!w) return true;
  if (w.component !== undefined && !node.components.some((c) => c.type === w.component)) return false;
  if (w.fx !== undefined && fxOf(node)?.[w.fx] === undefined) return false;
  if (w.threeD && !is3DEnabled(node)) return false;
  if (w.kinds || w.notKinds) {
    const kind = readNodeKind(node);
    if (w.kinds && !w.kinds.includes(kind)) return false;
    if (w.notKinds && w.notKinds.includes(kind)) return false;
  }
  if (w.fillType !== undefined) {
    const fill = fxOf(node)?.fill as { type?: unknown } | undefined;
    if (!fill || typeof fill !== 'object' || fill.type !== w.fillType) return false;
  }
  return true;
}

/** Every latent member of this layer, in table order (then stack / target order). */
export function latentMembers(node: SceneNode): LatentMember[] {
  const out: LatentMember[] = [];
  for (const spec of LATENT_PROPS) {
    if (!holds(node, spec.when)) continue;
    if (spec.expand === 'strokes') {
      readNodeStrokes(node).forEach((s, i) => {
        if (s.enabled) out.push({ member: strokeTrackPath(i, spec.member as StrokeTrackParam), home: spec.home });
      });
    } else if (spec.expand === 'morph') {
      const n = nodeMorphTargetCount(node);
      for (let i = 0; i < n; i++) out.push({ member: `${MORPH_PROP_PREFIX}${i}`, home: spec.home });
    } else {
      out.push({ member: spec.member, home: spec.home });
    }
  }
  return out;
}
