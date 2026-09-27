/**
 * The synchronous document context the Lottie importer writes through
 * (`applyImportPlan`, lottieImportApply.ts).
 *
 * It is a document BUILDER, not an automation client: since B3z (WS-L1) it
 * only ever runs OFF-document — inside `buildLayerFragment` /
 * `insertBuiltLayers` (src/core/engine/offDocument.ts) — so these synchronous
 * writers touch a scratch state and the result reaches the document as ONE
 * engine `pasteLayers` (layout/EditorLayout/lottieInsertEdits.ts). `comp.update`
 * must not be used there (`updateComp: false`): a composition change is its
 * own command.
 *
 * Moved here from src/core/ai/toolContext.ts in B5: the AI facades send engine
 * commands and no longer share these writers; the importer is their only user.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { activeCompRootId } from '@core/scene/activeComp';
import { flattenScene } from '@core/scene/sceneDerive';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { reparentNode } from '@core/scene/parenting';
import { insertCamera, insertLight, insertAdjustmentLayer, insertParticle } from '@core/scene/sceneInsert';
import { compToKeyframeTime } from '@core/timeline/TimelineController';
import { useSelectionStore } from '@stores/selectionStore';
import { useCompositionStore } from '@stores/compositionStore';
import { bumpScene } from '@stores/sceneStore';
import { ownerOf, spreadPlacement, transformComponent } from '@core/ai/propOwner';
import type { CompSettingsView } from '@motion/ai-tools';
import type { ID, SceneNode } from '@core/types';

export interface LegacyDocumentContext {
  scene: {
    create(kind: string, name: string, at?: { x: number; y: number }): string;
    setProp(nodeId: string, prop: string, value: unknown): boolean;
    reparent(nodeId: string, parentId: string | null, options?: { preserveWorld?: boolean }): void;
  };
  comp: { update(patch: Partial<CompSettingsView>): void };
  time: { toLayerTime(nodeId: string, compSeconds: number): number };
}

/**
 * Layer kinds whose real insert seeds config a generic rect would lose. Camera
 * and light take the caller's name as a seed; the other two are renamed once
 * the insert has selected the new node.
 */
const SPECIAL_INSERTERS: Record<string, ((name: string) => void) | undefined> = {
  camera: (name) => insertCamera({ name }),
  light: (name) => insertLight({ name }),
  adjustment: () => insertAdjustmentLayer(),
  particle: () => insertParticle(),
};

let createSeq = 0;

/** A detached node of `kind` (writes nothing). */
export function makeLegacyNode(kind: string, name: string, x: number, y: number, fill: string): SceneNode {
  const id = `${kind}_${(createSeq += 1)}_${Math.random().toString(36).slice(2, 6)}`;
  const transform = { position: { x, y }, rotation: 0, scale: { x: 1, y: 1 } };
  const base = { [SCENE_KIND_PROP]: kind, x, y, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0, anchorY: 0 };
  const components: SceneNode['components'] =
    kind === 'text'
      ? [
          { id: `${id}_t`, type: 'Transform', props: { ...base } },
          { id: `${id}_c`, type: 'Text', props: { content: name, fontSize: 32, opacity: 100 } },
        ]
      : kind === 'group' || kind === 'null'
        ? [{ id: `${id}_t`, type: 'Transform', props: { ...base } }]
        : [
            { id: `${id}_t`, type: 'Transform', props: { ...base, width: 220, height: 220, shapeType: 'rect' } },
            { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill } },
          ];
  return { id, name, parent: null, children: [], transform, visible: true, locked: false, components };
}

function create(kind: string, name: string, at?: { x: number; y: number }): string {
  const inserter = SPECIAL_INSERTERS[kind];
  if (inserter) {
    inserter(name);
    const id = useSelectionStore.getState().ids[0];
    const made = id ? defaultSceneGraph.getNode(id as ID) : undefined;
    if (made && name.trim() && made.name !== name.trim()) made.name = name.trim();
    if (id && at) {
      const n = defaultSceneGraph.getNode(id as ID);
      const t = n && transformComponent(n);
      if (t) {
        defaultSceneGraph.writeProp(id as ID, t.id, 'x', at.x);
        defaultSceneGraph.writeProp(id as ID, t.id, 'y', at.y);
      }
    }
    bumpScene();
    return id ?? '';
  }
  const comp = useCompositionStore.getState().comp();
  const place = at ?? spreadPlacement(flattenScene(defaultSceneGraph).length, comp.width, comp.height);
  const node = makeLegacyNode(kind, name, place.x, place.y, '#2b7eff');
  defaultSceneGraph.addChild(activeCompRootId() as ID, node);
  bumpScene();
  return node.id;
}

function setProp(nodeId: string, prop: string, value: unknown): boolean {
  const node = defaultSceneGraph.getNode(nodeId as ID);
  if (!node) return false;
  const owner = ownerOf(node, prop);
  if (!owner) return false;
  const ok = defaultSceneGraph.writeProp(node.id, owner.id, prop, value);
  if (ok) bumpScene();
  return ok;
}

export function createLegacyDocumentContext(): LegacyDocumentContext {
  return {
    scene: {
      create,
      setProp,
      reparent: (id, parentId, options) => {
        reparentNode(id, parentId, options);
        bumpScene();
      },
    },
    comp: { update: (patch) => useCompositionStore.getState().update(patch) },
    time: { toLayerTime: (nodeId, compSeconds) => compToKeyframeTime(nodeId, compSeconds) },
  };
}
