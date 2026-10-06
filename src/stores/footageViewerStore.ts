/**
 * The Footage viewer — After Effects' Footage panel: a tab of the viewer,
 * beside Composition and Layer, showing ONE source file before (or apart from)
 * its use in a composition.
 *
 * Session state only, never persisted, never in the document: which viewer tab
 * is up is the editor's business. WHICH file it shows is `useLastFootagePreview`
 * (layout/Assets/FootagePreviewDialog) — the tab's label reads it whether the
 * viewer is open or not.
 */

import { create } from 'zustand';
import { useLayerViewerStore } from './layerViewerStore';

interface FootageViewerState {
  open: boolean;
  show: () => void;
  close: () => void;
}

export const useFootageViewerStore = create<FootageViewerState>((set) => ({
  open: false,
  show: () => {
    // One viewer tab at a time: the Layer panel gives way.
    useLayerViewerStore.getState().close();
    set({ open: true });
  },
  close: () => set({ open: false }),
}));

// …and the other way: opening a layer in the Layer panel leaves the Footage viewer.
useLayerViewerStore.subscribe((s, prev) => {
  if (s.nodeId !== null && prev.nodeId === null && useFootageViewerStore.getState().open) {
    useFootageViewerStore.setState({ open: false });
  }
});
