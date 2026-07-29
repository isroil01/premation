/**
 * Project library store — the user's cloud projects (motion-back), used by the
 * Dashboard. Distinct from `projectStore`, which manages open editor tabs. This
 * is the list-of-saved-projects layer over `api.listProjects/createProject/
 * deleteProject`.
 *
 * The list is a PAGE, not the library: search, orientation and paging all go to
 * the server, because a client that holds 24 of 143 projects cannot filter,
 * sort or count the other 119. Anything derived from `projects` describes what
 * is on screen; anything about the library as a whole comes from `total`.
 */

import { create } from 'zustand';
import { api, type ProjectSummary } from '@core/api/client';

/** Default rows per page. The user can change it from the page control. */
export const DEFAULT_PAGE_SIZE = 24;

export type OrientationFilter = 'all' | 'landscape' | 'portrait' | 'square';

/** The part of the state that defines *which* rows — i.e. what to refetch on. */
export interface LibraryQuery {
  query: string;
  orientation: OrientationFilter;
  limit: number;
  offset: number;
}

interface LibraryState extends LibraryQuery {
  projects: ProjectSummary[];
  /** Projects matching the current query, ignoring paging. */
  total: number;
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** A request is in flight; the previous page stays on screen meanwhile. */
  busy: boolean;
  error: string | null;
}

interface LibraryActions {
  /**
   * Change the query and/or page, then fetch.
   *
   * Changing the search or the filter resets to page 1 — page 4 of the previous
   * query is a different set of projects and would look like a random jump.
   */
  load: (patch?: Partial<LibraryQuery>) => Promise<void>;
  /** Refetch exactly what is on screen (after a create, delete or restore). */
  refresh: () => Promise<void>;
  create: (name: string, document?: unknown) => Promise<ProjectSummary>;
  remove: (id: string) => Promise<void>;
  /** Bulk delete — one refetch at the end, not one per project. */
  removeMany: (ids: Iterable<string>) => Promise<void>;
}

/**
 * Only the newest fetch may write. Pages and keystrokes both outrun the
 * network, and an out-of-order response would show the wrong page under the
 * right label.
 */
let seq = 0;

export const useProjectLibrary = create<LibraryState & LibraryActions>((set, get) => ({
  projects: [],
  total: 0,
  query: '',
  orientation: 'all',
  limit: DEFAULT_PAGE_SIZE,
  offset: 0,
  status: 'idle',
  busy: false,
  error: null,

  load: async (patch = {}) => {
    const prev = get();
    const changesQuery =
      (patch.query !== undefined && patch.query !== prev.query) ||
      (patch.orientation !== undefined && patch.orientation !== prev.orientation);

    const next: LibraryQuery = {
      query: patch.query ?? prev.query,
      orientation: patch.orientation ?? prev.orientation,
      limit: patch.limit ?? prev.limit,
      offset: patch.offset ?? (changesQuery ? 0 : prev.offset),
    };

    const ticket = ++seq;
    set({
      ...next,
      busy: true,
      error: null,
      // Only blank the table when there is nothing to keep showing.
      status: prev.status === 'ready' ? 'ready' : 'loading',
    });

    try {
      const page = await api.listProjects({
        limit: next.limit,
        offset: next.offset,
        q: next.query || undefined,
        orientation: next.orientation === 'all' ? undefined : next.orientation,
      });
      if (ticket !== seq) return;

      // The page can outlive its rows — deleting the last project on page 6
      // leaves an offset past the end. Step back instead of showing an empty
      // table under a "…of 143" label.
      if (page.items.length === 0 && next.offset > 0 && page.total > 0) {
        const lastOffset = Math.max(0, (Math.ceil(page.total / next.limit) - 1) * next.limit);
        if (lastOffset !== next.offset) {
          await get().load({ offset: lastOffset });
          return;
        }
      }

      set({ projects: page.items, total: page.total, status: 'ready', busy: false });
    } catch (err) {
      if (ticket !== seq) return;
      set({
        status: 'error',
        busy: false,
        error: (err as Error).message || 'Could not load projects',
      });
    }
  },

  refresh: async () => {
    await get().load();
  },

  create: async (name, document?: unknown) => {
    const record = await api.createProject(name.trim() || 'Untitled', document);
    // The new project belongs at the top of page 1 by `updatedAt`, but the page
    // on screen may be page 4 of a search it doesn't match. Count it, then let
    // a refetch decide whether it is actually visible from here.
    set({ total: get().total + 1 });
    void get().refresh();
    return record;
  },

  remove: async (id) => {
    await api.deleteProject(id);
    // Drop it now so the row disappears on click, then refill the page from the
    // server — otherwise a page of 24 becomes 23 while 119 projects wait behind it.
    set({
      projects: get().projects.filter((p) => p.id !== id),
      total: Math.max(0, get().total - 1),
    });
    await get().refresh();
  },

  removeMany: async (ids) => {
    const list = [...ids];
    if (list.length === 0) return;
    const done = new Set<string>();
    for (const id of list) {
      try {
        await api.deleteProject(id);
        done.add(id);
      } catch {
        /* keep going — one failure shouldn't strand the rest of the selection */
      }
    }
    set({
      projects: get().projects.filter((p) => !done.has(p.id)),
      total: Math.max(0, get().total - done.size),
    });
    await get().refresh();
  },
}));
