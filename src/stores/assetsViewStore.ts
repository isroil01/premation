/**
 * assetsViewStore — how the Assets panel is LOOKED AT, kept apart from what
 * it holds.
 *
 * View mode (list / grid), the sort column, the active filters, which sub-tab
 * (the project bin or the on-disk media browser) and the browsed folders are
 * all statements about the person using the panel, not about the project —
 * the same argument `preferenceStore` makes for `effectFavorites`. They live
 * in their own small store rather than in the preference store because they
 * change dozens of times a session and none of them warrants a Preferences
 * dialog row; and they persist to localStorage because a panel that forgets
 * you switched it to grid view every reload is a panel you stop switching.
 *
 * Everything here is UI state. Nothing in it is read by the renderer, the
 * document, or the bundle.
 */

import { create } from 'zustand';

export type AssetsViewMode = 'list' | 'grid';
export type AssetSortKey = 'name' | 'type' | 'size' | 'date' | 'used';
export type SortDir = 'asc' | 'desc';
export type AssetTypeFilter = 'all' | 'image' | 'video' | 'audio';
export type AssetsTab = 'bin' | 'browse';

export interface AssetsViewState {
  view: AssetsViewMode;
  sortKey: AssetSortKey;
  sortDir: SortDir;
  /** Only assets no layer references. */
  unusedOnly: boolean;
  typeFilter: AssetTypeFilter;
  /** One tag, or null for any. */
  tagFilter: string | null;
  /** A `LABEL_COLORS` id, or null for any. */
  labelFilter: string | null;
  tab: AssetsTab;
  /**
   * The folders the Media Browser tab lists, per project (`browseKey`): each
   * project shows the folders added while it was open, so one project's
   * footage folders do not appear in another's. Desktop only.
   */
  browseRoots: Record<string, string[]>;
  /** Folders added in any project, newest first — the Add Folder menu's one-click list. */
  recentBrowseFolders: string[];
  /** The metadata drawer under the list. */
  drawerOpen: boolean;
}

interface AssetsViewActions {
  setView: (view: AssetsViewMode) => void;
  toggleView: () => void;
  /** Click a column: same column flips direction, a new column starts ascending. */
  sortBy: (key: AssetSortKey) => void;
  setSort: (key: AssetSortKey, dir: SortDir) => void;
  setUnusedOnly: (on: boolean) => void;
  setTypeFilter: (type: AssetTypeFilter) => void;
  setTagFilter: (tag: string | null) => void;
  setLabelFilter: (label: string | null) => void;
  clearFilters: () => void;
  setTab: (tab: AssetsTab) => void;
  /** Add a folder to `project`'s Media Browser (no-op when it is already there). */
  addBrowseRoot: (project: string, root: string) => void;
  removeBrowseRoot: (project: string, root: string) => void;
  setDrawerOpen: (open: boolean) => void;
}

export type AssetsViewStore = AssetsViewState & AssetsViewActions;

const STORAGE_KEY = 'motion-editor.assetsView.v1';

export const DEFAULT_ASSETS_VIEW: AssetsViewState = {
  view: 'list',
  sortKey: 'name',
  sortDir: 'asc',
  unusedOnly: false,
  typeFilter: 'all',
  tagFilter: null,
  labelFilter: null,
  tab: 'bin',
  browseRoots: {},
  recentBrowseFolders: [],
  drawerOpen: true,
};

/** How many folders the Add Folder menu remembers. */
const RECENT_FOLDERS = 8;
/** How many projects keep their Media Browser folders (oldest dropped first). */
const MAX_PROJECTS = 200;

/** The `browseRoots` key for a project: its id, or one shared key for a project not yet created. */
export function browseKey(projectId: string | null | undefined): string {
  return projectId || '_unsaved';
}

/** Folder paths compared the way Windows and macOS file systems do: separator- and case-insensitive. */
const samePath = (a: string, b: string): boolean => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();

/** Which sort direction a click on `key` produces, given the current sort. */
export function nextSort(
  current: { sortKey: AssetSortKey; sortDir: SortDir },
  key: AssetSortKey,
): { sortKey: AssetSortKey; sortDir: SortDir } {
  if (current.sortKey === key) {
    return { sortKey: key, sortDir: current.sortDir === 'asc' ? 'desc' : 'asc' };
  }
  // Size, date and usage read best largest / newest / most-used first; a
  // name or type column starts A→Z the way every file manager does.
  return { sortKey: key, sortDir: key === 'size' || key === 'date' || key === 'used' ? 'desc' : 'asc' };
}

function load(): Partial<AssetsViewState> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<AssetsViewState>;
    // Only the keys this version knows, so a stale field from an older build
    // cannot smuggle in a value no reducer expects.
    const out: Partial<AssetsViewState> = {};
    for (const k of Object.keys(DEFAULT_ASSETS_VIEW) as Array<keyof AssetsViewState>) {
      if (k in parsed) (out as Record<string, unknown>)[k] = parsed[k];
    }
    // The single global folder of older builds becomes a recent folder: offered in every project, shown in none.
    const legacy = (parsed as { browseRoot?: unknown }).browseRoot;
    if (typeof legacy === 'string' && legacy && !out.recentBrowseFolders?.length) out.recentBrowseFolders = [legacy];
    return out;
  } catch {
    return {};
  }
}

function persist(state: AssetsViewState): void {
  try {
    const { view, sortKey, sortDir, unusedOnly, typeFilter, tagFilter, labelFilter, tab, browseRoots, recentBrowseFolders, drawerOpen } = state;
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ view, sortKey, sortDir, unusedOnly, typeFilter, tagFilter, labelFilter, tab, browseRoots, recentBrowseFolders, drawerOpen }),
    );
  } catch {
    /* storage full or unavailable — the session still works */
  }
}

export const useAssetsViewStore = create<AssetsViewStore>((set, get) => {
  const update = (patch: Partial<AssetsViewState>): void => {
    set(patch);
    persist(get());
  };
  return {
    ...DEFAULT_ASSETS_VIEW,
    ...load(),
    setView: (view) => update({ view }),
    toggleView: () => update({ view: get().view === 'list' ? 'grid' : 'list' }),
    sortBy: (key) => update(nextSort(get(), key)),
    setSort: (sortKey, sortDir) => update({ sortKey, sortDir }),
    setUnusedOnly: (unusedOnly) => update({ unusedOnly }),
    setTypeFilter: (typeFilter) => update({ typeFilter }),
    setTagFilter: (tagFilter) => update({ tagFilter }),
    setLabelFilter: (labelFilter) => update({ labelFilter }),
    clearFilters: () => update({ unusedOnly: false, typeFilter: 'all', tagFilter: null, labelFilter: null }),
    setTab: (tab) => update({ tab }),
    addBrowseRoot: (project, root) => {
      const { browseRoots, recentBrowseFolders } = get();
      const cur = browseRoots[project] ?? [];
      const recent = [root, ...recentBrowseFolders.filter((r) => !samePath(r, root))].slice(0, RECENT_FOLDERS);
      if (cur.some((r) => samePath(r, root))) {
        update({ recentBrowseFolders: recent });
        return;
      }
      // Re-inserted last, so the most recently used projects are the ones kept.
      const { [project]: _drop, ...rest } = browseRoots;
      const keys = Object.keys(rest);
      const kept = keys.length >= MAX_PROJECTS ? Object.fromEntries(keys.slice(keys.length - MAX_PROJECTS + 1).map((k) => [k, rest[k]!])) : rest;
      update({ browseRoots: { ...kept, [project]: [...cur, root] }, recentBrowseFolders: recent });
    },
    removeBrowseRoot: (project, root) => {
      const { browseRoots } = get();
      const next = (browseRoots[project] ?? []).filter((r) => !samePath(r, root));
      const { [project]: _drop, ...rest } = browseRoots;
      update({ browseRoots: next.length > 0 ? { ...rest, [project]: next } : rest });
    },
    setDrawerOpen: (drawerOpen) => update({ drawerOpen }),
  };
});

/** Test seam — back to defaults, storage cleared. */
export function resetAssetsViewForTest(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  useAssetsViewStore.setState({ ...DEFAULT_ASSETS_VIEW });
}
