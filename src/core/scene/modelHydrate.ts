/**
 * Model rehydration — the reload half of glTF import.
 *
 * A reopened document holds each imported model's source (.glb as a data: URL
 * on the root's Model component) and, on textured leafs, a DEAD object URL in
 * `src` (object URLs die with the tab that minted them — the assetRebind
 * lesson). This watcher re-parses unregistered models into the session mesh
 * registry and repoints leaf `src`s at the freshly minted texture URLs, then
 * bumps the scene once so the frame repaints with geometry.
 *
 * Reentrancy: the final bump re-fires SceneGraphChanged, which re-runs the
 * scan — which then finds every model registered and returns without another
 * bump. `scanning` only guards overlapped ASYNC scans (two opens racing).
 */

import defaultSceneGraph from './DefaultSceneGraph';
import {
  isModelRegistered,
  registerModel,
  readNodeModelSource,
  readNodeModelRef,
  modelPrimitiveFor,
} from './modelMesh';
import { getEventBus } from '@core/events/EventBus';
import { bumpScene } from '@stores/sceneStore';
import type { SceneNode } from '@core/types';

let scanning = false;

/** Re-parse any unregistered models in the graph; repoint texture srcs. */
export async function hydrateModels(): Promise<number> {
  if (scanning) return 0;
  scanning = true;
  try {
    const sources: Array<{ modelKey: string; glbData: string }> = [];
    defaultSceneGraph.traverse((n: SceneNode) => {
      const src = readNodeModelSource(n);
      if (src && !isModelRegistered(src.modelKey)) sources.push(src);
    });
    if (sources.length === 0) return 0;

    let hydrated = 0;
    for (const s of sources) {
      try {
        // Decoded by hand, not `fetch(dataUrl)`: data: fetches are missing in
        // jsdom and add an async hop for what is a pure base64 decode anyway.
        const comma = s.glbData.indexOf(',');
        const bin = atob(s.glbData.slice(comma + 1));
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        registerModel(s.modelKey, bytes.buffer);
        hydrated += 1;
      } catch {
        // A corrupt stored model must not take the project open down with it;
        // its layers simply render nothing, which is visible and diagnosable.
      }
    }
    if (hydrated === 0) return 0;

    // Texture srcs: object URLs from the PREVIOUS session are dead — repoint
    // at this session's. `writeProp`, never the components view (throwaway).
    defaultSceneGraph.traverse((n: SceneNode) => {
      const ref = readNodeModelRef(n);
      if (!ref) return;
      const entry = modelPrimitiveFor(ref);
      if (!entry?.textureUrl) return;
      const t = n.components.find((c) => c.type === 'Transform');
      if (!t) return;
      const current = (t.props as Record<string, unknown>).src;
      if (current !== entry.textureUrl) {
        defaultSceneGraph.writeProp(n.id, t.id, 'src', entry.textureUrl);
      }
    });
    bumpScene();
    return hydrated;
  } finally {
    scanning = false;
  }
}

/** Boot hook: hydrate now and after every structural scene change (opens,
 *  undo restores, pasted subtrees). Returns the uninstaller. */
export function installModelHydration(): () => void {
  void hydrateModels();
  const sub = getEventBus().on('SceneGraphChanged', () => {
    void hydrateModels();
  });
  return () => sub.dispose();
}
