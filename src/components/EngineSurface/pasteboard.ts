/**
 * The pasteboard around the composition in the engine viewport.
 *
 * The C++ engine clears everything outside the comp to opaque black, so with
 * the engine's frames as THE viewport the comp (its own dark background) and
 * its surround read as one black field. The TypeScript viewport it replaced
 * drew the surround transparent over the stage, which showed the theme's
 * pasteboard colour. EngineSurface restores that look when it draws a frame:
 * outside the comp rectangle it paints `--color-pasteboard` (the theme token,
 * and the user's Settings override of it — core/theme/pasteboard.ts).
 *
 * Pure maths, so the rectangle can be tested without a GPU.
 */

/** The camera a frame was drawn with (setViewport): CSS size, zoom = CSS px per comp px, pan = the comp point at the centre. */
export interface SurfaceCamera {
  width: number;
  height: number;
  zoom: number;
  panX: number;
  panY: number;
}

/** The comp rectangle in the frame's UV space (0..1, y down), or null when there is none to draw around. */
export interface UvRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Where the comp (0,0)–(compWidth, compHeight) lands in a frame drawn with
 * `cam`, as UV. The engine's view (engine_frames.cpp, `vs.zoom` / `centerX`):
 * comp point p is at CSS `size/2 + (p − pan)·zoom`. Null for a fit camera
 * (zoom ≤ 0: the engine picks the framing) or a degenerate size.
 */
export function compUvRect(cam: SurfaceCamera, compWidth: number, compHeight: number): UvRect | null {
  if (!(cam.zoom > 0) || !(cam.width > 0) || !(cam.height > 0) || !(compWidth > 0) || !(compHeight > 0)) return null;
  const sx = (x: number): number => (cam.width / 2 + (x - cam.panX) * cam.zoom) / cam.width;
  const sy = (y: number): number => (cam.height / 2 + (y - cam.panY) * cam.zoom) / cam.height;
  const x0 = sx(0);
  const x1 = sx(compWidth);
  const y0 = sy(0);
  const y1 = sy(compHeight);
  if (![x0, x1, y0, y1].every(Number.isFinite)) return null;
  return { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
}

/** `rgb(r, g, b)` / `rgba(r, g, b, a)` (a computed CSS colour) → 0..1 channels; null if it is not one. */
export function parseCssRgb(css: string): [number, number, number] | null {
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(css.trim());
  if (!m) return null;
  const c = (s: string): number => Math.max(0, Math.min(1, Number(s) / 255));
  return [c(m[1]!), c(m[2]!), c(m[3]!)];
}
