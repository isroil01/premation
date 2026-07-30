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
  | { type: 'blur'; radiusPx: number }
  | { type: 'glow'; radiusPx: number; color?: Color }
  | { type: 'drop-shadow'; radiusPx: number; color?: Color; offsetX: number; offsetY: number }
  | { type: 'gradient-ramp'; blend: number; colorA?: Color; colorB?: Color }
  | { type: 'fractal-noise'; scale: number }
  | {
      type: 'displacement-map';
      amount: number;
      /** Renderable id of the layer whose pixels drive the displacement.
       *  Unset/unresolvable → the layer displaces by its own content. */
      mapLayerId?: string;
    }
  | { type: 'motion-tile'; scale: number }
  | { type: 'fill'; color: Color }
  | { type: 'stroke'; widthPx: number; color: Color }
  | { type: 'sharpen'; amount: number }
  | { type: 'noise'; amount: number; evolution: number; monochrome: boolean };

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
  /**
   * This layer's source texture holds PREMULTIPLIED colour, so the shader must
   * divide the premultiplication back out before grading (After Effects'
   * Interpret Footage ▸ Alpha ▸ Premultiplied). Absent/false = straight, which
   * is the default and every existing project.
   */
  premultipliedSource?: boolean;
  /** Clip children to this node's bounds. */
  clip?: boolean;
  /**
   * Motion-blur sub-frame samples: the layer accumulates ADDITIVELY into an
   * offscreen at each sample's transform × 1/n weight, then composites once —
   * the exact shutter-interval mean Canvas2D computes. Each entry carries the
   * fully-composed model matrix for that sub-frame plus its sampled opacity.
   */
  motionSamples?: ReadonlyArray<{ modelMatrix: Mat3; opacity: number }>;
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
      /** Per-quad Lambert gain fallback (adapter-computed). */
      quadGain?: readonly [number, number, number];
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
  if (r.matteSource || r.matte || r.adjustment || r.precomp) return false;
  if (r.advancedBlend && r.advancedBlend > 0) return false;
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
  /** cos/sin of the light's 2D aim angle. */
  aimX: number;
  aimY: number;
  /** Spot half-cone in radians. */
  halfConeRad: number;
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
  /** Selected renderable ids (drives the selection overlay pass). */
  selection?: string[];
  /** True if any layer in the frame has post-processing effects. */
  hasEffects?: boolean;
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
}

/** An empty scene for a given composition. */
export function emptyScene(id = 'default', width = 1920, height = 1080): FrameScene {
  return { composition: { id, size: { width, height } }, renderables: [] };
}
