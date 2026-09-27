/**
 * Keep imported 3D models hydrated: re-parse each stored .glb into the session
 * mesh registry and repoint dead texture object URLs (core/scene/modelHydrate)
 * now, and after every structural scene change (opens, undo restores, pasted
 * subtrees).
 *
 * Engine-side upkeep of the TypeScript engine — the mesh registry is render
 * infrastructure and the repointed `src`s are document data — and never drives
 * a render in the UI. Installed once by the editor shell (App.tsx); it moved
 * here from there (B4, docs/B4_MIRROR.md) so the UI no longer subscribes to
 * scene-graph traffic itself. It leaves with the TS engine.
 */

import { getEventBus } from '@core/events/EventBus';
import { hydrateModels } from '@core/scene/modelHydrate';

/** Hydrate now and on every SceneGraphChanged; returns the uninstaller. */
export function installModelHydration(): () => void {
  void hydrateModels();
  const sub = getEventBus().on('SceneGraphChanged', () => {
    void hydrateModels();
  });
  return () => sub.dispose();
}
