import { snapshotToFrameScene, layerToRenderable, viewToCamera } from './snapshotToFrameScene';
import type { RenderSnapshot, RenderLayer } from './RenderBackend';
import { Renderer, NullBackend, type Mat3 } from '@motion/renderer';

function layer(over: Partial<RenderLayer> = {}): RenderLayer {
  return {
    id: 'n1', kind: 'shape', x: 100, y: 200, rotation: 0, scaleX: 1, scaleY: 1,
    opacity: 1, width: 220, height: 220, fill: '#ff0000', visible: true, primitive: 'rect',
    ...over,
  };
}

function snapshot(layers: RenderLayer[], over: Partial<RenderSnapshot> = {}): RenderSnapshot {
  return { width: 1920, height: 1080, background: '#101014', layers, ...over };
}

/** Apply a column-major affine Mat3 to a point (matches renderer convention). */
function apply(m: Mat3, x: number, y: number): { x: number; y: number } {
  return { x: m[0]! * x + m[3]! * y + m[6]!, y: m[1]! * x + m[4]! * y + m[7]! };
}

describe('snapshotToFrameScene', () => {
  test('maps composition size + background', () => {
    const scene = snapshotToFrameScene(snapshot([]));
    expect(scene.composition.size).toEqual({ width: 1920, height: 1080 });
    // #101014 → linear-ish 0..1 rgba
    expect(scene.composition.background).toEqual({
      r: 0x10 / 255, g: 0x10 / 255, b: 0x14 / 255, a: 1,
    });
    expect(scene.renderables).toHaveLength(0);
    expect(scene.selection).toEqual([]);
  });

  test('drops invisible layers', () => {
    const scene = snapshotToFrameScene(snapshot([layer({ visible: false }), layer({ id: 'n2' })]));
    expect(scene.renderables.map((r) => r.id)).toEqual(['n2']);
  });

  test('maps kinds and assigns texture keys for textured kinds', () => {
    const scene = snapshotToFrameScene(snapshot([
      layer({ id: 's', kind: 'shape' }),
      layer({ id: 't', kind: 'text' }),
      layer({ id: 'i', kind: 'image' }),
      layer({ id: 'v', kind: 'video' }),
    ]));
    const byId = Object.fromEntries(scene.renderables.map((r) => [r.id, r]));
    expect(byId.s!.kind).toBe('rect');
    expect(byId.t!.kind).toBe('text');
    expect(byId.t!.textureKey).toBe('text:t');
    expect(byId.i!.kind).toBe('image');
    expect(byId.i!.textureKey).toBe('asset:i');
    expect(byId.v!.textureKey).toBe('asset:v');
    expect(byId.s!.textureKey).toBeUndefined();
  });

  test('passes through opacity and fill color', () => {
    const [r] = snapshotToFrameScene(snapshot([layer({ opacity: 0.5, fill: '#00ff00' })])).renderables;
    expect(r!.opacity).toBe(0.5);
    expect(r!.color).toEqual({ r: 0, g: 1, b: 0, a: 1 });
    expect(r!.blend).toBe('normal');
  });

  test('maps the layer blend mode onto the renderable', () => {
    const [r] = snapshotToFrameScene(snapshot([layer({ blend: 'multiply' })])).renderables;
    expect(r!.blend).toBe('multiply');
  });

  test('defaults blend to normal when the layer omits it', () => {
    const bare = layer();
    delete (bare as { blend?: unknown }).blend;
    const [r] = snapshotToFrameScene(snapshot([bare])).renderables;
    expect(r!.blend).toBe('normal');
  });

  describe('center-pivot model matrix', () => {
    test('unit-quad centre maps to the layer centre', () => {
      const r = layerToRenderable(layer({ x: 100, y: 200, width: 220, height: 220 }));
      const centre = apply(r.modelMatrix, 0.5, 0.5);
      expect(centre.x).toBeCloseTo(100);
      expect(centre.y).toBeCloseTo(200);
    });

    test('corners straddle the centre by half the (scaled) size', () => {
      const r = layerToRenderable(layer({ x: 0, y: 0, width: 200, height: 100, scaleX: 2, scaleY: 1 }));
      const tl = apply(r.modelMatrix, 0, 0); // top-left corner
      const br = apply(r.modelMatrix, 1, 1); // bottom-right corner
      expect(tl.x).toBeCloseTo(-200); // (200*2)/2
      expect(tl.y).toBeCloseTo(-50); // (100*1)/2
      expect(br.x).toBeCloseTo(200);
      expect(br.y).toBeCloseTo(50);
    });

    test('90° rotation about the centre swaps axes', () => {
      const r = layerToRenderable(layer({ x: 0, y: 0, width: 100, height: 100, rotation: 90 }));
      const right = apply(r.modelMatrix, 1, 0.5); // mid-right edge → rotates to mid-bottom
      expect(right.x).toBeCloseTo(0);
      expect(right.y).toBeCloseTo(50);
    });

    test('bounds are the AABB of the transformed quad', () => {
      const r = layerToRenderable(layer({ x: 10, y: 20, width: 100, height: 60, rotation: 0, scaleX: 1, scaleY: 1 }));
      expect(r.bounds.x).toBeCloseTo(-40); // 10 - 50
      expect(r.bounds.y).toBeCloseTo(-10); // 20 - 30
      expect(r.bounds.width).toBeCloseTo(100);
      expect(r.bounds.height).toBeCloseTo(60);
    });
  });
});

describe('viewToCamera', () => {
  const comp = { width: 1920, height: 1080 };

  test('maps an explicit view so comp pixels land where Canvas2D puts them', () => {
    const view = { scale: 0.5, offsetX: 40, offsetY: 30 };
    const cam = viewToCamera(view, comp, 800, 600);
    expect(cam.zoom).toBe(0.5);
    // Inverse of screen = (world-center)*zoom + vp/2 ; solving for center:
    expect(cam.center.x).toBeCloseTo((800 / 2 - 40) / 0.5);
    expect(cam.center.y).toBeCloseTo((600 / 2 - 30) / 0.5);
  });

  test('falls back to a centered 0.92 contain fit when no view', () => {
    const cam = viewToCamera(undefined, comp, 960, 540);
    expect(cam.zoom).toBeCloseTo(Math.min(960 / 1920, 540 / 1080) * 0.92);
    expect(cam.center).toEqual({ x: 960, y: 540 }); // comp centre
  });
});

describe('headless parity: mapped scene renders through the GPU pipeline', () => {
  test('emits background + one draw per visible shape via NullBackend', async () => {
    const backend = new NullBackend();
    let t = 0;
    const renderer = new Renderer({ backend, now: () => (t += 16) });
    await renderer.initialize();
    const vp = renderer.createViewport({
      width: 1920, height: 1080,
      overlays: { grid: false, checkerboard: false },
    });
    vp.camera.setState(viewToCamera(undefined, { width: 1920, height: 1080 }, 1920, 1080));

    const scene = snapshotToFrameScene(snapshot([
      layer({ id: 'a', x: 600, y: 400 }),
      layer({ id: 'b', x: 1200, y: 700 }),
      layer({ id: 'hidden', x: 300, y: 300, visible: false }),
    ]));

    renderer.render(vp, scene);
    // BackgroundPass (1) + ShapePass (2 visible shapes); the hidden layer was
    // dropped by the mapper so it never reaches the GPU.
    expect(backend.stats().draws).toBe(3);
    renderer.dispose();
  });
});
