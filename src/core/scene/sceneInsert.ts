/* eslint-disable no-restricted-syntax -- TODO(F11): UNCLASSIFIED, the largest cluster (99).
 * This file both CONSTRUCTS node literals before `addNode` (legitimate — the
 * object is not yet in the graph) and, in places, reads a node back with
 * getNode() and mutates it (not legitimate). Layer insertion demonstrably
 * works, so either the dangerous sites are compensated for elsewhere or they
 * are writing values that happen to match the defaults. Which is which is
 * exactly what F11's audit is for; suppressed wholesale rather than guessed at
 * one line at a time. */
/**
 * sceneInsert — shared "add a primitive to the composition" action, so the
 * insert controls can live anywhere (top tool bar, command palette, …) without
 * each call site re-implementing the node factory.
 */

import type { SceneNode } from '@core/types';
import { useCompositionStore } from '@stores/compositionStore';
import type { InsertFrame } from '@/engine-client/insertFragment';



export { activeCompRootId } from './activeComp';
import { activeCompRootId } from './activeComp';


import { useProjectStore } from '@stores/projectStore';
import { useInfoStore } from '@stores/infoStore';

import {  placeInFrame,                       type PlaceOptions } from './layerBuilders';
export {
  makeNode, placeInFrame, notifySvgWarnings, buildSvgLayer, buildSvgIconGroup, measureSvgText, intersectSvgPaths, buildPrimitive, buildShape, outlineExtent, buildText, buildSettingsSolid, buildSolid, notifyCameraNeeds3D, buildCamera, AMBIENT_FILL_INTENSITY, notifyAmbientFill, buildLight, notify3DPrimitive, build3DPrimitive, notify3DText, build3DText, buildAudio, isSvgAsset, readSvgText, buildSvgDocument, buildMedia, buildFootage, buildImageNode, buildImageSequence,
  type PlaceOptions, type ShapeKind, type CameraSeed, type LightSeed, type Primitive3DKind, type BuiltSvgDocument,
} from './layerBuilders';

/**
 * Places an inserted node under the active pointer cursor (or comp center if off-canvas),
 * and assigns a prominent, scene-proportional width/height/fontSize so elements are
 * visibly clear, large, and easy to edit across any composition resolution (HD, 4K, Reel, etc.).
 */
export function placeInComp(
  node: SceneNode,
  opts?: PlaceOptions,
): void {
  placeInFrame(node, legacyFrame(), opts);
}


/**
 * The insert frame read from the editor stores and the page replica (the
 * legacy inserts below). The engine-client inserts read theirs from the
 * mirror (engine-client/insertFragment.ts `insertFrame`).
 */
export function legacyFrame(): InsertFrame {
  const activeTabId = useProjectStore.getState().activeTabId;
  const activeTab = useProjectStore.getState().tabs[activeTabId ?? ''];
  const compId = activeTab?.compositionId ?? 'comp_root';
  const comp = useProjectStore.getState().comps[compId] ?? useCompositionStore.getState();
  const info = useInfoStore.getState();
  return {
    comp: activeCompRootId(),
    width: comp.width,
    height: comp.height,
    durationSeconds: comp.durationSeconds,
    fps: comp.fps,
    cursor: info.present ? { x: info.x, y: info.y } : null,
    ...(comp.defaultEnvPreset !== undefined ? { defaultEnvPreset: comp.defaultEnvPreset } : {}),
  };
}
