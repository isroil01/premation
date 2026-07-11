import type { TimelineModel, Engine, EngineContext } from '../types';

export interface TimelineStep {
  /** New playhead time (seconds), clamped/wrapped to [0, duration]. */
  currentTime: number;
  /** False once a non-looping timeline reaches the end. */
  playing: boolean;
}

/**
 * Pure time-advancement step — the single source of playback math, shared by
 * the playback clock (real-time rAF) and the Engine's frame-step `update`.
 * Advances `currentTime` by `dtSeconds`, wrapping when `loop` and stopping at
 * `duration` otherwise.
 */
export function stepTimeline(
  currentTime: number,
  dtSeconds: number,
  duration: number,
  loop: boolean,
): TimelineStep {
  const dur = Math.max(0, duration);
  if (dur === 0) return { currentTime: 0, playing: false };
  const next = currentTime + dtSeconds;
  if (next >= dur) {
    if (loop) return { currentTime: next % dur, playing: true };
    return { currentTime: dur, playing: false };
  }
  if (next < 0) return { currentTime: 0, playing: true };
  return { currentTime: next, playing: true };
}

export class TimelineEngine implements Engine {
  id = 'timeline';
  model: TimelineModel;
  playing = false;

  onTimeChange?: (t: number) => void;

  constructor(model: TimelineModel) {
    this.model = model;
  }

  init(): void | Promise<void> {
    // no-op for now
  }

  play(): void {
    this.playing = true;
  }

  pause(): void {
    this.playing = false;
  }

  scrub(time: number): void {
    this.model.currentTime = Math.max(0, Math.min(this.model.duration, time));
    this.onTimeChange?.(this.model.currentTime);
  }

  update(_ctx: EngineContext): void {
    if (!this.playing) return;
    // Advance by 1/frameRate per update tick; callers should call at consistent dt.
    const dt = 1 / Math.max(1, this.model.frameRate);
    const step = stepTimeline(this.model.currentTime, dt, this.model.duration, false);
    this.model.currentTime = step.currentTime;
    this.playing = step.playing;
    this.onTimeChange?.(this.model.currentTime);
  }
}

export default TimelineEngine;
