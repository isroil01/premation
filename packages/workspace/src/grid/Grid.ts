/**
 * Grid — an adaptive, infinite reference grid. Chooses a spacing that keeps
 * on-screen grid lines within a comfortable pixel range regardless of zoom, and
 * emits *minor* and *major* line sets for the visible region only (never the
 * whole infinite plane). The renderer draws them; this class just computes
 * geometry.
 *
 * Adaptive stepping uses a 1-2-5 progression (like rulers and chart axes) so the
 * grid subdivides/coalesces smoothly as you zoom. `major` lines land every
 * `majorEvery` cells.
 */

import type { Rect } from '../math/Rect';

export interface GridState {
  visible: boolean;
  /** Base world-space cell size at zoom 1. */
  baseSize: number;
  /** Major line every N minor cells. */
  majorEvery: number;
  /** Opacity multiplier for the whole grid [0..1]. */
  opacity: number;
  /** Target on-screen spacing (px) the adaptive stepper aims for. */
  targetScreenSpacing: number;
}

/** One axis of grid lines, in world coordinates. */
export interface GridLines {
  /** Chosen world-space spacing for minor lines at this zoom. */
  minorSpacing: number;
  majorSpacing: number;
  /** On-screen spacing (px) of minor lines — useful for fade. */
  minorScreenSpacing: number;
  /** World X positions of vertical lines. */
  verticalsMinor: number[];
  verticalsMajor: number[];
  /** World Y positions of horizontal lines. */
  horizontalsMinor: number[];
  horizontalsMajor: number[];
  /** Suggested opacity fade for minor lines as they get dense/sparse. */
  minorOpacity: number;
}

const DEFAULT_STATE: GridState = {
  visible: true,
  baseSize: 10,
  majorEvery: 5,
  opacity: 1,
  targetScreenSpacing: 24,
};

export class Grid {
  private state: GridState;

  constructor(state: Partial<GridState> = {}) {
    this.state = { ...DEFAULT_STATE, ...state };
  }

  getState(): GridState {
    return { ...this.state };
  }

  setState(patch: Partial<GridState>): void {
    this.state = { ...this.state, ...patch };
  }

  setVisible(visible: boolean): void {
    this.state.visible = visible;
  }

  setBaseSize(size: number): void {
    this.state.baseSize = Math.max(1e-6, size);
  }

  setOpacity(opacity: number): void {
    this.state.opacity = Math.min(1, Math.max(0, opacity));
  }

  /**
   * Pick a "nice" world-space spacing whose on-screen size is closest to the
   * target, snapped to the 1-2-5 progression scaled by `baseSize`.
   */
  adaptiveSpacing(zoom: number): number {
    const { baseSize, targetScreenSpacing } = this.state;
    // Desired world spacing so that spacing*zoom ≈ target.
    const desiredWorld = targetScreenSpacing / zoom;
    // Work in multiples of baseSize.
    const ratio = desiredWorld / baseSize;
    const pow = Math.floor(Math.log10(ratio));
    const base = Math.pow(10, pow);
    const candidates = [base, base * 2, base * 5, base * 10];
    let best = candidates[0]!;
    let bestErr = Infinity;
    for (const c of candidates) {
      const err = Math.abs(Math.log(c) - Math.log(ratio));
      if (err < bestErr) {
        bestErr = err;
        best = c;
      }
    }
    return Math.max(1e-6, best * baseSize);
  }

  /**
   * Compute the visible grid lines for a world-space region at a given zoom.
   * Returns world coordinates; convert to screen at draw time.
   */
  computeLines(visibleWorld: Rect, zoom: number): GridLines {
    const minorSpacing = this.adaptiveSpacing(zoom);
    const majorSpacing = minorSpacing * this.state.majorEvery;
    const minorScreenSpacing = minorSpacing * zoom;

    const verticalsMinor: number[] = [];
    const verticalsMajor: number[] = [];
    const horizontalsMinor: number[] = [];
    const horizontalsMajor: number[] = [];

    const majorEps = majorSpacing * 1e-6;
    const isMajor = (v: number): boolean => {
      const m = v / majorSpacing;
      return Math.abs(m - Math.round(m)) < 1e-6 || Math.abs((v % majorSpacing)) < majorEps;
    };

    const startX = Math.floor(visibleWorld.x / minorSpacing) * minorSpacing;
    const endX = visibleWorld.x + visibleWorld.width;
    for (let x = startX; x <= endX; x += minorSpacing) {
      if (isMajor(x)) verticalsMajor.push(x);
      else verticalsMinor.push(x);
    }

    const startY = Math.floor(visibleWorld.y / minorSpacing) * minorSpacing;
    const endY = visibleWorld.y + visibleWorld.height;
    for (let y = startY; y <= endY; y += minorSpacing) {
      if (isMajor(y)) horizontalsMajor.push(y);
      else horizontalsMinor.push(y);
    }

    // Fade minor lines in/out near the target so density stays comfortable.
    const t = minorScreenSpacing / this.state.targetScreenSpacing;
    const minorOpacity = this.state.opacity * Math.min(1, Math.max(0, t));

    return {
      minorSpacing,
      majorSpacing,
      minorScreenSpacing,
      verticalsMinor,
      verticalsMajor,
      horizontalsMinor,
      horizontalsMajor,
      minorOpacity,
    };
  }
}
