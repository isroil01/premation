/**
 * WorkspaceManager — built-in workspace presets, the user's saved layouts, and
 * applying either to the layout store.
 *
 * The docstring used to also advertise "workspace JSON export/import, and
 * automatic monitor layout matching". Export/import existed with zero callers
 * and no UI; monitor matching never existed at all. Both are gone rather than
 * left as claims — see the wiring audit.
 */

import { useLayoutStore, type RegionId } from '@stores/layoutStore';
import { getSettingsManager } from '@core/services/coreServices';
import { isPanelAvailable } from '@core/config/panelAvailability';

export interface WorkspaceSnapshot {
  id: string;
  name: string;
  builtin?: boolean;
  regions: Partial<Record<RegionId, { size: number; collapsed: boolean }>>;
  panelOrder?: Partial<Record<RegionId, ReadonlyArray<string>>>;
  activePanelByRegion?: Partial<Record<RegionId, string>>;
  externalPanels?: Array<{ id: string }>;
  leftSidebarPosition?: 'left' | 'right';
  rightInspectorPosition?: 'left' | 'right';
  timelinePosition?: 'bottom' | 'top';
  leftSidebarSplit?: boolean;
  rightInspectorSplit?: boolean;
  createdAt?: number;
  /**
   * A panel this preset exists FOR. When the build does not have it, the whole
   * preset is withheld rather than stripped — see `listWorkspaces`.
   *
   * Only for presets that are meaningless without the panel ("AI Focus"). A
   * preset that merely mentions a gated panel among others just gets it stripped.
   */
  requiresPanel?: string;
}

/**
 * Drop panels this build does not have out of a preset.
 *
 * Returns the snapshot unchanged when there is nothing to strip, so the common
 * case does not allocate — `listWorkspaces` runs on every Workspaces menu open.
 */
function stripUnavailablePanels(ws: WorkspaceSnapshot): WorkspaceSnapshot {
  const ids = [
    ...Object.values(ws.panelOrder ?? {}).flat(),
    ...Object.values(ws.activePanelByRegion ?? {}),
  ];
  if (ids.every((id) => isPanelAvailable(id))) return ws;

  // Rebuilt key-by-key off the original rather than via Object.fromEntries: the
  // region set is fixed and total, and a mapped-object round trip widens it to a
  // string index signature that no longer satisfies Record<RegionId, …>.
  let panelOrder: Partial<Record<RegionId, ReadonlyArray<string>>> | undefined;
  if (ws.panelOrder) {
    const source = ws.panelOrder;
    panelOrder = { ...source };
    for (const region of Object.keys(source) as RegionId[]) {
      if (source[region]) {
        panelOrder[region] = source[region]!.filter((id) => isPanelAvailable(id));
      }
    }
  }

  const activePanelByRegion = ws.activePanelByRegion
    ? Object.fromEntries(
        Object.entries(ws.activePanelByRegion).filter(([, id]) => id !== undefined && isPanelAvailable(id)),
      )
    : undefined;

  return {
    ...ws,
    ...(panelOrder ? { panelOrder } : {}),
    ...(activePanelByRegion ? { activePanelByRegion } : {}),
  };
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
      leftSidebar: ['scene', 'effectControls', 'assets', 'library', 'ai'],
      rightInspector: ['properties', 'rig', 'effects', 'motion', 'presets'],
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
      leftSidebar: ['scene', 'effectControls', 'assets', 'library'],
      rightInspector: ['properties', 'effects', 'motion'],
      centerWorkspace: [],
      bottomTimeline: [],
    },
    activePanelByRegion: { leftSidebar: 'scene', rightInspector: 'properties' },
  },
  {
    id: 'ai-focus',
    name: 'AI Focus',
    builtin: true,
    // Withheld entirely in editions with no assistant. Stripping it instead
    // would leave a preset called "AI Focus" that opens the Scene panel.
    requiresPanel: 'ai',
    regions: {
      leftSidebar: { size: 420, collapsed: false },
      rightInspector: { size: 320, collapsed: false },
      bottomTimeline: { size: 200, collapsed: false },
    },
    panelOrder: {
      leftSidebar: ['ai', 'scene', 'effectControls', 'assets'],
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
      leftSidebar: ['scene'],
      rightInspector: ['properties', 'rig'],
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
      leftSidebar: ['effectControls', 'scene', 'assets'],
      // The library stays on the right (add); Effect Controls leads on the
      // left (tune). That is the split this workspace exists to make obvious.
      rightInspector: ['effects', 'properties'],
      centerWorkspace: [],
      bottomTimeline: [],
    },
    activePanelByRegion: { leftSidebar: 'effectControls', rightInspector: 'effects' },
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
      { id: 'viewport' },
      { id: 'timeline' },
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
      { id: 'presentation' },
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

/**
 * The settings key of the workspace system this one replaced.
 *
 * `core/layout/workspaceLayouts.ts` was a SECOND, parallel implementation:
 * four built-in presets of its own, its own user list under this key, and
 * exactly one consumer (Customize ▸ Workspaces) — while the TopNav dropdown
 * used this manager. A layout saved from one never appeared in the other, and
 * both shipped a preset called "Default".
 *
 * That module is deleted. Anything a user saved under this key would have gone
 * with it, so it is migrated here rather than orphaned.
 */
const LEGACY_SETTINGS_KEY = 'workspaceLayouts';
const LEGACY_MIGRATED_KEY = 'workspace.legacyLayoutsMigrated';

/** The old `WorkspaceLayout` shape — no `id`, keyed by `name`. */
interface LegacyLayout {
  name: string;
  builtin?: boolean;
  regions: Partial<Record<RegionId, { size: number; collapsed: boolean }>>;
  panelOrder?: Record<RegionId, ReadonlyArray<string>>;
  activePanelByRegion?: Partial<Record<RegionId, string>>;
  leftSidebarPosition?: 'left' | 'right';
  rightInspectorPosition?: 'left' | 'right';
  timelinePosition?: 'bottom' | 'top';
}

/**
 * Fold any layouts saved under the old key into this manager's list, once.
 *
 * Idempotent by a flag rather than by clearing the source: if a user rolls back
 * to a build that still has the old system, their layouts are still there.
 * Name collisions keep the EXISTING entry — this manager's own saves are the
 * newer of the two systems, so they win.
 *
 * Runs lazily off `getUserWorkspaces` rather than at module scope, because
 * `getSettingsManager()` throws before `Application.boot()` — the same trap
 * that reset the AI provider on every launch (see aiProviderStore).
 */
export function migrateLegacyLayouts(): void {
  const settings = getSettingsManager();
  if (settings.get<boolean>(LEGACY_MIGRATED_KEY, false)) return;

  const legacy = settings.get<LegacyLayout[]>(LEGACY_SETTINGS_KEY, []);
  const existing = settings.get<WorkspaceSnapshot[]>(SETTINGS_KEY, []);

  if (Array.isArray(legacy) && legacy.length > 0) {
    const taken = new Set(existing.map((w) => w.name));
    const carried = legacy
      .filter((l) => l && !l.builtin && typeof l.name === 'string' && !taken.has(l.name))
      .map<WorkspaceSnapshot>((l, i) => ({
        id: `migrated-${i}-${l.name.replace(/\W+/g, '-').toLowerCase()}`,
        name: l.name,
        builtin: false,
        regions: l.regions ?? {},
        ...(l.panelOrder ? { panelOrder: l.panelOrder } : {}),
        ...(l.activePanelByRegion ? { activePanelByRegion: l.activePanelByRegion } : {}),
        ...(l.leftSidebarPosition ? { leftSidebarPosition: l.leftSidebarPosition } : {}),
        ...(l.rightInspectorPosition ? { rightInspectorPosition: l.rightInspectorPosition } : {}),
        ...(l.timelinePosition ? { timelinePosition: l.timelinePosition } : {}),
      }));
    if (carried.length > 0) {
      settings.set<WorkspaceSnapshot[]>(SETTINGS_KEY, [...existing, ...carried]);
    }
  }

  settings.set<boolean>(LEGACY_MIGRATED_KEY, true);
}

export class WorkspaceManager {
  private static instance: WorkspaceManager;

  public static getInstance(): WorkspaceManager {
    if (!WorkspaceManager.instance) {
      WorkspaceManager.instance = new WorkspaceManager();
    }
    return WorkspaceManager.instance;
  }

  /**
   * The workspaces this build offers.
   *
   * Two edition filters, and they are different in kind:
   *
   *  • A preset built AROUND a panel this edition lacks is dropped outright.
   *    "AI Focus" in a build with no assistant is a menu entry whose whole
   *    purpose is a panel that will not appear — it would apply, put an absent
   *    panel first, and silently fall back to whatever is next.
   *
   *  • Every other preset keeps its layout but has unavailable panels stripped
   *    from `panelOrder` and `activePanelByRegion`. `Default` lists `ai` last in
   *    the left sidebar; the dock already drops unregistered ids when it renders,
   *    so this changes nothing visible — but it stops an id the build does not
   *    have from being written into the persisted layout, where it would come
   *    back the day someone opens the same profile in the other edition.
   *
   * User-saved workspaces go through the same strip: one saved in a server build
   * and synced to a local one must not resurrect the panel.
   */
  public listWorkspaces(): WorkspaceSnapshot[] {
    const userSaved = this.getUserWorkspaces();
    return [...BUILTIN_WORKSPACES, ...userSaved]
      .filter((w) => w.requiresPanel === undefined || isPanelAvailable(w.requiresPanel))
      .map(stripUnavailablePanels);
  }

  public getUserWorkspaces(): WorkspaceSnapshot[] {
    try {
      migrateLegacyLayouts();
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
      externalPanels: store.externalPanels.map((pId) => ({ id: pId })),
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

    // Apply external popouts if defined
    if (target.externalPanels) {
      for (const ep of target.externalPanels) {
        store.popoutPanel(ep.id);
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

}

export const getWorkspaceManager = (): WorkspaceManager => WorkspaceManager.getInstance();
