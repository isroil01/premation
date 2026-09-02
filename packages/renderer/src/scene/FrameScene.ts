/**
 * The renderer's **input contract**. A `FrameScene` is a flat, paint-ordered
 * list of renderables with world matrices already resolved. The renderer reads
 * this and nothing else — it never imports the scene graph, timeline, or React.
 * An adapter (see `integration/`) converts a scene-graph snapshot into this DTO,
 * which keeps the renderer decoupled and trivially testable.
 */

import type { Color } from '../core/math/Color';
import type { Mat3 } from '../core/math/Mat3';
import type { Rect, Size } from '../core/math/geometry';
import type { BlendMode } from '../gpu/types';

export type RenderableKind = 'rect' | 'image' | 'video' | 'text' | 'path' | 'group';

/** Optional SDF geometry for a solid renderable, so shapes render as real
 *  rounded-rects/ellipses instead of flat quads. Omitted → a plain rectangle. */
export interface RenderableSdf {
  shape: 'rounded' | 'ellipse';
  /** Corner radius in world px (rounded only). */
  radiusPx: number;
  /** World-space box size, for px-accurate corners / edges. */
  width: number;
  height: number;
}

/**
 * Resolved Glass layer style, in device pixels and radians — the renderer does
 * no unit conversion of its own.
 *
 * Every field here is a keyframe track upstream; this is just the sampled
 * result for one frame.
 */
export interface RenderableGlass {
  /** Edge displacement strength, px. */
  refraction: number;
  /** How far in from the border refraction reaches, px. */
  edgeWidth: number;
  /** Per-channel offset inside the refraction band, px. THE detail that turns a
   *  blurred rectangle into glass. */
  aberration: number;
  /** Backdrop saturation multiplier — 1 = untouched, >1 = the "vibrancy" look. */
  saturation: number;
  /** Tint over the blurred backdrop. */
  tint: Color;
  tintOpacity: number;
  /** The bright border. */
  rim: Color;
  rimOpacity: number;
  rimWidth: number;
  /** Radians. */
  rimAngle: number;
  /** The travelling highlight. */
  specularAngle: number;
  specularIntensity: number;
  specularFalloff: number;
  /** Noise amount, 0..1. A blurred gradient bands without it. */
  grain: number;
}

/** Per-pixel affine colour transform (from colour-grade effects) applied to a
 *  textured sample: `out.rgb = M·rgb + offset`. `m` is a row-major 3×3. */
export interface RenderableColorMatrix {
  m: readonly number[];
  offset: readonly number[];
}

export type RenderableEffect = 
  | {
      type: 'blur';
      radiusPx: number;
      /** Iris blade count (≥3) selects polygonal bokeh instead of Gaussian. */
      blades?: number;
      /** 0 = sharp n-gon, 1 = circle. */
      roundness?: number;
      /** Extra weight on bright samples. */
      highlightGain?: number;
      /**
       * Planar per-pixel CoC: blur radii (px) at UV corners
       * (0,0), (1,0), (1,1), (0,1). When set, CompositionPass runs `coc-blur`
       * instead of a uniform separable / bokeh pass. `radiusPx` should be the
       * max corner (effect spread / skip gates).
       */
      cocCorners?: readonly [number, number, number, number];
    }
  | { type: 'glow'; radiusPx: number; color?: Color; /** Comp-px alpha dilate before blur (Spread). */ spreadPx?: number }
  | { type: 'drop-shadow'; radiusPx: number; color?: Color; offsetX: number; offsetY: number; spreadPx?: number }
  | {
      type: 'gradient-ramp';
      blend: number;
      colorA?: Color;
      colorB?: Color;
      /** Ramp direction in degrees, 0 = left→right, 90 = top→bottom (the same
       *  convention as a gradient FILL). Absent → 90, the previous hardcoded
       *  diagonal's nearest sane default. */
      angle?: number;
    }
  | { type: 'fractal-noise'; scale: number }
  | {
      type: 'displacement-map';
      amount: number;
      /** Renderable id of the layer whose pixels drive the displacement.
       *  Unset/unresolvable → the layer displaces by its own content. */
      mapLayerId?: string;
    }
  | {
      type: 'apply-color-lut';
      /** Texture key of the LUT STRIP (N slices of N×N, or N×1 for a 1D LUT). */
      lutTextureKey: string;
      /** Cube edge length, or the entry count for a 1D LUT. */
      size: number;
      is1d: boolean;
      /** 0..1. Mixes toward the graded colour, so the control is a STRENGTH
       *  rather than a switch — and matches what the Canvas2D path does. */
      intensity: number;
      domainMin: number;
      domainMax: number;
    }
  | {
      type: 'compound-blur';
      /** Ceiling on the blur, in comp px. The map scales each pixel's radius
       *  between 0 and this, so it is a maximum rather than an amount. */
      maxRadiusPx: number;
      /** Bright areas sharp instead of blurred. */
      invert: boolean;
      /** Renderable id of the layer whose LUMINANCE drives the radius. Unset or
       *  unresolvable → the layer blurs by its own luminance, matching the
       *  displacement-map fallback: visibly wrong and debuggable, rather than a
       *  silent no-op that reads as the effect being broken. */
      mapLayerId?: string;
    }
  | {
      type: 'set-matte';
      /** Renderable id of the layer supplying the coverage. Unset or
       *  unresolvable → the effect is a NO-OP, deliberately. Falling back to
       *  self-matting (as displacement-map does) would multiply the layer by its
       *  own alpha and read as a broken effect rather than an unconfigured one. */
      matteLayerId?: string;
      /** Read the matte's luminance instead of its alpha. */
      useLuminance: boolean;
      invert: boolean;
    }
  | { type: 'motion-tile'; scale: number }
  /**
   * Bend (AE's CC Bender). `angleRad` is the TOTAL bend and `style` indexes the
   * profile (0 Marilyn, 1 Sharp, 2 Circular). Everything else about the bend —
   * where the line sits, which way it runs, how far the bend takes to complete
   * — comes from the two POINTS, exactly as AE's Top and Base do.
   *
   * The points are in ASPECT-CORRECTED layer units: x is scaled by `aspect`
   * (w/h) so one unit means the same distance on both axes. Raw UV would shear
   * any bend line that is not axis-aligned on a non-square layer.
   */
  | {
      type: 'bend';
      angleRad: number; style: number; aspect: number;
      /** True confines the deformation to the Top→Base band; false hinges the
       *  remainder along with it, which is AE's CC Bender behaviour. */
      holdOutside: boolean;
      topX: number; topY: number; baseX: number; baseY: number;
    }
  /**
   * Perspective family. `thickness` is in UV units for the bevels; `lightRad`
   * is the direction light arrives from; `intensity` is a multiplier, not a
   * percentage. Spotlight's cone is a HALF-angle in radians, and `ambient` is
   * what the layer keeps outside it — 0 means fully dark.
   */
  | { type: 'bevel-alpha'; thickness: number; lightRad: number; intensity: number; color: Color }
  | { type: 'bevel-edges'; thickness: number; lightRad: number; intensity: number; color: Color }
  /**
   * Spotlight (CC Spotlight). `from`/`to` are point controls in
   * ASPECT-CORRECTED layer units — between them they carry the light's
   * position, its aim and its reach, so there is no separate direction or
   * radius to contradict them. `coneHalfRad` is measured from the axis;
   * `softness` 0..1 widens the falloff inward from the cone edge.
   */
  | {
      type: 'spotlight';
      fromX: number; fromY: number; toX: number; toY: number;
      coneHalfRad: number; softness: number; intensity: number; ambient: number;
      aspect: number; lightOnly: boolean; reach: number; color: Color;
    }
  /**
   * Sphere / Cylinder. `radius` is a fraction of the layer's short side (1 =
   * the sphere touches the edges); `shading` is 0..1, where 0 is a flat unlit
   * map and 1 lets the limb fall fully dark. Rotations are radians.
   */
  | {
      type: 'sphere';
      radius: number; rotXRad: number; rotYRad: number; rotZRad: number;
      shading: number; aspect: number; color: Color;
    }
  | { type: 'cylinder'; radius: number; rotRad: number; shading: number; color: Color }
  /**
   * Arithmetic (Channel). `operator` indexes AE's menu; `r`/`g`/`b` are the
   * per-channel constants normalised to 0..1 (authored 0..255, as AE does,
   * because the bitwise operators are only meaningful on 8-bit integers).
   */
  | { type: 'arithmetic'; operator: number; r: number; g: number; b: number; clip: boolean }
  /**
   * Round-six GPU ports — per-pixel colour passes whose CPU kernels remain the
   * parity reference (portedEffectContract.test.ts). Colours ride as RAW sRGB
   * fractions rather than working-space Colors: the CPU kernels do their maths
   * on sRGB bytes and CPU↔GPU parity is the contract.
   */
  | {
      type: 'vignette';
      /** Signed strength −1..1 (negative lightens, like the CPU kernel). */
      amount: number;
      inner: number; feather: number; roundness: number;
      /** Centre as fractions of the LAYER box (resolved against fxBox). */
      cx: number; cy: number;
      aspect: number;
    }
  | {
      type: 'black-and-white';
      reds: number; yellows: number; greens: number;
      cyans: number; blues: number; magentas: number;
      /** Precomputed tint hue/sat (0..1); tintOn 0 = plain greyscale. */
      tintOn: number; tintH: number; tintS: number;
    }
  | {
      type: 'tritone';
      sr: number; sg: number; sb: number;
      mr: number; mg: number; mb: number;
      hr: number; hg: number; hb: number;
      blend: number;
    }
  | { type: 'photo-filter'; r: number; g: number; b: number; density: number; preserveLuminosity: boolean }
  | { type: 'threshold'; level: number }
  | { type: 'vibrance'; vibrance: number; saturation: number }
  /**
   * Round-six waves 2–3: warps and neighbourhood passes. All geometry is in
   * LAYER PIXELS plus the layer's pixel size (`lw`/`lh`), so the shader can
   * mirror the CPU kernel's px-space maths exactly and resolve against fxBox.
   */
  | { type: 'mirror'; cx: number; cy: number; nx: number; ny: number; lw: number; lh: number }
  | { type: 'offset'; tx: number; ty: number; keep: number; lw: number; lh: number }
  | { type: 'bulge'; cx: number; cy: number; radius: number; amount: number; lw: number; lh: number }
  | { type: 'twirl'; cx: number; cy: number; radius: number; maxAngle: number; lw: number; lh: number }
  | { type: 'spherize'; cx: number; cy: number; radius: number; amount: number; lw: number; lh: number }
  | {
      type: 'kaleidoscope';
      cx: number; cy: number; rot: number; srcA: number;
      seg: number; scale: number; lw: number; lh: number;
    }
  | {
      type: 'ripple';
      cx: number; cy: number; radius: number; amplitude: number;
      frequency: number; phase: number; decay: number; lw: number; lh: number;
    }
  | {
      type: 'chromatic-aberration';
      amount: number; linear: boolean; lvx: number; lvy: number;
      falloffExp: number; cx: number; cy: number; maxR: number; lw: number; lh: number;
    }
  | { type: 'magnify'; cx: number; cy: number; radius: number; scale: number; square: boolean; feather: number; lw: number; lh: number }
  | { type: 'mosaic'; cols: number; rows: number; sharp: boolean; lw: number; lh: number }
  | { type: 'find-edges'; invert: boolean; blend: number; lw: number; lh: number }
  | { type: 'emboss'; dx: number; dy: number; k: number; keep: number; lw: number; lh: number }
  | { type: 'color-emboss'; ox: number; oy: number; k: number; blend: number; lw: number; lh: number }
  | {
      type: 'halftone';
      cell: number; ca: number; sa: number; k: number;
      inkR: number; inkG: number; inkB: number; colorize: boolean;
      paperR: number; paperG: number; paperB: number; blend: number;
      lw: number; lh: number;
    }
  | { type: 'fill'; color: Color }
  | {
      type: 'stroke';
      widthPx: number;
      color: Color;
      /** 0 = Outside (default), 1 = Inside, 2 = Center. */
      position?: 0 | 1 | 2;
    }
  | { type: 'sharpen'; amount: number }
  /**
   * Beam. Endpoints are fractions of the LAYER's box (0..1), matching the
   * percentage controls, because the chain's buffer is not the layer's box on
   * the 2D route; the pass resolves them against `fxBox`.
   */
  | {
      type: 'beam';
      startX: number; startY: number; endX: number; endY: number;
      /** 0..1 — how far along the path the head has travelled. */
      length: number;
      /** Comp px. */
      thickness: number;
      /** 0..1. Widens the soft outer pass to thickness*(1+softness*3). */
      softness: number;
      color: Color;
    }
  /**
   * Light Sweep. `position` is a fraction of the layer's projected span
   * (−1..2 so the band can start/end off-frame). `sweepWidth` is comp px;
   * `angle` degrees; `softness`/`intensity` 0..1; `composite` matches the
   * Canvas2D modes (0 over · 1 add · 2 screen · 3 multiply · 4 atop).
   */
  | {
      type: 'light-sweep';
      position: number;
      sweepWidth: number;
      angle: number;
      softness: number;
      intensity: number;
      composite: number;
      color: Color;
    }
  /**
   * Lens Flare. `centerX`/`centerY` are offsets from the layer centre in
   * composition pixels (same as the effect controls). `brightness` 0..1;
   * `scale` multiplies the halo/core/ghost radii.
   */
  | {
      type: 'lens-flare';
      centerX: number;
      centerY: number;
      brightness: number;
      scale: number;
      color: Color;
    }
  /**
   * Light Rays. Centre offsets are composition px from the layer mid.
   * `rayLength` is composition px; `opacity`/`falloff`/`spread` are 0..1;
   * `rotation` radians; `composite` matches Canvas2D modes (default add).
   */
  | {
      type: 'light-rays';
      centerX: number;
      centerY: number;
      rayCount: number;
      rayLength: number;
      spread: number;
      rotation: number;
      opacity: number;
      falloff: number;
      seed: number;
      composite: number;
      color: Color;
    }
  | { type: 'noise'; amount: number; evolution: number; monochrome: boolean }
  /**
   * An effect a PLUGIN declared, from WGSL the host validated and compiled.
   *
   * Deliberately opaque to this package. `shader` names a source the app
   * registered into `ShaderRegistry`; `params` is the plugin's half of the
   * uniform block, already packed by the app because only the app knows the
   * plugin's parameter layout.
   *
   * The pass fills in the `mvp`/`uvRect` header before drawing — it is the only
   * thing that knows the transform, and the transform changes per frame while
   * the plugin's parameters do not.
   *
   * The renderer therefore has no idea what a plugin effect DOES, which is the
   * point: supporting one must not mean teaching this package about plugins.
   */
  | {
      type: 'plugin';
      /** Registered shader name — `<pluginId>.<effectId>`, `…#<pass>` after the first. */
      shader: string;
      /** The plugin's parameters, packed at their declared offsets. */
      params: Float32Array;
      /**
       * Which pass of a chain this is. 0 for a single-pass effect.
       *
       * A multi-pass effect arrives as SEVERAL of these entries, in order, and
       * the existing ping-pong runs them — a chain needs no new mechanism here,
       * which is why this package still does not know what a plugin is.
       *
       * Carried as a number rather than folded into `params` because it sits in
       * the shader beside `texelSize`, and the texel size depends on the target
       * being drawn into. That is knowable here and nowhere else, so the whole
       * host block is written on this side.
       */
      passIndex?: number;
      /**
       * Linear downsample of the target this pass renders into. 1 by default.
       *
       * `0.5` renders into a half-size target — a quarter of the pixels — and
       * `0.25` a sixteenth. What makes a bloom affordable, and the upsample is
       * free because whatever samples the result next reads the smaller
       * texture through a linear sampler.
       *
       * Carried here rather than folded into the shader's uniforms because the
       * renderer needs it three ways: to pick the target, to size the
       * viewport, and to compute the texel size the shader reads. Only the
       * first two are this package's business, and the third has to agree with
       * them or a downsampled blur silently comes out too small.
       */
      passScale?: number;
      /**
       * Snapshot this pass's INPUT before drawing, for later passes to read.
       *
       * Set on pass 0 of a chain whose later passes declare `reads: origin`.
       * Decided app-side because only that side knows how this flat list of
       * entries groups into chains — and set per-chain rather than always,
       * because it is a full-screen blit that most chains never look at.
       */
      capturesOrigin?: boolean;
      /**
       * Bind the chain's pass-0 input at binding 4.
       *
       * What a composite step needs: a bloom adds its blurred copy back over
       * the ORIGINAL, which by then is several ping-pongs ago and overwritten.
       */
      readsOrigin?: boolean;
      /**
       * How far this effect draws outside the layer, in composition pixels.
       *
       * Feeds the margin reserved around a 3D layer's effect buffer. Absent or
       * 0 for the majority of effects, which map a pixel to a pixel and stay
       * inside the rectangle.
       *
       * Computed app-side from the effect's LIVE parameters, once per frame —
       * the same job After Effects does in its pre-render phase. A number
       * baked at install would have to be the animated worst case, and would
       * enlarge every 3D layer's buffer on frames where the radius is zero.
       */
      spreadPx?: number;
      /**
       * This effect's shader declares a fourth binding, so its material must
       * too — whether or not a map layer has been chosen.
       *
       * SEPARATE from `mapLayerId` on purpose, and the distinction is the whole
       * correctness argument. `mapLayerId` says which layer the user picked;
       * this says what the compiled shader asks for. An effect that declared a
       * layer parameter and has not been pointed at anything yet still declares
       * `@binding(3)`, and a layout missing it is an invalid pipeline — a dead
       * viewport rather than a missing map. Deriving the layout from
       * `mapLayerId` would produce exactly that, for every effect in its
       * default state.
       */
      readsMap?: boolean;
      /**
       * Renderable id supplying a SECOND texture, bound at 3.
       *
       * The same field name and the same unset rule as `displacement-map`
       * above, deliberately: absent means the effect self-samples rather than
       * being skipped, so a missing map draws something visibly wrong instead
       * of nothing at all.
       *
       * Present only for effects whose material declared the fourth binding.
       * Binding a texture the layout does not declare — or declaring one and
       * binding nothing — are both invalid pipelines, so the two are derived
       * from one predicate on the app side.
       */
      mapLayerId?: string;
      /**
       * Called around the draw so a device loss can be attributed to this
       * effect. Injected rather than imported: this package must not know that
       * plugins exist, and the app must not have to reach into the pass.
       */
      onDraw?: { begin(): void; end(): void };
    };

export interface Renderable {
  id: string;
  kind: RenderableKind;
  /** Maps the unit quad [0,1]² to the object's world-space quad. */
  modelMatrix: Mat3;
  /** World-space axis-aligned bounds, for culling. */
  bounds: Rect;
  opacity: number;
  blend: BlendMode;
  /** Advanced blend mode id (1..15) when the layer uses a blend that fixed-
   *  function GL can't do (overlay/hard-light/HSL/…). When set, `blend` stays
   *  'normal' and CompositionPass routes the layer through the backdrop-sampling
   *  BLEND_COMBINE shader instead. 0/undefined = simple blend via `blend`. */
  advancedBlend?: number;
  /**
   * Preserve Underlying Transparency: composite `source-atop` the accumulated
   * backdrop instead of `source-over`. Needs the backdrop as a shader input for
   * exactly the reason `advancedBlend` does, so it routes the same way — and it
   * COMPOSES with `advancedBlend` rather than replacing it.
   */
  preserveTransparency?: boolean;
  /**
   * Force this renderable off the depth-tested 3D path.
   *
   * Not a property of the layer — a property of the OBJECT it belongs to. An
   * extrusion is one solid spread across up to fourteen renderables, and
   * `depthEligible3D` is asked one renderable at a time, so any exclusion that
   * catches some faces and not others splits the body between the depth group
   * and the affine painter path. The snapshot adapter sets this on every face of
   * such an object so they stay together (`enforceExtrusionPathAgreement`).
   *
   * Written by the adapter only; nothing in the renderer sets it.
   */
  depthExempt?: boolean;
  /**
   * Frosted-glass backdrop blur radius in device px (0/undefined = off).
   *
   * Blurs what is BEHIND the layer and shows it through the layer's own alpha —
   * the one primitive a "glass" look cannot be faked without, since a normal
   * blur effect blurs the layer itself. Needs a samplable out target, exactly
   * like `advancedBlend`, so the adapter forces `hasEffects` when any layer
   * requests it.
   */
  backdropBlur?: number;
  /**
   * The GLASS layer style: refraction, tint, rim, specular and grain applied to
   * the blurred backdrop in one pass.
   *
   * Rides the same backdrop machinery as `backdropBlur` — which supplies the
   * frosted base — and replaces the plain masked composite with the glass
   * shader. Set without `backdropBlur` it still works; the "backdrop" is then
   * simply unblurred, which is what clear glass looks like.
   */
  glass?: RenderableGlass;
  /**
   * AE's per-layer Quality/Sampling switch: 'nearest' samples this layer's
   * texture with NEAREST instead of linear — faster, and visibly blocky when
   * the layer is scaled up. Absent = linear, the default everywhere else.
   *
   * Only meaningful for textured kinds; a solid rect samples nothing.
   */
  sampling?: 'nearest' | 'linear';
  /** Fill/tint color (rect, text). */
  color?: Color;
  /** SDF geometry for solid shapes (rounded-rect / ellipse). */
  sdf?: RenderableSdf;
  /** Colour-grade transform applied to a textured sample (image/text/video). */
  colorMatrix?: RenderableColorMatrix;
  /** Spatial post-processing effects (blur, glow, drop-shadow). */
  effects?: RenderableEffect[];
  /** Key into the texture provider (image/video). */
  textureKey?: string;
  /** Sub-rectangle of the source texture in [0,1] uv space (atlas/crop). */
  uvRect?: Rect;
  /** Clip children to this node's bounds. */
  clip?: boolean;
  /**
   * Motion-blur sub-frame samples: the layer accumulates ADDITIVELY into an
   * offscreen at each sample's transform × 1/n weight, then composites once —
   * the exact shutter-interval mean Canvas2D computes. Each entry carries the
   * fully-composed model matrix for that sub-frame plus its sampled opacity.
   */
  motionSamples?: ReadonlyArray<{ modelMatrix: Mat3; opacity: number }>;
  /**
   * Corner Pin homography as four normalised [0,1] corners (TL,TR,BR,BL). When
   * present, the draw composes `modelMatrix · squareToQuad(cornerPin)` into a
   * PROJECTIVE mvp so the layer is perspective-warped onto the quad; the shaders
   * emit p.z as w so the hardware divides and interpolates UVs correctly.
   * `modelMatrix` itself stays AFFINE (bounds, 3D and hit paths depend on that);
   * the pin is a pure render stage. Absent = no pin, fully affine.
   */
  cornerPin?: readonly [number, number, number, number, number, number, number, number];
  /** Id of a renderable used as an alpha mask. */
  maskId?: string;
  /** Texture key for a pre-rasterized alpha mask. */
  maskTextureKey?: string;
  /** Texture key for a 256×1 per-channel colour LUT (Levels/Curves/Posterize).
   *  When set, the layer is remapped through it after the affine colour grade. */
  lutTextureKey?: string;
  /** Adjustment layer: instead of drawing content, re-composite EVERYTHING drawn
   *  beneath this point through the given grade (an affine colour matrix and/or a
   *  LUT). CompositionPass copies the accumulated colour target and redraws it
   *  through the grade. Present => this renderable draws no content of its own. */
  adjustment?: { colorMatrix?: RenderableColorMatrix; lutTextureKey?: string };
  /** Track matte: this layer's alpha comes from the matte source `sourceId`
   *  (alpha or luma, optionally inverted). CompositionPass renders both to
   *  full-comp targets and combines them. */
  matte?: { mode: 'alpha' | 'luma'; inverted: boolean; sourceId: string };
  matteSource?: boolean;
  /**
   * Isolated precomp (nested composition): CompositionPass renders these child
   * renderables into an offscreen target, then composites that texture as ONE
   * unit with this renderable's opacity / blend / effects / mask / matte —
   * exactly like a single layer. Used when the container carries group opacity
   * over multiple children, a mask/matte, a non-normal blend, or effects; the
   * adapter keeps the cheap inline-collapse path otherwise. Children are in
   * the container's local (comp) space with identity parent transform.
   */
  precomp?: { renderables: Renderable[] };
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
  /**
   * Extruded solid geometry for a 3D layer with depth — side walls, bevel
   * rings and caps as ONE indexed mesh with per-vertex normals (built by
   * core/geometry/extrudeMesh.ts). Drawn through the depth-tested mesh path;
   * each `range` is one material group with its own colour (a back cap may
   * instead carry the layer's content via `textured`). `threeD.model` maps the
   * mesh's layer-centred pixel frame straight to 3D comp space — unlike a quad
   * renderable there is no unit-quad bridge. `key` identifies the geometry for
   * GPU buffer caching and must change whenever the vertices do.
   */
  extrudedMesh?: {
    key: string;
    /** Interleaved position xyz, normal xyz, uv — 8 floats per vertex. */
    vertices: Float32Array;
    indices: Uint16Array | Uint32Array;
    ranges: ReadonlyArray<{
      role: 'front' | 'back' | 'side' | 'bevel';
      first: number;
      count: number;
      color: Color;
      /** Fixed brightness when the scene has no lights (AE's face shading). */
      gain: number;
      /** Sample the layer's own texture instead of the flat colour. */
      textured?: boolean;
    }>;
    /**
     * An imported glTF material's maps beyond base colour. Present only when
     * the material carries at least one, which is what selects the `mesh3d-pbr`
     * pipeline — an extrusion, or a model with nothing but a base-colour
     * texture, keeps the exact shader (and therefore the exact pixels) it had
     * before this existed. Keys resolve through the texture registry like any
     * other; an absent one binds white, the identity for every multiplicative
     * map (see the shader's note).
     */
    pbr?: {
      normalKey?: string;
      metallicRoughnessKey?: string;
      occlusionKey?: string;
      emissiveKey?: string;
      /** `normalTexture.scale`. */
      normalScale: number;
      /** `occlusionTexture.strength`. */
      occlusionStrength: number;
      /** emissiveFactor × KHR_materials_emissive_strength, linear. */
      emissive: readonly [number, number, number];
    };
  };
  /**
   * True 3D placement (AE Classic-3D GPU path). `model` is the 16-number
   * column-major world matrix mapping the unit quad [0,1]² onto the layer's
   * plane in 3D comp space (the w×h + centre bridge already folded in). When
   * present AND the scene carries `camera3d`, CompositionPass renders the
   * layer through the depth-tested mat4 pipeline so intersecting 3D planes
   * composite per-pixel. `modelMatrix` above remains the CPU-projected affine
   * FALLBACK — hit-testing, bounds, and any branch the 3D group path can't
   * take (effects / mattes / adjustment / advanced blend / deformed meshes)
   * keep using it, so nothing ever renders in the wrong place.
   */
  threeD?: {
    model: readonly number[];
    /**
     * This renderable throws a geometric shadow (Material Options → Casts
     * Shadows). Read only when a light in the run has `shadowMap` on: it
     * selects the members drawn into the map.
     *
     * Separate from `shade` on purpose. `shade` is present only when the layer
     * ACCEPTS LIGHTS, and a layer that refuses lighting still blocks it —
     * hanging casting off the shade block would make an unlit card in front of
     * a lamp transparent to it.
     */
    castsShadow?: boolean;
    /**
     * Per-fragment shading (Material Options → Accepts Lights). When the
     * renderable draws through the depth-tested group path, the 3d shaders run
     * real per-fragment Lambert + Blinn-Phong specular using the scene's
     * `lights3d` and camera eye. `quadGain` is the CPU per-quad gain fallback:
     * any branch that can't shade per-fragment (no scene lights delivered, or
     * the renderable dropped to the affine painter path) multiplies it into
     * the tint instead, so lighting is never silently lost or double-applied.
     */
    shade?: {
      /** Blinn-Phong specular intensity, normalised 0..1 (0 = plain Lambert). */
      specular: number;
      /** Blinn-Phong exponent. */
      shininess: number;
      /** Metal 0..1: tints the highlight toward the layer's own colour. */
      metal?: number;
      /** PBR roughness 0..1. Present ⇒ GGX model — see `Shade3D.roughness`. */
      roughness?: number;
      /** Cel bands 2–8. Present ⇒ toon quantization — see `Shade3D.toonBands`. */
      toonBands?: number;
      /** Per-quad Lambert gain fallback (adapter-computed). */
      quadGain?: readonly [number, number, number];
      /** Light this surface from one side — see `Shade3D.oneSided`. Set by an
       *  extrusion's walls and back cap, which bound a volume. */
      oneSided?: boolean;
      /** Material Ambient % (AE). Scales ambient lights on the GPU path. */
      ambient?: number;
      /** Material Diffuse % (AE). Scales Lambert on the GPU path. */
      diffuse?: number;
      /**
       * This surface RECEIVES a geometric shadow (Material Options → Accepts
       * Shadows). False keeps the surface fully lit even where the map says it
       * is occluded — the shadow-catcher switch, honoured on the GPU path the
       * same way the projected copy already honours it on the CPU one.
       */
      acceptsShadows?: boolean;
    };
  };
}

/**
 * True when a renderable can render through the depth-tested 3D group path.
 *
 * Excluded cases genuinely need multi-target compositing (track mattes,
 * adjustment layers, advanced blend, precomp isolation), an accumulation target
 * (motion blur), or non-quad geometry (deformed meshes) — those fall back to the
 * CPU-projected affine `modelMatrix`.
 *
 * Spatial EFFECTS (blur/glow/drop-shadow/…) are ALLOWED: a 3D layer's effect
 * chain resolves to a single texture in 2D layer space, which CompositionPass's
 * render3DGroup pre-resolves into an offscreen target and then draws as a
 * textured3d quad INSIDE the depth pass — so the effect RESULT plane depth-
 * tests / intersects / lights like any other 3D quad, instead of dropping to the
 * affine painter path and losing per-pixel intersection with its 3D siblings.
 *
 * SHARED by CompositionPass (which partitions groups with it) and the snapshot
 * adapter (which decides whether to pre-fold the per-quad light gain into the
 * tint) — the two MUST agree or lit layers double- or under-light. A lit layer
 * that also carries an effect is now depth-eligible, so the adapter attaches
 * `threeD.shade` (per-fragment lighting on the effect result) rather than
 * folding the per-quad gain — the correct, desired behaviour.
 */
export function depthEligible3D(r: Renderable): boolean {
  if (!r.threeD) return false;
  // Set by the snapshot adapter when this renderable belongs to an object whose
  // OTHER parts are ineligible — an extrusion's faces, which are one solid
  // spread across many renderables. Without it a per-renderable exclusion cuts
  // the object in half: the excluded faces take the affine painter path while
  // their siblings stay depth-tested, and the two halves visibly come apart.
  // See `enforceExtrusionPathAgreement`. Checked FIRST so the exemption cannot
  // be overtaken by a rule below it.
  if (r.depthExempt) return false;
  if (r.matteSource || r.matte || r.adjustment || r.precomp) return false;
  if (r.advancedBlend && r.advancedBlend > 0) return false;
  // Reads the accumulated backdrop's alpha, which the depth pass cannot supply.
  if (r.preserveTransparency) return false;
  // GLASS / backdrop blur read what is composited BENEATH the layer, which the
  // depth pass cannot supply: it draws into the scene target it would have to
  // sample. render3DGroup has no backdrop branch, so a 3D glass panel used to
  // fall through to the plain solid draw and render as an opaque white card —
  // the style silently gone the moment the layer's 3D switch was flipped.
  // Excluded for exactly the reason `advancedBlend` is (it samples the backdrop
  // too): the affine painter path renders it correctly, at the cost of
  // per-pixel depth intersection with its 3D siblings.
  if (r.glass || (r.backdropBlur && r.backdropBlur > 0)) return false;
  if (r.motionSamples && r.motionSamples.length > 1) return false;
  if (r.deformedMesh) return false;
  return true;
}

/** A scene light in shader terms for the per-fragment 3D lighting path. */
export interface SceneLight3D {
  type: 'ambient' | 'point' | 'spot' | 'parallel';
  color: { r: number; g: number; b: number };
  /** intensity/100. */
  gain: number;
  x: number;
  y: number;
  z: number;
  radius: number;
  /** Resolved 3D UNIT aim — the Point of Interest direction, or this light
   *  type's legacy 2D-angle fallback. */
  aimX: number;
  aimY: number;
  aimZ: number;
  /** Spot half-cone in radians. */
  halfConeRad: number;
  /** Spot cone feather in ABSOLUTE radians (0 = hard edge). */
  coneFeatherRad: number;
  /** 0 none (legacy hard cutoff + linear ramp), 1 smooth, 2 inverse-square. */
  falloffMode: number;
  /** Smooth-curve span in px, default already applied. */
  falloffDistance: number;
  /**
   * Render this light's GEOMETRIC shadow — the run's casters rasterised from
   * the light into a depth map, sampled per fragment.
   *
   * Opt-in, and absent means off, because the alternative it replaces is not
   * broken: a 2.5D projected caster copy (see `buildSnapshot`) lands a correct
   * silhouette on the nearest accepting plane and costs nothing. A map buys
   * what that cannot express — a shadow that curves over the receiver's own
   * geometry, that a caster casts onto ITSELF, and that respects more than one
   * receiving surface — at the price of a second render of every caster.
   *
   * When this is on, the adapter must SUPPRESS this light's projected copy, or
   * the frame carries two shadows from one lamp.
   */
  shadowMap?: boolean;
  /** Map resolution; the renderer clamps to 512 / 1024 / 2048. */
  shadowMapSize?: number;
  /** Depth bias in WORLD units, subtracted from the receiver's distance before
   *  the comparison. Too little and a lit surface stripes itself; too much and
   *  a shadow detaches from the foot of its caster. */
  shadowBias?: number;
  /** PCF tap spacing, in map texels. 1 = a plain 3×3; larger softens the edge
   *  at the cost of banding, since the tap count stays 9. */
  shadowSoftness?: number;
  /** AE's Shadow Darkness as a FRACTION — how much of this light a caster
   *  blocks. 1 (the default) blocks all of it, which on a single-light scene
   *  renders the occluded surface pure black. */
  shadowDarkness?: number;
}

export interface CompositionInfo {
  id: string;
  size: Size;
  background?: Color;
}

export interface FrameScene {
  composition: CompositionInfo;
  /** Renderables in paint order (back to front). */
  renderables: Renderable[];
  /** True if any layer in the frame has post-processing effects. */
  hasEffects?: boolean;
  /**
   * The comp frame index, for Dancing Dissolve's per-frame re-roll (advanced
   * blend id 36). Scene-wide rather than per-renderable because it is a fact
   * about the FRAME, not the layer — and the adapter computes it from the
   * playhead, so the shader stays clock-free and export matches preview.
   * Absent (an adapter that predates it, `emptyScene`) means 0: Dancing
   * Dissolve degrades to plain Dissolve rather than to noise.
   */
  dissolveFrame?: number;
  /**
   * 3D camera for the depth-tested layer path: column-major 4×4 view and
   * projection (world → homogeneous COMP-space clip; the 2D pan/zoom camera is
   * lifted on top at draw time). Present when the frame contains 3D layers;
   * produced by the adapter from the SAME scalar camera the CPU affine
   * projection uses, so both paths agree.
   */
  camera3d?: {
    view: readonly number[];
    projection: readonly number[];
    /** Camera world position — the Blinn-Phong eye. Absent for ortho views
     *  (specular is skipped there). */
    eye?: readonly [number, number, number];
  };
  /** Scene lights for per-fragment Accepts-Lights shading in 3D groups. */
  lights3d?: ReadonlyArray<SceneLight3D>;
  /**
   * The comp's environment light as a prefiltered REFLECTION map.
   *
   * `lights3d` already carries the same environment's low-frequency
   * IRRADIANCE, as a derived rig of one ambient plus up to six parallels (see
   * core/scene/environmentLight.ts). That rig says how much light reaches a
   * surface; it cannot say what the surface mirrors, which is what a smooth
   * Physical material needs. So this is the second half of one environment,
   * not a second environment — the two share a rotation and an intensity, and
   * the shader turns them together.
   *
   * Present only when the comp HAS an environment light. Absent packs
   * `envParams` as zeros and the shader's reflection block never runs, which
   * is the gate that keeps every other scene bit-identical.
   */
  envMap?: EnvironmentMap;
}

/**
 * A prefiltered specular environment, as raw texels the pass uploads itself.
 *
 * PIXELS rather than a `textureKey`, unlike every other image in this DTO: the
 * texture registry resolves keys the APP registered, and the environment atlas
 * is derived (a preset is procedural, and an image sky's atlas is built from a
 * decode the app throws away) — routing it through the registry would mean
 * inventing a registration for something no layer references. `id` is what
 * makes that cheap: the pass keys its GPU texture off it and re-uploads only
 * when the sky itself changes, so a keyframed rotation costs one uniform.
 */
export interface EnvironmentMap {
  /** Identity of the CONTENT. Same id ⇒ same texels ⇒ no re-upload. */
  id: string;
  /** Full atlas size — `levels` equirect bands stacked top to bottom. */
  width: number;
  height: number;
  /** Roughness levels; must equal the renderer's `ENV_SPEC_LEVELS`. */
  levels: number;
  /** Multiplier the shader applies after squaring the stored value. */
  scale: number;
  /** RGBA8, `width * height * 4` bytes. */
  data: Uint8Array;
  /** Environment intensity (Intensity/100 x Reflections/100). */
  intensity: number;
  /** Environment rotation in DEGREES, as the light layer stores it. */
  rotationDeg: number;
}

/** An empty scene for a given composition. */
export function emptyScene(id = 'default', width = 1920, height = 1080): FrameScene {
  return { composition: { id, size: { width, height } }, renderables: [] };
}
