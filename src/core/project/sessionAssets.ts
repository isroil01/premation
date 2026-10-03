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

import { engine } from '@core/engine/engineInstance';
import { useAssetStore, parkedAmong } from '@stores/assetStore';

/** Drop the outgoing project's assets from the session. Library untouched. */
export function resetSessionAssets(): void {
  useAssetStore.getState().resetSession();
}

/**
 * Every item id the open document's layers reference (`LayerInfo.source`: the
 * same `assetId` / `__assetId` pair `rebindAssetSrcs` reconnects, or a
 * precomp's composition), asked of the engine — the document it just opened.
 */
export async function referencedAssetIds(): Promise<Set<string>> {
  const r = await engine().query({ type: 'getDocument', includeProperties: false, includeKeyframes: false });
  const ids = new Set<string>();
  if (r.ok) for (const l of r.value.layers) if (l.source) ids.add(l.source);
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
  const wanted = parkedAmong(await referencedAssetIds());
  if (wanted.size === 0) return;
  await useAssetStore.getState().initialize({ only: wanted });
}
