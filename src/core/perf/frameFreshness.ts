/**
 * The viewer's per-frame freshness cue (docs/AUDIT_2026-11-02_RENDER_SCENE.md
 * item 14, "scrub path"): whether the picture on screen is the one the user
 * asked for.
 *
 *   stale    paused (a scrub, a seek, an edit): the frame shown is not the
 *            playhead's frame, or is of an older document revision, for longer
 *            than STALE_AFTER_MS — the engine is still building the frame the
 *            user is waiting for. A normal frame lands inside the grace, so the
 *            cue never blinks on a quick comp.
 *   dropped  playing: the engine skipped frames to keep time (FrameReady
 *            `dropped`). Shown for DROPPED_HOLD_MS after the last skip, with
 *            the frames skipped in that window.
 *
 * Fed by EngineSurface (frames drawn, the play state) and the playback clock /
 * document mirror (what is wanted). Allocates nothing per frame: the surface
 * reads `stale(now)` and `dropped(now)` and writes the DOM only on a change.
 *
 * No React (src/core).
 */

/** Paused: how long the shown frame may trail the playhead / the document before it is called stale. */
export const STALE_AFTER_MS = 120;
/** Playing: how long a dropped-frames cue stays after the last skip. */
export const DROPPED_HOLD_MS = 700;

export class FrameFreshness {
  private wantFrame = -1;
  private wantRevision = -1;
  private shownFrame = -1;
  private shownRevision = -1;
  private playing = false;
  /** When the shown frame started to trail what is wanted (null: it does not). */
  private behindSince: number | null = null;
  private droppedCount = 0;
  private droppedUntil = 0;

  /** What the viewer should show: the playhead's frame of document `revision` (-1: nothing / unknown). */
  want(frame: number, revision: number, now: number): void {
    this.wantFrame = frame;
    this.wantRevision = Math.max(this.wantRevision, revision);
    this.update(now);
  }

  /** A frame was drawn; `dropped` = frames the engine skipped before it. */
  shown(frame: number, revision: number, dropped: number, now: number): void {
    this.shownFrame = frame;
    this.shownRevision = revision;
    if (this.playing && dropped > 0) {
      this.droppedCount = (now < this.droppedUntil ? this.droppedCount : 0) + dropped;
      this.droppedUntil = now + DROPPED_HOLD_MS;
    }
    this.update(now);
  }

  setPlaying(playing: boolean, now: number): void {
    if (playing === this.playing) return;
    this.playing = playing;
    // A new play starts counting afresh; a pause forgets the drops.
    this.droppedCount = 0;
    this.droppedUntil = 0;
    this.update(now);
  }

  /** The document started over (a new / opened project, an engine restart): revisions restart. */
  reset(now: number): void {
    this.wantRevision = -1;
    this.shownRevision = -1;
    this.update(now);
  }

  stale(now: number): boolean {
    return this.behindSince !== null && now - this.behindSince >= STALE_AFTER_MS;
  }

  /** Frames dropped in the last DROPPED_HOLD_MS of playback (0: no cue). */
  dropped(now: number): number {
    return this.playing && now < this.droppedUntil ? this.droppedCount : 0;
  }

  /** Ms until the cue can change with no new input (the grace ending, the hold ending), or null. */
  nextChangeIn(now: number): number | null {
    let next: number | null = null;
    if (this.behindSince !== null && !this.stale(now)) next = this.behindSince + STALE_AFTER_MS - now;
    if (this.dropped(now) > 0) {
      const d = this.droppedUntil - now;
      next = next === null ? d : Math.min(next, d);
    }
    return next === null ? null : Math.max(0, next);
  }

  private update(now: number): void {
    const behind = !this.playing && this.shownFrame >= 0 && this.wantFrame >= 0
      && (this.shownFrame !== this.wantFrame || this.shownRevision < this.wantRevision);
    if (!behind) this.behindSince = null;
    else if (this.behindSince === null) this.behindSince = now;
  }
}
