/**
 * The Media Browser's folder watches: the folders a window has on screen
 * (its added folders and every folder opened under them), watched one level
 * deep, and a change in any of them pushed back as the folder's path — so a
 * file saved, rendered or deleted on disk shows up without a Refresh click.
 *
 * Non-recursive `fs.watch` per folder (the tree is lazy: an unopened folder
 * is not on screen, so it is not watched), events debounced per batch, a cap
 * on how many folders one window may watch. Pure over its deps so the test
 * drives it without a disk.
 */

export interface DirWatchHandle {
  close(): void;
}

export interface DirWatchDeps {
  /** Watch one directory, non-recursively. Null when it cannot be watched. */
  watch(dir: string, onEvent: () => void): DirWatchHandle | null;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  emit(dirs: string[]): void;
}

/** Folders one window may watch at once — far more than fit on screen. */
export const MAX_WATCHED_DIRS = 256;
/** A render writing 300 frames is one refresh, not 300. */
export const DIR_EVENT_DEBOUNCE_MS = 250;

export class DirWatcher {
  private readonly watches = new Map<string, DirWatchHandle>();
  private readonly changed = new Set<string>();
  private timer: unknown = null;

  constructor(private readonly deps: DirWatchDeps) {}

  /** Replace the watched set. Folders that stay keep their watch. */
  setDirs(dirs: readonly string[]): void {
    const next = new Set(dirs.slice(0, MAX_WATCHED_DIRS));
    for (const [dir, h] of this.watches) {
      if (next.has(dir)) continue;
      h.close();
      this.watches.delete(dir);
      this.changed.delete(dir);
    }
    for (const dir of next) {
      if (this.watches.has(dir)) continue;
      const h = this.deps.watch(dir, () => this.noteChange(dir));
      if (h) this.watches.set(dir, h);
    }
  }

  watched(): string[] {
    return [...this.watches.keys()];
  }

  dispose(): void {
    for (const h of this.watches.values()) h.close();
    this.watches.clear();
    this.changed.clear();
    if (this.timer !== null) this.deps.clearTimeout(this.timer);
    this.timer = null;
  }

  private noteChange(dir: string): void {
    if (!this.watches.has(dir)) return;
    this.changed.add(dir);
    if (this.timer !== null) this.deps.clearTimeout(this.timer);
    this.timer = this.deps.setTimeout(() => {
      this.timer = null;
      const dirs = [...this.changed];
      this.changed.clear();
      if (dirs.length > 0) this.deps.emit(dirs);
    }, DIR_EVENT_DEBOUNCE_MS);
  }
}
