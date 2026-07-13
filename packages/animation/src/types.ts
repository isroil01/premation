/**
 * Animation Engine — data models.
 *
 * A property track is a sequence of keyframes for one animatable numeric
 * property of one node (e.g. node "shape_circle", prop "x"). The engine samples
 * tracks at a given time to produce a value snapshot the renderer consumes.
 * Values are numbers in v1 (position/rotation/scale/opacity); vector/color
 * properties are represented as separate scalar tracks (x, y, …).
 */

export type PropPath = string; // e.g. 'x' | 'y' | 'rotation' | 'opacity' | 'scale'

export type EasingKind =
  | 'linear'
  | 'step'
  | 'ease'
  | 'easeIn'
  | 'easeOut'
  | 'easeInOut'
  | 'bezier';

/** Cubic-bezier control points [x1, y1, x2, y2] (x in 0..1, y may overshoot). */
export type BezierHandles = [number, number, number, number];

export interface Keyframe {
  /** Time in seconds. */
  t: number;
  value: number;
  /** Easing applied on the segment that STARTS at this keyframe. */
  easing?: EasingKind;
  /** Control points when `easing === 'bezier'`. */
  bezier?: BezierHandles;
  /** Roving: the keyframe's TIME is auto-positioned between its anchor
   *  neighbours for constant speed (its value is unchanged). Ends can't rove. */
  roving?: boolean;
}

export interface PropertyTrack {
  nodeId: string;
  prop: PropPath;
  /** Sorted ascending by `t`. */
  keyframes: Keyframe[];
}

/** Evaluated animated values at a time: nodeId → (prop → value). */
export type SceneValueSnapshot = ReadonlyMap<string, ReadonlyMap<PropPath, number>>;
