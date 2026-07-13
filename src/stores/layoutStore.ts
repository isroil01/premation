/**
 * Layout store — describes the editor's main regions (areas) and which
 * panels live where. Built so the layout is JSON-serialisable for
 * workspace persistence.
 *
 * Regions:
 *   - leftSidebar  (collapsible, resizable, horizontal split)
 *   - rightInspector (collapsible, resizable, horizontal split)
 *   - bottomTimeline (collapsible, resizable, vertical split)
 *   - centerWorkspace (always present, fills remaining space)
 *
 * Each region may contain a vertical stack of panels; future docking will
 * add a richer graph (tabs, floating windows) without breaking this shape.
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { getEventBus } from '@core/events/EventBus';
import { clamp } from '@utils/lang';

export type RegionId =
  | 'leftSidebar'
  | 'rightInspector'
  | 'centerWorkspace'
  | 'bottomTimeline';

export interface RegionState {
  /** True when the region is collapsed (zero size or hidden). */
  collapsed: boolean;
  /** Current size in px. For vertical regions (timeline), this is height. */
  size: number;
  /** Minimum size in px (respected by split panes). */
  minSize: number;
  /** Maximum size in px. */
  maxSize: number;
}

export interface PanelRegistration {
  /** Unique id within the app. */
  id: string;
  /** Region where the panel is docked. */
  region: RegionId;
  /** Display title (also used as default tab label). */
  title: string;
  /** Optional icon name. */
  icon?: string;
  /** Default size contribution inside its region. */
  weight?: number;
  /** Whether the panel may be closed by the user. */
  closable?: boolean;
  /** Whether multiple panels may share this region (creates tabs). */
  allowGroup?: boolean;
}

export type LayoutMap = Record<RegionId, RegionState>;

interface LayoutActions {
  registerPanel(panel: PanelRegistration): void;
  unregisterPanel(panelId: string): void;
  openPanel(panelId: string): void;
  closePanel(panelId: string): void;
  togglePanel(panelId: string): void;
  setRegionSize(region: RegionId, size: number): void;
  toggleRegion(region: RegionId): void;
  setCollapsed(region: RegionId, collapsed: boolean): void;
  /** Apply a saved workspace layout (region sizes + collapsed states). Each
   *  region patch is partial — min/max come from the current region. */
  applyRegions(regions: Partial<Record<RegionId, Partial<RegionState>>>): void;
  resetLayout(): void;
}

export interface LayoutStore {
  panels: Record<string, PanelRegistration>;
  /** Region geometry, keyed by region id. */
  regions: LayoutMap;
  /** Order of panels within their region (for tab stacking). */
  panelOrder: Record<RegionId, ReadonlyArray<string>>;
  /** The currently active panel per region (for tab focus). */
  activePanelByRegion: Partial<Record<RegionId, string>>;
}

const DEFAULT_REGIONS: LayoutMap = {
  leftSidebar:     { collapsed: false, size: 280, minSize: 200, maxSize: 480 },
  rightInspector:  { collapsed: false, size: 320, minSize: 240, maxSize: 520 },
  centerWorkspace: { collapsed: false, size: 0,   minSize: 0,   maxSize: 0   },
  bottomTimeline:  { collapsed: false, size: 260, minSize: 120, maxSize: 600 },
};

export const useLayoutStore = create<LayoutStore & LayoutActions>()(
  immer((set, get) => ({
    panels: {},
    regions: structuredClone(DEFAULT_REGIONS),
    panelOrder: {
      leftSidebar: [],
      rightInspector: [],
      centerWorkspace: [],
      bottomTimeline: [],
    },
    activePanelByRegion: {},

    registerPanel: (panel) =>
      set((s) => {
        if (s.panels[panel.id]) return; // idempotent
        s.panels[panel.id] = panel;
        s.panelOrder[panel.region].push(panel.id);
        if (!s.activePanelByRegion[panel.region]) {
          s.activePanelByRegion[panel.region] = panel.id;
        }
        getEventBus().emit('PanelOpened', { panelId: panel.id });
      }),

    unregisterPanel: (panelId) =>
      set((s) => {
        const p = s.panels[panelId];
        if (!p) return;
        delete s.panels[panelId];
        s.panelOrder[p.region] = s.panelOrder[p.region].filter((id) => id !== panelId);
        if (s.activePanelByRegion[p.region] === panelId) {
          s.activePanelByRegion[p.region] = s.panelOrder[p.region][0];
        }
        getEventBus().emit('PanelClosed', { panelId });
      }),

    openPanel: (panelId) =>
      set((s) => {
        const p = s.panels[panelId];
        if (!p) return;
        s.regions[p.region].collapsed = false;
        if (!s.panelOrder[p.region].includes(panelId)) {
          s.panelOrder[p.region].push(panelId);
        }
        s.activePanelByRegion[p.region] = panelId;
        getEventBus().emit('PanelOpened', { panelId });
      }),

    closePanel: (panelId) =>
      set((s) => {
        const p = s.panels[panelId];
        if (!p) return;
        s.panelOrder[p.region] = s.panelOrder[p.region].filter((id) => id !== panelId);
        if (s.activePanelByRegion[p.region] === panelId) {
          s.activePanelByRegion[p.region] = s.panelOrder[p.region][0];
        }
        getEventBus().emit('PanelClosed', { panelId });
      }),

    togglePanel: (panelId) => {
      const p = get().panels[panelId];
      if (!p) return;
      if (get().panelOrder[p.region].includes(panelId)) {
        get().closePanel(panelId);
      } else {
        get().openPanel(panelId);
      }
    },

    setRegionSize: (region, size) =>
      set((s) => {
        const r = s.regions[region];
        r.size = clamp(size, r.minSize, r.maxSize);
        getEventBus().emit('PanelResized', { panelId: region, size: r.size });
      }),

    toggleRegion: (region) =>
      set((s) => {
        s.regions[region].collapsed = !s.regions[region].collapsed;
        getEventBus().emit('PanelResized', { panelId: region, size: s.regions[region].size });
      }),

    setCollapsed: (region, collapsed) =>
      set((s) => {
        s.regions[region].collapsed = collapsed;
      }),

    applyRegions: (regions) =>
      set((s) => {
        for (const key of Object.keys(regions) as RegionId[]) {
          const patch = regions[key];
          const r = s.regions[key];
          if (!patch || !r) continue;
          if (typeof patch.collapsed === 'boolean') r.collapsed = patch.collapsed;
          if (typeof patch.size === 'number') r.size = clamp(patch.size, r.minSize, r.maxSize);
        }
        getEventBus().emit('LayoutChanged', undefined);
      }),

    resetLayout: () =>
      set((s) => {
        s.regions = structuredClone(DEFAULT_REGIONS);
        s.activePanelByRegion = {};
        for (const p of Object.values(s.panels)) {
          s.panelOrder[p.region].push(p.id);
          if (!s.activePanelByRegion[p.region]) {
            s.activePanelByRegion[p.region] = p.id;
          }
        }
        getEventBus().emit('LayoutChanged', undefined);
      }),
  })),
);

export const usePanel = (panelId: string): PanelRegistration | undefined =>
  useLayoutStore((s) => s.panels[panelId]);
