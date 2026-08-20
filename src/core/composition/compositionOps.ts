/**
 * Composition operations — creating and deleting whole compositions.
 *
 * A composition is three things that must stay in step:
 *   1. an entry in `projectStore.comps` (size, fps, duration, background),
 *   2. a ROOT node in the scene graph whose id IS the composition id — comps
 *      are sibling subtrees of one graph, which is why anything that renders or
 *      lists a comp must scope to its root (see `flattenComposition`), and
 *   3. a tab.
 *
 * None of this existed before: nothing ever inserted into `comps`, so "New
 * Composition" could only overwrite the single seeded comp and wipe the scene —
 * it was Reset Project wearing the wrong label.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { insertMedia } from '@core/scene/sceneInsert';
import { DEFAULT_COMPOSITION } from '@stores/compositionStore';
import type { ImportedAsset } from '@stores/assetStore';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { flattenComposition } from '@core/scene/sceneDerive';
import { useProjectStore, type CompositionSettings } from '@stores/projectStore';
import { useSelectionStore } from '@stores/selectionStore';
import { getTimelineController } from '@core/timeline/TimelineController';
import { bumpScene } from '@stores/sceneStore';
import { defaultAnimation } from '@motion/animation';
import { shortId } from '@utils/lang';
import type { SceneNode } from '@core/types';

/** The scene root node backing a composition. */
function compRootNode(id: string, name: string): SceneNode {
  return {
    id,
    name,
    parent: null,
    children: [],
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true,
    locked: false,
    components: [{ id: `${id}_meta`, type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode;
}

/**
 * Add a composition to the project and open it. Returns the new comp's id.
 *
 * Additive: existing comps, layers and keyframes are untouched.
 */
export function createComposition(init: Partial<CompositionSettings> = {}): string {
  const actions = useProjectStore.getState().actions;
  const id = actions.createComp(init);
  const name = init.name ?? 'Composition';

  defaultSceneGraph.addNode(compRootNode(id, name));
  actions.openTab(id, [id], name);

  // The new tab is active, so the controller resolves to this comp's timeline;
  // touching it builds one at the comp's own fps/duration.
  getTimelineController().syncFromScene(id);

  useSelectionStore.getState().clear();
  bumpScene();
  return id;
}

/** Rename a composition. The scene root carries the name the panels show. */
export function renameComposition(id: string, name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  useProjectStore.getState().actions.updateComp(id, { name: trimmed });
  const root = defaultSceneGraph.getNode(id);
  if (root) root.name = trimmed;
  bumpScene();
}

/**
 * Copy a composition — its settings, its whole layer subtree and the keyframes
 * on every one of those layers — and open the copy.
 *
 * Layers get fresh ids, so the copy is independent; `parent` references are
 * remapped through the same table, or the clone's children would point back at
 * the original's nodes.
 */
export function duplicateComposition(id: string): string | null {
  const source = useProjectStore.getState().comps[id];
  if (!source || !defaultSceneGraph.getNode(id)) return null;

  const newId = createComposition({ ...source, id: undefined, name: `${source.name} copy` });

  // old id → new id, for both the nodes and their parent references.
  const idMap = new Map<string, string>([[id, newId]]);
  const subtree = flattenComposition(defaultSceneGraph, id).filter((n) => n.id !== id);
  for (const node of subtree) idMap.set(node.id, `${node.id}_copy_${shortId()}`);

  for (const node of subtree) {
    const clonedId = idMap.get(node.id)!;
    // Build a plain node rather than cloning the live view: a scene node is a
    // graph view whose `children` resolve to node objects, so a deep clone of
    // one walks straight into a cycle (and would drag the whole graph with it).
    // Same shape sceneProjectIO.capture writes.
    const clone: SceneNode = {
      id: clonedId,
      name: node.name,
      parent: idMap.get(node.parent ?? '') ?? newId,
      children: [],
      transform: JSON.parse(JSON.stringify(node.transform)),
      components: node.components.map((c) => ({
        id: `${clonedId}_${c.type}`,
        type: c.type,
        props: JSON.parse(JSON.stringify(c.props)),
      })),
      visible: node.visible,
      locked: node.locked,
      ...(node.solo !== undefined ? { solo: node.solo } : {}),
      ...((node as { color?: string }).color !== undefined ? { color: (node as { color?: string }).color } : {}),
    } as SceneNode;
    defaultSceneGraph.addChild(clone.parent!, clone as never);

    // Keyframes live per node id, so they must be copied across explicitly —
    // a subtree copy alone would silently produce a static duplicate.
    for (const track of defaultAnimation.tracksFor(node.id)) {
      defaultAnimation.setTrackKeyframes(clonedId, track.prop, JSON.parse(JSON.stringify(track.keyframes)));
    }
  }

  getTimelineController().syncFromScene(newId);
  bumpScene();
  return newId;
}

/**
 * Remove a composition, its layers and its tab.
 *
 * Refuses to delete the last composition — a project with no comp has nowhere
 * to put a layer, and the Scene panel would render an empty shell.
 */
export function deleteComposition(id: string): boolean {
  const state = useProjectStore.getState();
  if (Object.keys(state.comps).length <= 1) return false;
  if (!state.comps[id]) return false;

  for (const tab of Object.values(state.tabs)) {
    if (tab.compositionId === id) state.actions.closeTab(tab.id);
  }
  // Animation goes with the comp — gathered BEFORE removeNode takes the
  // subtree, and including the root itself (comp-level tracks like timeRemap
  // live there). Undo restores it: History snapshots scene + animation
  // together. Without this every deleted comp left its whole cast's tracks
  // orphaned in the document forever.
  for (const node of flattenComposition(defaultSceneGraph, id)) {
    defaultAnimation.clearNode(node.id);
  }
  defaultSceneGraph.removeNode(id);
  state.actions.removeComp(id);

  useSelectionStore.getState().clear();
  bumpScene();
  return true;
}

/**
 * Create a composition FROM a footage asset — sized, timed and paced to the
 * clip — then place the clip in it at full frame.
 *
 * This is AE's canonical first move (drag footage onto the comp icon), and the
 * reason it is an operation rather than "make a comp, then add the clip" is
 * that the by-hand version silently drifts: the comp keeps the default 1080p
 * while the phone clip is 2160×3840, the duration stays 10s under a 7s clip,
 * and every export ships three seconds of trailing background. The comp should
 * BE the clip.
 *
 * What each setting takes and what it honestly cannot:
 *
 *  • SIZE is the stored pixels × pixel aspect ratio — an anamorphic source is
 *    1024 wide on screen even though it stores 720, and the comp must be the
 *    on-screen size (the same PAR rule `insertMedia` applies to the layer).
 *    Audio and unprobed files keep the current default size.
 *  • DURATION is the clip's, when known.
 *  • FPS uses the PROBED rate and otherwise keeps the default. It must never
 *    guess from the browser: nothing in a web context reports a <video>'s real
 *    rate (see `ImportedAsset.metadata.fps`), and a comp invented at 30 for a
 *    23.976 clip would judder every 5th frame while looking configured.
 *
 * The footage lands via `insertMedia` — the same routing every import takes
 * (PAR, SVG paths, sequences, audio) — into the just-created comp, which is
 * active because `createComposition` opened its tab. Contain-fit into a comp
 * that IS the footage size is exact, so the layer sits at full frame.
 */
export async function createCompositionFromFootage(asset: ImportedAsset): Promise<string> {
  const meta = asset.metadata ?? {};
  const par = asset.interpret?.par ?? 1;
  // Fallbacks are the APP defaults, not the active comp's settings. Inheriting
  // the active comp would make the result depend on which tab happened to be
  // focused — an unprobed clip imported while a 23.976 comp is open would mint
  // a 23.976 comp, and the same clip an hour later a 30fps one.
  const defaults = DEFAULT_COMPOSITION;

  const width = meta.width && meta.width > 0 ? Math.round(meta.width * par) : defaults.width;
  const height = meta.height && meta.height > 0 ? meta.height : defaults.height;
  const durationSeconds = meta.duration && meta.duration > 0 ? meta.duration : defaults.durationSeconds;
  const fps = meta.fps && meta.fps > 0 ? meta.fps : defaults.fps;

  // The clip's name, sans extension — "shot_04.mp4" names a file; the comp is
  // "shot_04". AE does the same.
  const name = asset.name.replace(/\.[a-z0-9]+$/i, '') || asset.name;

  const id = createComposition({ name, width, height, durationSeconds, fps });
  await insertMedia(asset);
  return id;
}
