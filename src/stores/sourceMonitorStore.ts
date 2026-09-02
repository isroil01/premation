/**
 * Source monitor state — what the docked SOURCE viewer is showing, and the
 * in/out points marked on it.
 *
 * An NLE has two viewers: the PROGRAM (the comp, which this app calls the
 * viewport) and the SOURCE (one clip, before it is in the edit). This store is
 * the second one. It exists as a store rather than panel state for the same
 * reason `useLastFootagePreview` does — three separate surfaces address it:
 * the Assets panel's context menu, the footage preview dialog's "Open in Source
 * Monitor" button, and the panel itself. A viewer whose "show me this clip"
 * verb lives inside the viewer cannot be opened from anywhere else.
 *
 * ── Times are SOURCE seconds ────────────────────────────────────────────
 * `time`, `inPoint` and `outPoint` are offsets INTO THE FILE, not composition
 * time. That is the whole point of a source monitor: the range you mark travels
 * with the footage, so the same in/out means the same frames whichever comp
 * they are inserted into, at whatever playhead. Clip bars are frames (see
 * `Clip`), and the conversion happens at the moment of insert
 * (`sourceMonitorOps`), where the target comp's fps is known — never here,
 * because this store has no comp.
 *
 * ── Why `duration` lives here ───────────────────────────────────────────
 * Every clamp needs it, and it arrives LATE: an imported asset may carry no
 * probed duration at all (the browser import path fills in almost nothing), and
 * the real number shows up when the `<video>` element fires `loadedmetadata`.
 * So the store accepts marks against an unknown length (clamping only at zero)
 * and re-clamps everything once the length is learned. The alternative — the
 * panel clamping before it calls — puts the invariant in the caller, which is
 * where invariants go to be forgotten.
 */

import { create } from 'zustand';
import { useLayoutStore } from '@stores/layoutStore';
import type { ImportedAsset } from '@stores/assetStore';

export interface SourceMonitorState {
  /** The asset being viewed, or null when the monitor is empty. */
  assetId: string | null;
  /** Source length in seconds. 0 means "not known yet" — see the header. */
  duration: number;
  /** Playhead, in SOURCE seconds. */
  time: number;
  /** Marked in/out, in SOURCE seconds. null = not marked. */
  inPoint: number | null;
  outPoint: number | null;
  /** Whether the monitor's own transport is running (never the comp's). */
  playing: boolean;

  /** Show an asset. Re-opening the SAME asset keeps its marks and playhead. */
  open(assetId: string, durationSeconds?: number): void;
  /** Empty the monitor. */
  close(): void;
  /** Learn (or correct) the source length and re-clamp everything to it. */
  setDuration(seconds: number): void;
  setTime(seconds: number): void;
  setPlaying(playing: boolean): void;
  togglePlay(): void;
  /** Mark in at `seconds`, or at the current time when omitted. */
  setIn(seconds?: number): void;
  /** Mark out at `seconds`, or at the current time when omitted. */
  setOut(seconds?: number): void;
  clearInOut(): void;
}

/**
 * Clamp a source time into `[0, duration]`.
 *
 * A duration of 0 means "unknown", not "empty": marks are still accepted and
 * clamped at zero only, then re-clamped by {@link SourceMonitorState.setDuration}
 * once the real length arrives. Non-finite input lands at 0 rather than
 * poisoning every later comparison with NaN.
 */
export function clampSourceTime(seconds: number, duration: number): number {
  if (!Number.isFinite(seconds)) return 0;
  const t = Math.max(0, seconds);
  return duration > 0 ? Math.min(t, duration) : t;
}

/**
 * The range the action buttons act on: the marks when they exist, otherwise the
 * whole clip. Returns null when there is nothing usable — no length known and
 * no out point, or a degenerate (zero-length) range.
 *
 * Exported and pure so the panel, the ops and the tests all agree on what
 * "the marked range" means. It was briefly computed inline in the panel, which
 * is how "Insert" and "New comp from range" came to disagree about an
 * unmarked clip.
 */
export function sourceRange(
  s: Pick<SourceMonitorState, 'duration' | 'inPoint' | 'outPoint'>,
): { inSec: number; outSec: number } | null {
  const inSec = s.inPoint ?? 0;
  const outSec = s.outPoint ?? (s.duration > 0 ? s.duration : null);
  if (outSec === null) return null;
  if (!(outSec > inSec)) return null;
  return { inSec, outSec };
}

export const useSourceMonitorStore = create<SourceMonitorState>((set) => ({
  assetId: null,
  duration: 0,
  time: 0,
  inPoint: null,
  outPoint: null,
  playing: false,

  open: (assetId, durationSeconds) =>
    set((s) => {
      const duration = durationSeconds && durationSeconds > 0 ? durationSeconds : s.assetId === assetId ? s.duration : 0;
      // Same asset again → keep the marks. Loading a clip, marking a range,
      // glancing at another panel and coming back must not silently discard
      // the range, and re-opening is exactly what the Assets panel does on
      // every double-click.
      if (s.assetId === assetId) {
        return {
          duration,
          time: clampSourceTime(s.time, duration),
          inPoint: s.inPoint === null ? null : clampSourceTime(s.inPoint, duration),
          outPoint: s.outPoint === null ? null : clampSourceTime(s.outPoint, duration),
        };
      }
      return { assetId, duration, time: 0, inPoint: null, outPoint: null, playing: false };
    }),

  close: () => set({ assetId: null, duration: 0, time: 0, inPoint: null, outPoint: null, playing: false }),

  setDuration: (seconds) =>
    set((s) => {
      const duration = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
      return {
        duration,
        time: clampSourceTime(s.time, duration),
        inPoint: s.inPoint === null ? null : clampSourceTime(s.inPoint, duration),
        outPoint: s.outPoint === null ? null : clampSourceTime(s.outPoint, duration),
      };
    }),

  setTime: (seconds) => set((s) => ({ time: clampSourceTime(seconds, s.duration) })),
  setPlaying: (playing) => set({ playing }),
  togglePlay: () => set((s) => ({ playing: !s.playing })),

  /**
   * `in ≤ out` is enforced by DROPPING the other mark, not by clamping the new
   * one. Clamping would silently put the mark somewhere the user did not press
   * the key — and an in point pinned to an out point produces a zero-length
   * range, which every action button then has to special-case. Dropping says
   * plainly "the range you had no longer exists", which is what marking in
   * after your out point means.
   */
  setIn: (seconds) =>
    set((s) => {
      const at = clampSourceTime(seconds ?? s.time, s.duration);
      return { inPoint: at, outPoint: s.outPoint !== null && s.outPoint <= at ? null : s.outPoint };
    }),

  setOut: (seconds) =>
    set((s) => {
      const at = clampSourceTime(seconds ?? s.time, s.duration);
      return { outPoint: at, inPoint: s.inPoint !== null && s.inPoint >= at ? null : s.inPoint };
    }),

  clearInOut: () => set({ inPoint: null, outPoint: null }),
}));

/** The panel id, so the store and `panelDefs` cannot drift apart. */
export const SOURCE_MONITOR_PANEL_ID = 'sourceMonitor';

/**
 * Show an asset in the Source Monitor AND bring the panel forward.
 *
 * The one verb every caller outside the panel wants — the Assets context menu,
 * the preview dialog's footer button — because loading a clip into a viewer
 * the user cannot see is indistinguishable from doing nothing. `openPanel` is
 * idempotent, so this is safe to call on a panel that is already open (it
 * activates its tab, which is the right behaviour for "show me this clip").
 *
 * The probed duration is passed through when the import knew one; when it did
 * not, the panel's `<video>` reports the real length on `loadedmetadata` and
 * `setDuration` re-clamps whatever was marked in the meantime.
 */
export function openSourceMonitor(asset: Pick<ImportedAsset, 'id' | 'metadata'>): void {
  useSourceMonitorStore.getState().open(asset.id, asset.metadata?.duration);
  useLayoutStore.getState().openPanel(SOURCE_MONITOR_PANEL_ID);
}

/** The range currently marked in the monitor, or null. Convenience for callers
 *  outside React (the ops, the command layer) that would otherwise reach into
 *  `getState()` and re-derive it — see {@link sourceRange}. */
export function currentSourceRange(): { inSec: number; outSec: number } | null {
  return sourceRange(useSourceMonitorStore.getState());
}
