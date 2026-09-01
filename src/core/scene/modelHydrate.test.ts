/**
 * Rehydration: a reopened document has model SOURCES (data: URLs) but an
 * empty session registry — hydrateModels must re-parse them so the next
 * snapshot emits geometry instead of placeholder quads.
 */

import defaultSceneGraph from './DefaultSceneGraph';
import { hydrateModels } from './modelHydrate';
import { clearModelRegistry, isModelRegistered, modelKeyForBytes, MODEL_COMPONENT } from './modelMesh';
import { bytesToDataUrl } from './modelImport';
import { SCENE_KIND_PROP } from './seedDefaultScene';
import { buildQuadGlb } from '@/__testHelpers__/buildTestGlb';
import type { SceneNode } from '@core/types';

describe('hydrateModels', () => {
  const added: string[] = [];
  afterEach(() => {
    for (const id of added.splice(0)) {
      try { defaultSceneGraph.removeNode(id); } catch { /* already gone */ }
    }
    clearModelRegistry();
  });

  it('re-parses stored .glb sources into the registry, once', async () => {
    const glb = buildQuadGlb();
    const u8 = new Uint8Array(glb);
    const key = modelKeyForBytes(u8);
    const root: SceneNode = {
      id: 'model_hydrate_root', name: 'robot', parent: null, children: [], visible: true, locked: false,
      transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
      components: [
        { id: 'mhr_t', type: 'Transform', props: { [SCENE_KIND_PROP]: 'null', x: 0, y: 0, z: 0 } },
        { id: 'mhr_m', type: MODEL_COMPONENT, props: { modelKey: key, glbData: bytesToDataUrl(u8) } },
      ],
    } as unknown as SceneNode;
    defaultSceneGraph.addNode(root);
    added.push(root.id);

    expect(isModelRegistered(key)).toBe(false);
    expect(await hydrateModels()).toBe(1);
    expect(isModelRegistered(key)).toBe(true);
    // Second pass finds nothing to do — the reentrancy contract.
    expect(await hydrateModels()).toBe(0);
  });

  it('a corrupt source is skipped without failing the scan', async () => {
    const root: SceneNode = {
      id: 'model_hydrate_bad', name: 'bad', parent: null, children: [], visible: true, locked: false,
      transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
      components: [
        { id: 'mhb_t', type: 'Transform', props: { [SCENE_KIND_PROP]: 'null', x: 0, y: 0, z: 0 } },
        { id: 'mhb_m', type: MODEL_COMPONENT, props: { modelKey: 'gltf-bad-1', glbData: 'data:model/gltf-binary;base64,AAAA' } },
      ],
    } as unknown as SceneNode;
    defaultSceneGraph.addNode(root);
    added.push(root.id);
    expect(await hydrateModels()).toBe(0);
    expect(isModelRegistered('gltf-bad-1')).toBe(false);
  });
});
