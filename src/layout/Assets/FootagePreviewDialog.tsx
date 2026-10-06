/**
 * Opening footage — look at a file BEFORE committing it to the composition.
 *
 * This used to be a modal dialog (hence the file's name, kept for its many
 * importers). It is the viewer's Footage tab now (`FootageViewer`, hosted by
 * `EditorTabs`): a dialog covered the timeline the clip was going into and
 * could not stay open while you worked. What is left here is the one verb —
 * `openFootagePreview` — and the memory of which file the Footage tab shows.
 */

import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { useFootageViewerStore } from '@stores/footageViewerStore';
import type { ImportedAsset } from '@stores/assetStore';

/**
 * The most recently viewed asset — what the tab strip's Footage tab shows and
 * reopens, the way AE's Footage viewer holds what was last opened in it.
 * A store (not module state) so the tab label re-renders when it changes.
 */
export const useLastFootagePreview = createLastPreviewStore();
function createLastPreviewStore(): UseBoundStore<StoreApi<{ asset: ImportedAsset | null; set: (a: ImportedAsset) => void }>> {
  return create<{ asset: ImportedAsset | null; set: (a: ImportedAsset) => void }>((set) => ({
    asset: null,
    set: (asset) => set({ asset }),
  }));
}

/**
 * Forget the last-viewed asset. Called when a PROJECT opens: the memory is
 * per-working-session, and without this the Footage tab in a freshly opened
 * (even empty) project kept naming whatever clip the PREVIOUS project had in
 * its viewer — a label with no referent in the project on screen.
 */
export function clearLastFootagePreview(): void {
  useLastFootagePreview.setState({ asset: null });
  useFootageViewerStore.getState().close();
}

/** Show one asset in the Footage viewer (the viewer's Footage tab comes forward). */
export function openFootagePreview(asset: ImportedAsset): void {
  useLastFootagePreview.getState().set(asset);
  useFootageViewerStore.getState().show();
}
