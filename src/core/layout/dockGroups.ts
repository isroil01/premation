/**
 * Dock groups — how a sidebar column is divided into After Effects panel groups.
 *
 * A sidebar is a COLUMN of groups stacked top to bottom; a group is a TAB STRIP
 * with one panel in front. That one model covers both ways people organise
 * After Effects' right column, at the same time:
 *
 *   • tabs     several panels in one group, one at a time (Info | Audio);
 *   • stacked  several groups one above the other, each open or collapsed to
 *              its strip (Properties over Preview over Effects & Presets).
 *
 * It replaces a per-side "tabs OR stack" chrome and the fixed two-pane split,
 * which could each express only one of the two (2026-10 review: "why can't the
 * user organise vertically at the same time as tabs").
 *
 * ## Membership is still `panelOrder`
 *
 * `layoutStore.panelOrder[side]` remains the list of panels docked on a side —
 * the Window menu, the workspaces and the "+" read it, and tests seed it
 * directly. The groups only PARTITION that list. `reconcileGroups` keeps the two
 * agreeing: a group panel no longer docked drops out, an empty group goes, and
 * a docked panel no group holds is placed by `placePanel`'s policy. The store
 * writes `panelOrder[side]` back as the groups flattened, so the order a menu
 * sees is the order on screen.
 *
 * Pure functions over plain data: the store calls them inside its immer
 * recipes, and the dock calls `reconcileGroups` at render for a state some
 * caller seeded without groups.
 */

export type DockSide = 'leftSidebar' | 'rightInspector';

export const DOCK_SIDES: readonly DockSide[] = ['leftSidebar', 'rightInspector'];

export interface DockGroupState {
  /** Stable id: the React key, the resize and drop target. */
  id: string;
  /** The group's tabs, in strip order. */
  panels: string[];
  /** The tab in front — one of `panels` once reconciled. */
  active: string | null;
  /** Minimised to its tab strip, the way a stacked panel collapses in AE. */
  collapsed: boolean;
  /**
   * The group's share of the column's free height among the EXPANDED groups
   * (its flex-grow). Kept on a scale where an average group is 1, so a group
   * that opens later with the default weight gets an average share.
   */
  weight: number;
}

export type DockGroups = Record<DockSide, DockGroupState[]>;

export function emptyDockGroups(): DockGroups {
  return { leftSidebar: [], rightInspector: [] };
}

/** The legacy second pane of a side — the old split's bottom region. */
export function bottomRegionOf(side: DockSide): 'leftSidebar_bottom' | 'rightInspector_bottom' {
  return side === 'leftSidebar' ? 'leftSidebar_bottom' : 'rightInspector_bottom';
}

/** The side a region belongs to; null for the timeline and the workspace. */
export function sideOfRegion(region: string): DockSide | null {
  if (region.startsWith('leftSidebar')) return 'leftSidebar';
  if (region.startsWith('rightInspector')) return 'rightInspector';
  return null;
}

/**
 * Panels that share a group by default. After Effects' Default workspace keeps
 * Info and Audio as two tabs of one group, and Character and Paragraph of
 * another; every other panel of the right column is a group of its own.
 */
const DEFAULT_GROUP_KEY: Readonly<Record<string, string>> = {
  info: 'info-audio',
  audio: 'info-audio',
  character: 'type',
  paragraph: 'type',
};

/** Default height shares. Properties three to one, as the old stack had it. */
const DEFAULT_WEIGHT: Readonly<Record<string, number>> = {
  properties: 3,
};

export const MIN_GROUP_WEIGHT = 0.05;

/** `g-<seed>`, suffixed until no group in `groups` has it. */
export function uniqueGroupId(groups: ReadonlyArray<DockGroupState>, seed: string): string {
  const taken = new Set(groups.map((g) => g.id));
  const base = `g-${seed}`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`;
    if (!taken.has(id)) return id;
  }
}

export interface PlaceOptions {
  /**
   * Whether a NEW group made for the panel opens expanded. Default: only the
   * side's first group does on the right (AE's Default column — Properties
   * open, the rest collapsed to their strips); the left side always joins its
   * first group, so the question never arises there.
   */
  expand?: boolean;
}

/**
 * Put a panel no group holds into `groups` (MUTATES the array and the group it
 * joins — call it on fresh copies). Returns the group it landed in.
 *
 * Policy, in order:
 *   1. a default companion is already docked (Audio beside Info) → join it;
 *   2. the left sidebar → join its first group (Project · Effect Controls ·
 *      Layers are tabs of one group, as in AE);
 *   3. the right column → a group of its own at the bottom.
 */
export function placePanel(
  side: DockSide,
  groups: DockGroupState[],
  panelId: string,
  opts: PlaceOptions = {},
): DockGroupState {
  const key = DEFAULT_GROUP_KEY[panelId];
  if (key) {
    const companion = groups.find((g) => g.panels.some((p) => p !== panelId && DEFAULT_GROUP_KEY[p] === key));
    if (companion) {
      companion.panels.push(panelId);
      if (!companion.active) companion.active = panelId;
      return companion;
    }
  }
  if (side === 'leftSidebar' && groups.length > 0) {
    const first = groups[0]!;
    first.panels.push(panelId);
    if (!first.active) first.active = panelId;
    return first;
  }
  const expand = opts.expand ?? groups.length === 0;
  const group: DockGroupState = {
    id: uniqueGroupId(groups, panelId),
    panels: [panelId],
    active: panelId,
    collapsed: !expand,
    weight: DEFAULT_WEIGHT[panelId] ?? 1,
  };
  groups.push(group);
  return group;
}

export interface ReconcileOptions {
  /** Expand the new group made for this panel (see `PlaceOptions.expand`). */
  expandNew?: (panelId: string, groups: ReadonlyArray<DockGroupState>) => boolean | undefined;
}

/**
 * Groups that cover exactly `members`, in `members`' order.
 *
 * `members` (the side's `panelOrder`) decides ORDER — of the tabs within a
 * group, and of the groups down the column (by each group's first tab) — so a
 * caller that writes `panelOrder` directly (a workspace, a test, an older code
 * path) is drawn in the order it wrote. The groups decide only the DIVISION and
 * each group's state: which panels share a strip, the front tab, collapsed,
 * weight. Panels that are not members (closed, moved away) drop out and groups
 * left empty go; a member no group holds is placed by `placePanel`. A panel
 * listed in two groups keeps its first. Returns fresh objects — the input is
 * not touched.
 */
export function reconcileGroups(
  side: DockSide,
  members: ReadonlyArray<string>,
  groups: ReadonlyArray<DockGroupState>,
  opts: ReconcileOptions = {},
): DockGroupState[] {
  const want = new Set(members);
  const placed = new Set<string>();
  const out: DockGroupState[] = [];
  for (const g of groups) {
    const panels: string[] = [];
    for (const id of g.panels) {
      if (!want.has(id) || placed.has(id)) continue;
      placed.add(id);
      panels.push(id);
    }
    if (panels.length === 0) continue;
    out.push({
      id: out.some((o) => o.id === g.id) ? uniqueGroupId(out, panels[0]!) : g.id,
      panels,
      active: g.active && panels.includes(g.active) ? g.active : panels[0]!,
      collapsed: g.collapsed === true,
      weight: Number.isFinite(g.weight) && g.weight > 0 ? g.weight : 1,
    });
  }
  for (const id of members) {
    if (placed.has(id)) continue;
    placed.add(id);
    placePanel(side, out, id, { expand: opts.expandNew?.(id, out) });
  }
  const rank = new Map<string, number>();
  members.forEach((id, i) => {
    if (!rank.has(id)) rank.set(id, i);
  });
  const at = (id: string): number => rank.get(id) ?? Number.MAX_SAFE_INTEGER;
  for (const g of out) g.panels.sort((a, b) => at(a) - at(b));
  out.sort((a, b) => at(a.panels[0]!) - at(b.panels[0]!));
  return out;
}

/** The side's panels in on-screen order. */
export function flattenGroups(groups: ReadonlyArray<DockGroupState>): string[] {
  return groups.flatMap((g) => g.panels);
}

/** The group holding `panelId`, if any. */
export function groupOfPanel<G extends DockGroupState>(groups: ReadonlyArray<G>, panelId: string): G | undefined {
  return groups.find((g) => g.panels.includes(panelId));
}

/**
 * Rescale the expanded groups' weights so their mean is 1, keeping their
 * ratios — called after a resize writes pixel heights in as weights, so a group
 * opened later with the default weight of 1 still gets an average share
 * instead of a sliver beside groups weighted in hundreds.
 */
export function normalizeWeights(groups: DockGroupState[]): void {
  const open = groups.filter((g) => !g.collapsed);
  if (open.length === 0) return;
  const mean = open.reduce((sum, g) => sum + g.weight, 0) / open.length;
  if (!(mean > 0)) return;
  for (const g of open) g.weight = Math.max(MIN_GROUP_WEIGHT, g.weight / mean);
}

/**
 * Groups for a layout saved before groups existed: the old split's top and
 * bottom panes each become the groups the policy would give them, top first.
 * Returns an empty list when there is no bottom pane (the policy builds the
 * groups as the panels register).
 */
export function legacySplitGroups(
  side: DockSide,
  top: ReadonlyArray<string>,
  bottom: ReadonlyArray<string>,
): DockGroupState[] {
  if (bottom.length === 0) return [];
  const upper = reconcileGroups(side, top, []);
  // The bottom pane's first group starts a new stack of its own on the left
  // too — it was a separate pane, not more tabs of the top one.
  const lower: DockGroupState[] = [];
  for (const id of bottom) {
    if (side === 'leftSidebar' && lower.length > 0) {
      lower[0]!.panels.push(id);
      continue;
    }
    placePanel('rightInspector', lower, id, { expand: lower.length === 0 });
  }
  const out = [...upper];
  for (const g of lower) out.push({ ...g, id: uniqueGroupId(out, g.panels[0]!) });
  return out;
}

/** A persisted / imported group list, or null when it is not one. */
export function sanitizeGroupList(raw: unknown): DockGroupState[] | null {
  if (!Array.isArray(raw)) return null;
  const out: DockGroupState[] = [];
  for (const g of raw) {
    if (!g || typeof g !== 'object') continue;
    const r = g as Partial<Record<keyof DockGroupState, unknown>>;
    const panels = Array.isArray(r.panels) ? r.panels.filter((p): p is string => typeof p === 'string') : [];
    if (panels.length === 0) continue;
    const id = typeof r.id === 'string' && r.id.length > 0 && !out.some((o) => o.id === r.id) ? r.id : uniqueGroupId(out, panels[0]!);
    out.push({
      id,
      panels,
      active: typeof r.active === 'string' && panels.includes(r.active) ? r.active : panels[0]!,
      collapsed: r.collapsed === true,
      weight: typeof r.weight === 'number' && Number.isFinite(r.weight) && r.weight > 0 ? r.weight : 1,
    });
  }
  return out;
}

/** Both sides of a persisted value; a side that is not a list comes back null. */
export function sanitizeDockGroups(raw: unknown): Partial<Record<DockSide, DockGroupState[]>> | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<Record<DockSide, unknown>>;
  const out: Partial<Record<DockSide, DockGroupState[]>> = {};
  for (const side of DOCK_SIDES) {
    const list = sanitizeGroupList(r[side]);
    if (list) out[side] = list;
  }
  return out;
}
