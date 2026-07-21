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
  };
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
}

/** An empty scene for a given composition. */
export function emptyScene(id = 'default', width = 1920, height = 1080): FrameScene {
  return { composition: { id, size: { width, height } }, renderables: [] };
}
