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

  test('transparent comp → fully transparent background (alpha 0)', () => {
    const scene = snapshotToFrameScene(snapshot([], { transparent: true }));
    expect(scene.composition.background).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });

  describe('shape SDF geometry', () => {
    test('a rect layer gets a rounded-rect SDF (default 0px corners)', () => {
      const r = layerToRenderable(layer({ primitive: 'rect', width: 220, height: 140 }));
      expect(r.sdf).toEqual({ shape: 'rounded', radiusPx: 0, width: 220, height: 140 });
    });

    test('a rect layer with cornerRadius gets a rounded-rect SDF with that radius', () => {
      const r = layerToRenderable(layer({ primitive: 'rect', width: 220, height: 140, cornerRadius: 15 }));
      expect(r.sdf).toEqual({ shape: 'rounded', radiusPx: 15, width: 220, height: 140 });
    });

    test('an ellipse layer gets an ellipse SDF', () => {
      const r = layerToRenderable(layer({ primitive: 'ellipse', width: 200, height: 200 }));
      expect(r.sdf).toEqual({ shape: 'ellipse', radiusPx: 0, width: 200, height: 200 });
    });

    test('a path layer has no SDF (deferred → flat quad)', () => {
      expect(layerToRenderable(layer({ primitive: 'path' })).sdf).toBeUndefined();
    });

    test('textured layers (image/text/video) never carry an SDF', () => {
      for (const kind of ['image', 'text', 'video'] as const) {
        expect(layerToRenderable(layer({ kind })).sdf).toBeUndefined();
      }
    });
  });

  describe('colour-grade effects on solid shapes', () => {
    test('brightness(50%) halves a white fill on the GPU path', () => {
      const r = layerToRenderable(layer({
        fill: '#ffffff',
        effects: [{ id: 'e', type: 'brightness', amount: 50 }],
      }));
      expect(r.color!.r).toBeCloseTo(0.5, 5);
      expect(r.color!.g).toBeCloseTo(0.5, 5);
      expect(r.color!.b).toBeCloseTo(0.5, 5);
      expect(r.color!.a).toBe(1);
    });

    test('a spatial-only effect stack (blur) leaves the colour unchanged', () => {
      const r = layerToRenderable(layer({ fill: '#3366cc', effects: [{ id: 'b', type: 'blur', amount: 8 }] }));
      const base = layerToRenderable(layer({ fill: '#3366cc' }));
      expect(r.color).toEqual(base.color);
    });

    test('textured layers carry a colorMatrix when colour-graded (per-pixel shader)', () => {
      const graded = layerToRenderable(layer({ kind: 'image', effects: [{ id: 'e', type: 'invert', amount: 100 }] }));
      expect(graded.colorMatrix).toBeDefined();
      // invert(100%): m = diag(-1), offset = [1,1,1]
      expect(graded.colorMatrix!.m).toEqual([-1, 0, 0, 0, -1, 0, 0, 0, -1]);
      expect(graded.colorMatrix!.offset).toEqual([1, 1, 1]);
    });

    test('textured layers with no colour effects carry no colorMatrix', () => {
      expect(layerToRenderable(layer({ kind: 'image' })).colorMatrix).toBeUndefined();
      expect(layerToRenderable(layer({ kind: 'image', effects: [{ id: 'b', type: 'blur', amount: 8 }] })).colorMatrix).toBeUndefined();
    });
  });

  test('drops invisible layers', () => {
    const scene = snapshotToFrameScene(snapshot([layer({ visible: false }), layer({ id: 'n2' })]));
    expect(scene.renderables.map((r) => r.id)).toEqual(['n2']);
  });

  test('drops consumed matte-source layers on the GPU path', () => {
    const scene = snapshotToFrameScene(snapshot([
      layer({ id: 'src', isMatteSource: true }),
      layer({ id: 'matted', matte: 'alpha' }),
    ]));
    expect(scene.renderables.map((r) => r.id)).toEqual(['matted']);
  });

  test('drops adjustment layers on the GPU path', () => {
    const scene = snapshotToFrameScene(snapshot([
      layer({ id: 'below' }),
      layer({ id: 'adj', isAdjustment: true }),
    ]));
    expect(scene.renderables.map((r) => r.id)).toEqual(['below']);
  });

  test('maps kinds and assigns texture keys for textured kinds', () => {
    const scene = snapshotToFrameScene(snapshot([
      layer({ id: 's', kind: 'shape' }),
      layer({ id: 'p', kind: 'shape', primitive: 'path', pathPoints: [{ x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 }] }),
      layer({ id: 'm', kind: 'shape', mask: { paths: [{ id: 'm1', points: [], inverted: false, mode: 'add', closed: true, feather: 0, opacity: 1, expansion: 0 }] } }),
      layer({ id: 'c', kind: 'shape', matte: 'alpha' }),
      layer({ id: 't', kind: 'text' }),
      layer({ id: 'i', kind: 'image' }),
      layer({ id: 'v', kind: 'video' }),
    ]));
    const byId = Object.fromEntries(scene.renderables.map((r) => [r.id, r]));
    expect(byId.s!.kind).toBe('rect');
    expect(byId.p!.kind).toBe('image');
    expect(byId.p!.textureKey).toBe('path:p');
    
    // Masks are now passed directly as a mask texture
    expect(byId.m!.kind).toBe('rect');
    expect(byId.m!.textureKey).toBeUndefined();
    expect(byId.m!.maskTextureKey).toBe('mask:m');
    
    // Mattes are temporarily treated as normal until phase 4.3
    expect(byId.c!.kind).toBe('rect');
    expect(byId.c!.textureKey).toBeUndefined();
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

  test('textured renderables (image/video/text) are untinted (white)', () => {
    for (const kind of ['image', 'video', 'text'] as const) {
      const [r] = snapshotToFrameScene(snapshot([layer({ kind, fill: '#00ff00' })])).renderables;
      expect(r!.color).toEqual({ r: 1, g: 1, b: 1, a: 1 });
    }
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

  describe('nested precompositions', () => {
    test('recursively flattens precomp child layers and computes world transform and opacity', () => {
      const child = layer({
        id: 'nested_child',
        kind: 'shape',
        x: 100,
        y: 50,
        width: 100,
        height: 100,
        opacity: 0.5,
      });
      const precomp = layer({
        id: 'precomp_container',
        kind: 'shape', // buildSnapshot emits precomp containers as 'shape'
        x: 100,
        y: 200,
        width: 1920,
        height: 1080,
        opacity: 0.8,
        precompLayers: [child],
      });

      const scene = snapshotToFrameScene(snapshot([precomp]));

      // Precomp container itself is dropped from final renderables list, but its children are flattened in
      expect(scene.renderables).toHaveLength(1);
      const r = scene.renderables[0]!;
      expect(r.id).toBe('nested_child');

      // Opacity: parent (0.8) * child (0.5) = 0.4
      expect(r.opacity).toBeCloseTo(0.4);

      // World matrix translation:
      // Parent center = (100, 200), parent width = 1920, height = 1080
      // Parent top-left local offset = (-960, -540)
      // Parent top-left in world = (100 - 960, 200 - 540) = (-860, -340)
      // Child local offset = (100, 50)
      // Child center in world = (-860 + 100, -340 + 50) = (-760, -290)
      const centre = apply(r.modelMatrix, 0.5, 0.5);
      expect(centre.x).toBeCloseTo(-760);
      expect(centre.y).toBeCloseTo(-290);
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
