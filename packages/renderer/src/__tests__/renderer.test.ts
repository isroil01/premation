import { Renderer } from '../core/renderer/Renderer';
import { NullBackend } from '../gpu/backends/NullBackend';
import { buildFrameScene } from '../integration/buildFrameScene';
import { Color } from '../core/math/Color';
import { LINEAR_INTERMEDIATE_STORAGE } from '../shaders/linearWorkingSpace';

function makeRenderer() {
  const backend = new NullBackend();
  let t = 0;
  const renderer = new Renderer({ backend, now: () => (t += 16) });
  return { backend, renderer };
}

function sceneWith(...rects: Array<{ id: string; x: number; y: number }>) {
  return buildFrameScene(
    { id: 'comp', size: { width: 1920, height: 1080 }, background: Color.of(0.1, 0.1, 0.1, 1) },
    rects.map((r) => ({ id: r.id, kind: 'rect' as const, x: r.x, y: r.y, width: 40, height: 40, color: Color.white() })),
  );
}

describe('Renderer lifecycle', () => {
  it('requires initialize before rendering', () => {
    const { renderer } = makeRenderer();
    const vp = renderer.createViewport({ width: 800, height: 600 });
    expect(() => renderer.render(vp, sceneWith())).toThrow(/initialize/);
  });

  it('renders the default pipeline: clear → background → composition', async () => {
    const { backend, renderer } = makeRenderer();
    await renderer.initialize();
    const vp = renderer.createViewport({ width: 800, height: 600, overlays: { grid: false, checkerboard: false } });
    const result = renderer.render(vp, sceneWith({ id: 'a', x: 100, y: 100 }, { id: 'b', x: 150, y: 120 }));

    expect(backend.passLog).toEqual(expect.arrayContaining(['clear', 'background', 'composition']));
    if (LINEAR_INTERMEDIATE_STORAGE) expect(backend.passLog).toContain('effect');
    // 1 composition background + 2 visible rects.
    expect(backend.stats().draws).toBeGreaterThanOrEqual(2);
    expect(result.frame.index).toBe(1);
  });

  it('culls renderables outside the viewport', async () => {
    const { backend, renderer } = makeRenderer();
    await renderer.initialize();
    const vp = renderer.createViewport({ width: 800, height: 600, overlays: { grid: false, checkerboard: false } });
    vp.camera.setState({ center: { x: 0, y: 0 }, zoom: 1 }); // visible ~[-400..400, -300..300]
    renderer.render(vp, sceneWith({ id: 'near', x: 0, y: 0 }, { id: 'far', x: 50000, y: 50000 }));
    // background (1) + only the near rect (1) [+ encode blit when RTs stay linear]
    expect(backend.stats().draws).toBe(LINEAR_INTERMEDIATE_STORAGE ? 3 : 2);
  });

  it('shares one pipeline across same-material draws', async () => {
    const { renderer } = makeRenderer();
    await renderer.initialize();
    const vp = renderer.createViewport({ width: 800, height: 600, overlays: { grid: false, checkerboard: false } });
    renderer.render(vp, sceneWith({ id: 'a', x: 10, y: 10 }, { id: 'b', x: 20, y: 20 }, { id: 'c', x: 30, y: 30 }));
    // One solid pipeline; linear storage adds the scene-blit pipeline.
    expect(renderer.resourceStats().pipelines).toBe(LINEAR_INTERMEDIATE_STORAGE ? 2 : 1);
  });

  it('increments the frame index across renders', async () => {
    const { renderer } = makeRenderer();
    await renderer.initialize();
    const vp = renderer.createViewport({ width: 400, height: 400, overlays: { grid: false } });
    expect(renderer.render(vp, sceneWith()).frame.index).toBe(1);
    expect(renderer.render(vp, sceneWith()).frame.index).toBe(2);
  });

  it('supports multiple viewports in one frame', async () => {
    const { backend, renderer } = makeRenderer();
    await renderer.initialize();
    const a = renderer.createViewport({ width: 400, height: 400, overlays: { grid: false, checkerboard: false } });
    const b = renderer.createViewport({ width: 400, height: 400, overlays: { grid: false, checkerboard: false } });
    const scene = sceneWith({ id: 'r', x: 10, y: 10 });

    const frame = renderer.beginFrame();
    renderer.renderViewport(a, scene, frame);
    renderer.renderViewport(b, scene, frame);
    renderer.endFrame();

    // Two viewports each ran clear+background+composition.
    expect(backend.passLog).toEqual(expect.arrayContaining(['clear', 'background', 'composition', 'clear', 'background', 'composition']));
    expect(renderer.viewportCount).toBe(2);
  });

  it('rejects nested frames', async () => {
    const { renderer } = makeRenderer();
    await renderer.initialize();
    renderer.beginFrame();
    expect(() => renderer.beginFrame()).toThrow();
    renderer.endFrame();
  });

  it('resize forwards to the backend after init', async () => {
    const { renderer } = makeRenderer();
    await renderer.initialize();
    expect(() => renderer.resize(1024, 768, 2)).not.toThrow();
  });

  it('destroyViewport removes it', async () => {
    const { renderer } = makeRenderer();
    await renderer.initialize();
    const vp = renderer.createViewport({ width: 10, height: 10 });
    expect(renderer.viewportCount).toBe(1);
    expect(renderer.destroyViewport(vp)).toBe(true);
    expect(renderer.viewportCount).toBe(0);
  });

  it('dispose releases all GPU resources', async () => {
    const { backend, renderer } = makeRenderer();
    await renderer.initialize();
    const vp = renderer.createViewport({ width: 400, height: 400, overlays: { grid: false } });
    renderer.render(vp, sceneWith({ id: 'a', x: 10, y: 10 }));
    renderer.dispose();
    const s = backend.stats();
    expect(s.liveBuffers).toBe(0);
    expect(s.liveTextures).toBe(0);
    expect(s.livePipelines).toBe(0);
    expect(s.liveBindGroups).toBe(0);
  });

  it('throws when used after dispose', async () => {
    const { renderer } = makeRenderer();
    await renderer.initialize();
    renderer.dispose();
    const vp = renderer.createViewport({ width: 10, height: 10 });
    expect(() => renderer.render(vp, sceneWith())).toThrow(/disposed/);
  });
});
