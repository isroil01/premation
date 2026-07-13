/**
 * Core value types for the Scene Graph Engine. Pure data — no behavior, no
 * framework, no DOM. These are shared by nodes, components, and systems.
 */

/** A 2D vector / point. */
export interface Vec2 {
  x: number;
  y: number;
}

/** A 3D vector / point. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** A 2D size. */
export interface Size {
  width: number;
  height: number;
}

/**
 * A 4x4 matrix in **column-major** order (WebGL / gl-matrix convention):
 * `index = col * 4 + row`, translation in indices 12/13/14. Used for 3D (and
 * lifted-2D) transforms. See `../utils/matrix4`.
 */
export type Matrix4 = [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
];

/**
 * A 2D affine transform in the canonical 6-value form (same convention as
 * SVG/Canvas `matrix(a,b,c,d,e,f)`):
 *
 *   | a c e |
 *   | b d f |
 *   | 0 0 1 |
 */
export interface Matrix2D {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

/** Compositing blend modes (superset of CSS `mix-blend-mode`). */
export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'color-dodge'
  | 'color-burn'
  | 'hard-light'
  | 'soft-light'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity';

/** Arbitrary metadata / user-defined custom properties. */
export type Metadata = Record<string, unknown>;

/** Millisecond epoch timestamp. */
export type Timestamp = number;

/** Branded node id (a uuid string) for a little extra type-safety. */
export type NodeId = string & { readonly __brand: 'NodeId' };
