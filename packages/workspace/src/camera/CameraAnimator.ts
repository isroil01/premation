/**
 * CameraAnimator — tween the camera toward a target state over time. The host
 * drives it from its animation loop via `update(dtMs)`; the animator eases
 * center and zoom (zoom in log space so it feels perceptually linear). Kept
 * separate from `Camera` so instantaneous ops (drag-pan) stay allocation-free.
 */

import type { Camera, CameraState } from './Camera';
import type { Vec2 } from '../math/Vec2';

export type Easing = (t: number) => number;

/** Smooth ease-in-out, the default for camera moves. */
export const easeInOutCubic: Easing = (t) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

interface Tween {
  fromCenter: Vec2;
  toCenter: Vec2;
  fromLogZoom: number;
  toLogZoom: number;
  elapsed: number;
  duration: number;
  easing: Easing;
  onDone?: () => void;
}

export class CameraAnimator {
  private tween: Tween | null = null;

  constructor(private readonly camera: Camera) {}

  get isAnimating(): boolean {
    return this.tween !== null;
  }

  /** Animate to a target camera state over `durationMs`. */
  animateTo(target: CameraState, durationMs = 300, easing: Easing = easeInOutCubic, onDone?: () => void): void {
    const state = this.camera.getState();
    if (durationMs <= 0) {
      this.camera.setState(target);
      onDone?.();
      return;
    }
    this.tween = {
      fromCenter: state.center,
      toCenter: { ...target.center },
      fromLogZoom: Math.log(Math.max(1e-6, state.zoom)),
      toLogZoom: Math.log(Math.max(1e-6, target.zoom)),
      elapsed: 0,
      duration: durationMs,
      easing,
      ...(onDone ? { onDone } : {}),
    };
  }

  /** Immediately stop any in-flight animation, leaving the camera where it is. */
  cancel(): void {
    this.tween = null;
  }

  /**
   * Advance the animation by `dtMs`. Returns true while animating (so the host
   * knows to keep the frame loop warm), false once idle.
   */
  update(dtMs: number): boolean {
    const tw = this.tween;
    if (!tw) return false;
    tw.elapsed = Math.min(tw.duration, tw.elapsed + dtMs);
    const t = tw.easing(tw.elapsed / tw.duration);
    const cx = tw.fromCenter.x + (tw.toCenter.x - tw.fromCenter.x) * t;
    const cy = tw.fromCenter.y + (tw.toCenter.y - tw.fromCenter.y) * t;
    const zoom = Math.exp(tw.fromLogZoom + (tw.toLogZoom - tw.fromLogZoom) * t);
    this.camera.setState({ center: { x: cx, y: cy }, zoom });
    if (tw.elapsed >= tw.duration) {
      const done = tw.onDone;
      this.tween = null;
      done?.();
      return false;
    }
    return true;
  }
}
