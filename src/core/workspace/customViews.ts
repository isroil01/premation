/**
 * Custom Views — AE-parity navigable 3D views that NEVER touch the scene's
 * Camera layer.
 *
 * Each custom view is a stored orbit configuration (yaw/pitch/distance/POI) in
 * guidesStore; the renderer builds a projection camera FROM these params via
 * the exact same Project3D helpers the scene camera resolver (camera3d.ts)
 * uses, so a custom view shows the same scene from anywhere without moving the
 * shot camera. Camera navigation (Alt+drag / Alt+wheel / C-tools) writes THESE
 * params while a custom view is active — see cameraNav.ts.
 *
 * Pure and store-free: everything here is testable math + types.
 */

import { Project3D, type Camera3D } from '@motion/scene';

export const CUSTOM_VIEW_IDS = ['custom1', 'custom2', 'custom3'] as const;
export type CustomViewId = (typeof CUSTOM_VIEW_IDS)[number];

export function isCustomViewId(mode: string): mode is CustomViewId {
  return (CUSTOM_VIEW_IDS as readonly string[]).includes(mode);
}

/** Human labels, shared by the 3D View dropdown and the viewport header. */
export const CUSTOM_VIEW_LABEL: Record<CustomViewId, string> = {
  custom1: 'Custom View 1',
  custom2: 'Custom View 2',
  custom3: 'Custom View 3',
};

/**
 * Stored parameters of one custom view. `distance`/`poi` are null until the
 * user navigates: null means "comp-relative default" (POI = comp centre,
 * distance = 1.2 × the default focal length), resolved against the ACTIVE
 * comp's size at camera-build time — so the defaults frame any comp sensibly
 * without baking one comp's dimensions into the store.
 */
export interface CustomViewParams {
  /** Orbit yaw about the POI, degrees. */
  yaw: number;
  /** Orbit pitch about the POI, degrees (clamped ±89 like the scene orbit). */
  pitch: number;
  /** Eye→POI distance in px, or null = 1.2 × default focal length. */
  distance: number | null;
  /** Point of interest in comp space, or null = comp centre on the z=0 plane. */
  poi: { x: number; y: number; z: number } | null;
}

/** All-concrete view params (defaults resolved against a comp size). */
export interface ResolvedCustomView {
  yaw: number;
  pitch: number;
  distance: number;
  poi: { x: number; y: number; z: number };
}

/** Factory (not a shared constant) so store resets can't alias mutable state. */
export function defaultCustomViews(): Record<CustomViewId, CustomViewParams> {
  return {
    // Three-quarter view from up-right — the classic "inspect the scene" angle.
    custom1: { yaw: 35, pitch: -20, distance: null, poi: null },
    // Mirror three-quarter from up-left.
    custom2: { yaw: -35, pitch: -20, distance: null, poi: null },
    // High vantage looking steeply down (perspective cousin of the Top view).
    custom3: { yaw: 0, pitch: -55, distance: null, poi: null },
  };
}

/** Distance multiplier over the default focal for un-navigated custom views. */
const DEFAULT_DISTANCE_FACTOR = 1.2;

export function resolveCustomView(
  v: CustomViewParams,
  width: number,
  height: number,
): ResolvedCustomView {
  const def = Project3D.defaultCamera(width, height);
  return {
    yaw: v.yaw,
    pitch: v.pitch,
    distance: v.distance ?? def.focalLength * DEFAULT_DISTANCE_FACTOR,
    poi: v.poi ?? { x: width / 2, y: height / 2, z: 0 },
  };
}

/**
 * Build the projection camera for a custom view — the mirror of camera3d.ts's
 * two-node (POI) path: the eye starts pulled back from the POI along −z by
 * `distance`, orbits about the POI by yaw/pitch, then LOOKS AT the POI. The
 * focal length is the comp's default (custom views inspect, they don't zoom
 * the lens), and DOF is the caller's job to disable.
 */
export function customViewCamera(v: CustomViewParams, width: number, height: number): Camera3D {
  const def = Project3D.defaultCamera(width, height);
  const r = resolveCustomView(v, width, height);
  const base = { x: r.poi.x, y: r.poi.y, z: r.poi.z - r.distance };
  const orbited = Project3D.orbitCamera(base, r.poi, r.yaw, r.pitch);
  const orientation = Project3D.lookAtOrientation(orbited.position, r.poi);
  return {
    focalLength: def.focalLength,
    position: orbited.position,
    principal: def.principal,
    ...(orientation.yaw !== 0 || orientation.pitch !== 0 ? { orientation } : {}),
  };
}

// ── Navigation math (pure patches; sensitivities match cameraNav.ts) ────────

/** Orbit: 0.4°/px, pitch clamped ±89 — identical feel to the scene camera. */
export function orbitViewParams(
  v: Pick<CustomViewParams, 'yaw' | 'pitch'>,
  dx: number,
  dy: number,
): Pick<CustomViewParams, 'yaw' | 'pitch'> {
  return {
    yaw: v.yaw + dx * 0.4,
    pitch: Math.max(-89, Math.min(89, v.pitch + dy * 0.4)),
  };
}

/**
 * Track XY: the framing follows the cursor (POI moves opposite the drag),
 * screen px → comp px through the viewport zoom — same as trackCameraBy.
 */
export function trackViewParams(
  v: ResolvedCustomView,
  dx: number,
  dy: number,
  viewScale: number,
): Pick<CustomViewParams, 'poi'> {
  const s = viewScale || 1;
  return { poi: { x: v.poi.x - dx / s, y: v.poi.y - dy / s, z: v.poi.z } };
}

/**
 * Dolly: distance along the view axis. Positive wheel delta (wheel-down) pulls
 * BACK, matching dollyCameraBy's `z - delta*2` (z is negative-back). Clamped
 * so the eye can't cross the POI.
 */
export function dollyViewParams(
  v: ResolvedCustomView,
  delta: number,
): Pick<CustomViewParams, 'distance'> {
  return { distance: Math.max(1, v.distance + delta * 2) };
}

// ── Smooth dolly easing ─────────────────────────────────────────────────────

/**
 * rAF easing accumulator for wheel dolly: wheel ticks ADD to a pending delta,
 * and a rAF loop applies `pending × factor` per frame (exponential decay)
 * until the remainder drops under `epsilon` (final flush, then stop). This
 * turns the steppy per-tick z writes into a smooth glide — for both the scene
 * camera and custom-view targets, because `apply` is whatever write path the
 * caller routes through.
 *
 * The scheduler is injectable for tests; production uses requestAnimationFrame.
 */
export class DollyEaser {
  private pendingDelta = 0;
  private handle: number | null = null;

  constructor(
    private readonly apply: (delta: number) => void,
    private readonly schedule: (cb: () => void) => number = (cb) => requestAnimationFrame(cb),
    private readonly cancelScheduled: (h: number) => void = (h) => cancelAnimationFrame(h),
    private readonly factor = 0.25,
    private readonly epsilon = 0.1,
  ) {}

  /** Remaining un-applied delta (for tests / debugging). */
  get pending(): number {
    return this.pendingDelta;
  }

  /** Accumulate a wheel tick and (re)start the easing loop. */
  add(delta: number): void {
    this.pendingDelta += delta;
    if (this.handle === null) this.handle = this.schedule(() => this.tick());
  }

  private tick(): void {
    this.handle = null;
    if (Math.abs(this.pendingDelta) <= this.epsilon) {
      // Final flush: apply the sub-epsilon remainder so the total applied
      // always equals the total added (no drift), then stop.
      if (this.pendingDelta !== 0) {
        this.apply(this.pendingDelta);
        this.pendingDelta = 0;
      }
      return;
    }
    const step = this.pendingDelta * this.factor;
    this.pendingDelta -= step;
    this.apply(step);
    this.handle = this.schedule(() => this.tick());
  }

  /** Cancel the loop and drop any pending delta (unmount / tool exit). */
  dispose(): void {
    if (this.handle !== null) {
      this.cancelScheduled(this.handle);
      this.handle = null;
    }
    this.pendingDelta = 0;
  }
}
