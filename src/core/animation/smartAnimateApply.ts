/**
 * Smart Animate, applied: two compositions in, a transition composition out.
 *
 * `layerMatch.ts` decides which layer is which and `smartAnimate.ts` decides
 * what to write; this is the part that touches the scene graph.
 *
 * ── It never edits either board ────────────────────────────────────
 * The transition is built in a DUPLICATE of the first composition. Both boards
 * are things the user designed and will keep designing — animating one of them
 * in place would mean the source of the transition no longer shows the state it
 * is meant to represent, and there would be no way back to it except undo. A
 * third composition also matches how the result is used: A and B are boards,
 * "A → B" is a shot.
 *
 * ── Arrivals are cloned, not referenced ────────────────────────────
 * A layer that exists only in the second board has to physically exist in the
 * transition, so it is copied in — subtree, components and keyframes — the way
 * `duplicateComposition` copies a comp. Referencing it across compositions
 * would tie the transition to later edits of the target board, which is the
 * opposite of what a baked transition is for.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { flattenComposition, readNodeKind } from '@core/scene/sceneDerive';
import { assetIdOf } from '@core/source/sourceInfo';
import { defaultAnimation } from '@motion/animation';
import { duplicateComposition } from '@core/composition/compositionOps';
import { getTimelineController } from '@core/timeline/TimelineController';
import { bumpScene } from '@stores/sceneStore';
import { useProjectStore } from '@stores/projectStore';
import type { SceneNode } from '@core/types';
import { runAnimEdit } from './animationCommands';
import { nodeBaseValue } from './animationPresets';
import { matchLayers, type LayerDescriptor } from './layerMatch';
import {
  planArrivalTracks,
  planDepartureTracks,
  planMatchedTracks,
  TWEENABLE_PROPS,
  type TweenOptions,
  type TweenTrack,
} from './smartAnimate';

/** The string a text layer displays — `content`, not `text`. */
function textOf(node: SceneNode): string | undefined {
  const component = node.components.find((c) => c.type === 'Text');
  const value = (component?.props as Record<string, unknown> | undefined)?.content;
  return typeof value === 'string' ? value : undefined;
}

/**
 * Describe a composition's layers for matching.
 *
 * The composition root itself is excluded — it is the container, not a layer,
 * and matching it against the other comp's root would pair two things that
 * cannot move.
 */
export function describeComposition(compId: string): LayerDescriptor[] {
  const nodes = flattenComposition(defaultSceneGraph, compId);
  const nameById = new Map<string, string>(nodes.map((n) => [n.id, n.name ?? n.id]));

  const pathOf = (node: SceneNode): string[] => {
    const path: string[] = [];
    let parent = node.parent ?? null;
    while (parent && parent !== compId) {
      path.unshift(nameById.get(parent) ?? parent);
      parent = defaultSceneGraph.getNode(parent)?.parent ?? null;
    }
    return path;
  };

  return nodes
    .filter((n) => n.id !== compId)
    .map((node) => ({
      id: node.id,
      // An unnamed layer gets an empty name deliberately: the matcher ignores
      // empty names rather than treating "no name" as a shared identity, so it
      // falls through to the source and text rules.
      name: node.name ?? '',
      kind: readNodeKind(node),
      path: pathOf(node),
      assetId: assetIdOf(node) ?? undefined,
      text: textOf(node),
    }));
}

/** Every tweenable value a layer currently carries, at `atTime`. */
function valuesOf(nodeId: string, atTime: number): Record<string, number | undefined> {
  const out: Record<string, number | undefined> = {};
  for (const prop of TWEENABLE_PROPS) out[prop] = nodeBaseValue(nodeId, prop, atTime, defaultAnimation);
  return out;
}

/**
 * Copy a layer (and its subtree) from another composition into `parentId`.
 *
 * Modelled on `duplicateComposition`'s inner loop, and for the same reasons: a
 * scene node is a graph VIEW whose `children` resolve to live node objects, so
 * a deep clone walks into a cycle and drags the whole graph with it — hence
 * the plain rebuild. Keyframes live per node id and have to be copied across
 * explicitly or the arrival is a static duplicate.
 */
function cloneInto(sourceId: string, parentId: string, suffix: string): string | null {
  const source = defaultSceneGraph.getNode(sourceId);
  if (!source) return null;

  const subtree = flattenComposition(defaultSceneGraph, sourceId);
  const idMap = new Map<string, string>();
  for (const node of subtree) idMap.set(node.id, `${node.id}_sa_${suffix}`);

  for (const node of subtree) {
    const clonedId = idMap.get(node.id)!;
    const clone = {
      id: clonedId,
      name: node.name,
      parent: node.id === sourceId ? parentId : (idMap.get(node.parent ?? '') ?? parentId),
      children: [],
      transform: JSON.parse(JSON.stringify(node.transform)),
      components: node.components.map((c) => ({
        id: `${clonedId}_${c.type}`,
        type: c.type,
        props: JSON.parse(JSON.stringify(c.props)),
      })),
      visible: node.visible,
      locked: node.locked,
    } as SceneNode;
    defaultSceneGraph.addChild(clone.parent!, clone as never);

    for (const track of defaultAnimation.tracksFor(node.id)) {
      defaultAnimation.setTrackKeyframes(clonedId, track.prop, JSON.parse(JSON.stringify(track.keyframes)));
    }
  }
  return idMap.get(sourceId) ?? null;
}

export interface SmartAnimateOptions extends TweenOptions {
  /** Name for the transition composition. Defaults to "A → B". */
  name?: string;
}

export interface SmartAnimateResult {
  /** The new transition composition. */
  compId: string;
  matched: number;
  departing: number;
  arriving: number;
  keyframes: number;
  /** How each pairing was decided — surfaced so a surprising match is legible. */
  reasons: Record<string, number>;
}

/**
 * Build a transition composition from `fromCompId` to `toCompId`.
 *
 * Returns null when either composition is missing. Everything else — a board
 * with nothing in common with the other, an empty board — is a valid
 * transition (everything fades) and comes back with counts saying so.
 */
export function smartAnimateBetween(
  fromCompId: string,
  toCompId: string,
  opts: SmartAnimateOptions,
): SmartAnimateResult | null {
  const project = useProjectStore.getState();
  const fromComp = project.comps[fromCompId];
  const toComp = project.comps[toCompId];
  if (!fromComp || !toComp) return null;
  if (!defaultSceneGraph.getNode(fromCompId) || !defaultSceneGraph.getNode(toCompId)) return null;

  const compId = duplicateComposition(fromCompId);
  if (!compId) return null;

  // Matched against the DUPLICATE, not the original: the copy has fresh ids,
  // and every keyframe written below has to land on the layer that is actually
  // in the transition.
  const working = describeComposition(compId);
  const target = describeComposition(toCompId);
  const match = matchLayers(working, target);

  const suffix = compId.slice(-6);
  const plans: Array<{ nodeId: string; tracks: TweenTrack[] }> = [];

  for (const pair of match.pairs) {
    const tracks = planMatchedTracks(
      valuesOf(pair.from.id, opts.startTime),
      // The target board's designed state, which is its value at its own time
      // zero — not at the transition's start, where it may be mid-animation.
      valuesOf(pair.to.id, 0),
      opts,
    );
    if (tracks.length > 0) plans.push({ nodeId: pair.from.id, tracks });
  }

  for (const leaving of match.onlyFrom) {
    const tracks = planDepartureTracks(nodeBaseValue(leaving.id, 'opacity', opts.startTime, defaultAnimation), opts);
    if (tracks.length > 0) plans.push({ nodeId: leaving.id, tracks });
  }

  // Arrivals are cloned in FIRST (a scene edit) so their keyframes have
  // somewhere to land, and are parented to whatever their own parent matched
  // to — an arriving label inside a card that exists in both boards belongs
  // inside that card, not at the root.
  const matchedByTargetId = new Map(match.pairs.map((p) => [p.to.id, p.from.id]));
  let arriving = 0;
  for (const incoming of match.onlyTo) {
    // Only top-level arrivals: a layer whose PARENT is also arriving comes
    // along inside its parent's subtree, and cloning it again would duplicate.
    const parentIsArriving = match.onlyTo.some((other) => {
      const node = defaultSceneGraph.getNode(incoming.id);
      return node?.parent === other.id;
    });
    if (parentIsArriving) continue;

    const sourceParent = defaultSceneGraph.getNode(incoming.id)?.parent ?? toCompId;
    const parentId = sourceParent === toCompId ? compId : (matchedByTargetId.get(sourceParent) ?? compId);
    const clonedId = cloneInto(incoming.id, parentId, suffix);
    if (!clonedId) continue;
    arriving++;
    const tracks = planArrivalTracks(nodeBaseValue(incoming.id, 'opacity', 0, defaultAnimation), opts);
    if (tracks.length > 0) plans.push({ nodeId: clonedId, tracks });
  }

  let keyframes = 0;
  runAnimEdit('Smart Animate', () => {
    for (const plan of plans) {
      for (const track of plan.tracks) {
        for (const key of track.keys) {
          defaultAnimation.setKeyframe(plan.nodeId, track.prop, key.t, key.value, key.bezier ? 'bezier' : 'easeOut');
          if (key.bezier) defaultAnimation.setBezier(plan.nodeId, track.prop, key.t, key.bezier);
          keyframes++;
        }
      }
    }
  });

  const reasons: Record<string, number> = {};
  for (const pair of match.pairs) reasons[pair.reason] = (reasons[pair.reason] ?? 0) + 1;

  if (opts.name) {
    useProjectStore.setState((s) => {
      const comp = s.comps[compId];
      if (comp) comp.name = opts.name!;
    });
  }
  getTimelineController().syncFromScene(compId);
  bumpScene();

  return {
    compId,
    matched: match.pairs.length,
    departing: match.onlyFrom.length,
    arriving,
    keyframes,
    reasons,
  };
}
