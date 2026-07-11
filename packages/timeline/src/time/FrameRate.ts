/**
 * FrameRate — the timeline's temporal resolution. Stored as an exact fps plus a
 * nominal (rounded) fps used for timecode framing. Drop-frame is modeled in the
 * type for forward-compatibility but not yet applied to formatting.
 *
 * Examples: 24, 25, 30, 60, 120, and broadcast rates like 23.976 / 29.97.
 */

export interface FrameRate {
  /** Exact frames per second (e.g. 29.97). */
  fps: number;
  /** Nominal integer fps used to frame timecode (e.g. 30 for 29.97). */
  nominal: number;
  /** SMPTE drop-frame timecode (reserved — not yet applied). */
  dropFrame: boolean;
}

export const COMMON_FRAME_RATES = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120] as const;

export function frameRate(fps: number, dropFrame = false): FrameRate {
  if (!(fps > 0) || !Number.isFinite(fps)) {
    throw new RangeError(`Invalid fps: ${fps}`);
  }
  return { fps, nominal: Math.round(fps), dropFrame };
}

export const FPS_24 = frameRate(24);
export const FPS_25 = frameRate(25);
export const FPS_30 = frameRate(30);
export const FPS_60 = frameRate(60);
export const FPS_120 = frameRate(120);

export function equals(a: FrameRate, b: FrameRate): boolean {
  return a.fps === b.fps && a.dropFrame === b.dropFrame;
}
