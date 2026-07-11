import { Camera2D } from '../camera/Camera2D';

describe('Camera2D', () => {
  it('round-trips screen ↔ world at the default state', () => {
    const cam = new Camera2D();
    cam.setViewport(800, 600);
    const screen = { x: 123, y: 456 };
    const world = cam.screenToWorld(screen);
    const back = cam.worldToScreen(world);
    expect(back.x).toBeCloseTo(screen.x, 5);
    expect(back.y).toBeCloseTo(screen.y, 5);
  });

  it('maps the viewport center to the camera center', () => {
    const cam = new Camera2D();
    cam.setViewport(800, 600);
    cam.setState({ center: { x: 50, y: 70 }, zoom: 2 });
    expect(cam.screenToWorld({ x: 400, y: 300 })).toEqual({ x: 50, y: 70 });
  });

  it('pans in world units inversely to zoom', () => {
    const cam = new Camera2D();
    cam.setViewport(800, 600);
    cam.setState({ center: { x: 0, y: 0 }, zoom: 2 });
    cam.panByScreen(100, 0); // 100 screen px / zoom 2 = 50 world units
    expect(cam.getState().center.x).toBeCloseTo(-50, 5);
  });

  it('keeps the anchor point fixed while zooming', () => {
    const cam = new Camera2D();
    cam.setViewport(800, 600);
    const anchor = { x: 600, y: 200 };
    const worldBefore = cam.screenToWorld(anchor);
    cam.zoomBy(2, anchor);
    const worldAfter = cam.screenToWorld(anchor);
    expect(worldAfter.x).toBeCloseTo(worldBefore.x, 4);
    expect(worldAfter.y).toBeCloseTo(worldBefore.y, 4);
    expect(cam.zoom).toBe(2);
  });

  it('clamps zoom to configured limits', () => {
    const cam = new Camera2D();
    cam.setViewport(100, 100);
    cam.setZoomLimits(0.5, 4);
    cam.zoomBy(100);
    expect(cam.zoom).toBe(4);
    cam.zoomBy(0.0001);
    expect(cam.zoom).toBe(0.5);
  });

  it('viewProjection maps the camera center to clip-space origin', () => {
    const cam = new Camera2D();
    cam.setViewport(800, 600);
    cam.setState({ center: { x: 10, y: 20 }, zoom: 1.5 });
    const vp = cam.viewProjectionMatrix();
    // center → (0,0) in clip space
    const cx = vp[0]! * 10 + vp[3]! * 20 + vp[6]!;
    const cy = vp[1]! * 10 + vp[4]! * 20 + vp[7]!;
    expect(cx).toBeCloseTo(0, 5);
    expect(cy).toBeCloseTo(0, 5);
  });
});
