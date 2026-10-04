/**
 * AutosaveController — writes a crash-recovery snapshot on a fixed interval
 * (spec: "Autosave every 60 seconds, invisible and non-blocking").
 *
 * It only writes when the document is dirty, so a quiet session costs nothing.
 * It also flushes when the tab is hidden or the window is closing, so a crash
 * loses at most the last few seconds. Autosave protects against data loss; it
 * does NOT clear the unsaved indicator — that's reserved for an explicit Save.
 *
 * ── Settings ─────────────────────────────────────────────────────────────
 * The interval is the user's (Preferences ▸ Files, `autosaveIntervalSec`);
 * `intervalMs` in the options is the fallback for a caller that boots before
 * the preference store, and the timer re-arms by itself when the preference
 * changes. Every successful write stamps `uiStore.lastAutosaveAt`, which the
 * status bar and the Files tab show, on top of whatever `onSaved` the caller
 * passed. How many snapshots are kept, and whether a copy also lands in a
 * folder, is `recovery.ts`'s business.
 *
 * ── Main-thread cost ─────────────────────────────────────────────────────
 * An interval tick waits for an idle period before capturing, and hands the
 * snapshot to the recovery worker, which serialises, compresses and skips an
 * unchanged document off the main thread. Only the window closing writes
 * synchronously, because nothing runs after it.
 */

export interface AutosaveOptions {
  /** Fallback interval when no preference is readable. */
  intervalMs?: number;
  /** Current playhead time (persisted so recovery restores the position). */
  getTime: () => number;
  /** Whether there are unsaved edits worth persisting. */
  isDirty: () => boolean;
  /** Wall-clock stamp (injected so the module stays testable). */
  now: () => number;
  /** Optional hook fired after each successful autosave. */
  onSaved?: (at: number) => void;
}

/** Bounds on the interval a preference can set — see the Files tab. */
export const AUTOSAVE_MIN_SEC = 10;
export const AUTOSAVE_MAX_SEC = 30 * 60;
export const AUTOSAVE_DEFAULT_SEC = 60;
