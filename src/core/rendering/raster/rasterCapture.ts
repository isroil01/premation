/**
 * Raster capture — an EXPORT PATH for the C++ text/vector rasterizer's parity
 * harness (docs/NATIVE_CORE_PLAN.md E3). Off unless a harness installs one.
 *
 * `Canvas2DVectorRasterizer.rasterize` brackets every raster it draws with
 * `begin` / `end`. A harness implementation (packages/render-tests/harness/
 * rasterRecorder.ts) records what the painter drew FROM (the drawable) and the
 * Canvas2D calls it issued, and files both under the texture the raster was
 * uploaded to. `frameSceneExport` then writes a `RenderRasterSource` next to the
 * texels of every such texture, so `premation-render` can draw the same raster
 * in C++ and compare it with the TS one.
 *
 * Nothing on a frame path pays for this: with no capture installed the hook is
 * one null check per raster MISS (a cache hit never reaches it).
 */

/** What the rasterizer is about to draw. */
export interface RasterCaptureBegin {
  /** 'text' | 'path' | 'mask' — the painter Canvas2DVectorRasterizer picks. */
  kind: string;
  /** The rasterizer's cache key for this raster. */
  cacheKey: string;
  /** The drawable exactly as the painter reads it (TextSpec or RenderLayer). */
  drawable: unknown;
  resolutionScale: number;
  padding: number;
  /** The rasterizer's texture-size cap (supersampleFor's `deviceMax`). */
  deviceMax: number;
}

/** What it drew: the canvas (= texture size) and the texture it was uploaded to. */
export interface RasterCaptureEnd {
  canvas: HTMLCanvasElement;
  /** The ResourceManager texture handle — identity is what `rasterSourceOf` looks up. */
  texture: unknown;
}

/** A recorded raster, as `frameSceneExport` writes it (engine-api `RenderRasterSource`). */
export interface CapturedRaster {
  kind: 'text' | 'path' | 'mask';
  cacheKey: string;
  width: number;
  height: number;
  resolutionScale: number;
  padding: number;
  specJson: string;
  opsJson: string;
  incomplete: string;
}

export interface RasterCapture {
  begin(info: RasterCaptureBegin): void;
  /** The painter finished drawing (before the texture upload) — for timing. */
  drawn?(): void;
  end(info: RasterCaptureEnd): void;
  /** The recording filed under a texture handle, if any. */
  rasterOf(texture: unknown): CapturedRaster | undefined;
}

let active: RasterCapture | null = null;

/** Install (or with null, remove) the capture. Harness only. */
export function setRasterCapture(capture: RasterCapture | null): void {
  active = capture;
}

/** The installed capture, or null — the rasterizer's one check. */
export function rasterCapture(): RasterCapture | null {
  return active;
}

/** The recording for a texture handle, when a capture is installed. */
export function rasterSourceOf(texture: unknown): CapturedRaster | undefined {
  return active?.rasterOf(texture);
}
