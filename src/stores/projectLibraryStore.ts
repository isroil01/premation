/**
 * Project library store — the user's cloud projects (motion-back), used by the
 * Dashboard. Distinct from `projectStore`, which manages open editor tabs. This
 * is the list-of-saved-projects layer over `api.listProjects/createProject/
 * deleteProject`.
 */

import { create } from 'zustand';
import { api, type ProjectSummary } from '@core/api/client';

/** How many projects a page holds. */
const PAGE_SIZE = 24;

interface LibraryState {
  projects: ProjectSummary[];
  /** Projects matching the current search, ignoring paging. */
  total: number;
  /** The search this list reflects — so the UI can't mislabel what it shows. */
  query: string;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
}

interface LibraryActions {
  /** Load the first page. Searching is server-side; see `load`. */
  load: (query?: string) => Promise<void>;
  /** Append the next page. No-op when everything is already shown. */
  loadMore: () => Promise<void>;
  create: (name: string, document?: unknown) => Promise<ProjectSummary>;
  remove: (id: string) => Promise<void>;
}

export const useProjectLibrary = create<LibraryState & LibraryActions>((set, get) => ({
  projects: [],
  total: 0,
  query: '',
  status: 'idle',
  error: null,

  /**
   * First page for a search.
   *
   * The query goes to the server. Filtering in the browser only worked while
   * the whole library was sent every time; with paging it would quietly become
   * "search the projects that happen to be loaded".
   */
  load: async (query = '') => {
    set({ status: 'loading', error: null, query });
    try {
      const page = await api.listProjects({ limit: PAGE_SIZE, q: query || undefined });
      set({ projects: page.items, total: page.total, status: 'ready' });
    } catch (err) {
      set({ status: 'error', error: (err as Error).message || 'Could not load projects' });
    }
  },

  loadMore: async () => {
    const { projects, total, query, status } = get();
    if (status === 'loading' || projects.length >= total) return;
    set({ status: 'loading' });
    try {
      const page = await api.listProjects({
        limit: PAGE_SIZE,
        offset: projects.length,
        q: query || undefined,
      });
      set({ projects: [...get().projects, ...page.items], total: page.total, status: 'ready' });
    } catch (err) {
      set({ status: 'error', error: (err as Error).message || 'Could not load more projects' });
    }
  },

  create: async (name, document?: unknown) => {
    const record = await api.createProject(name.trim() || 'Untitled', document);
    // Prepend so the newest project shows first (matches the API's ordering).
    set({ projects: [record, ...get().projects], total: get().total + 1 });
    return record;
  },

  remove: async (id) => {
    await api.deleteProject(id);
    set({
      projects: get().projects.filter((p) => p.id !== id),
      total: Math.max(0, get().total - 1),
    });
  },
}));
