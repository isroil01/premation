/**
 * A viewport: a rectangular region with its own camera and overlay settings
 * (grid, checkerboard, safe-area, guides, rulers). Multiple viewports can view
 * the same or different compositions. Pure state + geometry — the renderer reads
 * it each frame; it holds no GPU objects.
 */

import { Camera2D } from '../camera/Camera2D';
import type { Color } from '../core/math/Color';
import type { Rect, Size } from '../core/math/geometry';
import { nextId } from '../utils/ids';

export interface Guide {
  axis: 'x' | 'y';
  /** Position in world units. */
  position: number;
}

export interface ViewportOverlays {
  /** The ABSOLUTE grid (AE's standard grid): fixed-size cells in world units. */
  grid: boolean;
  /** AE "Gridline every" — major line spacing, in world units. */
  gridSpacing: number;
  /** AE "Subdivisions" — minor lines drawn between major gridlines. 1 = none. */
  gridSubdivisions: number;
  /** AE "Grid Style". `dots` marks intersections instead of drawing lines. */
  gridStyle: 'lines' | 'dashed' | 'dots';
  /** Grid line colour. Major lines use it as-is; minor lines are faded. */
  gridColor: Color;
  /**
   * The PROPORTIONAL grid (AE's second grid): the composition divided into a
   * fixed number of cells, so it rescales with the comp. Reference only —
   * nothing snaps to it, matching After Effects.
   */
  proportionalGrid: boolean;
  proportionalColumns: number;
  proportionalRows: number;
  /** Comp rect the proportional grid divides, in world units. */
  compRect: Rect | null;
  checkerboard: boolean;
  safeArea: boolean;
  rulers: boolean;
  guides: Guide[];
  background: Color;
}

export interface ViewportOptions {
  width: number;
  height: number;
  devicePixelRatio?: number;
  /** The composition/scene this viewport renders (renderer resolves it). */
  compositionId?: string;
  overlays?: Partial<ViewportOverlays>;
}

const DEFAULT_OVERLAYS: ViewportOverlays = {
  grid: true,
  gridSpacing: 100,
  gridSubdivisions: 4,
  gridStyle: 'lines',
  gridColor: { r: 1, g: 1, b: 1, a: 0.06 },
  proportionalGrid: false,
  proportionalColumns: 8,
  proportionalRows: 6,
  compRect: null,
  checkerboard: true,
  safeArea: false,
  rulers: false,
  guides: [],
  background: { r: 0.06, g: 0.06, b: 0.07, a: 1 },
};

export class Viewport {
  readonly id: number = nextId();
  readonly camera = new Camera2D();
  overlays: ViewportOverlays;
  compositionId?: string;

  private size: Size;
  private dpr: number;

  constructor(options: ViewportOptions) {
    this.size = { width: Math.max(1, options.width), height: Math.max(1, options.height) };
    this.dpr = options.devicePixelRatio ?? 1;
    this.compositionId = options.compositionId;
    this.overlays = { ...DEFAULT_OVERLAYS, ...options.overlays };
    this.camera.setViewport(this.size.width, this.size.height);
  }

  get width(): number {
    return this.size.width;
  }
  get height(): number {
    return this.size.height;
  }
  get devicePixelRatio(): number {
    return this.dpr;
  }

  /** Framebuffer size in physical pixels. */
  get pixelSize(): Size {
    return { width: Math.round(this.size.width * this.dpr), height: Math.round(this.size.height * this.dpr) };
  }

  /** The world-space rectangle currently visible (for culling). */
  get visibleWorldRect(): Rect {
    const tl = this.camera.screenToWorld({ x: 0, y: 0 });
    const br = this.camera.screenToWorld({ x: this.size.width, y: this.size.height });
    return { x: tl.x, y: tl.y, width: br.x - tl.x, height: br.y - tl.y };
  }

  resize(width: number, height: number, devicePixelRatio?: number): void {
    this.size = { width: Math.max(1, width), height: Math.max(1, height) };
    if (devicePixelRatio !== undefined) this.dpr = devicePixelRatio;
    this.camera.setViewport(this.size.width, this.size.height);
  }
}
