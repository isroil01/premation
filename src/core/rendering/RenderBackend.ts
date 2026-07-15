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
import type { Effect } from '@core/effects/effects';
import type { LayerMask } from '@core/effects/mask';
import type { MatteProp } from '@core/effects/matte';
import type { FillPaint } from '@core/paint/fill';
import type { Stroke } from '@core/paint/stroke';
import type { BezierPoint } from '../../../packages/workspace/src/math/BezierPoint';

export type LayerKind = 'shape' | 'text' | 'image' | 'video';

/** One sub-frame transform sample used for motion-blur accumulation. */
export interface MotionSample {
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  opacity: number;
}

export interface RenderLayer {
  id: string;
  kind: LayerKind;
  /** Compositing mode against the layers beneath (defaults to 'normal'). */
  blend?: LayerBlendMode;
  /** Vector mask clipping the layer (local space). Omitted when unmasked. */
  mask?: LayerMask;
  /** Track matte: the layer above (or explicit sourceId) defines this layer's alpha. */
  matte?: MatteProp;
  /** True when the layer above consumes this layer as its matte source. */
  isMatteSource?: boolean;
  /** Adjustment layer: its `filter` applies to everything beneath, and it draws
   *  no content of its own. */
  isAdjustment?: boolean;
  /** Precomp (nested composition): these inner layers are rendered to an
   *  offscreen texture, then this layer composites that texture as one unit
   *  (its opacity / blend / filter / mask apply to the whole nested result). */
  precompLayers?: ReadonlyArray<RenderLayer>;
  /** Point light: a radial glow (colour, intensity 0..100, radius px) drawn at
   *  x,y with a screen blend to brighten the layers beneath. */
  light?: { color: string; intensity: number; radius: number };
  /** Source playhead time in seconds (for video/audio/precomps with timeRemap or stretch). Defaults to current composition time if undefined. */
  sourceTime?: number;
  /** Sub-frame transform samples for motion blur (accumulated by the backend).
   *  Present only when motion blur is on and the layer actually moves. */
  motionSamples?: ReadonlyArray<MotionSample>;
  /** Center position in composition space. */
  x: number;
  y: number;
  rotation: number; // degrees
  scaleX: number;
  scaleY: number;
  /** Anchor offset from centre (px). Content is shifted by -anchor so the
   *  anchor point sits at the pivot (rotation/scale centre). */
  anchorX?: number;
  anchorY?: number;
  /** Full 2×3 affine `[a,b,c,d,e,f]` in composition space, mapping the layer's
   *  local coords to screen. Present for 3D layers (carries perspective tilt /
   *  shear that x/y/rotation/scale can't); when set it supersedes them for
   *  drawing. `x/y/scaleX/scaleY/rotation` remain as the decomposed fallback. */
  matrix?: readonly [number, number, number, number, number, number];
  /** Distance from the camera along the view axis; larger = farther. Drives 3D
   *  painter-order sorting. */
  depth?: number;
  opacity: number; // 0..1
  width: number;
  height: number;
  /** Solid fallback colour (legacy). `fillPaint` supersedes it when present. */
  fill: string;
  /** Rich fill: solid / linear / radial gradient. Canvas2D renders all; the GPU
   *  path uses the first stop for gradients (documented gap). */
  fillPaint?: FillPaint;
  /** Outline stroke over the layer's primitive (Canvas2D only for now). */
  stroke?: Stroke;
  /** Layer color (e.g. for label tagging in the UI). */
  color?: string;
  visible: boolean;
  /** For shapes. */
  primitive?: 'rect' | 'ellipse' | 'path';
  cornerRadius?: number;
  /** Vector path points in LOCAL space (only present if primitive === 'path') */
  pathPoints?: ReadonlyArray<BezierPoint>;
  /** True for open strokes (freehand pencil / line) that must NOT be closed or
   *  filled — the backend draws them as an open polyline instead of a loop. */
  pathOpen?: boolean;
  /** Trim-path visible arcs [lo,hi] (0..1 of the outline length). When present
   *  the backend strokes only these portions of the shape outline (MG-C). */
  trim?: ReadonlyArray<readonly [number, number]>;
  /** For text. */
  text?: string;
  fontSize?: number;
  /** Font family name (e.g. 'Inter', 'Roboto'). Falls back to Inter. */
  fontFamily?: string;
  /** CSS font-weight ('300'..'700'). Falls back to 600. */
  fontWeight?: string;
  /** 'normal' | 'italic'. */
  fontStyle?: string;
  /** Extra spacing between characters (px). */
  letterSpacing?: number;
  /** Line height as a multiple of font size (for multi-line text). */
  lineHeight?: number;
  /** Paragraph alignment: 'left' | 'center' | 'right' | 'justify'. */
  align?: string;
  /** Per-glyph transforms from the layer's text animators (MG Phase D). When
   *  present the backend lays the string out glyph-by-glyph; when absent it
   *  draws the whole string as one run (no animators → unchanged). */
  glyphs?: ReadonlyArray<import('@core/text/textAnimators').GlyphTransform>;
  /** CSS filter string from the layer's effect stack (blur/glow/color…). Used by
   *  the Canvas2D backend. */
  filter?: string;
  /** The resolved effect stack (amounts sampled at the current time). Canvas2D
   *  uses `filter`; the GPU path reads this to build a colour matrix, etc. */
  effects?: ReadonlyArray<Effect>;
  /** Imported source URL (blob: or web URL) for image/video/audio layers. */
  src?: string;
  /** Referenced project asset ID. */
  assetId?: string;
}

export interface RenderOverlays {
  grid?: boolean;
  /** Number of grid cells per axis (default 3 = rule-of-thirds). */
  gridDivisions?: number;
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
  /** When true the comp has no background fill (transparent — checkerboard in
   *  preview, alpha:0 in export). `background` is then ignored for compositing. */
  transparent?: boolean;
  /** Current playhead time in seconds. */
  time?: number;
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
  /** Enable preview-only chrome (float shadow + transparency checkerboard).
   *  Left off for export so transparent comps yield real alpha. */
  setPreviewChrome?(on: boolean): void;
  dispose(): void;
  /** Promise that resolves when the backend is fully initialized (e.g. GPU compilation). */
  readyPromise?: Promise<void>;
}
