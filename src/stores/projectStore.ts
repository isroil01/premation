/**
 * ProjectStore — Tab manager and root state for the multi-composition editor.
 * Replaces WorkspaceStore.
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { getEventBus } from '@core/events/EventBus';
import { shortId } from '@utils/lang';

export interface TabInfo {
  id: string; // The UI tab ID
  compositionId: string; // The root SceneNode ID for this tab
  breadcrumbPath: string[]; // E.g. ['comp_main', 'comp_lower_third']
  time: number;
  frame: number;
  playing: boolean;
  title: string;
  dirty: boolean;
}

export interface CompositionSettings {
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  background: string;
  transparent: boolean;
}

export interface ProjectStoreShape {
  tabs: Record<string, TabInfo>;
  comps: Record<string, CompositionSettings>;
  tabOrder: string[];
  activeTabId: string | null;
  // Compatibility
  activeId: string | null;
  workspaces: Record<string, any>;
  actions: {
    setActiveTab: (tabId: string) => void;
    setActive: (id: string) => void;
    openTab: (compositionId: string, breadcrumbPath?: string[]) => string;
    closeTab: (tabId: string) => void;
    markDirty: (id: string, dirty: boolean) => void;
    
    // Per-tab playback state (driven by TimelineController)
    setTime: (time: number, frame: number) => void;
    setPlaying: (playing: boolean) => void;

    // Breadcrumb drill-down
    pushBreadcrumb: (nodeId: string) => void;
    jumpToBreadcrumb: (index: number) => void;

    // Composition management
    updateComp: (id: string, patch: Partial<CompositionSettings>) => void;
  };
}

export const useProjectStore = create<ProjectStoreShape>()(
  immer((set, get) => {
    // We start with one default tab pointing to a "Main Comp"
    const defaultTabId = `tab_${shortId()}`;
    const defaultCompId = 'scene-root';

    const initialTab: TabInfo = {
      id: defaultTabId,
      compositionId: defaultCompId,
      breadcrumbPath: [defaultCompId],
      time: 0,
      frame: 0,
      playing: false,
      title: 'Main Comp',
      dirty: false,
    };

    const initialComp: CompositionSettings = {
      id: defaultCompId,
      name: 'Main Comp',
      width: 1920,
      height: 1080,
      fps: 30,
      durationSeconds: 10,
      background: '#101014',
      transparent: false,
    };

    return {
      tabs: { [defaultTabId]: initialTab },
      comps: { [defaultCompId]: initialComp },
      tabOrder: [defaultTabId],
      activeTabId: defaultTabId,
      // Compatibility aliases for the old WorkspaceStore shape
      get activeId() { return this.activeTabId; },
      get workspaces() { return this.tabs as Record<string, any>; },
      actions: {
        setActiveTab: (tabId) => {
          const previous = get().activeTabId;
          set((s) => {
            if (!s.tabs[tabId]) return;
            s.activeTabId = tabId;
          });
          if (previous !== tabId) {
            getEventBus().emit('WorkspaceChanged', { from: previous ?? '', to: tabId });
          }
        },
        setActive: (id: string) => {
          get().actions.setActiveTab(id);
        },
        openTab: (compositionId, breadcrumbPath) => {
          const tabId = `tab_${shortId()}`;
          const tab: TabInfo = {
            id: tabId,
            compositionId,
            breadcrumbPath: breadcrumbPath ?? [compositionId],
            time: 0,
            frame: 0,
            playing: false,
            title: 'New Comp',
            dirty: false,
          };
          set((s) => {
            s.tabs[tabId] = tab;
            s.tabOrder.push(tabId);
            s.activeTabId = tabId;
          });
          getEventBus().emit('WorkspaceChanged', { from: get().activeTabId ?? '', to: tabId });
          return tabId;
        },
        closeTab: (tabId) => {
          set((s) => {
            if (!s.tabs[tabId]) return;
            delete s.tabs[tabId];
            s.tabOrder = s.tabOrder.filter((id) => id !== tabId);
            if (s.activeTabId === tabId) {
              s.activeTabId = s.tabOrder[s.tabOrder.length - 1] ?? null;
            }
          });
        },
        markDirty: (id: string, dirty: boolean) => {
          set((s) => {
            if (s.tabs[id]) s.tabs[id]!.dirty = dirty;
          });
          getEventBus().emit('ProjectDirtyChanged', { dirty });
        },
        setTime: (time, frame) => {
          set((s) => {
            const active = s.activeTabId ? s.tabs[s.activeTabId] : null;
            if (active) {
              active.time = time;
              active.frame = frame;
            }
          });
          getEventBus().emit('TimeChanged', { time, frame });
        },
        setPlaying: (playing) => {
          set((s) => {
            const active = s.activeTabId ? s.tabs[s.activeTabId] : null;
            if (active) active.playing = playing;
          });
          getEventBus().emit('PlayStateChanged', { playing });
        },
        pushBreadcrumb: (nodeId) => {
          set((s) => {
            const active = s.activeTabId ? s.tabs[s.activeTabId] : null;
            if (active) {
              active.breadcrumbPath.push(nodeId);
            }
          });
        },
        jumpToBreadcrumb: (index) => {
          set((s) => {
            const active = s.activeTabId ? s.tabs[s.activeTabId] : null;
            if (active && index >= 0 && index < active.breadcrumbPath.length) {
              active.breadcrumbPath = active.breadcrumbPath.slice(0, index + 1);
            }
          });
        },
        updateComp: (id, patch) => {
          set((s) => {
            if (s.comps[id]) {
              Object.assign(s.comps[id], patch);
            }
          });
        },
      },
    };
  })
);

export function useActiveTab(): TabInfo | null {
  return useProjectStore((s) => (s.activeTabId ? s.tabs[s.activeTabId] ?? null : null));
}

// Aliases for compatibility
export const useWorkspaceStore = useProjectStore;
export const useActiveWorkspace = useActiveTab;
