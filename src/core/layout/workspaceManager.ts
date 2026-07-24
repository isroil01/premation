/**
 * WorkspaceManager — engine for managing workspace presets, user custom workspaces,
 * workspace JSON export/import, and automatic monitor layout matching.
 */

import { useLayoutStore, type RegionId } from '@stores/layoutStore';
import { getSettingsManager } from '@core/services/coreServices';

export interface WorkspaceSnapshot {
  id: string;
  name: string;
  builtin?: boolean;
  regions: Partial<Record<RegionId, { size: number; collapsed: boolean }>>;
  panelOrder?: Record<RegionId, ReadonlyArray<string>>;
  activePanelByRegion?: Partial<Record<RegionId, string>>;
  floatingPanels?: Array<{ id: string; x: number; y: number; width: number; height: number }>;
  externalPanels?: Array<{ id: string; monitorId?: string }>;
  leftSidebarPosition?: 'left' | 'right';
  rightInspectorPosition?: 'left' | 'right';
  timelinePosition?: 'bottom' | 'top';
  createdAt?: number;
}

const SETTINGS_KEY = 'workspace.userWorkspaces';
const ACTIVE_WORKSPACE_KEY = 'workspace.activeId';

/** Built-in professional presets tuned for specific tasks. */
export const BUILTIN_WORKSPACES: ReadonlyArray<WorkspaceSnapshot> = [
  {
    id: 'default',
    name: 'Default',
    builtin: true,
    regions: {
      leftSidebar: { size: 340, collapsed: false },
      rightInspector: { size: 340, collapsed: false },
      bottomTimeline: { size: 260, collapsed: false },
    },
    panelOrder: {
      leftSidebar: ['scene', 'assets', 'flow', 'library', 'ai'],
      rightInspector: ['properties', 'style', 'rig', 'effects', 'motiontools', 'presets', 'misc'],
      centerWorkspace: [],
      bottomTimeline: [],
    },
    activePanelByRegion: { leftSidebar: 'scene', rightInspector: 'properties' },
  },
  {
    id: 'motion-design',
    name: 'Motion Design',
    builtin: true,
    regions: {
      leftSidebar: { size: 360, collapsed: false },
      rightInspector: { size: 340, collapsed: false },
      bottomTimeline: { size: 380, collapsed: false },
    },
    panelOrder: {
      leftSidebar: ['flow', 'scene', 'assets', 'library'],
      rightInspector: ['properties', 'effects', 'motiontools', 'style'],
      centerWorkspace: [],
      bottomTimeline: [],
    },
    activePanelByRegion: { leftSidebar: 'flow', rightInspector: 'properties' },
  },
  {
    id: 'ai-focus',
    name: 'AI Focus',
    builtin: true,
    regions: {
      leftSidebar: { size: 420, collapsed: false },
      rightInspector: { size: 320, collapsed: false },
      bottomTimeline: { size: 200, collapsed: false },
    },
    panelOrder: {
      leftSidebar: ['ai', 'scene', 'assets'],
      rightInspector: ['properties', 'effects', 'presets'],
      centerWorkspace: [],
      bottomTimeline: [],
    },
    activePanelByRegion: { leftSidebar: 'ai', rightInspector: 'properties' },
  },
  {
    id: 'animation',
    name: 'Animation',
    builtin: true,
    regions: {
      leftSidebar: { size: 300, collapsed: false },
      rightInspector: { size: 320, collapsed: false },
      bottomTimeline: { size: 440, collapsed: false },
    },
    panelOrder: {
      leftSidebar: ['scene', 'flow'],
      rightInspector: ['properties', 'rig', 'motiontools'],
      centerWorkspace: [],
      bottomTimeline: [],
    },
    activePanelByRegion: { leftSidebar: 'scene', rightInspector: 'properties' },
  },
  {
    id: 'color-grading',
    name: 'Color & VFX',
    builtin: true,
    regions: {
      leftSidebar: { size: 300, collapsed: false },
      rightInspector: { size: 480, collapsed: false },
      bottomTimeline: { size: 220, collapsed: false },
    },
    panelOrder: {
      leftSidebar: ['scene', 'assets'],
      rightInspector: ['style', 'effects', 'properties'],
      centerWorkspace: [],
      bottomTimeline: [],
    },
    activePanelByRegion: { leftSidebar: 'scene', rightInspector: 'style' },
  },
  {
    id: 'dual-monitor-studio',
    name: 'Dual Monitor Studio',
    builtin: true,
    regions: {
      leftSidebar: { size: 340, collapsed: false },
      rightInspector: { size: 340, collapsed: false },
      bottomTimeline: { size: 180, collapsed: false },
    },
    externalPanels: [
      { id: 'viewport', monitorId: '2' },
      { id: 'timeline', monitorId: '2' },
    ],
  },
  {
    id: 'presentation',
    name: 'Presentation Mode',
    builtin: true,
    regions: {
      leftSidebar: { size: 340, collapsed: true },
      rightInspector: { size: 340, collapsed: true },
      bottomTimeline: { size: 260, collapsed: true },
    },
    externalPanels: [
      { id: 'presentation', monitorId: '2' },
    ],
  },
  {
    id: 'minimal',
    name: 'Minimal Canvas',
    builtin: true,
    regions: {
      leftSidebar: { size: 340, collapsed: true },
      rightInspector: { size: 340, collapsed: true },
      bottomTimeline: { size: 260, collapsed: true },
    },
  },
];

export class WorkspaceManager {
  private static instance: WorkspaceManager;

  public static getInstance(): WorkspaceManager {
    if (!WorkspaceManager.instance) {
      WorkspaceManager.instance = new WorkspaceManager();
    }
    return WorkspaceManager.instance;
  }

  public listWorkspaces(): WorkspaceSnapshot[] {
    const userSaved = this.getUserWorkspaces();
    return [...BUILTIN_WORKSPACES, ...userSaved];
  }

  public getUserWorkspaces(): WorkspaceSnapshot[] {
    try {
      return getSettingsManager().get<WorkspaceSnapshot[]>(SETTINGS_KEY, []);
    } catch {
      return [];
    }
  }

  public saveCurrentWorkspace(name: string): WorkspaceSnapshot {
    const store = useLayoutStore.getState();
    const id = `user-${Date.now()}`;
    const snapshot: WorkspaceSnapshot = {
      id,
      name,
      builtin: false,
      createdAt: Date.now(),
      regions: {
        leftSidebar: { size: store.regions.leftSidebar.size, collapsed: store.regions.leftSidebar.collapsed },
        rightInspector: { size: store.regions.rightInspector.size, collapsed: store.regions.rightInspector.collapsed },
        bottomTimeline: { size: store.regions.bottomTimeline.size, collapsed: store.regions.bottomTimeline.collapsed },
      },
      panelOrder: store.panelOrder,
      activePanelByRegion: store.activePanelByRegion,
      leftSidebarPosition: store.leftSidebarPosition,
      rightInspectorPosition: store.rightInspectorPosition,
      timelinePosition: store.timelinePosition,
      floatingPanels: store.floatingPanels.map((pId) => {
        const bounds = store.panels[pId]?.floatingBounds;
        return { id: pId, x: bounds?.x ?? 100, y: bounds?.y ?? 100, width: bounds?.width ?? 360, height: bounds?.height ?? 480 };
      }),
      externalPanels: store.externalPanels.map((pId) => ({
        id: pId,
        monitorId: store.panels[pId]?.monitorId,
      })),
    };

    const existing = this.getUserWorkspaces().filter((w) => w.name !== name);
    const updated = [...existing, snapshot];
    try {
      getSettingsManager().set<WorkspaceSnapshot[]>(SETTINGS_KEY, updated);
      getSettingsManager().set<string>(ACTIVE_WORKSPACE_KEY, id);
    } catch { /* noop */ }

    return snapshot;
  }

  public applyWorkspace(workspaceId: string): boolean {
    const target = this.listWorkspaces().find((w) => w.id === workspaceId || w.name === workspaceId);
    if (!target) return false;

    const store = useLayoutStore.getState();

    // Apply region geometries
    store.applyWorkspaceLayout({
      name: target.name,
      regions: target.regions,
      panelOrder: target.panelOrder,
      activePanelByRegion: target.activePanelByRegion,
      leftSidebarPosition: target.leftSidebarPosition,
      rightInspectorPosition: target.rightInspectorPosition,
      timelinePosition: target.timelinePosition,
    });

    // Apply floating panels if defined
    if (target.floatingPanels) {
      for (const fp of target.floatingPanels) {
        store.floatPanel(fp.id, { x: fp.x, y: fp.y, width: fp.width, height: fp.height });
      }
    }

    // Apply external popouts if defined
    if (target.externalPanels) {
      for (const ep of target.externalPanels) {
        store.popoutPanel(ep.id, ep.monitorId);
      }
    }

    try {
      getSettingsManager().set<string>(ACTIVE_WORKSPACE_KEY, target.id);
    } catch { /* noop */ }

    return true;
  }

  public deleteWorkspace(workspaceId: string): void {
    const updated = this.getUserWorkspaces().filter((w) => w.id !== workspaceId);
    try {
      getSettingsManager().set<WorkspaceSnapshot[]>(SETTINGS_KEY, updated);
    } catch { /* noop */ }
  }

  public exportWorkspaceJSON(workspaceId: string): string {
    const target = this.listWorkspaces().find((w) => w.id === workspaceId);
    if (!target) throw new Error('Workspace not found');
    return JSON.stringify(target, null, 2);
  }

  public importWorkspaceJSON(jsonString: string): WorkspaceSnapshot {
    const parsed = JSON.parse(jsonString) as WorkspaceSnapshot;
    if (!parsed.name || !parsed.regions) {
      throw new Error('Invalid workspace JSON schema');
    }
    parsed.id = `imported-${Date.now()}`;
    parsed.builtin = false;
    parsed.createdAt = Date.now();

    const existing = this.getUserWorkspaces();
    try {
      getSettingsManager().set<WorkspaceSnapshot[]>(SETTINGS_KEY, [...existing, parsed]);
    } catch { /* noop */ }

    return parsed;
  }
}

export const getWorkspaceManager = (): WorkspaceManager => WorkspaceManager.getInstance();
