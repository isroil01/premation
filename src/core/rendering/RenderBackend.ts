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
  /**
   * 3D only: the projected affine at this sub-frame time. `drawComposited`
   * prefers a layer's `matrix` over its decomposed x/y/rotation/scale, so a 3D
   * sample without its own matrix renders identically to every other sample.
   */
  matrix?: readonly [number, number, number, number, number, number];
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
  /** Resolved matte source layer id (explicit sourceId, else the layer above) —
   *  set by resolveMatteSources so the GPU path can pair by lookup. */
  matteSourceId?: string;
  /** True when the layer above consumes this layer as its matte source. */
  isMatteSource?: boolean;
  /** Adjustment layer: its `filter` applies to everything beneath, and it draws
   *  no content of its own. */
  isAdjustment?: boolean;
  /** Per-layer render quality (AE's Quality switch). 'draft' disables image
   *  smoothing for this layer (nearest-neighbour). Absent = 'best'. */
  quality?: 'best' | 'draft';
  /** Precomp (nested composition): these inner layers are rendered to an
   *  offscreen texture, then this layer composites that texture as one unit
   *  (its opacity / blend / filter / mask apply to the whole nested result). */
  precompLayers?: ReadonlyArray<RenderLayer>;
  /** Point light: a radial glow (colour, intensity 0..100, radius px) drawn at
   *  x,y with a screen blend to brighten the layers beneath. */
  light?: { color: string; intensity: number; radius: number; type?: 'point' | 'ambient' | 'spot' | 'parallel'; angle?: number; cone?: number };
  /** Particle emitter config. When present, the layer draws a particle system
   *  (simulated deterministically at the current time) instead of its content. */
  particles?: import('@core/particles/particleSim').ParticleConfig;
  /** Paint strokes (AE Paint effect) drawn over the layer content in local
   *  space — paint composites colour, erase cuts holes. */
  paint?: import('@core/paint/paintStrokes').PaintConfig;
  /** Source playhead time in seconds (for video/audio/precomps with timeRemap or stretch). Defaults to current composition time if undefined. */
  sourceTime?: number;
  /** Frame blending (AE's Frame Mix) for retimed footage: cross-dissolve the
   *  two source frames bracketing `sourceTime` rather than showing the nearest
   *  one, which is what removes the judder from slowed footage.
   *
   *  Resolved to times here rather than passing a flag + fps, because
   *  buildSnapshot knows the composition frame rate and a backend does not.
   *  Emitted only when the layer asks for it — see `capabilities.frameBlending`
   *  for which backends honour it. */
  frameBlend?: {
    /** Source time of the earlier frame. */
    a: number;
    /** Source time of the later frame. */
    b: number;
    /** How far between them, 0..1 — the later frame's alpha. */
    weight: number;
  };
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
  /** Full 4×4 column-major WORLD matrix for a 3D layer (local centered pixels →
   *  3D comp space; same compose as `matrix`'s projection input). Present only
   *  for 3D layers. The GPU path renders it through the depth-tested mat4
   *  pipeline; `matrix` remains the CPU-projected affine fallback used for
   *  hit-testing, bounds, and Canvas2D/offline paths. */
  world3d?: readonly number[];
  /** Per-quad Lambert light gain (Material Options → Accepts Lights, 3D only).
   *  Multiplied into the layer's draw tint by the adapter; absent = unlit
   *  pipeline (identity). */
  lighting?: readonly [number, number, number];
  /** Per-fragment shading params (Accepts Lights on the depth-tested GPU path):
   *  Blinn-Phong specular intensity (already normalised 0..1) and exponent.
   *  Present only alongside `lighting`; the adapter attaches it (plus the
   *  snapshot's `lights3d`/camera eye) to renderables that take the depth path,
   *  where the shader replaces the per-quad tint fold with real per-fragment
   *  Lambert + specular. */
  shade3d?: { specular: number; shininess: number; metal?: number };
  /** Distance from the camera along the view axis; larger = farther. Drives 3D
   *  painter-order sorting. */
  depth?: number;
  opacity: number; // 0..1
  width: number;
  height: number;
  /** Solid fallback colour (legacy). `fillPaint` supersedes it when present. */
  fill?: string;
  /** Rich fill: solid / linear / radial gradient. The GPU rasterizer renders
   *  all gradient types and stop counts via the Canvas2DVectorRasterizer. */
  fillPaint?: FillPaint;
  /** Multi-fill stack (bottom→top). When present it supersedes `fillPaint`;
   *  entry 0 is kept equal to `fillPaint` for single-fill readers. */
  fillPaints?: FillPaint[];
  /** Outline stroke over the layer's primitive (rasterized by Canvas2DVectorRasterizer). */
  stroke?: Stroke;
  /** Multi-stroke stack (bottom→top). Supersedes `stroke` when present;
   *  entry 0 mirrors `stroke`. */
  strokes?: Stroke[];
  /**
   * Frosted-glass backdrop blur radius (comp px). Blurs what is BEHIND the layer
   * and shows it through the layer's alpha — a normal `blur` effect blurs the
   * layer itself, which is why glass could not be expressed before.
   */
  backdropBlur?: number;
  /**
   * The resolved GLASS layer style — refraction, chromatic aberration, tint,
   * rim, specular and grain over the blurred backdrop.
   *
   * Carried on the layer rather than compiled into `effects` because the effect
   * chain operates on the layer's OWN pixels and glass is a function of what is
   * behind it. It rides the same backdrop machinery as `backdropBlur`.
   */
  glass?: import('@core/effects/glassResolve').ResolvedGlass;
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
  /** Per-character static styling. Each run overrides the layer's font fields
   *  for a `[start, end)` span of `[...text]`. Like `glyphs`, presence forces
   *  the glyph-by-glyph path — a layer with one style still takes the cheap
   *  whole-string draw. */
  runs?: ReadonlyArray<import('@core/text/textLayout').RichRun>;
  /** Extra px between paragraphs (every newline starts one). */
  paragraphSpacing?: number;
  /** Paint the per-glyph stroke OVER the fill rather than under it (AE's
   *  Fill & Stroke order). Under is the default: an animated stroke then
   *  thickens outward instead of eating into the glyph. */
  strokeOverFill?: boolean;
  /** Text on a path: the layer's chosen mask, already flattened to a polyline
   *  in layer-local space, plus how to ride it. Resolved in buildSnapshot so a
   *  backend never has to reach back into the scene graph for geometry. */
  textPath?: {
    points: ReadonlyArray<{ x: number; y: number }>;
    closed: boolean;
    firstMargin: number;
    reversed: boolean;
    perpendicular: boolean;
  };
  /** CSS filter string from the layer's effect stack + DOF blur + cast shadow.
   *  Legacy: only the (deleted) Canvas2D backend read it; kept because tests
   *  assert against it and it documents the frame in one greppable string. The
   *  renderer consumes `effects` instead. */
  filter?: string;
  /**
   * FILL OPACITY, 0..1. Fades the layer's own pixels but NOT its layer styles,
   * so fill 0 on a shadowed layer leaves the shadow floating. Distinct from
   * `opacity`, which fades both. Absent = 1.
   */
  fillOpacity?: number;
  /** Shear angle in degrees (AE's Skew). 0 = none. */
  skew?: number;
  /** Direction the shear acts along, in degrees. 0 = horizontal. */
  skewAxis?: number;
  /** The resolved effect stack (amounts sampled at the current time), including
   *  synthetic entries buildSnapshot appends for 3D depth-of-field blur and
   *  2.5D light-cast shadows. The GPU path renders from THIS (colour matrix +
   *  spatial effect passes), never from `filter`. */
  effects?: ReadonlyArray<Effect>;
  /** Imported source URL (blob: or web URL) for image/video/audio layers. */
  src?: string;
  /** Referenced project asset ID. */
  assetId?: string;
  /**
   * Sub-rect of the SOURCE texture to sample, in 0..1 UV space. Absent = the
   * whole texture.
   *
   * This is how a `cover` media slot crops: the drawn quad stays exactly the
   * slot rect and the overflow is removed in texture space, so a covered source
   * cannot bleed over the rest of the composition. Scaling the quad up instead
   * would need a clipping step that could be forgotten; cropping the UVs makes
   * overflow impossible by construction.
   */
  uvRect?: { x: number; y: number; width: number; height: number };
  /**
   * The layer's footage is interpreted as PREMULTIPLIED (see
   * `FootageInterpretation.alpha`). Nothing in a file records this, so it is
   * always a user setting; absent = straight, the default.
   */
  premultipliedSource?: boolean;
  /** Digest of the fields that determine this layer's OWN rasterized pixels
   *  (geometry + fills/strokes/text/masks + pre-DOF effects + width/height),
   *  excluding transform + compositing. Computed once in buildSnapshot (see
   *  contentHash.ts); the VectorRasterizer keys its texture cache on it, so a
   *  transform-only animation reuses one texture. */
  contentHash?: string;
  /** Dynamic CPU-skinned mesh geometry for puppet deformation. */
  deformedMesh?: {
    vertices: Float32Array;
    triangles: Uint16Array;
    /**
     * Optional per-vertex OVERLAP depth (AE's blue Overlap pin). Signed; higher
     * draws in front. Absent means the mesh composites flat, exactly as before.
     */
    depth?: Float32Array;
  };
}

export interface RenderOverlays {
  /** AE's standard grid: fixed-size cells, the only grid that snaps. */
  grid?: boolean;
  /** AE "Gridline every" — cell size in composition pixels. */
  gridSpacing?: number;
  /** AE "Subdivisions" — minor lines between gridlines (1 = none). */
  gridSubdivisions?: number;
  /** AE "Grid Style". */
  gridStyle?: 'lines' | 'dashed' | 'dots';
  /** Grid line colour (#rrggbbaa). Default: faint white. */
  gridColor?: string;
  /** AE's proportional grid: comp divided into cells; reference only, no snap. */
  proportionalGrid?: boolean;
  proportionalColumns?: number;
  proportionalRows?: number;
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
  /** Rich background paint (linear/radial gradient). When present the Canvas2D
   *  backend paints this over the flat `background`; `background` remains the
   *  solid fallback for the GPU backend and exports. */
  backgroundPaint?: FillPaint;
  /** When true the comp has no background fill (transparent — checkerboard in
   *  preview, alpha:0 in export). `background` is then ignored for compositing. */
  transparent?: boolean;
  /**
   * Paint the composition backdrop? Default true; false in the orthographic and
   * custom views, where the frame is marked by its projected outline only.
   *
   * The backdrop is a solid fill of the comp frame drawn through the 2D
   * viewport transform, so it is always screen-axis-aligned — which contradicts
   * the comp plane the moment you look at the scene from anywhere but the
   * camera. See CompositionInfo.backdrop for the full reasoning.
   */
  backdrop?: boolean;
  /**
   * Which channel to display. 'alpha' paints the comp's own alpha as opaque
   * greyscale — the standard way to inspect a matte. Preview-only; export
   * always writes real colour.
   */
  channel?: 'rgb' | 'alpha' | 'red' | 'green' | 'blue';
  /** Current playhead time in seconds. */
  time?: number;
  layers: ReadonlyArray<RenderLayer>;
  /** Guide overlays drawn over the composition. */
  overlays?: RenderOverlays;
  /**
   * Region of Interest, in comp px. Preview-only: content is clipped to it (so
   * the expensive draws outside cost nothing) and the surround is dimmed.
   * Export ignores this — a render always covers the whole comp.
   */
  roi?: { x: number; y: number; width: number; height: number };
  /**
   * False when the frame is being rendered through an ORTHO or CUSTOM view
   * rather than the active camera. Those are inspection views and must not be
   * clipped to the composition rectangle — a Top view exists precisely to show
   * where layers sit outside the render frame. Defaults to true (clip).
   */
  viewIsActiveCamera?: boolean;
  /** Camera-driven comp→canvas transform (falls back to fit when omitted). */
  view?: RenderView;
  /** 3D camera as column-major 4×4 view/projection matrices (world →
   *  homogeneous comp-space clip). Emitted only when the frame contains 3D
   *  layers; derived from the SAME scalar camera the affine projection uses,
   *  so the GPU depth path and the CPU fallback agree. */
  camera3d?: {
    view: readonly number[];
    projection: readonly number[];
    /** Camera world position — the eye for Blinn-Phong specular. */
    eye?: readonly [number, number, number];
  };
  /** Scene lights in shader terms (per-fragment Accepts-Lights shading on the
   *  depth path). Emitted only when the frame has 3D layers AND lights. Colors
   *  are linear 0..1 RGB; `gain` = intensity/100; `aimX/aimY` = cos/sin of the
   *  light's 2D aim angle; `halfConeRad` is the spot half-cone in radians. */
  lights3d?: ReadonlyArray<{
    type: 'ambient' | 'point' | 'spot' | 'parallel';
    color: { r: number; g: number; b: number };
    gain: number;
    x: number;
    y: number;
    z: number;
    radius: number;
    aimX: number;
    aimY: number;
    halfConeRad: number;
  }>;
}

export interface RenderBackend {
  /** The tier this backend was ASKED for. Stable from construction, so it is
   *  readable before init resolves — and therefore NOT an answer to "what
   *  rendered this frame". Use `resolvedKind` for that. */
  readonly kind: string;
  /** The tier that actually initialized, or null before/after one does. See
   *  MotionRendererBackend.resolvedKind for why the distinction matters. */
  resolvedKind?: 'webgl2' | 'webgpu' | 'null' | null;
  attach(canvas: HTMLCanvasElement): void;
  /** CSS pixel size + device pixel ratio. */
  resize(width: number, height: number, dpr: number): void;
  renderFrame(snapshot: RenderSnapshot): void;
  /** Enable preview-only chrome (float shadow + transparency checkerboard).
   *  Left off for export so transparent comps yield real alpha. */
  setPreviewChrome?(on: boolean): void;
  dispose(): void;
  /** Promise that resolves when async initialization FINISHED (success or
   *  failure — check `initFailed` after it resolves; resolving is not a
   *  success signal, so awaiters never hang on a failed GPU init). */
  readyPromise?: Promise<void>;
  /** True when async init finished but the backend cannot render (all GPU
   *  tiers failed). The UI must surface an error instead of a blank canvas. */
  initFailed?: boolean;
  /** Human-readable failure reason when `initFailed` is true. */
  initErrorMessage?: string | null;
  /**
   * Exact media timing for offline export. On, video layers seek with a
   * sub-millisecond deadband (the live path tolerates 0.05s ≈ ±1.5 frames to
   * avoid seek storms during playback) and every async media wait started by a
   * render (video seeks, first-decode readiness, blend-cache fills) is
   * COLLECTED so the export loop can await them and re-render — otherwise a
   * captured frame shows whatever stale frame the element still held.
   */
  setExactMediaTiming?(on: boolean): void;
  /** Drain the media waits started by renders since the last call. Empty when
   *  every media layer drew its exact frame — the settle signal. */
  takeMediaWaits?(): Promise<void>[];
}
