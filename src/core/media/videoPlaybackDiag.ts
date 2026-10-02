/**
 * Live video-playback diagnostics — the shared channel between the texture
 * provider (which drives the hidden `<video>` elements) and the status-bar
 * health readout.
 *
 * WHY THIS EXISTS: a browser whose media pipeline is exhausted (leaked
 * hardware decoders accumulate over long sessions; Chromium then stalls EVERY
 * new `<video>` at readyState 0, in every tab, with no error event) makes the
 * editor look broken — black imports, frozen playback — while the editor's
 * own code is doing everything right. That failure was invisible: no console
 * error, no event, nothing to act on. This module gives it a face: the
 * provider reports per-element state here, and the status bar surfaces
 * "decoder not responding — restart" the moment it happens instead of letting
 * users replay a broken loop seven times wondering what they did wrong.
 *
 * Deliberately a dumb module-level singleton with no store imports: core/
 * rendering must not depend on UI stores, and diagnostics must keep working
 * from any provider instance (viewport, export, thumbnails).
 */

export interface VideoDiagSample {
  key: string;
  src: string;
  readyState: number;
  seeking: boolean;
  ended: boolean;
  /** v.currentTime − requested time, ms. Positive = picture ahead. */
  driftMs: number;
  playbackRate: number;
  /** Cumulative decoder drops for this element (getVideoPlaybackQuality). */
  droppedFrames: number;
  totalFrames: number;
  /** This sample came from a cache-blit sync, not a live texture feed — the
   *  element's pixels are NOT on screen, so its lag must not slow the
   *  timeline (cached playback needs no decoder at all). */
  syncOnly: boolean;
  updatedAt: number;
}

export const videoDiag = {
  /** Per texture key, mutated in place each feed — read, don't hold. */
  samples: new Map<string, VideoDiagSample>(),
  /** Sources whose element sat at readyState 0 past the stall window even
   *  after a reload attempt — the browser-wedged signature. */
  stalledSources: new Set<string>(),
};

/** Samples older than this are elements no longer being fed (paused layer,
 *  released entry) — the readout ignores them. */
export const VIDEO_DIAG_LIVE_MS = 2000;

/**
 * How close to realtime the transport actually ran recently (EMA, 0..1).
 * Written by the playback clock each tick; read by the audio bridge to mute
 * audio during non-realtime preview — the After Effects behaviour, and far
 * better than the crackle of Web Audio voices restarting every quarter
 * second against a slowed timeline.
 */
export const playbackHealth = { realtimeFactor: 1 };

/**
 * Frames dropped RECENTLY, from counters that only ever grow.
 *
 * `getVideoPlaybackQuality().droppedVideoFrames` is cumulative for the
 * element's lifetime — and elements are deliberately PARKED and reused across
 * loop passes (AppTextureProvider.retain), so the counter never resets. Read
 * raw against a fixed threshold, one rough first pass tripped the status
 * badge red and kept it red for the rest of the session, however smooth
 * playback became. A warning that cannot clear once tripped says nothing;
 * it reads as "still broken" over a perfect picture.
 *
 * So: per-key deltas against the previous reading, clamped at zero (an
 * element torn down and re-created under the same key restarts its counter,
 * which must not read as negative drops), summed over a short rolling window.
 * Red then means pressure NOW, and clears within a breath of recovery.
 *
 * A class rather than refs in the badge component so the arithmetic is
 * testable without React or a ticking clock.
 */
export class DropRateWindow {
  private readonly prev = new Map<string, number>();
  private readonly window: Array<{ t: number; drops: number }> = [];

  constructor(private readonly windowMs = 4000) {}

  /**
   * Record one sampling tick and return the drops within the window.
   *
   * `counts` is key → the element's CUMULATIVE drop counter as of now. Keys
   * absent this tick keep their last baseline, so an element that skips a tick
   * (paused layer) does not re-count its history when it comes back.
   */
  sample(now: number, counts: ReadonlyMap<string, number>): number {
    let tickDrops = 0;
    for (const [key, total] of counts) {
      tickDrops += Math.max(0, total - (this.prev.get(key) ?? total));
      this.prev.set(key, total);
    }
    this.window.push({ t: now, drops: tickDrops });
    while (this.window.length > 0 && now - this.window[0]!.t > this.windowMs) {
      this.window.shift();
    }
    let recent = 0;
    for (const e of this.window) recent += e.drops;
    return recent;
  }
}
