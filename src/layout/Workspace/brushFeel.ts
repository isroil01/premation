/**
 * The brush's keyboard and drag feel (RotoBrushOverlay.tsx), pure: `[` / `]`
 * steps and the Ctrl-drag that sizes the brush on the picture.
 */

/** The next brush size for `[` (down) / `]` (up): finer steps while it is small (2…200 screen px). */
export function stepBrushSize(size: number, up: boolean): number {
  const step = size < 10 ? 1 : size < 50 ? 5 : 10;
  const next = up ? Math.floor(size / step) * step + step : Math.ceil(size / step) * step - step;
  return Math.max(2, Math.min(200, next));
}

/** Ctrl-drag: the size from the horizontal travel (1 px per px); with Shift the hardness (½ % per px). */
export function dragBrush(start: { size: number; hardness: number }, dx: number, what: 'size' | 'hardness'): { size: number; hardness: number } {
  if (what === 'size') return { size: Math.max(2, Math.min(200, Math.round(start.size + dx))), hardness: start.hardness };
  return { size: start.size, hardness: Math.max(0, Math.min(100, Math.round(start.hardness + dx / 2))) };
}

/** Whether a press that travelled `maxTravel` screen px is still a click (may pair into a double-click). */
export function isClickTravel(maxTravel: number, slopPx = 3): boolean {
  return maxTravel <= slopPx;
}
