/**
 * Footage workflow actions — the gestures between "file in the library" and
 * "layer in the comp", shaped after AE's.
 *
 * These live in core rather than in the Assets panel because each is a real
 * operation with an invariant, not a click handler: the panel offers them, the
 * preview dialog offers them, and (later) a drag gesture can offer them, and
 * all three must mean the same thing. The panel calling scene mutations inline
 * is how the library-insert-invisible bug happened the first time.
 */

import { insertMedia } from './sceneInsert';
import defaultSceneGraph from './DefaultSceneGraph';
import { getTimelineController } from '@core/timeline/TimelineController';
import { useSelectionStore } from '@stores/selectionStore';
import { bumpScene } from '@stores/sceneStore';
import { readNodeKind } from './sceneDerive';
import type { ImportedAsset } from '@stores/assetStore';

/**
 * Insert footage with its clip STARTING AT THE PLAYHEAD, not at frame 0.
 *
 * AE's drag-to-timeline behaviour, and the one an editor actually wants while
 * assembling: the playhead is parked where the next shot should begin. The
 * plain insert keeps starting at 0 — both are legitimate, which is why this is
 * a second verb rather than a mode.
 *
 * The playhead is captured BEFORE the (async) insert: an SVG import reads its
 * file, and the transport may be running — the clip must land where the
 * playhead was when the user acted, not wherever it drifted to by the time
 * decoding finished.
 */
export async function insertMediaAtPlayhead(asset: ImportedAsset): Promise<string | null> {
  const controller = getTimelineController();
  const at = controller.currentSeconds;
  await insertMedia(asset);
  // `insertMedia` selects what it created — the one contract every insert path
  // in sceneInsert already keeps, so it is the reliable way to find the node.
  const nodeId = [...useSelectionStore.getState().ids][0] ?? null;
  if (!nodeId) return null;
  // Sync EXPLICITLY rather than trusting the App's SceneGraphChanged
  // subscription to have run: this verb edits the clip it just created, so its
  // existence cannot depend on who else is mounted. Same lesson the library
  // insert learned (`cursorLibrary.ts`) — an insert whose timeline half arrives
  // later is an insert that lands invisible.
  controller.syncFromScene();
  for (const layer of controller.getLayersForNode(nodeId)) {
    controller.setClipStart(layer.id, at);
  }
  return nodeId;
}

/**
 * Point an EXISTING layer at different footage — AE's Alt-drag replace.
 *
 * Everything else about the layer survives: transform, keyframes, effects,
 * masks, its place in the stack. That is the entire point of replace over
 * delete-and-reinsert, and it is why this writes only `src`/`assetId` and
 * touches nothing else.
 *
 * Kind-checked, not duck-typed: pointing a video layer at an audio file would
 * not error anywhere — the texture provider would simply never produce a frame
 * and the layer would go black with nothing to diagnose. Refusing up front
 * turns a silent failure into a return value the caller can surface.
 */
export function retargetLayerSource(nodeId: string, asset: ImportedAsset): boolean {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return false;
  if (asset.type !== 'image' && asset.type !== 'video') return false;
  const kind = readNodeKind(node);
  if (kind !== 'image' && kind !== 'video') return false;

  const transform = node.components.find((c) => c.type === 'Transform');
  if (!transform) return false;
  defaultSceneGraph.writeProp(nodeId, transform.id, 'src', asset.src);
  defaultSceneGraph.writeProp(nodeId, transform.id, 'assetId', asset.id);
  bumpScene();
  return true;
}

/**
 * The one selected layer that {@link retargetLayerSource} could retarget, or
 * null. The MENU reads this to decide whether to offer "Use as Source" at all
 * — an entry that is always present and usually fails teaches people not to
 * open the menu.
 */
export function replaceableSelectedLayer(): string | null {
  const ids = [...useSelectionStore.getState().ids];
  if (ids.length !== 1) return null;
  const node = defaultSceneGraph.getNode(ids[0]!);
  if (!node) return null;
  const kind = readNodeKind(node);
  return kind === 'image' || kind === 'video' ? ids[0]! : null;
}
