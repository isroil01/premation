/**
 * A solid-mode transition as an ENGINE CLIENT: the comp-covering panel(s)
 * (transitionLibrary.ts `insertTransitionPanel`: a comp-sized shape flagged
 * as a transition panel, its solid fill), their choreography over the cut
 * (`panelRecipe`, keys from the playhead `t0` — a new layer starts at 0, so
 * comp and layer seconds agree), a real Blur effect where the recipe keys
 * `@blur`, and the iris's animated ellipse mask — laid into a
 * {@link FragmentBuilder} and pasted as ONE `pasteLayers` by the caller.
 * Pinned against `applyTransitionItem`'s off-document build
 * (engine-client/transitionFragment.test.ts). No page replica.
 */

import { makeNode } from '@core/scene/layerBuilders';
import { effectDefFor, effectPropPath, newInstanceParamsOf } from '@core/effects/effects';
import { ellipseMask, interpolateMask, type LayerMask, type MaskKeyframe } from '@core/effects/mask';
import type { FragmentBuilder } from '@/engine-client/fragmentBuilder';
import type { InsertFrame } from '@/engine-client/insertFragment';
import { TRANSITION_PANEL_PROP, getTransitionItem, panelRecipe, solidRestTime, type CompBox } from './transitionLibrary';

export interface BuiltTransitionPanels {
  /** The panels' scratch ids, in insert order (the layers to select). */
  panels: string[];
  /** Where the preview rests (seconds after `t0`): half-covered (`solidRestTime`). */
  restAfter: number;
  duration: number;
}

let seq = 0;

/** One comp-sized transition panel (insertTransitionPanel's layer). */
function addPanel(b: FragmentBuilder, comp: string, color: string, box: CompBox, name: string): string | null {
  const node = makeNode('shape', name);
  const t = node.components.find((c) => c.type === 'Transform');
  if (!t) return null;
  const p = t.props as Record<string, unknown>;
  p[TRANSITION_PANEL_PROP] = true;
  p.x = box.width / 2;
  p.y = box.height / 2;
  p.width = box.width;
  p.height = box.height;
  b.addChild(comp, node);
  b.setFx(node.id, 'fill', { type: 'solid', color });
  return node.id;
}

/** A fresh Blur effect on a new panel (effects.ts addEffect on an empty stack); its Amount track. */
function addBlur(b: FragmentBuilder, id: string): string | null {
  const def = effectDefFor('blur');
  if (!def) return null;
  const fxId = `fx_t${(seq += 1)}`;
  b.setFx(id, 'effects', [{ id: fxId, type: 'blur', params: newInstanceParamsOf(def) }]);
  return effectPropPath(fxId, 'amount');
}

/**
 * The iris (applyIrisMask): a tiny ellipse mask keyed at `t0`, past full
 * frame at the midpoint, tiny again at the end — the same keys mask.ts
 * `addMaskPath` / `keyframeMask` / `setMaskPoints` write on a mask-less layer.
 */
function addIrisMask(b: FragmentBuilder, id: string, box: CompBox, t0: number, duration: number): void {
  const small = ellipseMask(12, 12);
  const bigD = Math.hypot(box.width, box.height) * 1.05;
  const big = ellipseMask(bigD, bigD);
  const base: LayerMask = { paths: [small] };
  b.setFx(id, 'mask', base);
  let keys: MaskKeyframe[] = [{ t: t0, mask: base }];
  const keyPoints = (t: number, points: typeof small.points): void => {
    const current = interpolateMask(keys, t) ?? base;
    const next = keys.filter((k) => Math.abs(k.t - t) > 1e-4);
    next.push({ t, mask: { paths: current.paths.map((p) => (p.id === small.id ? { ...p, points } : p)) } });
    keys = next.sort((x, y) => x.t - y.t);
  };
  keyPoints(t0 + duration / 2, big.points);
  keyPoints(t0 + duration, small.points);
  b.setFx(id, 'maskAnim', keys);
}

/**
 * Lay a transition's solid-mode panels into `b` under `frame.comp`, keyed
 * from `t0`. Null for an unknown id.
 */
export function buildTransitionPanels(b: FragmentBuilder, frame: InsertFrame, transId: string, t0: number): BuiltTransitionPanels | null {
  const item = getTransitionItem(transId);
  if (!item) return null;
  const box: CompBox = { width: frame.width || 1920, height: frame.height || 1080 };
  const count = item.solidCount ?? 1;
  const panels: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = addPanel(b, frame.comp, item.a, box, count > 1 ? `${item.name} ${i + 1}` : item.name);
    if (!id) continue;
    let blurTrack: string | null | undefined;
    for (const kf of panelRecipe(transId, box, i, count)) {
      let prop = kf.prop;
      if (prop === '@blur') {
        if (blurTrack === undefined) blurTrack = addBlur(b, id);
        if (!blurTrack) continue;
        prop = blurTrack;
      }
      b.setKeyframe(id, prop, t0 + kf.t, kf.value, kf.ease ?? 'easeInOut');
    }
    if (item.irisMask) addIrisMask(b, id, box, t0, item.duration);
    panels.push(id);
  }
  if (panels.length === 0) return null;
  return { panels, restAfter: solidRestTime(transId, box), duration: item.duration };
}
