/**
 * AutosaveController — writes a crash-recovery snapshot on a fixed interval
 * (spec: "Autosave every 60 seconds, invisible and non-blocking").
 *
 * It only writes when the document is dirty, so a quiet session costs nothing.
 * It also flushes when the tab is hidden or the window is closing, so a crash
 * loses at most the last few seconds. Autosave protects against data loss; it
 * does NOT clear the unsaved indicator — that's reserved for an explicit Save.
 */

import { captureRecovery, persistRecovery } from './recovery';

export interface AutosaveOptions {
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

export class AutosaveController {
  private timer: ReturnType<typeof setInterval> | null = null;
  private opts: AutosaveOptions | null = null;
  private readonly onHide = (): void => { if (document.hidden) this.flush(); };
  private readonly onUnload = (): void => this.flush();

  start(opts: AutosaveOptions): void {
    this.stop();
    this.opts = opts;
    const ms = opts.intervalMs ?? 60_000;
    this.timer = setInterval(() => this.flush(), ms);
    document.addEventListener('visibilitychange', this.onHide);
    window.addEventListener('beforeunload', this.onUnload);
  }

  /** Capture + persist a snapshot now, if dirty. Non-blocking, best-effort. */
  flush(): void {
    const o = this.opts;
    if (!o || !o.isDirty()) return;
    try {
      const snap = captureRecovery(o.getTime());
      snap.savedAt = o.now();
      persistRecovery(snap);
      o.onSaved?.(snap.savedAt);
    } catch {
      /* autosave must never throw into the app */
    }
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    document.removeEventListener('visibilitychange', this.onHide);
    window.removeEventListener('beforeunload', this.onUnload);
    this.opts = null;
  }
}

let instance: AutosaveController | null = null;
export function getAutosaveController(): AutosaveController {
  if (!instance) instance = new AutosaveController();
  return instance;
}
