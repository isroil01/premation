/**
 * Rendering Engine — backend port + snapshot contract (TAD §6.4.1).
 *
 * A RenderSnapshot is an immutable, fully‑resolved description of a frame. The
 * backend is a PURE function of it: `renderFrame(snapshot)` → pixels. Backends
 * hold no document authority and no React reference (TAD D2/D5). Canvas2D is the
 * reference backend; WebGL/WebGPU implement the same interface and slot in via
 * the same port with no changes above this line.
 */

import type { LayerBlendMode } from '@core/effects/blendMode';

export type LayerKind = 'shape' | 'text' | 'image' | 'video';

export interface RenderLayer {
  id: string;
  kind: LayerKind;
  /** Compositing mode against the layers beneath (defaults to 'normal'). */
  blend?: LayerBlendMode;
  /** Center position in composition space. */
  x: number;
  y: number;
  rotation: number; // degrees
  scaleX: number;
  scaleY: number;
  opacity: number; // 0..1
  width: number;
  height: number;
  fill: string;
  visible: boolean;
  /** For shapes. */
  primitive?: 'rect' | 'ellipse';
  /** For text. */
  text?: string;
  fontSize?: number;
  /** CSS filter string from the layer's effect stack (blur/glow/color…). */
  filter?: string;
}

export interface RenderOverlays {
  grid?: boolean;
  safeArea?: boolean;
  rulers?: boolean;
}

/**
 * View transform (comp → canvas, in CSS pixels) supplied by the Workspace
 * camera. When present the backend uses it verbatim instead of its own
 * fit-to-surface, so pan/zoom from the interaction engine drive what's drawn.
 *   canvasPx = compPx * scale + offset
 */
export interface RenderView {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export interface RenderSnapshot {
  /** Composition size in px. */
  width: number;
  height: number;
  background: string;
  layers: ReadonlyArray<RenderLayer>;
  /** Guide overlays drawn over the composition. */
  overlays?: RenderOverlays;
  /** Camera-driven comp→canvas transform (falls back to fit when omitted). */
  view?: RenderView;
}

export interface RenderBackend {
  readonly kind: string;
  attach(canvas: HTMLCanvasElement): void;
  /** CSS pixel size + device pixel ratio. */
  resize(width: number, height: number, dpr: number): void;
  renderFrame(snapshot: RenderSnapshot): void;
  dispose(): void;
}
