import { Viewport } from '../viewport/Viewport';

describe('Viewport', () => {
  it('computes framebuffer pixel size from dpr', () => {
    const vp = new Viewport({ width: 800, height: 600, devicePixelRatio: 2 });
    expect(vp.pixelSize).toEqual({ width: 1600, height: 1200 });
  });

  it('resize updates size and camera viewport', () => {
    const vp = new Viewport({ width: 100, height: 100 });
    vp.resize(1280, 720, 1.5);
    expect(vp.width).toBe(1280);
    expect(vp.height).toBe(720);
    expect(vp.pixelSize).toEqual({ width: 1920, height: 1080 });
  });

  it('visibleWorldRect covers the viewport in world units', () => {
    const vp = new Viewport({ width: 800, height: 600 });
    vp.camera.setState({ center: { x: 0, y: 0 }, zoom: 1 });
    const r = vp.visibleWorldRect;
    expect(r.x).toBeCloseTo(-400, 5);
    expect(r.y).toBeCloseTo(-300, 5);
    expect(r.width).toBeCloseTo(800, 5);
    expect(r.height).toBeCloseTo(600, 5);
  });

  it('merges overlay defaults with overrides', () => {
    const vp = new Viewport({ width: 10, height: 10, overlays: { grid: false } });
    expect(vp.overlays.grid).toBe(false);
    expect(vp.overlays.checkerboard).toBe(true); // default kept
  });

  it('assigns unique ids', () => {
    const a = new Viewport({ width: 1, height: 1 });
    const b = new Viewport({ width: 1, height: 1 });
    expect(a.id).not.toBe(b.id);
  });
});
