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
 * Each sidebar is a column of panel GROUPS (`dockGroups`, see dockGroups.ts):
 * tab strips stacked top to bottom, each open or collapsed — After Effects'
 * panel groups. `panelOrder` stays the list of what is docked on a side.
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { getEventBus } from '@core/events/EventBus';
import { clamp } from '@utils/lang';
import {
  DOCK_SIDES,
  bottomRegionOf,
  emptyDockGroups,
  flattenGroups,
  groupOfPanel,
  legacySplitGroups,
  normalizeWeights,
  reconcileGroups,
  sanitizeDockGroups,
  sanitizeGroupList,
  sideOfRegion,
  uniqueGroupId,
  type DockGroupState,
  type DockGroups,
  type DockSide,
} from '@core/layout/dockGroups';

export type { DockGroupState, DockGroups, DockSide } from '@core/layout/dockGroups';

const PANEL_ORDER_SETTINGS_KEY = 'layout.panelOrder';

/**
 * Width of a closed sidebar: a thin EDGE with a grip (`--dock-rail-width` in
 * tokens/spacing.css — the two must agree). A closed sidebar is hidden, the
 * way After Effects closes a panel group; it used to stay as a 56px icon rail,
 * which read as a second, different sidebar. EditorLayout sizes the closed
 * pane with this.
 */
export const COLLAPSED_SIDEBAR_SIZE = 8;
/**
 * How far the divider of a closed sidebar must be dragged before it opens
 * again. Well past the edge's own width, so resting the pointer on the edge —
 * or a one-pixel wobble while clicking it — is not a drag-open.
 */
const SIDEBAR_DRAG_OPEN_THRESHOLD = 40;
const LAYOUT_PERSIST_KEY = 'motion-editor.layout.v1';

/**
 * Bumped when the DEFAULT panel sets change enough that a persisted tab order
 * would hide the change from everyone who has run the app before.
 *
 * 3: Effects, Presets and Plugins moved to permanent right-inspector tabs.
 * 4: Layers hosts Compositions and is permanent on the left sidebar; Project renamed to Assets.
 * 5: The inspector is a stack of bars; Preview and Align are permanent in it. Assets is
 *    Project again, first on the left, and lists the compositions above the media.
 * 6: The left group is Project + Effect Controls; Layers and Library are on demand; the
 *    assistant is the last bar on the right.
 * 7: Layers is permanent on the left again (it is where the compositions are listed).
 * 8: The Render Queue is a tab of the timeline panel (timelinePanelStore), no longer a dock
 *    panel — a saved order that still lists it is dropped.
 * 9: The right stack is After Effects' Default: Properties, Info, Audio, Preview, Effects &
 *    Presets, Align, Character. Plugins, Assistant and Animation Presets are on demand.
 */
export const LAYOUT_SCHEMA_VERSION = 9;

// ── Persistence helpers ───────────────────────────────────────────
export interface PersistedLayout {
  /** Absent on every layout written before the schema was versioned (= 1). */
  version?: number;
  regions: Partial<Record<RegionId, Partial<RegionState>>>;
  panelOrder?: Partial<Record<RegionId, ReadonlyArray<string>>>;
  activePanelByRegion?: Partial<Record<RegionId, string>>;
  leftSidebarPosition?: 'left' | 'right';
  rightInspectorPosition?: 'left' | 'right';
  timelinePosition?: 'bottom' | 'top';
  /** The old two-pane split. Read only to seed groups for a layout saved before them. */
  leftSidebarSplit?: boolean;
  rightInspectorSplit?: boolean;
  /** Each side's panel groups (dockGroups.ts). Absent on layouts saved before groups. */
  dockGroups?: Partial<Record<DockSide, DockGroupState[]>>;
}

/**
 * Bring a persisted layout up to LAYOUT_SCHEMA_VERSION.
 *
 * Keeps what the user SHAPED — region sizes, collapsed states, which side
 * each dock sits on, splits — and drops what the defaults now decide: the tab
 * order and the active tab per region. Pure, so the migration is tested on
 * literal old payloads rather than through module-load side effects.
 */
export function migratePersistedLayout(saved: PersistedLayout): { layout: PersistedLayout; migrated: boolean } {
  if ((saved.version ?? 1) >= LAYOUT_SCHEMA_VERSION) return { layout: saved, migrated: false };
  const { panelOrder: _dropOrder, activePanelByRegion: _dropActive, ...kept } = saved;
  return { layout: { ...kept, version: LAYOUT_SCHEMA_VERSION }, migrated: true };
}

/** Set when this session's persisted layout was migrated; read once by `consumeLayoutMigration`. */
let _layoutMigrated = false;

/**
 * True exactly once per session, when the persisted layout predated the
 * current schema. `App` uses it to re-apply the ACTIVE builtin workspace's
 * panel lists (see `reconcileActiveWorkspace`), which the migration dropped
 * along with the old order.
 */
export function consumeLayoutMigration(): boolean {
  const was = _layoutMigrated;
  _layoutMigrated = false;
  return was;
}

function loadPersistedLayout(): PersistedLayout | null {
  try {
    const raw = localStorage.getItem(LAYOUT_PERSIST_KEY);
    if (!raw) return null;
    const { layout, migrated } = migratePersistedLayout(JSON.parse(raw) as PersistedLayout);
    _layoutMigrated = migrated;
    return layout;
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
  timelinePosition?: 'bottom' | 'top',
  dockGroups?: DockGroups,
): void {
  try {
    const data: PersistedLayout = {
      version: LAYOUT_SCHEMA_VERSION,
      regions,
      panelOrder,
      activePanelByRegion,
      leftSidebarPosition,
      rightInspectorPosition,
      timelinePosition,
      dockGroups,
    };
    localStorage.setItem(LAYOUT_PERSIST_KEY, JSON.stringify(data));
  } catch {
    // storage quota or private mode — silently ignore
  }
}

/**
 * Which panels the old right-hand STACK had open (DockPanel kept them in
 * localStorage). Read once, for a layout saved before groups: those panels'
 * groups start expanded, so the column a user left open stays open.
 */
function legacyExpandedPanels(): ReadonlySet<string> {
  try {
    const raw = localStorage.getItem('premation.dock.expanded.rightInspector');
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
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
  | 'leftSidebar_bottom'
  | 'rightInspector'
  | 'rightInspector_bottom'
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

/**
 * Where a panel lives. There is deliberately no 'floating' member: nothing ever
 * rendered a floating placement, no UI could produce one (the panel menu
 * offers Pop Out and two dock targets, never Float), and the whole floating
 * surface — floatPanel / setFloatingBounds / bringFloatingToFront /
 * floatingBounds / floatingPanels — was removed in the wiring audit. Keeping
 * the member would keep a state the renderer cannot draw expressible.
 */
export type PlacementMode = 'docked' | 'external';

export interface PanelRegistration {
  /** Unique id within the app. */
  id: string;
  /** Region where the panel is docked. */
  region: RegionId;
  /** The panel's default region as declared at registration. */
  homeRegion?: RegionId;
  /** Placement mode: docked in a region, or external OS pop-out. */
  placement?: PlacementMode;
  /** Display title (also used as default tab label). */
  title: string;
  /** Optional icon name. */
  icon?: string;
  /** Default size contribution inside its region. */
  weight?: number;
  /** Whether the panel may be closed by the user. */
  closable?: boolean;
  /** Whether panel is pinned in place. */
  pinned?: boolean;
  /**
   * Opened from a menu, not docked by default (`PanelDef.onDemand`). The store
   * needs it for Reset Layout, which re-docks every registered panel at home
   * and would otherwise put all the on-demand panels back on the rails.
   */
  onDemand?: boolean;
}

export type LayoutMap = Record<RegionId, RegionState>;

/**
 * The shape `applyWorkspaceLayout` consumes.
 *
 * Declared HERE rather than imported from the workspace module, so the store
 * does not depend on whichever layer happens to own workspace persistence this
 * month. `WorkspaceSnapshot` in `core/layout/workspaceManager` is a superset and
 * satisfies it structurally. It previously pointed at `workspaceLayouts.ts`,
 * which was one of two competing workspace systems and has since been deleted.
 */
export interface WorkspaceLayoutInput {
  name: string;
  regions: Partial<Record<RegionId, { size: number; collapsed: boolean }>>;
  panelOrder?: Partial<Record<RegionId, ReadonlyArray<string>>>;
  activePanelByRegion?: Partial<Record<RegionId, string>>;
  leftSidebarPosition?: 'left' | 'right';
  rightInspectorPosition?: 'left' | 'right';
  timelinePosition?: 'bottom' | 'top';
  /** The old two-pane split: ignored (a workspace's `_bottom` lists still seed a group). */
  leftSidebarSplit?: boolean;
  rightInspectorSplit?: boolean;
  /**
   * Each side's panel groups. A workspace without them (every builtin) gets the
   * default grouping for its panel lists, with the group of its active panel
   * open.
   */
  dockGroups?: Partial<Record<DockSide, ReadonlyArray<DockGroupState>>>;
}

interface LayoutActions {
  registerPanel(panel: PanelRegistration): void;
  unregisterPanel(panelId: string): void;
  openPanel(panelId: string): void;
  closePanel(panelId: string): void;
  togglePanel(panelId: string): void;
  /** Move a panel tab to a new index within its group. */
  reorderPanel(panelId: string, toIndex: number): void;
  /**
   * Move a panel to another side (`toRegion`): it lands where that side puts a
   * newly opened panel (dockGroups.ts `placePanel`). Within its own side it is
   * a reorder inside its group. A `_bottom` region means "a new group at the
   * bottom of that side" — what moving to the old split's lower pane did.
   */
  movePanel(panelId: string, toRegion: RegionId, toIndex: number): void;
  /** Move a panel into an existing group (either side), at `index` in its strip (default: the end). */
  movePanelToGroup(panelId: string, groupId: string, index?: number): void;
  /** Take a panel out into a group of its own, inserted at `index` in `side`'s column. */
  movePanelToNewGroup(panelId: string, side: DockSide, index: number): void;
  /** Bring a panel to the front of its group (and open the group) without other side effects. */
  setGroupActive(groupId: string, panelId: string): void;
  /** Collapse a group to its tab strip, or open it again. */
  setGroupCollapsed(groupId: string, collapsed: boolean): void;
  toggleGroupCollapsed(groupId: string): void;
  /** Close every closable panel of a group. */
  closeGroup(groupId: string): void;
  /** Merge a group into the one above it (its tabs appended to that strip). */
  mergeGroupUp(groupId: string): void;
  /** Height shares for a side's expanded groups (a divider drag's result), by group id. */
  setGroupWeights(side: DockSide, weights: Readonly<Record<string, number>>): void;
  /** Redock an external panel into a region. */
  dockPanel(panelId: string, toRegion?: RegionId): void;
  /** Mark panel for external OS window pop-out. */
  popoutPanel(panelId: string): void;
  setRegionSize(region: RegionId, size: number): void;
  toggleRegion(region: RegionId): void;
  setCollapsed(region: RegionId, collapsed: boolean): void;
  /** Apply a saved workspace layout (region sizes + collapsed states + tab assignments). */
  applyWorkspaceLayout(layout: WorkspaceLayoutInput): void;
  resetLayout(): void;
  setLeftSidebarPosition(pos: 'left' | 'right'): void;
  setRightInspectorPosition(pos: 'left' | 'right'): void;
  setTimelinePosition(pos: 'bottom' | 'top'): void;
  /**
   * One-key focus modes (`` ` `` / `` Shift+` ``).
   *
   * Entering a mode snapshots which regions were collapsed and collapses the
   * ones the mode hides; toggling the SAME mode again restores that snapshot;
   * switching to the OTHER mode re-collapses against the original snapshot,
   * so leaving either way puts back what the user had before the first Tab.
   */
  setFocusMode(mode: FocusMode): void;
}

/**
 * `viewport-timeline` = both sidebars collapsed, timeline kept;
 * `viewport` = sidebars and timeline collapsed; `none` = as the user left it.
 */
export type FocusMode = 'none' | 'viewport-timeline' | 'viewport';

/** The regions a focus mode may collapse, and therefore must remember. */
export const FOCUS_MODE_REGIONS: ReadonlyArray<RegionId> = [
  'leftSidebar',
  'leftSidebar_bottom',
  'rightInspector',
  'rightInspector_bottom',
  'bottomTimeline',
];

/** Which of those a mode collapses. */
export function focusModeCollapses(mode: FocusMode, region: RegionId): boolean {
  if (mode === 'none') return false;
  if (region === 'bottomTimeline') return mode === 'viewport';
  return FOCUS_MODE_REGIONS.includes(region);
}

export interface LayoutStore {
  panels: Record<string, PanelRegistration>;
  /** Region geometry, keyed by region id. */
  regions: LayoutMap;
  /**
   * The panels docked on each side, in on-screen order — the groups flattened.
   * Membership lives here (menus, workspaces and the "+" read it); how a side
   * is divided into groups lives in `dockGroups`. The `_bottom` regions are the
   * old split's and stay empty once a layout has been loaded.
   */
  panelOrder: Record<RegionId, ReadonlyArray<string>>;
  /** Each side's panel groups, top to bottom (dockGroups.ts). */
  dockGroups: DockGroups;
  /** List of currently externally popped-out panel IDs. */
  externalPanels: ReadonlyArray<string>;
  /**
   * The panel last brought forward on each side — the one with focus, whose
   * group the dock marks. Each group's own front tab is `DockGroupState.active`.
   */
  activePanelByRegion: Partial<Record<RegionId, string>>;
  leftSidebarPosition: 'left' | 'right';
  rightInspectorPosition: 'left' | 'right';
  timelinePosition: 'bottom' | 'top';
  /** Active focus mode. Not persisted: a reload puts the user back in charge of the panels. */
  focusMode: FocusMode;
  /** Collapsed state per region as it was before the focus mode was entered. */
  focusModeRestore: Partial<Record<RegionId, boolean>> | null;
}

const DEFAULT_REGIONS: LayoutMap = {
  leftSidebar:           { collapsed: false, size: 280, minSize: 220, maxSize: 640 },
  leftSidebar_bottom:    { collapsed: false, size: 280, minSize: 220, maxSize: 640 },
  // 320, not 280: the labelled rail takes 56px of the region, and Properties
  // draws paired X / Y fields that need the room.
  rightInspector:        { collapsed: false, size: 320, minSize: 240, maxSize: 640 },
  rightInspector_bottom: { collapsed: false, size: 320, minSize: 240, maxSize: 640 },
  centerWorkspace:       { collapsed: false, size: 0,   minSize: 0,   maxSize: 0   },
  bottomTimeline:        { collapsed: false, size: 240, minSize: 100, maxSize: 600 },
};

// Merge any persisted region state on top of defaults at module load time.
const _persisted = loadPersistedLayout();
const _initialRegions: LayoutMap = structuredClone(DEFAULT_REGIONS);
if (_persisted?.regions) applyPersistedToRegions(_initialRegions, _persisted.regions);

/**
 * The groups a session starts with: the persisted ones; for a layout saved
 * before groups existed, the old split's two panes as groups
 * (`legacySplitGroups`); otherwise none yet — the panels form the default
 * groups as they register (`placePanel`).
 */
function initialDockGroups(saved: PersistedLayout | null): DockGroups {
  const groups = emptyDockGroups();
  const persisted = sanitizeDockGroups(saved?.dockGroups);
  for (const side of DOCK_SIDES) {
    const list = persisted?.[side];
    if (list) {
      groups[side] = list;
      continue;
    }
    const top = [...new Set(saved?.panelOrder?.[side] ?? [])];
    const bottom = [...new Set(saved?.panelOrder?.[bottomRegionOf(side)] ?? [])];
    groups[side] = legacySplitGroups(side, top, bottom);
  }
  return groups;
}

/**
 * Panels whose new group opens expanded when it is first formed: what the old
 * right-hand stack had open, for a layout saved before groups. Cleared by
 * Reset Layout, which means the fresh-session default.
 */
let _legacyExpanded: ReadonlySet<string> = _persisted && !_persisted.dockGroups ? legacyExpandedPanels() : new Set();

/** A side's docked panels: its `panelOrder`, then its old split's bottom pane. */
function sideMembers(s: LayoutStore, side: DockSide): string[] {
  return [...new Set([...(s.panelOrder[side] ?? []), ...(s.panelOrder[bottomRegionOf(side)] ?? [])])];
}

/**
 * Bring a side's groups and `panelOrder` back into agreement after a change to
 * either (dockGroups.ts): membership from `panelOrder`, division from the
 * groups. Writes `panelOrder[side]` back as the groups flattened, empties the
 * old bottom pane, and keeps the side's focused panel one that is docked.
 */
function syncSide(s: LayoutStore, side: DockSide): void {
  const groups = reconcileGroups(side, sideMembers(s, side), s.dockGroups[side], {
    expandNew: (id) => (_legacyExpanded.has(id) ? true : undefined),
  });
  s.dockGroups[side] = groups;
  s.panelOrder[side] = flattenGroups(groups);
  s.panelOrder[bottomRegionOf(side)] = [];
  for (const id of s.panelOrder[side]) {
    const p = s.panels[id];
    if (p) p.region = side;
  }
  const focus = s.activePanelByRegion[side];
  if (!focus || !s.panelOrder[side].includes(focus)) {
    const open = groups.find((g) => !g.collapsed) ?? groups[0];
    s.activePanelByRegion[side] = open?.active ?? undefined;
  }
  delete s.activePanelByRegion[bottomRegionOf(side)];
}

/** Membership follows the groups after a direct edit of them, then `syncSide`. */
function commitGroups(s: LayoutStore, side: DockSide): void {
  s.panelOrder[side] = flattenGroups(s.dockGroups[side]);
  s.panelOrder[bottomRegionOf(side)] = [];
  syncSide(s, side);
}

/** The side and group holding a docked panel. */
function locate(s: LayoutStore, panelId: string): { side: DockSide; group: DockGroupState } | null {
  for (const side of DOCK_SIDES) {
    const group = groupOfPanel(s.dockGroups[side], panelId);
    if (group) return { side, group };
  }
  return null;
}

/** The side and group with this id. */
function locateGroup(s: LayoutStore, groupId: string): { side: DockSide; group: DockGroupState; index: number } | null {
  for (const side of DOCK_SIDES) {
    const index = s.dockGroups[side].findIndex((g) => g.id === groupId);
    if (index >= 0) return { side, group: s.dockGroups[side][index]!, index };
  }
  return null;
}

/**
 * Show a docked panel: in front of its group, the group open, the side open
 * and the panel the side's focus — what Window ▸ <panel>, a shortcut or a tab
 * click all mean.
 */
function bringForward(s: LayoutStore, panelId: string): void {
  const at = locate(s, panelId);
  if (!at) return;
  at.group.active = panelId;
  at.group.collapsed = false;
  s.activePanelByRegion[at.side] = panelId;
  s.regions[at.side].collapsed = false;
}

/** Take a panel out of whichever group holds it (both sides re-synced by the caller). */
function detach(s: LayoutStore, panelId: string): DockSide | null {
  const at = locate(s, panelId);
  if (!at) return null;
  at.group.panels = at.group.panels.filter((id) => id !== panelId);
  if (at.group.active === panelId) at.group.active = at.group.panels[0] ?? null;
  s.dockGroups[at.side] = s.dockGroups[at.side].filter((g) => g.panels.length > 0);
  return at.side;
}

export const useLayoutStore = create<LayoutStore & LayoutActions>()(
  immer((set, get) => ({
    panels: {},
    regions: _initialRegions,
    focusMode: 'none',
    focusModeRestore: null,
    // De-dupe restored order: older persisted layouts (written before the
    // registerPanel guard below) can contain each id twice, which rendered
    // every sidebar tab twice.
    panelOrder: {
      leftSidebar: [...new Set(_persisted?.panelOrder?.leftSidebar ?? [])],
      leftSidebar_bottom: [...new Set(_persisted?.panelOrder?.leftSidebar_bottom ?? [])],
      rightInspector: [...new Set(_persisted?.panelOrder?.rightInspector ?? [])],
      rightInspector_bottom: [...new Set(_persisted?.panelOrder?.rightInspector_bottom ?? [])],
      // Only the two sidebars host panels. Any ids persisted into the center or
      // bottom (timeline) regions by the old move code are orphans — nothing
      // renders them — so drop them; the panels re-register into their home
      // sidebar on boot. Prevents "moved a panel to the timeline and it vanished".
      centerWorkspace: [],
      bottomTimeline: [],
    },
    externalPanels: [],
    activePanelByRegion: (_persisted?.activePanelByRegion ?? {}) as Partial<Record<RegionId, string>>,
    leftSidebarPosition: _persisted?.leftSidebarPosition ?? 'left',
    rightInspectorPosition: _persisted?.rightInspectorPosition ?? 'right',
    timelinePosition: _persisted?.timelinePosition ?? 'bottom',
    dockGroups: initialDockGroups(_persisted),

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
          s.panelOrder[r]?.includes(panel.id),
        );
        const region = persistedRegion ?? panel.region;
        s.panels[panel.id] = {
          ...panel,
          homeRegion: panel.homeRegion ?? panel.region,
          region,
          placement: panel.placement ?? 'docked',
        };

        // No cross-dock duplicates: the id stays only where the persisted
        // layout had it — at its persisted place, so a saved order and the
        // saved groups survive registration — or is appended to its home.
        for (const rKey of Object.keys(s.panelOrder) as RegionId[]) {
          if (rKey !== region && s.panelOrder[rKey]?.includes(panel.id)) {
            s.panelOrder[rKey] = s.panelOrder[rKey].filter((id) => id !== panel.id);
          }
        }
        if (!s.panelOrder[region]) s.panelOrder[region] = [];
        if (!s.panelOrder[region].includes(panel.id)) s.panelOrder[region].push(panel.id);
        if (!s.activePanelByRegion[region]) {
          s.activePanelByRegion[region] = panel.id;
        }
        const side = sideOfRegion(region);
        if (side) syncSide(s, side);
        getEventBus().emit('PanelOpened', { panelId: panel.id });
      }),

    unregisterPanel: (panelId) =>
      set((s) => {
        const p = s.panels[panelId];
        if (!p) return;
        delete s.panels[panelId];
        if (s.panelOrder[p.region]) {
          s.panelOrder[p.region] = s.panelOrder[p.region].filter((id) => id !== panelId);
        }
        s.externalPanels = s.externalPanels.filter((id) => id !== panelId);
        if (s.activePanelByRegion[p.region] === panelId) {
          s.activePanelByRegion[p.region] = s.panelOrder[p.region]?.[0];
        }
        const side = sideOfRegion(p.region);
        if (side) syncSide(s, side);
        getEventBus().emit('PanelClosed', { panelId });
      }),

    openPanel: (panelId) =>
      set((s) => {
        const p = s.panels[panelId];
        if (!p) return;
        const side = sideOfRegion(p.region);
        if (!side) {
          // Not a sidebar panel (nothing registers one today): the old behaviour.
          s.regions[p.region].collapsed = false;
          if (!s.panelOrder[p.region]) s.panelOrder[p.region] = [];
          if (!s.panelOrder[p.region].includes(panelId)) s.panelOrder[p.region].push(panelId);
          s.activePanelByRegion[p.region] = panelId;
          getEventBus().emit('PanelOpened', { panelId });
          return;
        }
        if (!sideMembers(s, side).includes(panelId)) {
          s.panelOrder[side] = [...(s.panelOrder[side] ?? []), panelId];
        }
        syncSide(s, side);
        // Opened = shown: in front of its group, the group expanded (a newly
        // placed group starts collapsed on the right), the side its focus.
        bringForward(s, panelId);
        getEventBus().emit('PanelOpened', { panelId });
      }),

    closePanel: (panelId) =>
      set((s) => {
        const p = s.panels[panelId];
        if (!p) return;
        if (s.panelOrder[p.region]) {
          s.panelOrder[p.region] = s.panelOrder[p.region].filter((id) => id !== panelId);
        }
        s.externalPanels = s.externalPanels.filter((id) => id !== panelId);
        if (s.activePanelByRegion[p.region] === panelId) {
          s.activePanelByRegion[p.region] = s.panelOrder[p.region]?.[0];
        }
        const side = sideOfRegion(p.region);
        if (side) {
          // Its group loses the tab (and goes, if that was its only one); the
          // side's focus passes to whatever is open there now.
          if (s.activePanelByRegion[side] === panelId) delete s.activePanelByRegion[side];
          syncSide(s, side);
        }
        getEventBus().emit('PanelClosed', { panelId });
      }),

    togglePanel: (panelId) => {
      const p = get().panels[panelId];
      if (!p) return;
      if (get().panelOrder[p.region]?.includes(panelId)) {
        get().closePanel(panelId);
      } else {
        get().openPanel(panelId);
      }
    },

    reorderPanel: (panelId: string, toIndex: number) => {
      set((s) => {
        for (const side of DOCK_SIDES) syncSide(s, side);
        const at = locate(s, panelId);
        if (!at) return;
        const panels = at.group.panels.filter((id) => id !== panelId);
        panels.splice(clamp(toIndex, 0, panels.length), 0, panelId);
        at.group.panels = panels;
        commitGroups(s, at.side);
      });
      getEventBus().emit('LayoutChanged', undefined);
    },

    movePanel: (panelId: string, toRegion: RegionId, toIndex: number) => {
      set((s) => {
        const panel = s.panels[panelId];
        if (!panel) return;
        const toSide = sideOfRegion(toRegion);
        // Only the two sidebars host docked panels (see PanelHeader's targets).
        if (!toSide) return;
        panel.placement = 'docked';
        s.externalPanels = s.externalPanels.filter((id) => id !== panelId);
        for (const side of DOCK_SIDES) syncSide(s, side);

        const at = locate(s, panelId);
        const toBottom = toRegion === bottomRegionOf(toSide);
        if (at && at.side === toSide && !toBottom) {
          // Same side: a reorder inside its own group.
          const panels = at.group.panels.filter((id) => id !== panelId);
          panels.splice(clamp(toIndex, 0, panels.length), 0, panelId);
          at.group.panels = panels;
          commitGroups(s, toSide);
          return;
        }
        const fromSide = detach(s, panelId);
        if (fromSide) commitGroups(s, fromSide);
        if (toBottom) {
          // The old split's lower pane: a group of its own at the bottom.
          const groups = s.dockGroups[toSide];
          groups.push({ id: uniqueGroupId(groups, panelId), panels: [panelId], active: panelId, collapsed: false, weight: 1 });
          commitGroups(s, toSide);
        } else {
          s.panelOrder[toSide] = [...(s.panelOrder[toSide] ?? []), panelId];
          syncSide(s, toSide);
        }
        bringForward(s, panelId);
      });
      getEventBus().emit('LayoutChanged', undefined);
    },

    movePanelToGroup: (panelId, groupId, index) => {
      set((s) => {
        const panel = s.panels[panelId];
        if (!panel) return;
        for (const side of DOCK_SIDES) syncSide(s, side);
        const target = locateGroup(s, groupId);
        if (!target) return;
        panel.placement = 'docked';
        s.externalPanels = s.externalPanels.filter((id) => id !== panelId);
        const fromSide = detach(s, panelId);
        // The target group survives a detach unless the panel was its only tab
        // (dropping a lone tab back onto its own strip), which is then a no-op.
        const into = s.dockGroups[target.side].find((g) => g.id === groupId);
        if (into) {
          const panels = [...into.panels];
          panels.splice(clamp(index ?? panels.length, 0, panels.length), 0, panelId);
          into.panels = panels;
          into.active = panelId;
          into.collapsed = false;
        } else {
          s.dockGroups[target.side].splice(target.index, 0, { ...target.group, panels: [panelId], active: panelId, collapsed: false });
        }
        if (fromSide && fromSide !== target.side) commitGroups(s, fromSide);
        commitGroups(s, target.side);
        s.activePanelByRegion[target.side] = panelId;
        s.regions[target.side].collapsed = false;
      });
      getEventBus().emit('LayoutChanged', undefined);
    },

    movePanelToNewGroup: (panelId, side, index) => {
      set((s) => {
        const panel = s.panels[panelId];
        if (!panel) return;
        for (const sd of DOCK_SIDES) syncSide(s, sd);
        panel.placement = 'docked';
        s.externalPanels = s.externalPanels.filter((id) => id !== panelId);
        // The insertion index is a position BETWEEN the column's groups as the
        // user saw them, so it is counted before the panel's own group can
        // vanish (a lone tab dragged to a gap elsewhere).
        const before = s.dockGroups[side].slice(0, Math.max(0, index));
        const lostAbove = before.filter((g) => g.panels.length === 1 && g.panels[0] === panelId).length;
        const fromSide = detach(s, panelId);
        const groups = s.dockGroups[side];
        const at = clamp(index - lostAbove, 0, groups.length);
        groups.splice(at, 0, { id: uniqueGroupId(groups, panelId), panels: [panelId], active: panelId, collapsed: false, weight: 1 });
        if (fromSide && fromSide !== side) commitGroups(s, fromSide);
        commitGroups(s, side);
        s.activePanelByRegion[side] = panelId;
        s.regions[side].collapsed = false;
      });
      getEventBus().emit('LayoutChanged', undefined);
    },

    setGroupActive: (groupId, panelId) =>
      set((s) => {
        const at = locateGroup(s, groupId);
        if (!at || !at.group.panels.includes(panelId)) return;
        at.group.active = panelId;
        at.group.collapsed = false;
        s.activePanelByRegion[at.side] = panelId;
        s.regions[at.side].collapsed = false;
      }),

    setGroupCollapsed: (groupId, collapsed) =>
      set((s) => {
        const at = locateGroup(s, groupId);
        if (!at) return;
        at.group.collapsed = collapsed;
      }),

    toggleGroupCollapsed: (groupId) =>
      set((s) => {
        const at = locateGroup(s, groupId);
        if (!at) return;
        at.group.collapsed = !at.group.collapsed;
      }),

    closeGroup: (groupId) =>
      set((s) => {
        const at = locateGroup(s, groupId);
        if (!at) return;
        const closing = at.group.panels.filter((id) => s.panels[id]?.closable !== false);
        if (closing.length === 0) return;
        s.panelOrder[at.side] = (s.panelOrder[at.side] ?? []).filter((id) => !closing.includes(id));
        s.externalPanels = s.externalPanels.filter((id) => !closing.includes(id));
        if (closing.includes(s.activePanelByRegion[at.side] ?? '')) delete s.activePanelByRegion[at.side];
        syncSide(s, at.side);
        for (const panelId of closing) getEventBus().emit('PanelClosed', { panelId });
      }),

    mergeGroupUp: (groupId) =>
      set((s) => {
        const at = locateGroup(s, groupId);
        if (!at || at.index === 0) return;
        const groups = s.dockGroups[at.side];
        const above = groups[at.index - 1]!;
        above.panels = [...above.panels, ...at.group.panels];
        above.active = at.group.active ?? above.active;
        above.collapsed = above.collapsed && at.group.collapsed;
        groups.splice(at.index, 1);
        commitGroups(s, at.side);
      }),

    setGroupWeights: (side, weights) =>
      set((s) => {
        for (const g of s.dockGroups[side]) {
          const w = weights[g.id];
          if (typeof w === 'number' && Number.isFinite(w) && w > 0) g.weight = w;
        }
        normalizeWeights(s.dockGroups[side]);
      }),

    dockPanel: (panelId, toRegion) =>
      set((s) => {
        const panel = s.panels[panelId];
        if (!panel) return;
        const targetRegion = toRegion ?? panel.homeRegion ?? 'leftSidebar';
        panel.placement = 'docked';
        s.externalPanels = s.externalPanels.filter((id) => id !== panelId);
        const toSide = sideOfRegion(targetRegion);
        if (!toSide) {
          panel.region = targetRegion;
          if (!s.panelOrder[targetRegion]) s.panelOrder[targetRegion] = [];
          if (!s.panelOrder[targetRegion].includes(panelId)) s.panelOrder[targetRegion].push(panelId);
          s.activePanelByRegion[targetRegion] = panelId;
          getEventBus().emit('LayoutChanged', undefined);
          return;
        }
        // Docked on the other side already: it moves, it is not duplicated.
        for (const side of DOCK_SIDES) {
          if (side === toSide) continue;
          if (sideMembers(s, side).includes(panelId)) {
            s.panelOrder[side] = (s.panelOrder[side] ?? []).filter((id) => id !== panelId);
            s.panelOrder[bottomRegionOf(side)] = (s.panelOrder[bottomRegionOf(side)] ?? []).filter((id) => id !== panelId);
            syncSide(s, side);
          }
        }
        panel.region = toSide;
        if (!sideMembers(s, toSide).includes(panelId)) s.panelOrder[toSide] = [...(s.panelOrder[toSide] ?? []), panelId];
        syncSide(s, toSide);
        bringForward(s, panelId);
        getEventBus().emit('LayoutChanged', undefined);
      }),

    // No `monitorId` parameter: nothing enumerates monitors, so every caller
    // passed undefined and the field could only ever be set by hand-editing an
    // imported workspace. Multi-monitor targeting is not a feature here.
    popoutPanel: (panelId) =>
      set((s) => {
        const panel = s.panels[panelId];
        if (!panel) return;
        panel.placement = 'external';
        if (!s.externalPanels.includes(panelId)) {
          s.externalPanels.push(panelId);
        }
        getEventBus().emit('LayoutChanged', undefined);
      }),

    setRegionSize: (region, size) =>
      set((s) => {
        const r = s.regions[region];
        if (!r) return;
        const collapsedThreshold = region === 'bottomTimeline' ? 60 : SIDEBAR_DRAG_OPEN_THRESHOLD;
        if (r.collapsed && size > collapsedThreshold) {
          r.collapsed = false;
        }
        r.size = clamp(size, r.minSize, r.maxSize);
        getEventBus().emit('PanelResized', { panelId: region, size: r.size });
      }),

    toggleRegion: (region) =>
      set((s) => {
        const r = s.regions[region];
        if (!r) return;
        r.collapsed = !r.collapsed;
        getEventBus().emit('PanelResized', { panelId: region, size: r.size });
      }),

    setCollapsed: (region, collapsed) =>
      set((s) => {
        if (s.regions[region]) {
          s.regions[region].collapsed = collapsed;
        }
      }),

    setFocusMode: (mode) =>
      set((s) => {
        const leaving = mode === 'none' || mode === s.focusMode;
        if (leaving) {
          if (s.focusMode === 'none') return; // nothing to leave
          for (const region of FOCUS_MODE_REGIONS) {
            const was = s.focusModeRestore?.[region];
            if (typeof was === 'boolean') s.regions[region].collapsed = was;
          }
          s.focusMode = 'none';
          s.focusModeRestore = null;
        } else {
          // Snapshot only on the way IN from `none`: switching between the two
          // modes keeps the original snapshot, or the second toggle would
          // "restore" to the first mode's already-collapsed layout.
          if (s.focusMode === 'none') {
            const snap: Partial<Record<RegionId, boolean>> = {};
            for (const region of FOCUS_MODE_REGIONS) snap[region] = s.regions[region].collapsed;
            s.focusModeRestore = snap;
          }
          for (const region of FOCUS_MODE_REGIONS) {
            s.regions[region].collapsed = focusModeCollapses(mode, region)
              ? true
              : (s.focusModeRestore?.[region] ?? s.regions[region].collapsed);
          }
          s.focusMode = mode;
        }
        for (const region of FOCUS_MODE_REGIONS) {
          getEventBus().emit('PanelResized', { panelId: region, size: s.regions[region].size });
        }
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
          s.panelOrder = {
            leftSidebar: [],
            leftSidebar_bottom: [],
            rightInspector: [],
            rightInspector_bottom: [],
            centerWorkspace: [],
            bottomTimeline: [],
          };
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

        // The groups: the workspace's own when it saved them; otherwise the
        // default grouping for its lists (a saved `_bottom` list — the old
        // split — becomes a group of its own), with the group of the
        // workspace's active panel open, so Color still opens on Scopes.
        if (layout.panelOrder || layout.dockGroups) {
          for (const side of DOCK_SIDES) {
            const given = layout.dockGroups?.[side] ? sanitizeGroupList(layout.dockGroups[side]) : null;
            if (given) {
              s.dockGroups[side] = given;
              if (!layout.panelOrder) s.panelOrder[side] = flattenGroups(given);
              syncSide(s, side);
              continue;
            }
            if (!layout.panelOrder) continue;
            s.dockGroups[side] = legacySplitGroups(
              side,
              [...new Set(s.panelOrder[side] ?? [])],
              [...new Set(s.panelOrder[bottomRegionOf(side)] ?? [])],
            );
            syncSide(s, side);
            const front = layout.activePanelByRegion?.[side];
            const g = front ? groupOfPanel(s.dockGroups[side], front) : undefined;
            if (g && front) {
              g.active = front;
              g.collapsed = false;
            }
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
        // Fresh-session groups: the policy rebuilds them as the panels are
        // re-docked below, with nothing carried over from the old stack.
        s.dockGroups = emptyDockGroups();
        _legacyExpanded = new Set();
        s.panelOrder = {
          leftSidebar: [],
          leftSidebar_bottom: [],
          rightInspector: [],
          rightInspector_bottom: [],
          centerWorkspace: [],
          bottomTimeline: [],
        };
        for (const p of Object.values(s.panels)) {
          const home = p.homeRegion ?? (p.region.startsWith('leftSidebar') ? 'leftSidebar' : p.region.startsWith('rightInspector') ? 'rightInspector' : p.region);
          p.region = home;
          // "Reset" means the fresh-session layout, and a fresh session does not
          // dock on-demand panels — they come back from the menu or the "+".
          if (p.onDemand) continue;
          if (!s.panelOrder[home]) s.panelOrder[home] = [];
          if (!s.panelOrder[home].includes(p.id)) {
            s.panelOrder[home].push(p.id);
          }
          if (!s.activePanelByRegion[home]) {
            s.activePanelByRegion[home] = p.id;
          }
        }
        for (const side of DOCK_SIDES) syncSide(s, side);
        try {
          localStorage.removeItem(LAYOUT_PERSIST_KEY);
          // MUST stay lazy. A static import evaluates coreServices at module scope,
          // where getSettingsManager() throws because the app has not booted yet.
          // eslint-disable-next-line @typescript-eslint/no-require-imports
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
    // MUST stay lazy. A static import evaluates coreServices at module scope,
    // where getSettingsManager() throws because the app has not booted yet.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getSettingsManager } = require('@core/services/coreServices') as typeof import('@core/services/coreServices');
    getSettingsManager().set(PANEL_ORDER_SETTINGS_KEY, state.panelOrder);
  } catch {
    /* SettingsManager not yet booted — safe to ignore on first render */
  }
});

// Persist the full layout (regions, panelOrder, activePanelByRegion, dock groups) to
// localStorage so the workspace survives page refresh / Electron restart.
let _lastLayoutSig = '';
let _saveLayoutTimer: ReturnType<typeof setTimeout> | null = null;
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
    g: state.dockGroups,
  });
  if (sig === _lastLayoutSig) return;
  _lastLayoutSig = sig;
  if (_saveLayoutTimer !== null) clearTimeout(_saveLayoutTimer);
  _saveLayoutTimer = setTimeout(() => {
    _saveLayoutTimer = null;
    saveLayout(
      state.regions,
      state.panelOrder,
      state.activePanelByRegion,
      state.leftSidebarPosition,
      state.rightInspectorPosition,
      state.timelinePosition,
      state.dockGroups,
    );
  }, 250);
});

export const usePanel = (panelId: string): PanelRegistration | undefined =>
  useLayoutStore((s) => s.panels[panelId]);

