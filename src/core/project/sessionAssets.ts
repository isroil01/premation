/**
 * The Assets panel across a project transition.
 *
 * The asset store is two things at once: this DEVICE's footage library
 * (IndexedDB, hydrated whole at boot) and the open project's asset list. Nothing
 * separated them at a document boundary, so File ▸ New Project produced an
 * "Untitled" project with 0 layers whose Assets panel still listed the previous
 * project's clip.mp4 and image.png.
 *
 * New and Close empty the session list (`resetSessionAssets`). Open does not —
 * but an Open that FOLLOWS a reset has to put back what the opened document
 * points at, because a single-file project and a crash-recovery snapshot both
 * reconnect their footage by asset id out of that list (see assetRebind.ts).
 * That is `rehydrateReferencedAssets`, and it is why the reset never deletes
 * anything from the library itself.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useAssetStore, parkedAmong } from '@stores/assetStore';

/** Drop the outgoing project's assets from the session. Library untouched. */
export function resetSessionAssets(): void {
  useAssetStore.getState().resetSession();
}

/**
 * Every asset id the live scene references — the same two prop pairs
 * `rebindAssetSrcs` reconnects (`assetId` on picture layers, `__assetId` on
 * audio layers).
 */
export function referencedAssetIds(): Set<string> {
  const ids = new Set<string>();
  const visit = (id: string): void => {
    const node = defaultSceneGraph.getNode(id);
    if (!node) return;
    for (const c of node.components) {
      const props = c.props as Record<string, unknown>;
      for (const key of ['assetId', '__assetId']) {
        const v = props[key];
        if (typeof v === 'string' && v) ids.add(v);
      }
    }
    for (const child of defaultSceneGraph.getChildren(id)) visit(child.id);
  };
  for (const root of defaultSceneGraph.getRoots()) visit(root.id);
  return ids;
}

/**
 * Bring back the library assets the just-opened document references.
 *
 * A no-op unless a reset actually parked one of them: the library read pulls
 * every blob out of IndexedDB, which is not a cost to pay on each open for the
 * common case where nothing was ever dropped. `initialize` rebinds the layers
 * itself once the fresh object URLs exist.
 */
export async function rehydrateReferencedAssets(): Promise<void> {
  const wanted = parkedAmong(referencedAssetIds());
  if (wanted.size === 0) return;
  await useAssetStore.getState().initialize({ only: wanted });
}
