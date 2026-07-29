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

const PANEL_ORDER_SETTINGS_KEY = 'layout.panelOrder';
const LAYOUT_PERSIST_KEY = 'motion-editor.layout.v1';

// ── Persistence helpers ───────────────────────────────────────────
interface PersistedLayout {
  regions: Partial<Record<RegionId, Partial<RegionState>>>;
  panelOrder?: Partial<Record<RegionId, ReadonlyArray<string>>>;
  activePanelByRegion?: Partial<Record<RegionId, string>>;
  leftSidebarPosition?: 'left' | 'right';
  rightInspectorPosition?: 'left' | 'right';
  timelinePosition?: 'bottom' | 'top';
}

function loadPersistedLayout(): PersistedLayout | null {
  try {
    const raw = localStorage.getItem(LAYOUT_PERSIST_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PersistedLayout;
  } catch {
    return null;
  }
}

function saveLayout(
  regions: LayoutMap,
  panelOrder: Record<RegionId, ReadonlyArray<string>>,
  activePanelByRegion: Partial<Record<RegionId, string>>,
  leftSidebarPosition?: 'left' | 'right',
  rightInspectorPosition?: 'left' | 'right',
  timelinePosition?: 'bottom' | 'top'
): void {
  try {
    const data: PersistedLayout = {
      regions,
      panelOrder,
      activePanelByRegion,
      leftSidebarPosition,
      rightInspectorPosition,
      timelinePosition,
    };
    localStorage.setItem(LAYOUT_PERSIST_KEY, JSON.stringify(data));
  } catch {
    // storage quota or private mode — silently ignore
  }
}

function applyPersistedToRegions(regions: LayoutMap, saved: Partial<Record<RegionId, Partial<RegionState>>>): void {
  for (const key of Object.keys(saved) as RegionId[]) {
    const patch = saved[key];
    const r = regions[key];
    if (!patch || !r) continue;
    if (typeof patch.collapsed === 'boolean') r.collapsed = patch.collapsed;
    if (typeof patch.size === 'number') r.size = clamp(patch.size, r.minSize, r.maxSize);
  }
}

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

export type PlacementMode = 'docked' | 'floating' | 'external';

export interface FloatingBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
}

export interface PanelRegistration {
  /** Unique id within the app. */
  id: string;
  /** Region where the panel is docked. */
  region: RegionId;
  /** The panel's default region as declared at registration. */
  homeRegion?: RegionId;
  /** Placement mode: docked in a region, floating in-app, or external OS pop-out. */
  placement?: PlacementMode;
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
  /** Floating bounds (px) when placement === 'floating'. */
  floatingBounds?: FloatingBounds;
  /** Monitor identifier when placement === 'external' or assigned to second display. */
  monitorId?: string;
  /** Whether panel is pinned in place. */
  pinned?: boolean;
}

export type LayoutMap = Record<RegionId, RegionState>;

interface LayoutActions {
  registerPanel(panel: PanelRegistration): void;
  unregisterPanel(panelId: string): void;
  openPanel(panelId: string): void;
  closePanel(panelId: string): void;
  togglePanel(panelId: string): void;
  /** Move a panel tab to a new index within its current region. */
  reorderPanel(panelId: string, toIndex: number): void;
  /** Move a panel tab to a new region and index. */
  movePanel(panelId: string, toRegion: RegionId, toIndex: number): void;
  /** Float a panel inside the editor workspace. */
  floatPanel(panelId: string, bounds?: Partial<FloatingBounds>): void;
  /** Redock a floating/external panel into a region. */
  dockPanel(panelId: string, toRegion?: RegionId): void;
  /** Mark panel for external OS window pop-out. */
  popoutPanel(panelId: string, monitorId?: string): void;
  /** Update in-app floating panel geometry. */
  setFloatingBounds(panelId: string, bounds: Partial<FloatingBounds>): void;
  /** Bring floating panel to top of Z stack. */
  bringFloatingToFront(panelId: string): void;
  setRegionSize(region: RegionId, size: number): void;
  toggleRegion(region: RegionId): void;
  setCollapsed(region: RegionId, collapsed: boolean): void;
  /** Lock workspace layout to prevent accidental panel dragging. */
  setWorkspaceLocked(locked: boolean): void;
  /** Apply a saved workspace layout (region sizes + collapsed states + tab assignments). */
  applyWorkspaceLayout(layout: import('@core/layout/workspaceLayouts').WorkspaceLayout): void;
  resetLayout(): void;
  setLeftSidebarPosition(pos: 'left' | 'right'): void;
  setRightInspectorPosition(pos: 'left' | 'right'): void;
  setTimelinePosition(pos: 'bottom' | 'top'): void;
}

export interface LayoutStore {
  panels: Record<string, PanelRegistration>;
  /** Region geometry, keyed by region id. */
  regions: LayoutMap;
  /** Order of panels within their region (for tab stacking). */
  panelOrder: Record<RegionId, ReadonlyArray<string>>;
  /** List of currently floating panel IDs. */
  floatingPanels: ReadonlyArray<string>;
  /** List of currently externally popped-out panel IDs. */
  externalPanels: ReadonlyArray<string>;
  /** The currently active panel per region (for tab focus). */
  activePanelByRegion: Partial<Record<RegionId, string>>;
  leftSidebarPosition: 'left' | 'right';
  rightInspectorPosition: 'left' | 'right';
  timelinePosition: 'bottom' | 'top';
  /** True when workspace layout is locked against dragging/moving. */
  workspaceLocked: boolean;
}

const DEFAULT_REGIONS: LayoutMap = {
  leftSidebar:     { collapsed: false, size: 340, minSize: 320, maxSize: 640 },
  rightInspector:  { collapsed: false, size: 340, minSize: 300, maxSize: 640 },
  centerWorkspace: { collapsed: false, size: 0,   minSize: 0,   maxSize: 0   },
  bottomTimeline:  { collapsed: false, size: 260, minSize: 120, maxSize: 600 },
};

// Merge any persisted region state on top of defaults at module load time.
const _persisted = loadPersistedLayout();
const _initialRegions: LayoutMap = structuredClone(DEFAULT_REGIONS);
if (_persisted?.regions) applyPersistedToRegions(_initialRegions, _persisted.regions);

export const useLayoutStore = create<LayoutStore & LayoutActions>()(
  immer((set, get) => ({
    panels: {},
    regions: _initialRegions,
    // De-dupe restored order: older persisted layouts (written before the
    // registerPanel guard below) can contain each id twice, which rendered
    // every sidebar tab twice.
    panelOrder: {
      leftSidebar: [...new Set(_persisted?.panelOrder?.leftSidebar ?? [])],
      rightInspector: [...new Set(_persisted?.panelOrder?.rightInspector ?? [])],
      // Only the two sidebars host panels. Any ids persisted into the center or
      // bottom (timeline) regions by the old move code are orphans — nothing
      // renders them — so drop them; the panels re-register into their home
      // sidebar on boot. Prevents "moved a panel to the timeline and it vanished".
      centerWorkspace: [],
      bottomTimeline: [],
    },
    floatingPanels: [],
    externalPanels: [],
    activePanelByRegion: (_persisted?.activePanelByRegion ?? {}) as Partial<Record<RegionId, string>>,
    leftSidebarPosition: _persisted?.leftSidebarPosition ?? 'left',
    rightInspectorPosition: _persisted?.rightInspectorPosition ?? 'right',
    timelinePosition: _persisted?.timelinePosition ?? 'bottom',
    workspaceLocked: false,

    registerPanel: (panel) =>
      set((s) => {
        const existing = s.panels[panel.id];
        if (existing) {
          existing.closable = panel.closable;
          existing.title = panel.title;
          existing.icon = panel.icon;
          existing.weight = panel.weight;
          return;
        }
        const persistedRegion = (Object.keys(s.panelOrder) as RegionId[]).find((r) =>
          s.panelOrder[r].includes(panel.id),
        );
        const region = persistedRegion ?? panel.region;
        s.panels[panel.id] = {
          ...panel,
          homeRegion: panel.homeRegion ?? panel.region,
          region,
          placement: panel.placement ?? 'docked',
        };
        
        // Strip this id from all regions first to guarantee no cross-dock duplicates
        for (const rKey of Object.keys(s.panelOrder) as RegionId[]) {
          s.panelOrder[rKey] = s.panelOrder[rKey].filter((id) => id !== panel.id);
        }
        
        s.panelOrder[region].push(panel.id);
        if (!s.activePanelByRegion[region]) {
          s.activePanelByRegion[region] = panel.id;
        }
        getEventBus().emit('PanelOpened', { panelId: panel.id });
      }),

    unregisterPanel: (panelId) =>
      set((s) => {
        const p = s.panels[panelId];
        if (!p) return;
        delete s.panels[panelId];
        s.panelOrder[p.region] = s.panelOrder[p.region].filter((id) => id !== panelId);
        s.floatingPanels = s.floatingPanels.filter((id) => id !== panelId);
        s.externalPanels = s.externalPanels.filter((id) => id !== panelId);
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
        s.floatingPanels = s.floatingPanels.filter((id) => id !== panelId);
        s.externalPanels = s.externalPanels.filter((id) => id !== panelId);
        if (s.activePanelByRegion[p.region] === panelId) {
          s.activePanelByRegion[p.region] = s.panelOrder[p.region][0];
        }
        getEventBus().emit('PanelClosed', { panelId });
      }),

    togglePanel: (panelId) => {
      const p = get().panels[panelId];
      if (!p) return;
      if (get().panelOrder[p.region].includes(panelId) || get().floatingPanels.includes(panelId)) {
        get().closePanel(panelId);
      } else {
        get().openPanel(panelId);
      }
    },

    reorderPanel: (panelId: string, toIndex: number) => {
      set((s) => {
        const panel = s.panels[panelId];
        if (!panel) return;
        const order = [...s.panelOrder[panel.region]];
        const fromIndex = order.indexOf(panelId);
        if (fromIndex === -1) return;

        order.splice(fromIndex, 1);
        order.splice(toIndex, 0, panelId);
        s.panelOrder[panel.region] = order;
      });
      getEventBus().emit('LayoutChanged', undefined);
    },

    movePanel: (panelId: string, toRegion: RegionId, toIndex: number) => {
      set((s) => {
        const panel = s.panels[panelId];
        if (!panel) return;
        
        const fromRegion = panel.region;
        panel.placement = 'docked';
        s.floatingPanels = s.floatingPanels.filter((id) => id !== panelId);
        s.externalPanels = s.externalPanels.filter((id) => id !== panelId);

        if (fromRegion === toRegion) {
          const order = [...s.panelOrder[fromRegion]];
          const fromIndex = order.indexOf(panelId);
          if (fromIndex === -1) return;
          order.splice(fromIndex, 1);
          order.splice(toIndex, 0, panelId);
          s.panelOrder[fromRegion] = order;
        } else {
          // Remove from ALL regions completely so no duplicate version remains
          for (const rKey of Object.keys(s.panelOrder) as RegionId[]) {
            const oldLen = s.panelOrder[rKey].length;
            s.panelOrder[rKey] = s.panelOrder[rKey].filter((id) => id !== panelId);
            if (s.panelOrder[rKey].length !== oldLen && s.activePanelByRegion[rKey] === panelId) {
              s.activePanelByRegion[rKey] = s.panelOrder[rKey].length > 0 ? s.panelOrder[rKey][0] : undefined;
            }
          }
          
          panel.region = toRegion;
          const toOrder = [...(s.panelOrder[toRegion] || [])];
          toOrder.splice(toIndex, 0, panelId);
          s.panelOrder[toRegion] = toOrder;
          s.activePanelByRegion[toRegion] = panelId;
        }
      });
      getEventBus().emit('LayoutChanged', undefined);
    },

    /**
     * There are no in-window floating panels — this docks instead.
     *
     * "Detach a panel" is served by pop-out windows, which are live-synced to the
     * editor and work across monitors. Nothing renders `placement: 'floating'`.
     *
     * This must not be a no-op, though: `floating` can still arrive from an old
     * persisted layout or an imported workspace, and with no host to render it
     * that panel would appear NOWHERE. Docking is the safe landing.
     */
    floatPanel: (panelId) =>
      set((s) => {
        const panel = s.panels[panelId];
        if (!panel) return;
        panel.placement = 'docked';
        panel.region = panel.homeRegion ?? panel.region ?? 'leftSidebar';
        s.floatingPanels = s.floatingPanels.filter((id) => id !== panelId);
        s.externalPanels = s.externalPanels.filter((id) => id !== panelId);
        getEventBus().emit('LayoutChanged', undefined);
      }),

    dockPanel: (panelId, toRegion) =>
      set((s) => {
        const panel = s.panels[panelId];
        if (!panel) return;
        const targetRegion = toRegion ?? panel.homeRegion ?? 'leftSidebar';
        panel.placement = 'docked';
        panel.region = targetRegion;
        s.floatingPanels = s.floatingPanels.filter((id) => id !== panelId);
        s.externalPanels = s.externalPanels.filter((id) => id !== panelId);
        if (!s.panelOrder[targetRegion].includes(panelId)) {
          s.panelOrder[targetRegion].push(panelId);
        }
        s.activePanelByRegion[targetRegion] = panelId;
        getEventBus().emit('LayoutChanged', undefined);
      }),

    popoutPanel: (panelId, monitorId) =>
      set((s) => {
        const panel = s.panels[panelId];
        if (!panel) return;
        panel.placement = 'external';
        if (monitorId) panel.monitorId = monitorId;
        if (!s.externalPanels.includes(panelId)) {
          s.externalPanels.push(panelId);
        }
        s.floatingPanels = s.floatingPanels.filter((id) => id !== panelId);
        getEventBus().emit('LayoutChanged', undefined);
      }),

    setFloatingBounds: (panelId, bounds) =>
      set((s) => {
        const panel = s.panels[panelId];
        if (!panel || !panel.floatingBounds) return;
        panel.floatingBounds = {
          ...panel.floatingBounds,
          ...bounds,
        };
      }),

    bringFloatingToFront: (panelId) =>
      set((s) => {
        const panel = s.panels[panelId];
        if (!panel || !panel.floatingBounds) return;
        const maxZ = Math.max(100, ...Object.values(s.panels).map((p) => p.floatingBounds?.zIndex ?? 100));
        panel.floatingBounds.zIndex = maxZ + 1;
      }),

    setWorkspaceLocked: (locked) =>
      set((s) => {
        s.workspaceLocked = locked;
        getEventBus().emit('LayoutChanged', undefined);
      }),

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

    applyWorkspaceLayout: (layout) =>
      set((s) => {
        for (const key of Object.keys(layout.regions) as RegionId[]) {
          const patch = layout.regions[key];
          const r = s.regions[key];
          if (!patch || !r) continue;
          if (typeof patch.collapsed === 'boolean') r.collapsed = patch.collapsed;
          if (typeof patch.size === 'number') r.size = clamp(patch.size, r.minSize, r.maxSize);
        }
        
        if (layout.panelOrder) {
          // Reset all arrays to ensure clean non-duplicated placement across regions
          s.panelOrder = { leftSidebar: [], rightInspector: [], centerWorkspace: [], bottomTimeline: [] };
          for (const [regionId, order] of Object.entries(layout.panelOrder)) {
            const rId = regionId as RegionId;
            const uniqueOrder = [...new Set(order)];
            s.panelOrder[rId] = uniqueOrder;
            for (const panelId of uniqueOrder) {
              if (s.panels[panelId]) {
                s.panels[panelId].region = rId;
              }
            }
          }
        }
        
        if (layout.activePanelByRegion) {
          for (const [regionId, activeTabId] of Object.entries(layout.activePanelByRegion)) {
            s.activePanelByRegion[regionId as RegionId] = activeTabId;
          }
        }

        if (layout.leftSidebarPosition) s.leftSidebarPosition = layout.leftSidebarPosition;
        if (layout.rightInspectorPosition) s.rightInspectorPosition = layout.rightInspectorPosition;
        if (layout.timelinePosition) s.timelinePosition = layout.timelinePosition;

        getEventBus().emit('LayoutChanged', undefined);
      }),

    resetLayout: () =>
      set((s) => {
        s.regions = structuredClone(DEFAULT_REGIONS);
        s.activePanelByRegion = {};
        s.leftSidebarPosition = 'left';
        s.rightInspectorPosition = 'right';
        s.timelinePosition = 'bottom';
        s.panelOrder = {
          leftSidebar: [],
          rightInspector: [],
          centerWorkspace: [],
          bottomTimeline: [],
        };
        for (const p of Object.values(s.panels)) {
          const home = p.homeRegion ?? p.region;
          p.region = home;
          if (!s.panelOrder[home].includes(p.id)) {
            s.panelOrder[home].push(p.id);
          }
          if (!s.activePanelByRegion[home]) {
            s.activePanelByRegion[home] = p.id;
          }
        }
        try {
          localStorage.removeItem(LAYOUT_PERSIST_KEY);
          const { getSettingsManager } = require('@core/services/coreServices') as typeof import('@core/services/coreServices');
          getSettingsManager().delete(PANEL_ORDER_SETTINGS_KEY);
        } catch { /* noop */ }
        getEventBus().emit('LayoutChanged', undefined);
      }),

    setLeftSidebarPosition: (pos) =>
      set((s) => {
        s.leftSidebarPosition = pos;
        getEventBus().emit('LayoutChanged', undefined);
      }),

    setRightInspectorPosition: (pos) =>
      set((s) => {
        s.rightInspectorPosition = pos;
        getEventBus().emit('LayoutChanged', undefined);
      }),

    setTimelinePosition: (pos) =>
      set((s) => {
        s.timelinePosition = pos;
        getEventBus().emit('LayoutChanged', undefined);
      }),
  })),
);

// Persist panelOrder to SettingsManager whenever it changes so tab ordering
// survives page refresh. We subscribe lazily to avoid a boot-order dependency
// on SettingsManager (which is registered during Application.boot).
let _lastPanelOrder: unknown = null;
useLayoutStore.subscribe((state) => {
  if (state.panelOrder === _lastPanelOrder) return;
  _lastPanelOrder = state.panelOrder;
  try {
    const { getSettingsManager } = require('@core/services/coreServices') as typeof import('@core/services/coreServices');
    getSettingsManager().set(PANEL_ORDER_SETTINGS_KEY, state.panelOrder);
  } catch {
    /* SettingsManager not yet booted — safe to ignore on first render */
  }
});

// Persist the full layout (regions, panelOrder, activePanelByRegion) to
// localStorage so the workspace survives page refresh / Electron restart.
let _lastLayoutSig = '';
useLayoutStore.subscribe((state) => {
  // Cheap signature: JSON of the parts we care about.
  const sig = JSON.stringify({
    r: Object.fromEntries(
      (Object.keys(state.regions) as RegionId[]).map((k) => [k, { collapsed: state.regions[k].collapsed, size: state.regions[k].size }])
    ),
    p: state.panelOrder,
    a: state.activePanelByRegion,
    leftPos: state.leftSidebarPosition,
    rightPos: state.rightInspectorPosition,
    timePos: state.timelinePosition,
  });
  if (sig === _lastLayoutSig) return;
  _lastLayoutSig = sig;
  saveLayout(
    state.regions,
    state.panelOrder,
    state.activePanelByRegion,
    state.leftSidebarPosition,
    state.rightInspectorPosition,
    state.timelinePosition
  );
});

export const usePanel = (panelId: string): PanelRegistration | undefined =>
  useLayoutStore((s) => s.panels[panelId]);
