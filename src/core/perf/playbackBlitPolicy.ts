/**
 * When a short cached run is still worth blitting during playback.
 *
 * The run rule (a blit needs several cached frames ahead) assumes the live
 * render keeps up. When it does not — every live frame already exceeds the
 * frame period — an isolated cached hit is a correct frame at the cost of one
 * 2D blit.
 *
 * Both costs are measured: `noteLiveRender` from the preview-quality store,
 * `noteBlit` from the frame cache's own copy. Until both exist, nothing
 * changes. The decision is entered after three slow live frames and left
 * only after thirty fast ones, so a stretch of blits cannot talk it out of
 * itself.
 */

/** Consecutive over-budget live renders before single-frame blits are allowed,
 *  and consecutive in-budget ones before they are withdrawn. */
const SLOW_LIVE_TO_ENTER = 3;
const FAST_LIVE_TO_EXIT = 30;
/** How much dearer than a blit a live render must be before a lone hit wins. */
const LIVE_OVER_BLIT = 2;

export class PlaybackBlitPolicy {
  private liveMs = NaN;
  private blitMs = NaN;
  private slow = false;
  private over = 0;
  private under = 0;

  /** One live playback render: its cost and the frame period it had. */
  noteLiveRender(ms: number, budgetMs: number): void {
    if (!Number.isFinite(ms) || !(budgetMs > 0)) return;
    this.liveMs = Number.isNaN(this.liveMs) ? ms : this.liveMs * 0.7 + ms * 0.3;
    if (ms > budgetMs) {
      this.over += 1;
      this.under = 0;
      if (this.over >= SLOW_LIVE_TO_ENTER) this.slow = true;
    } else {
      this.under += 1;
      this.over = 0;
      if (this.under >= FAST_LIVE_TO_EXIT) this.slow = false;
    }
  }

  /** One frame-sized 2D copy (the cache's own copy, a blit's twin). */
  noteBlit(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.blitMs = Number.isNaN(this.blitMs) ? ms : this.blitMs * 0.8 + ms * 0.2;
  }

  /** May a cached frame with a short run be served? */
  get singleFrameBlits(): boolean {
    if (!this.slow || Number.isNaN(this.blitMs) || Number.isNaN(this.liveMs)) return false;
    return this.liveMs > Math.max(this.blitMs, 0.1) * LIVE_OVER_BLIT;
  }

  reset(): void {
    this.liveMs = NaN;
    this.blitMs = NaN;
    this.slow = false;
    this.over = 0;
    this.under = 0;
  }
}

/** The viewport's policy, fed by the render-quality store and the frame cache. */
export const playbackBlitPolicy = new PlaybackBlitPolicy();
