/**
 * Normalized input events. The workspace never binds to DOM `PointerEvent`
 * directly — a host adapter translates raw device events into these plain
 * value objects, so the engine runs identically in a browser, in Electron, or
 * under a Node test harness. Coordinates are **screen/client pixels**; the
 * workspace projects them into world space.
 */

import type { Vec2 } from '../math/Vec2';

export type PointerType = 'mouse' | 'pen' | 'touch';
export type PointerButton = 'left' | 'middle' | 'right' | 'none';

export interface Modifiers {
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
  /** Platform-normalized "primary" modifier (⌘ on macOS, Ctrl elsewhere). */
  mod: boolean;
}

export const NO_MODIFIERS: Modifiers = {
  shift: false,
  ctrl: false,
  alt: false,
  meta: false,
  mod: false,
};

export interface PointerInput {
  /** Screen/client-space position. */
  position: Vec2;
  pointerType: PointerType;
  button: PointerButton;
  /** Bitmask-ish flags of currently pressed buttons (left/middle/right). */
  buttons: { left: boolean; middle: boolean; right: boolean };
  modifiers: Modifiers;
  /** Pen/touch pressure [0..1] when available (mouse = 0.5). */
  pressure: number;
  /** Monotonic timestamp (ms). */
  time: number;
  pointerId: number;
}

export interface WheelInput {
  position: Vec2;
  /** Scroll delta (positive = down/away). */
  deltaX: number;
  deltaY: number;
  /** True when the gesture is a pinch-zoom (ctrl+wheel on trackpads). */
  isZoom: boolean;
  modifiers: Modifiers;
  time: number;
}

export interface KeyInput {
  /** `KeyboardEvent.key` (e.g. "a", "Escape", "ArrowLeft"). */
  key: string;
  /** `KeyboardEvent.code` (physical key, e.g. "KeyA", "Space"). */
  code: string;
  modifiers: Modifiers;
  repeat: boolean;
  time: number;
}

export interface GestureInput {
  /** Trackpad pinch/rotate. */
  type: 'pinch' | 'rotate' | 'pan';
  position: Vec2;
  /** Pinch scale factor (1 = no change) or pan delta magnitude. */
  scale: number;
  rotation: number;
  delta: Vec2;
  modifiers: Modifiers;
  time: number;
}
