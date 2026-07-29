/** Workspace math primitives: 2D vectors, affine matrices, and rectangles. */

export * as Vec from './Vec2';
export * as Mat from './Mat2D';
export * as Rect from './Rect';
export * as OBox from './OrientedBox';

export type { Vec2 } from './Vec2';
export type { Mat2D } from './Mat2D';
export type { Rect as RectType } from './Rect';
export type { Corners } from './OrientedBox';

/** A 2D size. */
export interface Size {
  width: number;
  height: number;
}
