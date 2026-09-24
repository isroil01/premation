/**
 * What the motion assistants (the Presets panel's "Animate selection" block,
 * the Bounce workspace, the Stagger dialog) SHOW about the document, over the
 * document MIRROR (B4, docs/B4_MIRROR.md) — the mirror twins of the core
 * helpers those panels used to call for display:
 *
 *   firstAudioLayerIn(m)             `beatGrid.findAudioLayer()` — any audio layer in the document
 *   retimableLayerIds(m, ids)        `speedRampCommands.rampTargets()` — layers whose source can be retimed
 *   curveAnimatedLayerIds(m, ids)    `choreographyCommands.staggerTargets()` — layers with keyed curves
 *   staggerLayersIn(m, ids, t)       `choreography.staggerLayersFor()` — names + resting x/y at comp time `t`
 *   smartAnimateTargetsIn(m, …)      `smartAnimateCommands.transitionTargets()` — the other boards
 *   layerHasAnimation(m, id)         `defaultAnimation.animatedProps(id).length > 0` — keys or an expression
 *
 * Pure: they take a mirror reader (the app passes the document mirror) and
 * never touch the engine. The engine-side helpers stay for the commands that
 * WRITE with them; these only answer what a panel draws.
 */

import type { Keyframe, LayerInfo, PropertyInfo, Value } from '@motion/engine-api';
import type { StaggerLayer } from '@core/animation/choreography';
import { readTrack } from './selection';
import type { MirrorTreeLike } from './trackIndex';

/** What these readers need from the mirror. `DocumentMirror` is one. */
export interface MotionAssistRead {
  layer(id: string): LayerInfo | undefined;
  layerIds(): readonly string[];
  layerKeyframes(layer: string): ReadonlyMap<string, readonly Keyframe[]>;
  tree(id: string): MirrorTreeLike | undefined;
  keyframes(layer: string, path: string): readonly Keyframe[];
  valueAt(layer: string, path: string, time: number): Value | undefined;
}

/** What `smartAnimateTargetsIn` needs: the compositions in document order. */
export interface MirrorCompsRead {
  readonly compIds: readonly string[];
  comp(id: string): { readonly settings: { readonly name: string }; readonly layers: readonly string[] } | undefined;
}

/** Value types the TS engine keeps as numeric CURVE tracks (not data tracks: text, paths, gradients). */
const CURVE_TYPES = new Set(['scalar', 'int', 'bool', 'choice', 'vec2', 'vec3', 'vec4', 'color']);

function isCurve(info: PropertyInfo | undefined): boolean {
  // An unknown path (tree not loaded) counts: keys on it are keys.
  return !info || CURVE_TYPES.has(info.valueType);
}

/** The first audio layer the document holds (any composition), or undefined. */
export function firstAudioLayerIn(m: Pick<MotionAssistRead, 'layer' | 'layerIds'>): string | undefined {
  return m.layerIds().find((id) => m.layer(id)?.kind === 'audio');
}

/**
 * The layers of `ids` a speed ramp can act on: footage that plays (video,
 * audio) and precomps — the kinds whose rendering reads a source time.
 */
export function retimableLayerIds(m: Pick<MotionAssistRead, 'layer'>, ids: readonly string[]): string[] {
  return ids.filter((id) => {
    const k = m.layer(id)?.kind;
    return k === 'video' || k === 'audio' || k === 'precomp';
  });
}

/** Whether a layer has keyframes on a numeric curve (what a stagger can shift). */
export function hasCurveKeys(m: Pick<MotionAssistRead, 'layerKeyframes' | 'tree'>, id: string): boolean {
  const keys = m.layerKeyframes(id);
  if (keys.size === 0) return false;
  const tree = m.tree(id);
  for (const [path, list] of keys) {
    if (list.length > 0 && isCurve(tree?.nodes.get(path))) return true;
  }
  return false;
}

/** The layers of `ids` that exist and already animate a curve — what Stagger shifts. */
export function curveAnimatedLayerIds(m: Pick<MotionAssistRead, 'layer' | 'layerKeyframes' | 'tree'>, ids: readonly string[]): string[] {
  return ids.filter((id) => m.layer(id) !== undefined && hasCurveKeys(m, id));
}

/**
 * The layers as the stagger planner needs them: name, and the resting x / y
 * (stored px) at composition time `atCompTime` (seconds) — animated or not.
 */
export function staggerLayersIn(m: MotionAssistRead, ids: readonly string[], atCompTime: number): StaggerLayer[] {
  const out: StaggerLayer[] = [];
  for (const nodeId of ids) {
    const layer = m.layer(nodeId);
    if (!layer) continue;
    out.push({
      nodeId,
      name: layer.name || nodeId,
      x: readTrack(m, nodeId, 'x', atCompTime) ?? 0,
      y: readTrack(m, nodeId, 'y', atCompTime) ?? 0,
    });
  }
  return out;
}

/**
 * Compositions a Smart Animate transition could go to: every one except
 * `current`, and except the auto-minted empty placeholder (`isPlaceholder`:
 * pristine, and still without a layer — a pristine comp the user has drawn
 * into is theirs by use).
 */
export function smartAnimateTargetsIn(
  m: MirrorCompsRead,
  current: string | undefined,
  isPlaceholder: (compId: string) => boolean,
): Array<{ id: string; name: string }> {
  const out: Array<{ id: string; name: string }> = [];
  for (const id of m.compIds) {
    if (id === current) continue;
    const comp = m.comp(id);
    if (!comp) continue;
    if (isPlaceholder(id) && comp.layers.length === 0) continue;
    out.push({ id, name: comp.settings.name });
  }
  return out;
}

/** Whether a layer is animated at all: a keyframe anywhere, or a property carrying an expression. */
export function layerHasAnimation(m: Pick<MotionAssistRead, 'layerKeyframes' | 'tree'>, id: string): boolean {
  if (m.layerKeyframes(id).size > 0) return true;
  const tree = m.tree(id);
  if (!tree) return false;
  for (const info of tree.nodes.values()) {
    if (info.kind !== 'property') continue;
    if (info.expression !== '' || (info.memberExpressions?.length ?? 0) > 0) return true;
  }
  return false;
}
