/* eslint-disable no-restricted-syntax -- F11: SAFE, verified.
 * `restore` walks `file.nodes` from a parsed ProjectFile BEFORE anything is
 * loaded into the graph, so these are plain objects. (The legacy positional-matte
 * fixup here predates the versioned migrations in core/project/migrations and
 * could move there.) */
/**
 * sceneProjectIO — bridges the ProjectManager to the scene graph document.
 *
 * Pure with respect to the UI: it only reads/writes the scene graph. The UI
 * refreshes by listening for ProjectLoaded/ProjectUnloaded on the EventBus and
 * bumping its own revision — this module never imports a store.
 */

import type { ProjectFile, SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from './sceneKind';

/** The default composition root every new/empty project needs — layers parent to
 *  it and the Scene panel shows it as "Composition 1". Without this a restored
 *  empty scene has no root, so inserting a layer silently fails. */
function defaultComposition(): SceneNode {
  return {
    id: 'comp_root',
    name: 'Composition 1',
    parent: null,
    children: [],
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true,
    locked: false,
    components: [{ id: 'comp_root_meta', type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  };
}

/** A fresh empty scene file: the default composition root and nothing else (reads no graph). */
export function emptySceneProject(): ProjectFile {
  return { version: '1.0.0', nodes: [defaultComposition()] };
}
