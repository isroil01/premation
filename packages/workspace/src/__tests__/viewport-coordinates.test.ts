import { Viewport } from '../viewport/Viewport';
import { Camera } from '../camera/Camera';
import { CoordinateSystem } from '../coordinates/CoordinateSystem';
import * as Mat from '../math/Mat2D';

describe('Viewport', () => {
  it('resizes and reports device pixels', () => {
    const vp = new Viewport({ width: 100, height: 50, dpr: 2 });
    expect(vp.devicePixelSize).toEqual({ width: 200, height: 100 });
    expect(vp.resize(200, 100)).toBe(true);
    expect(vp.resize(200, 100)).toBe(false); // no change
    expect(vp.size).toEqual({ width: 200, height: 100 });
  });

  it('maps screen ↔ viewport via offset', () => {
    const vp = new Viewport({ width: 800, height: 600, offsetX: 40, offsetY: 10 });
    expect(vp.screenToViewport({ x: 100, y: 60 })).toEqual({ x: 60, y: 50 });
    expect(vp.viewportToScreen({ x: 60, y: 50 })).toEqual({ x: 100, y: 60 });
  });

  it('detects points inside the window', () => {
    const vp = new Viewport({ width: 100, height: 100 });
    expect(vp.containsViewportPoint({ x: 50, y: 50 })).toBe(true);
    expect(vp.containsViewportPoint({ x: -1, y: 50 })).toBe(false);
  });
});

describe('CoordinateSystem', () => {
  function make() {
    const vp = new Viewport({ width: 800, height: 600, offsetX: 20, offsetY: 30 });
    const cam = new Camera();
    cam.setViewportSize(800, 600);
    return { coords: new CoordinateSystem(cam, vp), cam, vp };
  }

  it('accounts for the viewport offset in screen→world', () => {
    const { coords, cam } = make();
    // A screen point at the canvas top-left+offset maps to the viewport origin,
    // which the camera maps relative to its center.
    const screenCenter = { x: 20 + 400, y: 30 + 300 };
    expect(coords.screenToWorld(screenCenter)).toEqual({ x: 0, y: 0 });
    expect(coords.worldToScreen({ x: 0, y: 0 })).toEqual(screenCenter);
    void cam;
  });

  it('round-trips screen ↔ world with pan and zoom', () => {
    const { coords, cam } = make();
    cam.setCenter({ x: -75, y: 120 });
    cam.zoomTo(0.6);
    const screen = { x: 333, y: 222 };
    const world = coords.screenToWorld(screen);
    const back = coords.worldToScreen(world);
    expect(back.x).toBeCloseTo(screen.x);
    expect(back.y).toBeCloseTo(screen.y);
  });

  it('converts world ↔ local via a node matrix', () => {
    const { coords } = make();
    const nodeMatrix = Mat.multiply(Mat.translation(100, 100), Mat.scaling(2, 2));
    const local = { x: 5, y: 5 };
    const world = coords.localToWorld(local, nodeMatrix);
    expect(world).toEqual({ x: 110, y: 110 });
    const back = coords.worldToLocal(world, nodeMatrix);
    expect(back.x).toBeCloseTo(5);
    expect(back.y).toBeCloseTo(5);
  });

  it('converts local ↔ parent through both world matrices', () => {
    const { coords } = make();
    const parentMatrix = Mat.translation(10, 10);
    const nodeMatrix = Mat.multiply(parentMatrix, Mat.translation(5, 5));
    const inParent = coords.localToParent({ x: 0, y: 0 }, nodeMatrix, parentMatrix);
    expect(inParent.x).toBeCloseTo(5);
    expect(inParent.y).toBeCloseTo(5);
  });
});
