/**
 * Local index row shapes.
 *
 * The `.motion` bundles on disk are the source of truth; the local index is a
 * rebuildable cache that answers the queries the dashboard/recents/recovery need
 * WITHOUT opening every bundle (and while offline). These are the row types the
 * index stores. They intentionally mirror the RFC's SQLite tables but are
 * storage-agnostic: the in-memory index (browser/tests) and the future
 * SQLite-backed index (Electron main) both speak these shapes.
 *
 * Nothing here is authoritative — every row is derivable by scanning bundles
 * (`deriveProjectFacts`), so the index can always be rebuilt if lost.
 */

/** One project in the registry — powers the dashboard grid + "Open Recent". */
export interface ProjectIndexRow {
  id: string;
  /** Absolute path to the `.motion` bundle directory. */
  bundlePath: string;
  name: string;
  /** Mirrored composition facts (avoid opening the bundle to show a card). */
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  layerCount: number;
  /** Local monotonic revision (bumped each save). */
  rev: number;
  /** epoch ms of last write. */
  updatedAt: number;
  /** epoch ms of last open, for recents ordering. */
  openedAt?: number;
  /** True when `bundlePath` no longer exists (moved/deleted on disk). */
  missing?: boolean;
  /**
   * Content hash of the project's card thumbnail in the app cache dir.
   * The SQLite adapter has persisted this column since day one — this field
   * is what finally lets a caller set it. Derived data, so absent is fine:
   * the card renders its facts and no image.
   */
  thumbHash?: string;
}

/** A crash-recovery snapshot on disk, indexed for the boot-time "Recover?" prompt. */
export interface RecoveryRow {
  projectId: string;
  /** Path to the recovery snapshot file. */
  snapshotPath: string;
  createdAt: number;
  rev?: number;
}
