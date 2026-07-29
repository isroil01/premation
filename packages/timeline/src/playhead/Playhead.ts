/**
 * Playhead — the current time cursor. Holds the current frame (fractional during
 * smooth playback, snapped on frame-stepping) and clamps to [0, duration]. It
 * knows nothing about clocks or rendering; something external advances it. All
 * moves funnel through `set` which fires the `onChange` hook the Timeline wires
 * to its event bus.
 */

export class Playhead {
  private frame = 0;
  private durationFrames: number;

  /** (current, previous) → emitted by the Timeline. */
  onChange: ((current: number, previous: number) => void) | null = null;

  constructor(durationFrames = 0) {
    this.durationFrames = Math.max(0, durationFrames);
  }

  get current(): number {
    return this.frame;
  }

  /** Current whole-frame index (floored). */
  get frameIndex(): number {
    return Math.floor(this.frame);
  }

  get duration(): number {
    return this.durationFrames;
  }

  setDuration(durationFrames: number): void {
    this.durationFrames = Math.max(0, durationFrames);
    // Re-clamp if the playhead now sits past the end.
    if (this.frame > this.durationFrames) this.set(this.durationFrames);
  }

  /** Move to an absolute frame (clamped). Fractional frames allowed. */
  set(frame: number): void {
    const clamped = Math.min(this.durationFrames, Math.max(0, frame));
    if (clamped === this.frame) return;
    const previous = this.frame;
    this.frame = clamped;
    this.onChange?.(clamped, previous);
  }

  /** Seek to a whole frame (snaps). */
  seek(frame: number): void {
    this.set(Math.round(frame));
  }

  /** Relative jump by a number of frames (may be fractional). */
  jump(deltaFrames: number): void {
    this.set(this.frame + deltaFrames);
  }

  nextFrame(): void {
    this.set(Math.floor(this.frame) + 1);
  }

  previousFrame(): void {
    this.set(Math.ceil(this.frame) - 1);
  }

  goToStart(): void {
    this.set(0);
  }

  goToEnd(): void {
    this.set(this.durationFrames);
  }
}
