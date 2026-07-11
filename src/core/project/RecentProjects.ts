/**
 * RecentProjects — a persisted, bounded MRU list of opened projects.
 * Backed by SettingsManager so it survives restarts and stays swappable.
 */

import type { SettingsManager } from '@core/settings/SettingsManager';

export interface RecentProjectEntry {
  id: string;
  name: string;
  path: string | null;
  /** Epoch ms of last open. Injected by the caller (no clock in this module). */
  openedAt: number;
}

const KEY = 'project.recent';

export class RecentProjects {
  constructor(
    private readonly settings: SettingsManager,
    private readonly max = 10,
  ) {}

  list(): RecentProjectEntry[] {
    return this.settings.get<RecentProjectEntry[]>(KEY, []);
  }

  add(entry: RecentProjectEntry): void {
    const existing = this.list().filter((e) => e.id !== entry.id);
    const next = [entry, ...existing].slice(0, this.max);
    this.settings.set(KEY, next);
  }

  remove(id: string): void {
    this.settings.set(KEY, this.list().filter((e) => e.id !== id));
  }

  clear(): void {
    this.settings.set(KEY, []);
  }

  subscribe(listener: (list: RecentProjectEntry[]) => void): () => void {
    return this.settings.observe<RecentProjectEntry[]>(KEY, (v) => listener(v ?? []));
  }
}
