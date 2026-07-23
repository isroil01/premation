/**
 * Custom-view math (customViews.ts) — the pure half of AE-style 3D view
 * management:
 *   - stored params → the SAME camera construction the scene camera resolver
 *     uses (Project3D.orbitCamera + lookAtOrientation about a POI);
 *   - orbit/track/dolly param patches (sensitivities matching cameraNav.ts);
 *   - the DollyEaser rAF accumulator (converges, no drift, cancellable).
 */

import { Project3D } from '@motion/scene';
import {
  customViewCamera,
  defaultCustomViews,
  DollyEaser,
  dollyViewParams,
  isCustomViewId,
  orbitViewParams,
  resolveCustomView,
  trackViewParams,
  type CustomViewParams,
} from './customViews';

const W = 1920;
const H = 1080;

describe('isCustomViewId', () => {
  it('accepts exactly the three custom ids', () => {
    expect(isCustomViewId('custom1')).toBe(true);
    expect(isCustomViewId('custom2')).toBe(true);
    expect(isCustomViewId('custom3')).toBe(true);
    expect(isCustomViewId('active')).toBe(false);
    expect(isCustomViewId('front')).toBe(false);
    expect(isCustomViewId('top')).toBe(false);
  });
});

describe('resolveCustomView defaults', () => {
  it('null distance resolves to 1.2 × the default focal length; null poi to the comp centre', () => {
    const def = Project3D.defaultCamera(W, H);
    const r = resolveCustomView({ yaw: 10, pitch: -5, distance: null, poi: null }, W, H);
    expect(r.distance).toBeCloseTo(def.focalLength * 1.2, 6);
    expect(r.poi).toEqual({ x: W / 2, y: H / 2, z: 0 });
    expect(r.yaw).toBe(10);
    expect(r.pitch).toBe(-5);
  });

  it('explicit distance/poi pass through untouched', () => {
    const r = resolveCustomView(
      { yaw: 0, pitch: 0, distance: 500, poi: { x: 1, y: 2, z: 3 } },
      W,
      H,
    );
    expect(r.distance).toBe(500);
    expect(r.poi).toEqual({ x: 1, y: 2, z: 3 });
  });
});

describe('customViewCamera', () => {
  it('zero yaw/pitch = camera pulled straight back from the POI, no orientation', () => {
    const cam = customViewCamera({ yaw: 0, pitch: 0, distance: 1000, poi: null }, W, H);
    const def = Project3D.defaultCamera(W, H);
    expect(cam.position).toEqual({ x: W / 2, y: H / 2, z: -1000 });
    expect(cam.orientation).toBeUndefined();
    expect(cam.focalLength).toBeCloseTo(def.focalLength, 6);
    expect(cam.principal).toEqual(def.principal);
  });

  it('builds through the SAME helpers the scene camera uses (orbitCamera + lookAtOrientation)', () => {
    const v: CustomViewParams = { yaw: 35, pitch: -20, distance: 900, poi: { x: 800, y: 400, z: 50 } };
    const cam = customViewCamera(v, W, H);

    // Mirror of camera3d.ts's two-node (POI) path, done by hand:
    const base = { x: 800, y: 400, z: 50 - 900 };
    const orbited = Project3D.orbitCamera(base, v.poi!, v.yaw, v.pitch);
    const orientation = Project3D.lookAtOrientation(orbited.position, v.poi!);

    expect(cam.position.x).toBeCloseTo(orbited.position.x, 9);
    expect(cam.position.y).toBeCloseTo(orbited.position.y, 9);
    expect(cam.position.z).toBeCloseTo(orbited.position.z, 9);
    expect(cam.orientation).toBeDefined();
    expect(cam.orientation!.yaw).toBeCloseTo(orientation.yaw, 9);
    expect(cam.orientation!.pitch).toBeCloseTo(orientation.pitch, 9);
  });

  it('the POI projects to the principal point (the view LOOKS AT its POI)', () => {
    const poi = { x: W / 2, y: H / 2, z: 0 };
    const cam = customViewCamera({ yaw: 47, pitch: -33, distance: 1500, poi }, W, H);
    const p = Project3D.projectPoint(poi, cam);
    expect(p.x).toBeCloseTo(cam.principal.x, 3);
    expect(p.y).toBeCloseTo(cam.principal.y, 3);
  });

  it('keeps the eye at the stored distance from the POI under any orbit', () => {
    const poi = { x: 100, y: 200, z: -40 };
    const cam = customViewCamera({ yaw: 120, pitch: 60, distance: 777, poi }, W, H);
    const d = Math.hypot(cam.position.x - poi.x, cam.position.y - poi.y, cam.position.z - poi.z);
    expect(d).toBeCloseTo(777, 6);
  });
});

describe('navigation param math', () => {
  it('orbit: 0.4°/px on both axes', () => {
    expect(orbitViewParams({ yaw: 10, pitch: -5 }, 10, -20)).toEqual({ yaw: 14, pitch: -13 });
  });

  it('orbit: pitch clamps at ±89', () => {
    expect(orbitViewParams({ yaw: 0, pitch: 85 }, 0, 100).pitch).toBe(89);
    expect(orbitViewParams({ yaw: 0, pitch: -85 }, 0, -100).pitch).toBe(-89);
  });

  it('track: POI moves OPPOSITE the drag, through the viewport zoom', () => {
    const r = resolveCustomView({ yaw: 0, pitch: 0, distance: 100, poi: { x: 50, y: 60, z: 7 } }, W, H);
    const patch = trackViewParams(r, 10, -4, 2);
    expect(patch.poi).toEqual({ x: 45, y: 62, z: 7 });
  });

  it('dolly: 2× delta like the scene camera, clamped so the eye cannot cross the POI', () => {
    const r = resolveCustomView({ yaw: 0, pitch: 0, distance: 100, poi: null }, W, H);
    expect(dollyViewParams(r, 30).distance).toBe(160); // wheel-down = pull back
    expect(dollyViewParams(r, -30).distance).toBe(40); // wheel-up = dolly in
    expect(dollyViewParams(r, -1000).distance).toBe(1); // clamp
  });
});

describe('defaultCustomViews', () => {
  it('returns fresh (non-aliased) objects each call', () => {
    const a = defaultCustomViews();
    const b = defaultCustomViews();
    expect(a).toEqual(b);
    expect(a.custom1).not.toBe(b.custom1);
  });
});

describe('DollyEaser', () => {
  /** Manual scheduler: collects callbacks, runs them on demand. */
  function makeScheduler() {
    let next = 1;
    const pending = new Map<number, () => void>();
    return {
      schedule: (cb: () => void): number => {
        const id = next++;
        pending.set(id, cb);
        return id;
      },
      cancel: (id: number): void => {
        pending.delete(id);
      },
      /** Run one frame; returns false when nothing was scheduled. */
      step(): boolean {
        const [entry] = pending;
        if (!entry) return false;
        pending.delete(entry[0]);
        entry[1]();
        return true;
      },
      get scheduledCount(): number {
        return pending.size;
      },
    };
  }

  it('eases toward the target with exponential decay and converges without drift', () => {
    const s = makeScheduler();
    const applied: number[] = [];
    const easer = new DollyEaser((d) => applied.push(d), s.schedule, s.cancel);

    easer.add(100);
    // First eased frame = 25% of the pending delta.
    s.step();
    expect(applied[0]).toBeCloseTo(25, 9);
    expect(easer.pending).toBeCloseTo(75, 9);

    let guard = 0;
    while (s.step() && guard++ < 100) { /* run to convergence */ }
    expect(guard).toBeLessThan(100); // it STOPS (no infinite rAF loop)
    // Total applied equals total added — the sub-epsilon remainder is flushed.
    expect(applied.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 9);
    expect(easer.pending).toBe(0);
  });

  it('accumulates wheel ticks that arrive mid-glide', () => {
    const s = makeScheduler();
    const applied: number[] = [];
    const easer = new DollyEaser((d) => applied.push(d), s.schedule, s.cancel);

    easer.add(40);
    s.step(); // applies 10, 30 pending
    easer.add(-10); // wheel reversed mid-glide → 20 pending
    expect(easer.pending).toBeCloseTo(20, 9);
    let guard = 0;
    while (s.step() && guard++ < 100) { /* drain */ }
    expect(applied.reduce((a, b) => a + b, 0)).toBeCloseTo(30, 9);
  });

  it('dispose cancels the scheduled frame and drops the pending delta', () => {
    const s = makeScheduler();
    const applied: number[] = [];
    const easer = new DollyEaser((d) => applied.push(d), s.schedule, s.cancel);

    easer.add(500);
    easer.dispose();
    expect(easer.pending).toBe(0);
    expect(s.scheduledCount).toBe(0);
    expect(s.step()).toBe(false); // nothing left to run
    expect(applied).toHaveLength(0);

    // Reusable after dispose.
    easer.add(8);
    let guard = 0;
    while (s.step() && guard++ < 100) { /* drain */ }
    expect(applied.reduce((a, b) => a + b, 0)).toBeCloseTo(8, 9);
  });

  it('a sub-epsilon add is flushed exactly once', () => {
    const s = makeScheduler();
    const applied: number[] = [];
    const easer = new DollyEaser((d) => applied.push(d), s.schedule, s.cancel);
    easer.add(0.05);
    s.step();
    expect(applied).toEqual([0.05]);
    expect(s.scheduledCount).toBe(0);
  });
});
