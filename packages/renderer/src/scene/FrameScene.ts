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
  | { type: 'drop-shadow'; radiusPx: number; color?: Color; offsetX: number; offsetY: number };

export interface Renderable {
  id: string;
  kind: RenderableKind;
  /** Maps the unit quad [0,1]² to the object's world-space quad. */
  modelMatrix: Mat3;
  /** World-space axis-aligned bounds, for culling. */
  bounds: Rect;
  opacity: number;
  blend: BlendMode;
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
  /** Id of a renderable used as an alpha mask. */
  maskId?: string;
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
