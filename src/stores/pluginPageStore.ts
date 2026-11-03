/**
 * Plugin pages — a plugin's page as a closable tab of the main body, beside
 * Composition, Footage and Layer (owner-approved mockup board 1, 2026-11-03;
 * VS Code opens an extension's page the same way).
 *
 * One tab per plugin id, reused when it is already open. Which pages are open
 * is the editor's business: session state only, never persisted, never in the
 * project document.
 *
 * A page drawn over the composition viewer leaves it mounted (EditorTabs). The
 * Composition, Footage and Layer tabs take the body back by `activate(null)`;
 * opening the Layer or Footage viewer does too.
 */

import { create } from 'zustand';
import { useFootageViewerStore } from './footageViewerStore';
import { useLayerViewerStore } from './layerViewerStore';

export interface PluginPageEntry {
  /** The plugin id. */
  id: string;
  /** The tab's name for it ("Plugin: <name>"). */
  name: string;
  /** Listed from the signed-in publisher's own private plugins: the page reads the listing as the owner. */
  owner?: boolean;
}

interface PluginPageState {
  /** Open pages, in tab order. */
  pages: PluginPageEntry[];
  /** The page in front, or null when a viewer (Composition / Footage / Layer) is. */
  active: string | null;
  /** Open (or bring forward) a plugin's page. */
  open: (page: PluginPageEntry) => void;
  /** Close a page; the one beside it comes forward when it was in front. */
  close: (id: string) => void;
  /** Bring a page forward, or null to give the body back to the viewers. */
  activate: (id: string | null) => void;
}

export const usePluginPageStore = create<PluginPageState>((set, get) => ({
  pages: [],
  active: null,
  open: (page) => {
    const pages = get().pages;
    const at = pages.findIndex((p) => p.id === page.id);
    if (at < 0) {
      set({ pages: [...pages, page], active: page.id });
      return;
    }
    // Reused: its name and owner follow the latest opener (a rename, a private listing).
    const prev = pages[at]!;
    const same = prev.name === page.name && prev.owner === page.owner;
    set({ pages: same ? pages : pages.map((p, i) => (i === at ? page : p)), active: page.id });
  },
  close: (id) => {
    const { pages, active } = get();
    const at = pages.findIndex((p) => p.id === id);
    if (at < 0) return;
    const next = pages.filter((p) => p.id !== id);
    if (active !== id) {
      set({ pages: next });
      return;
    }
    const neighbour = next[Math.min(at, next.length - 1)];
    set({ pages: next, active: neighbour?.id ?? null });
  },
  activate: (id) => {
    if (id !== null && !get().pages.some((p) => p.id === id)) return;
    set({ active: id });
  },
}));

// Opening the Layer or Footage viewer brings it in front of a plugin page.
useLayerViewerStore.subscribe((s, prev) => {
  if (s.nodeId !== null && prev.nodeId !== s.nodeId && usePluginPageStore.getState().active !== null) {
    usePluginPageStore.setState({ active: null });
  }
});
useFootageViewerStore.subscribe((s, prev) => {
  if (s.open && !prev.open && usePluginPageStore.getState().active !== null) {
    usePluginPageStore.setState({ active: null });
  }
});
