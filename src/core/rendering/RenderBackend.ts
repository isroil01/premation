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
import type { TrackMatte } from '@core/effects/matte';
import type { FillPaint } from '@core/paint/fill';
import type { ShaderLight } from '@core/scene/lightShading';
import type { Stroke } from '@core/paint/stroke';
import type { BezierPoint } from '../../../packages/workspace/src/math/BezierPoint';

export type LayerKind = 'shape' | 'text' | 'image' | 'video';

/**
 * One continuous run of a layer's path geometry.
 *
 * A shape used to be exactly one polyline — `pathPoints` — which is why Trim
 * Paths could only ever annotate the STROKE: cutting a path into two visible
 * arcs produces two runs, and the contract had nowhere to put the second one.
 * `trimPolyline` has returned `Pt[][]` since it was written; the list simply
 * died inside `strokeTrimmed` instead of reaching the renderer.
 *
 * `open` is per-subpath, not per-layer, because it differs between the two
 * operations that consume it: a trimmed arc must NOT be closed by the stroke
 * (that would draw a chord back to the start), while the fill closes it
 * implicitly — which is exactly what Canvas2D does for a path with no
 * `closePath`, and exactly what AE draws.
 */
export interface Subpath {
  points: ReadonlyArray<BezierPoint>;
  /** Stroke leaves this run open; fill still closes it implicitly. */
  open?: boolean;
  /**
   * PER-RUN PAINT. Absent means "paint with the layer's own fill/stroke", which
   * is what every existing writer produces and what keeps this field free.
   *
   * ── Why a run needs its own paint ───────────────────────────────────────
   *
   * The repeater emits its copies as N `RenderLayer`s that share one geometry
   * and differ by transform deltas, which is why it cannot fold into
   * `fx.pathOps` (F16): folding means baking the copies into geometry — now
   * expressible as N subpaths — but per-copy `offsetOpacity` is keyframeable
   * TODAY and would have nowhere to live. Dropping a parameter users already
   * animate is worse than an inert control, because the control still moves.
   *
   * ── What `paint` being present COSTS, and why it is opt-in ──────────────
   *
   * Runs are normally drawn as ONE Canvas path so `fill()` sees them as a
   * single nonzero-winding region — that is what makes a reverse-wound run cut
   * a HOLE rather than paint over the shape. A run with its own paint cannot
   * share that path; it has to be filled separately, and separately-filled runs
   * cannot cut holes in each other.
   *
   * So the two behaviours are genuinely exclusive, and the resolution is that
   * paint is opt-in per run: runs without it stay batched (holes intact, output
   * byte-identical to before this field existed), runs with it are drawn
   * individually. See `drawSubpathBatches` in vectorDraw.ts, which is the one
   * place that grouping happens.
   *
   * Both cache keys — the content hash and the texture signature — must digest
   * this. Two structurally identical paths differing only in run paint are
   * different pictures, and without it the second silently reuses the first's
   * texture.
   */
  paint?: SubpathPaint;
}

/**
 * A single run's paint override. Every field is optional and falls back to the
 * layer's own value, so `{ opacity: 0.5 }` means "this run, at half opacity,
 * otherwise exactly like the layer" rather than "this run, unpainted".
 */
export interface SubpathPaint {
  /** Overrides the layer's fill. */
  fill?: FillPaint;
  /** Overrides the layer's stroke. */
  stroke?: Stroke;
  /**
   * 0..1, multiplied into BOTH fill and stroke for this run only.
   *
   * The field the repeater fold-in actually needs: `offsetOpacity` ramps each
   * copy, and it multiplies whatever paint the copy already has rather than
   * replacing it.
   */
  opacity?: number;
}

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
  /**
   * Preserve Underlying Transparency — the layer is clipped to the alpha
   * already accumulated beneath it. Orthogonal to `blend`, not a member of it:
   * "Multiply AND preserve transparency" is a state users want.
   */
  preserveTransparency?: boolean;
  /** Vector mask clipping the layer (local space). Omitted when unmasked. */
  mask?: LayerMask;
  /** Track matte: the explicit sourceId (or the layer above) defines this layer's alpha. */
  matte?: TrackMatte;
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
  /** A light layer's 2D wash: a glow drawn at x,y and screen-blended to brighten
   *  the layers beneath. A SPOT is shaped by `angle`/`cone`/`coneFeather`; every
   *  other type is a plain radial falloff. `coneFeather` is a PERCENT of the
   *  half-cone (AE's Cone Feather) — absent ⇒ 20 %, matching `shadeLayer`. */
  light?: { color: string; intensity: number; radius: number; type?: 'point' | 'ambient' | 'spot' | 'parallel'; angle?: number; cone?: number; coneFeather?: number };
  /** Particle emitter config. When present, the layer draws a particle system
   *  (simulated deterministically at the current time) instead of its content. */
  particles?: import('@core/particles/particleSim').ParticleConfig;
  /** Paint strokes (AE Paint effect) drawn over the layer content in local
   *  space — paint composites colour, erase cuts holes. */
  paint?: import('@core/paint/paintStrokes').PaintConfig;
  /**
   * Content-Aware Fill stamp — full-frame PNG data-URL for this time, replacing
   * the video/image pixels when present (PatchMatch bake).
   */
  contentAwareFillSrc?: string;
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
    /** 'mix' cross-dissolves the brackets; 'pixelMotion' warps them along
     *  estimated optical flow first (smooth slow motion). Absent means 'mix'
     *  — the field predates the mode, and mix is what it always did. */
    mode?: 'mix' | 'pixelMotion';
  };
  /** Sub-frame transform samples for motion blur (accumulated by the backend).
   *  Present only when motion blur is on and the layer actually moves. */
  motionSamples?: ReadonlyArray<MotionSample>;
  /** Corner Pin: four normalised [0,1] corners (TL,TR,BR,BL) the source
   *  rectangle is mapped onto via a perspective homography. Present only for a
   *  non-identity, convex pin — the affine path is unchanged otherwise. Applied
   *  as a separate render stage on the mvp; `matrix` stays affine. */
  cornerPin?: readonly [number, number, number, number, number, number, number, number];
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
  shade3d?: {
    specular: number;
    shininess: number;
    metal?: number;
    /** PBR roughness 0..1. Present ⇒ the GGX model; absent ⇒ Blinn-Phong. */
    roughness?: number;
    /** Light this surface from one side. Set only by an extrusion's walls and
     *  back cap, which bound a volume — see `lightShading.ndotl`. */
    oneSided?: boolean;
    /** Material Options → Ambient (AE %). Scales ambient-light response on the
     *  per-fragment path; omit ⇒ 100 (identity). */
    ambient?: number;
    /** Material Options → Diffuse (AE %). Scales Lambert response; omit ⇒ 50
     *  (AE default, identity vs the pre-material gain). */
    diffuse?: number;
  };
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
  /** Uniform corner radius (legacy / linked mode). Prefer `cornerRadii` when set. */
  cornerRadius?: number;
  /** Per-corner radii in TL → TR → BR → BL order (Appearance → Corners). */
  cornerRadii?: readonly [number, number, number, number];
  /**
   * Draw as a bare quad with no SDF edge coverage.
   *
   * For a facet of a larger body — the strips an extruded object's wall ring is
   * made of. A solid quad's SDF edge fades to transparent, so two facets meeting
   * along a shared edge each blend half the BACKGROUND in and the join shows as
   * a dark hairline: twenty of them around a cylinder, more on a rounded box.
   * The facets tile exactly, so the coverage that makes a standalone shape look
   * smooth is the very thing that ruins a seam. The body's OUTER silhouette is
   * still antialiased by the pass's multisampling.
   */
  flatFacet?: boolean;
  /**
   * Vector path points in LOCAL space (only present if primitive === 'path').
   *
   * The single-subpath shorthand. `subpaths` is the general form; this field is
   * the overwhelmingly common one-run case kept in place so every existing
   * writer (SVG import, audio waveform, path operators, the pen tool) is
   * untouched. **The two are mutually exclusive** — see `layerSubpaths`, which
   * is the ONLY reader of either, so a consumer cannot pick the wrong one.
   */
  pathPoints?: ReadonlyArray<BezierPoint>;
  /**
   * Path geometry as a LIST of runs — the general form of `pathPoints`.
   *
   * Set only when the geometry genuinely has more than one run (a trim whose
   * window wraps past the end of the path yields two arcs). Writers must set
   * this OR `pathPoints`, never both; `assertSinglePathSource` pins that.
   */
  subpaths?: ReadonlyArray<Subpath>;
  /** True for open strokes (freehand pencil / line) that must NOT be closed or
   *  filled — the backend draws them as an open polyline instead of a loop.
   *  Applies to `pathPoints`; `subpaths` carry their own per-run `open`. */
  pathOpen?: boolean;
  /** For text. */
  text?: string;
  fontSize?: number;
  /** Font family name (e.g. 'Inter', 'Roboto'). Falls back to Inter. */
  fontFamily?: string;
  /** CSS font-weight ('300'..'700'). Falls back to 600. */
  fontWeight?: string;
  /** Variable-font wdth axis (typically 50–200). */
  fontWidth?: number;
  /** Variable-font slnt axis (typically −15..0). */
  fontSlant?: number;
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
  /**
   * Intact animated SVG: re-rasterize at `sourceTime` each frame instead of
   * caching a single static decode.
   */
  liveSvgPlayback?: boolean;
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
   *
   * Consumed by the TEXTURE FEED, not by any draw: MotionRendererBackend passes
   * it to `setImage`, which carries it to the upload where it decides whether
   * the browser multiplies. It used to select one of six `-premul` shader
   * variants; under the alpha invariant (see `TextureSource`) every texture is
   * premultiplied by the time it is sampled, so there is nothing left to select.
   */
  premultipliedSource?: boolean;
  /**
   * Interpret Footage ▸ Fields: the field order of interlaced source video,
   * absent for progressive (every modern file, and the previous behaviour).
   * Consumed by the texture feed like `premultipliedSource`: the provider
   * deinterlaces the decoded frame (single-field bob, see
   * `rendering/deinterlace.ts`) before upload, so both GPU backends and every
   * decode path (exact, legacy cache, element) see clean frames.
   */
  fieldsSource?: 'upper' | 'lower';
  /**
   * Interpret Footage ▸ Remove Pulldown: the 3:2 cadence phase (0–4). When
   * present the exact decode path serves inverse-telecined progressive film
   * frames (see `video/pulldownDetect.ts` ▸ `pulldownFrameFor`), and
   * `fieldsSource` is absent by construction (`footageSourceOf` suppresses
   * it). Legacy fallback paths cannot weave, so they bob instead — comb never
   * reaches the screen either way.
   */
  pulldownSource?: number;
  /** Digest of the fields that determine this layer's OWN rasterized pixels
   *  (geometry + fills/strokes/text/masks + pre-DOF effects + width/height),
   *  excluding transform + compositing. Computed once in buildSnapshot (see
   *  contentHash.ts); the VectorRasterizer keys its texture cache on it, so a
   *  transform-only animation reuses one texture. */
  contentHash?: string;
  /**
   * Continuous Rasterization: re-raster this layer's vector content at the scale
   * it is actually drawn at, past the 4× ceiling `resolutionTier` imposes.
   *
   * Absent/false = today's behaviour exactly, which is what keeps every existing
   * project byte-identical. Only shape/text/SVG layers ever set it; see
   * `@core/scene/continuousRaster` for why bitmaps and flat solids do not.
   */
  continuousRaster?: boolean;
  /** Dynamic CPU-skinned mesh geometry for puppet deformation. */
  /**
   * Extruded solid for a 3D layer with depth — walls, bevels and back cap as
   * ONE mesh with per-vertex normals (core/scene/extrusionMesh.ts), carried by
   * a synthetic `::ext-mesh` layer that shares the front face's `world3d`.
   * Vertices are in the layer's CENTRED pixel frame; `ranges` are the material
   * groups, each with its resolved fill and the unlit brightness gain. The
   * adapter routes it to the renderer's depth-tested mesh path.
   */
  extrudedMesh?: {
    key: string;
    vertices: Float32Array;
    indices: Uint16Array | Uint32Array;
    ranges: ReadonlyArray<{
      role: 'front' | 'back' | 'side' | 'bevel';
      first: number;
      count: number;
      fill: string;
      gain: number;
      /** Sample the layer's own texture (image/video back cap) instead of `fill`. */
      textured?: boolean;
    }>;
  };
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
   * Which channel to display. 'alpha' paints the comp's own alpha as opaque
   * greyscale — the standard way to inspect a matte. Preview-only; export
   * always writes real colour.
   */
  channel?: 'rgb' | 'alpha' | 'red' | 'green' | 'blue';
  /** Current playhead time in seconds. */
  time?: number;
  /** Comp frame rate — stateful particles and other frame-stepped sims. */
  fps?: number;
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
  /**
   * Scene lights in shader terms (per-fragment Accepts-Lights shading on the
   * depth path). Emitted only when the frame has 3D layers AND lights.
   *
   * Refers to `ShaderLight` rather than restating its shape. This was a third
   * structural copy of the same DTO, and copies are how `coneFeather`,
   * `falloff` and `poi` came to be honoured on the CPU and silently dropped on
   * the GPU — a field added to one declaration and not the others still
   * typechecks everywhere.
   */
  lights3d?: ReadonlyArray<ShaderLight>;
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
  /**
   * Compositing operations the LAST renderFrame could not honour.
   *
   * Empty on the overwhelmingly common path. Non-empty means the frame is a
   * materially different picture from the one authored — e.g. a track matte that
   * could not be built, so the layer drew unmatted. The CALLER decides: the
   * viewport warns and keeps the frame, an export must refuse it, because a
   * warning next to a delivered file is not a warning anyone acts on.
   */
  lastFrameDiagnostics?(): ReadonlyArray<{ code: string; detail: string; layerId?: string }>;
  /** Linear float RGBA of the last composed scene (EXR export). */
  readLinearRgba?(): Float32Array | null;
  /** Async linear readback (WebGPU). */
  readLinearRgbaAsync?(): Promise<Float32Array | null>;
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
  /** Timeline playback — plain video uses hardware decode instead of WebCodecs. */
  setPlaybackMode?(on: boolean): void;
  /** Drain the media waits started by renders since the last call. Empty when
   *  every media layer drew its exact frame — the settle signal. */
  takeMediaWaits?(): Promise<void>[];
}
