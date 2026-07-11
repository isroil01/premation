import { Camera } from '../camera/Camera';
import { CameraAnimator } from '../camera/CameraAnimator';
import * as Mat from '../math/Mat2D';

function makeCamera(): Camera {
  const cam = new Camera();
  cam.setViewportSize(800, 600);
  return cam;
}

describe('Camera coordinate conversion', () => {
  it('maps world center to viewport center', () => {
    const cam = makeCamera();
    expect(cam.worldToScreen({ x: 0, y: 0 })).toEqual({ x: 400, y: 300 });
  });

  it('round-trips screen ↔ world', () => {
    const cam = makeCamera();
    cam.setCenter({ x: 50, y: -30 });
    cam.zoomTo(2.5);
    const world = { x: 123, y: 456 };
    const screen = cam.worldToScreen(world);
    const back = cam.screenToWorld(screen);
    expect(back.x).toBeCloseTo(world.x);
    expect(back.y).toBeCloseTo(world.y);
  });

  it('worldToScreenMatrix agrees with worldToScreen', () => {
    const cam = makeCamera();
    cam.setCenter({ x: 10, y: 20 });
    cam.zoomTo(1.7);
    const m = cam.worldToScreenMatrix();
    const p = { x: 33, y: -12 };
    const viaMatrix = Mat.apply(m, p);
    const viaFn = cam.worldToScreen(p);
    expect(viaMatrix.x).toBeCloseTo(viaFn.x);
    expect(viaMatrix.y).toBeCloseTo(viaFn.y);
  });
});

describe('Camera pan', () => {
  it('pans by screen pixels scaled by zoom', () => {
    const cam = makeCamera();
    cam.zoomTo(2);
    cam.panByScreen(100, 0); // 100px at 2x = 50 world units
    expect(cam.center.x).toBeCloseTo(-50);
  });
});

describe('Camera zoom', () => {
  it('keeps the anchor point fixed while zooming', () => {
    const cam = makeCamera();
    const anchor = { x: 600, y: 200 };
    const worldBefore = cam.screenToWorld(anchor);
    cam.zoomBy(3, anchor);
    const worldAfter = cam.screenToWorld(anchor);
    expect(worldAfter.x).toBeCloseTo(worldBefore.x);
    expect(worldAfter.y).toBeCloseTo(worldBefore.y);
  });

  it('clamps to zoom limits', () => {
    const cam = makeCamera();
    cam.setZoomLimits(0.5, 4);
    cam.zoomTo(100);
    expect(cam.zoom).toBe(4);
    cam.zoomTo(0.001);
    expect(cam.zoom).toBe(0.5);
  });

  it('frames a world rect with zoomToRect', () => {
    const cam = makeCamera();
    cam.zoomToRect({ x: 0, y: 0, width: 400, height: 300 }, 0);
    // 800/400 = 2, 600/300 = 2 → zoom 2, centered at (200,150).
    expect(cam.zoom).toBeCloseTo(2);
    expect(cam.center).toEqual({ x: 200, y: 150 });
  });

  it('reset returns to origin at 1:1', () => {
    const cam = makeCamera();
    cam.setCenter({ x: 99, y: 99 });
    cam.zoomTo(7);
    cam.reset();
    expect(cam.center).toEqual({ x: 0, y: 0 });
    expect(cam.zoom).toBe(1);
  });

  it('reports the visible world rect', () => {
    const cam = makeCamera();
    cam.zoomTo(2);
    const r = cam.visibleWorldRect();
    expect(r.width).toBeCloseTo(400);
    expect(r.height).toBeCloseTo(300);
  });
});

describe('CameraAnimator', () => {
  it('eases toward the target and completes', () => {
    const cam = makeCamera();
    const anim = new CameraAnimator(cam);
    anim.animateTo({ center: { x: 100, y: 100 }, zoom: 4 }, 100);
    expect(anim.isAnimating).toBe(true);
    anim.update(50);
    expect(cam.center.x).toBeGreaterThan(0);
    expect(cam.center.x).toBeLessThan(100);
    const stillGoing = anim.update(50);
    expect(stillGoing).toBe(false);
    expect(cam.center.x).toBeCloseTo(100);
    expect(cam.zoom).toBeCloseTo(4);
  });

  it('applies instantly with zero duration', () => {
    const cam = makeCamera();
    const anim = new CameraAnimator(cam);
    let done = false;
    anim.animateTo({ center: { x: 5, y: 5 }, zoom: 2 }, 0, undefined, () => {
      done = true;
    });
    expect(done).toBe(true);
    expect(cam.center).toEqual({ x: 5, y: 5 });
  });
});
