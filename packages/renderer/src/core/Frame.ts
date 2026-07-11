/** Per-frame timing/counters, passed read-only to passes. */
export interface FrameInfo {
  /** Monotonic frame index since renderer init. */
  index: number;
  /** Wall-clock time in milliseconds for this frame. */
  timeMs: number;
  /** Delta since the previous frame, milliseconds. */
  deltaMs: number;
  /** Device pixel ratio in effect. */
  devicePixelRatio: number;
}
