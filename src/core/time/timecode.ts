/**
 * SMPTE timecode formatting, in one place.
 *
 * `formatClock` in App.tsx and `formatTime` in BottomTimeline.tsx were
 * copy-pasted frame-based formatters. Composition start timecode needs the
 * offset applied consistently to every readout, so the logic lives here once —
 * three drifting copies would show three different times for the same frame.
 *
 * IMPORTANT: the offset is DISPLAY ONLY. The animation time domain stays
 * 0-based — keyframes, sampling and seeking all work in real comp seconds. A
 * comp that "starts at 1:00:00:00" just labels frame 0 as that; nothing about
 * the timing changes. The one place the offset flows backwards is a timecode a
 * user *types* to seek (they type the label, so we subtract the offset to get
 * the domain time) — see `displayFramesToDomainSeconds`.
 */

/** Width of the frames field, so 120fps shows a stable 3-digit field. */
function frameFieldWidth(fps: number): number {
  return Math.max(2, String(Math.max(1, Math.ceil(fps)) - 1).length);
}

const pad2 = (n: number): string => Math.trunc(n).toString().padStart(2, '0');

/**
 * `sec` (real comp seconds) -> "mm:ss:ff", with `startFrame` added for display.
 *
 * Rolls into hours as "hh:mm:ss:ff" only once the time reaches an hour, so the
 * common case stays compact.
 */
export function framesToTimecode(sec: number, fps: number, startFrame = 0): string {
  const rate = fps > 0 ? fps : 30;
  const totalFrames = Math.max(0, Math.round(sec * rate) + Math.round(startFrame));
  const fw = frameFieldWidth(rate);
  const f = totalFrames % Math.round(rate);
  const totalSeconds = Math.floor(totalFrames / rate);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  const frames = f.toString().padStart(fw, '0');
  return h > 0 ? `${pad2(h)}:${pad2(m)}:${pad2(s)}:${frames}` : `${pad2(m)}:${pad2(s)}:${frames}`;
}

/**
 * A displayed timecode (already offset) back to a real domain time in seconds.
 *
 * The inverse of the offset in {@link framesToTimecode}: a user types the label
 * they see, so subtract the start to land on the actual playhead time. Clamped
 * at 0 — you cannot seek before the composition begins.
 */
export function displayFramesToDomainSeconds(displaySeconds: number, fps: number, startFrame = 0): number {
  const rate = fps > 0 ? fps : 30;
  return Math.max(0, displaySeconds - startFrame / rate);
}
