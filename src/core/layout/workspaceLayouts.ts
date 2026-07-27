/**
 * Saveable workspace layouts (Prompt E10). A workspace layout is a snapshot of
 * the editor's region geometry (sizes + collapsed states). Ships built-in
 * presets (Animation / Effects / Minimal) and lets the user save their own,
 * persisted via the SettingsManager. Applying one drives the layout store.
 */

import { useLayoutStore, type LayoutMap, type RegionId } from '@stores/layoutStore';
import { getSettingsManager } from '@core/services/coreServices';

/** A layout stores each region's size + collapsed flag (min/max come from the
 *  store's region definitions, so presets don't need to carry them). */
export type LayoutSnapshot = Partial<Record<RegionId, { size: number; collapsed: boolean }>>;

export interface WorkspaceLayout {
  name: string;
  builtin?: boolean;
  regions: LayoutSnapshot;
  panelOrder?: Record<RegionId, ReadonlyArray<string>>;
  activePanelByRegion?: Partial<Record<RegionId, string>>;
  leftSidebarPosition?: 'left' | 'right';
  rightInspectorPosition?: 'left' | 'right';
  timelinePosition?: 'bottom' | 'top';
}

/** Built-in presets tuned for common tasks. */
export const BUILTIN_LAYOUTS: ReadonlyArray<WorkspaceLayout> = [
  {
    name: 'Default',
    builtin: true,
    regions: {
      leftSidebar: { size: 340, collapsed: false },
      rightInspector: { size: 340, collapsed: false },
      bottomTimeline: { size: 260, collapsed: false },
    },
  },
  {
    name: 'Animation',
    builtin: true,
    regions: {
      leftSidebar: { size: 320, collapsed: false },
      rightInspector: { size: 320, collapsed: false },
      bottomTimeline: { size: 420, collapsed: false }, // tall timeline for keyframes
    },
  },
  {
    name: 'Effects',
    builtin: true,
    regions: {
      leftSidebar: { size: 320, collapsed: false },
      rightInspector: { size: 460, collapsed: false }, // wide inspector for controls
      bottomTimeline: { size: 180, collapsed: false },
    },
  },
  {
    name: 'Minimal',
    builtin: true,
    regions: {
      leftSidebar: { size: 340, collapsed: true },
      rightInspector: { size: 340, collapsed: true },
      bottomTimeline: { size: 260, collapsed: true }, // canvas-only
    },
  },
];

/**
 * Must match the ids actually registered in App.tsx.
 *
 * This list had gone stale: it named `components`, `shapes`, `text` and
 * `comments` — none of which are registered (`comments` has no renderer at all)
 * — while OMITTING `library` and `ai`. Since every built-in workspace preset and
 * "Reset Layout to Default" applies this list verbatim, choosing any workspace
 * silently DELETED the Elements & Library and AI Assistant tabs from the
 * sidebar, and the dead ids were dropped on the floor.
 */
const DEFAULT_PANEL_ORDER: Record<RegionId, ReadonlyArray<string>> = {
  leftSidebar: ['scene', 'assets', 'library', 'ai'],
  rightInspector: ['properties', 'style', 'rig', 'effects', 'presets', 'misc'],
  centerWorkspace: [],
  bottomTimeline: [],
};

const DEFAULT_ACTIVE_PANEL: Record<RegionId, string> = {
  leftSidebar: 'scene',
  rightInspector: 'properties',
  centerWorkspace: '',
  bottomTimeline: '',
};

// Helper to fill in panelOrder for builtin layouts
export function getBuiltinLayouts(): ReadonlyArray<WorkspaceLayout> {
  return BUILTIN_LAYOUTS.map(layout => ({
    ...layout,
    panelOrder: layout.panelOrder || DEFAULT_PANEL_ORDER,
    activePanelByRegion: layout.activePanelByRegion || DEFAULT_ACTIVE_PANEL
  }));
}

const SETTINGS_KEY = 'workspaceLayouts';

function readUserLayouts(): WorkspaceLayout[] {
  try {
    return getSettingsManager().get<WorkspaceLayout[]>(SETTINGS_KEY, []);
  } catch {
    return [];
  }
}

function writeUserLayouts(layouts: WorkspaceLayout[]): void {
  try {
    getSettingsManager().set<WorkspaceLayout[]>(SETTINGS_KEY, layouts);
  } catch {
    /* settings not booted */
  }
}

/** All layouts (built-ins first, then the user's saved ones). */
export function listLayouts(): WorkspaceLayout[] {
  return [...getBuiltinLayouts(), ...readUserLayouts()];
}

/** Snapshot the current region geometry from a layout map (pure). */
export function captureRegions(regions: LayoutMap): LayoutSnapshot {
  const out: LayoutSnapshot = {};
  for (const key of Object.keys(regions) as RegionId[]) {
    if (key === 'centerWorkspace') continue; // always fills; nothing to persist
    out[key] = { size: regions[key].size, collapsed: regions[key].collapsed };
  }
  return out;
}

/** Save the current layout under `name` (overwrites a same-named user layout). */
export function saveCurrentLayout(name: string): void {
  const store = useLayoutStore.getState();
  const snapshot = captureRegions(store.regions);
  const others = readUserLayouts().filter((l) => l.name !== name);
  writeUserLayouts([...others, { 
    name, 
    regions: snapshot,
    panelOrder: store.panelOrder,
    activePanelByRegion: store.activePanelByRegion
  }]);
}

/** Apply a layout by name to the live layout store. */
export function applyLayout(name: string): boolean {
  const layout = listLayouts().find((l) => l.name === name);
  if (!layout) return false;
  useLayoutStore.getState().applyWorkspaceLayout(layout);
  return true;
}

/** Delete a user-saved layout (built-ins can't be deleted). */
export function deleteLayout(name: string): void {
  writeUserLayouts(readUserLayouts().filter((l) => l.name !== name));
}
