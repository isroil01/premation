import { snapshotToFrameScene, layerToRenderable, viewToCamera } from './snapshotToFrameScene';
import type { RenderSnapshot, RenderLayer } from './RenderBackend';
import { BLEND_MODES } from '@core/effects/blendMode';
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

    test('a rect with independent corner radii forces shape raster (no isotropic SDF)', () => {
      const r = layerToRenderable(layer({
        primitive: 'rect', width: 220, height: 140,
        cornerRadius: 40,
        cornerRadii: [40, 4, 40, 4],
      }));
      // Non-uniform corners → path:/image raster, not SDF solid.
      expect(r.textureKey).toBe('path:n1');
      expect(r.sdf?.radiusPx ?? 0).toBe(0);
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

  test('emits matte-source layers flagged for the GPU matte pass (not dropped)', () => {
    // The source is kept but flagged `matteSource` — CompositionPass renders it
    // into MATTE_TARGET on demand instead of drawing it to the scene, so its
    // pixels are available to build the matte for the matted layer.
    const scene = snapshotToFrameScene(snapshot([
      layer({ id: 'src', isMatteSource: true }),
      layer({ id: 'matted', matte: { mode: 'alpha', inverted: false } }),
    ]));
    expect(scene.renderables.map((r) => r.id)).toEqual(['src', 'matted']);
    const src = scene.renderables.find((r) => r.id === 'src')!;
    expect(src.matteSource).toBe(true);
  });

  test('drops adjustment layers on the GPU path', () => {
    const scene = snapshotToFrameScene(snapshot([
      layer({ id: 'below' }),
      layer({ id: 'adj', isAdjustment: true }),
    ]));
    expect(scene.renderables.map((r) => r.id)).toEqual(['below']);
  });

  describe('lights (screen-blended radial-gradient quad)', () => {
    const lightLayer = (over: Partial<RenderLayer> = {}): RenderLayer =>
      layer({ id: 'L', x: 300, y: 400, light: { color: '#ffffff', intensity: 80, radius: 100 }, ...over });

    test('emits a light as a screen-blend textured quad (not dropped)', () => {
      const scene = snapshotToFrameScene(snapshot([lightLayer()]));
      expect(scene.renderables).toHaveLength(1);
      const r = scene.renderables[0]!;
      expect(r.kind).toBe('image');
      expect(r.blend).toBe('screen');
      expect(r.textureKey).toBe('light:L');
    });

    test('intensity drives opacity (80 → 0.8)', () => {
      const r = snapshotToFrameScene(snapshot([lightLayer({ light: { color: '#fff', intensity: 80, radius: 100 } })])).renderables[0]!;
      expect(r.opacity).toBeCloseTo(0.8, 5);
    });

    test('the quad is a 2·radius box centred at the light position', () => {
      const r = snapshotToFrameScene(snapshot([lightLayer({ x: 300, y: 400, light: { color: '#fff', intensity: 100, radius: 100 } })])).renderables[0]!;
      // 200×200 box centred at (300,400) → AABB origin (200,300), size 200².
      expect(r.bounds.width).toBeCloseTo(200, 5);
      expect(r.bounds.height).toBeCloseTo(200, 5);
      expect(r.bounds.x).toBeCloseTo(200, 5);
      expect(r.bounds.y).toBeCloseTo(300, 5);
    });
  });

  test('maps kinds and assigns texture keys for textured kinds', () => {
    const scene = snapshotToFrameScene(snapshot([
      layer({ id: 's', kind: 'shape' }),
      layer({ id: 'p', kind: 'shape', primitive: 'path', pathPoints: [{ x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 }] }),
      layer({ id: 'm', kind: 'shape', mask: { paths: [{ id: 'm1', points: [], inverted: false, mode: 'add', closed: true, feather: 0, opacity: 1, expansion: 0 }] } }),
      layer({ id: 'c', kind: 'shape', matte: { mode: 'alpha', inverted: false } }),
      layer({ id: 't', kind: 'text' }),
      layer({ id: 'i', kind: 'image' }),
      layer({ id: 'v', kind: 'video' }),
    ]));
    const byId = Object.fromEntries(scene.renderables.map((r) => [r.id, r]));
    expect(byId.s!.kind).toBe('rect');
    expect(byId.p!.kind).toBe('image');
    expect(byId.p!.textureKey).toBe('path:p');
    
    // A masked SHAPE rasterizes to a `path:` texture: the mask shader only
    // runs on textured renderables, so keeping it an SDF rect silently
    // ignored the mask (verified with real pixels — the subtract hole never
    // appeared on the GPU backend).
    expect(byId.m!.kind).toBe('image');
    expect(byId.m!.textureKey).toBe('path:m');
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

  test('routes an advanced blend mode through advancedBlend (blend stays normal)', () => {
    // Advanced modes (fixed-function GL can't do them) composite via the
    // BLEND_COMBINE shader: blend='normal', advancedBlend=<id>. multiply=1.
    const [r] = snapshotToFrameScene(snapshot([layer({ blend: 'multiply' })])).renderables;
    expect(r!.blend).toBe('normal');
    expect(r!.advancedBlend).toBe(1);
    const [o] = snapshotToFrameScene(snapshot([layer({ blend: 'overlay' })])).renderables;
    expect(o!.advancedBlend).toBe(3);
  });

  test('routes the Matte family through the combine, at its own ids', () => {
    // These ids are a WIRE FORMAT shared with two shader dialects. Pinning them
    // here is what stops a renumber from silently turning Stencil Alpha into
    // Silhouette Luma — both of which render a perfectly plausible picture.
    const id = (blend: string): number | undefined =>
      snapshotToFrameScene(snapshot([layer({ blend: blend as never })])).renderables[0]!.advancedBlend;
    expect(id('stencil-alpha')).toBe(31);
    expect(id('stencil-luma')).toBe(32);
    expect(id('silhouette-alpha')).toBe(33);
    expect(id('silhouette-luma')).toBe(34);
  });

  test('every blend mode maps to a distinct combine id', () => {
    // One id serving two modes is invisible until someone compares two renders.
    const ids = BLEND_MODES
      .map((b) => snapshotToFrameScene(snapshot([layer({ blend: b.mode })])).renderables[0]!.advancedBlend ?? 0)
      .filter((n) => n > 0);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('keeps a fixed-function blend mode on the renderable blend field', () => {
    const [r] = snapshotToFrameScene(snapshot([layer({ blend: 'add' })])).renderables;
    expect(r!.blend).toBe('add');
    expect(r!.advancedBlend).toBeUndefined();
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

    test('scale 0 collapses the quad to the layer origin (the layer vanishes)', () => {
      // `0 || 1` used to treat scale 0 as 1, so text/shapes scaled to 0 still
      // drew at authored size. Every corner of a 0-scale quad must land on (x,y).
      const r = layerToRenderable(layer({ x: 40, y: 80, width: 200, height: 100, scaleX: 0, scaleY: 0 }));
      for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0.5]] as const) {
        const p = apply(r.modelMatrix, u, v);
        expect(p.x).toBeCloseTo(40);
        expect(p.y).toBeCloseTo(80);
      }
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
    // Inverse of screen = (world-center)*zoom + vp/2; solving for center:
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
    // BackgroundPass (1) + ShapePass (2 visible shapes) + the scene blit (1);
    // the hidden layer was dropped by the mapper so it never reaches the GPU.
    //
    // The blit is the fourth draw because LINEAR_INTERMEDIATE_STORAGE keeps the
    // render targets in linear light, so every frame — even one with no effects
    // — ends in an EffectPass running `scene-blit` to encode sRGB for the
    // canvas. Asserting the pass names too, so that a future regression that
    // adds a draw somewhere else cannot be absorbed by bumping this number.
    expect(backend.passLog).toEqual(['clear', 'background', 'composition', 'effect']);
    expect(backend.stats().draws).toBe(4);
    renderer.dispose();
  });
});

describe('frame blending (Frame Mix) on the GPU path', () => {
  test('a frame-blended video emits TWO renderables: bracket A full, B at weight', () => {
    const scene = snapshotToFrameScene(snapshot([
      layer({ id: 'v', kind: 'video', opacity: 0.8, frameBlend: { a: 0.1, b: 0.1333, weight: 0.25 } }),
    ]));
    const a = scene.renderables.find((r) => r.id === 'v');
    const b = scene.renderables.find((r) => r.id === 'v::fb');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.textureKey).toBe('vfa:v');
    expect(b!.textureKey).toBe('vfb:v');
    expect(a!.opacity).toBeCloseTo(0.8);
    expect(b!.opacity).toBeCloseTo(0.8 * 0.25);
    // Same placement — B cross-dissolves over A.
    expect([...b!.modelMatrix]).toEqual([...a!.modelMatrix]);
  });

  test('a video without frameBlend stays a single asset-keyed renderable', () => {
    const scene = snapshotToFrameScene(snapshot([layer({ id: 'v', kind: 'video' })]));
    expect(scene.renderables.filter((r) => r.id.startsWith('v')).length).toBe(1);
    expect(scene.renderables.find((r) => r.id === 'v')!.textureKey).toBe('asset:v');
  });
});

describe('motion-blur samples on the GPU path', () => {
  test('samples become per-subframe model matrices at their sampled opacity', () => {
    const scene = snapshotToFrameScene(snapshot([
      layer({ id: 'm', kind: 'shape', motionSamples: [
        { x: 90, y: 100, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1 },
        { x: 110, y: 100, rotation: 0, scaleX: 1, scaleY: 1, opacity: 0.5 },
      ] }),
    ]));
    const r = scene.renderables.find((x) => x.id === 'm')!;
    expect(r.motionSamples).toHaveLength(2);
    expect(r.motionSamples![1]!.opacity).toBe(0.5);
    // The two samples sit at different x translations.
    expect(r.motionSamples![0]!.modelMatrix[6]).not.toBe(r.motionSamples![1]!.modelMatrix[6]);
  });

  test('a single sample does not trigger the multi-sample path', () => {
    const scene = snapshotToFrameScene(snapshot([
      layer({ id: 's', kind: 'shape', motionSamples: [
        { x: 100, y: 100, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1 },
      ] }),
    ]));
    expect(scene.renderables.find((x) => x.id === 's')!.motionSamples).toBeUndefined();
  });
});

describe('Accepts-Lights routing (per-fragment vs per-quad fold)', () => {
  // A lit 3D layer as buildSnapshot emits it: world matrix + projected affine +
  // per-quad gain + per-fragment shade params.
  const IDENTITY_W3D = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;
  const lit3d = (over: Partial<RenderLayer> = {}): RenderLayer =>
    layer({
      matrix: [1, 0, 0, 1, 100, 200],
      world3d: IDENTITY_W3D,
      lighting: [0.5, 0.5, 0.5],
      shade3d: { specular: 0.25, shininess: 32 },
      ...over,
    });

  test('depth-eligible lit layer: tint stays UNfolded, shade rides threeD (with quadGain fallback)', () => {
    const r = layerToRenderable(lit3d());
    expect(r.threeD).toBeDefined();
    expect(r.threeD!.shade).toEqual({ specular: 0.25, shininess: 32, quadGain: [0.5, 0.5, 0.5] });
    // fill #ff0000 → red channel 1, NOT pre-multiplied by the 0.5 gain
    expect(r.color!.r).toBeCloseTo(1, 5);
  });

  test('lit layer WITH effects is now depth-eligible: shade rides threeD, tint stays UNfolded', () => {
    // A 3D layer carrying a spatial effect is depth-eligible again — CompositionPass
    // pre-resolves the effect chain to a texture and draws it as a textured3d quad
    // inside the depth pass, so the effect result is lit per-fragment. The adapter
    // therefore attaches shade (with the per-quad gain as fallback) and does NOT
    // pre-fold the gain into the tint.
    const r = layerToRenderable(lit3d({ effects: [{ id: 'b', type: 'blur', params: { amount: 5 } }] }));
    expect(r.threeD!.shade).toEqual({ specular: 0.25, shininess: 32, quadGain: [0.5, 0.5, 0.5] });
    expect(r.color!.r).toBeCloseTo(1, 5);
  });

  test('per-quad-only layer (no shade3d — e.g. old snapshots): folds exactly as before', () => {
    const r = layerToRenderable(lit3d({ shade3d: undefined }));
    expect(r.threeD?.shade).toBeUndefined();
    expect(r.color!.r).toBeCloseTo(0.5, 5);
  });

  /**
   * AE's per-layer Quality switch.
   *
   * This shipped WRITE-ONLY: stored on `fx`, carried into the snapshot, folded
   * into the CONTENT HASH — and read by no renderer, so flipping it busted the
   * layer's texture cache and redrew a byte-identical image. These are the
   * behavioural half of the guard; `__tests__/contentHashReaders.test.ts` is
   * the structural half that catches the whole class.
   */
  describe('per-layer draft quality → sampling', () => {
    test("quality 'draft' asks the compositor for nearest sampling", () => {
      expect(layerToRenderable(layer({ kind: 'image', quality: 'draft' })).sampling).toBe('nearest');
    });

    test('the default (best) leaves sampling unset, i.e. linear', () => {
      expect(layerToRenderable(layer({ kind: 'image' })).sampling).toBeUndefined();
      expect(layerToRenderable(layer({ kind: 'image', quality: undefined })).sampling).toBeUndefined();
    });
  });

  test('scene passthrough: lights3d + camera eye reach the FrameScene', () => {
    const cam = {
      view: IDENTITY_W3D, projection: IDENTITY_W3D,
      eye: [960, 540, -1500] as const,
    };
    const lights3d = [{
      type: 'point' as const, color: { r: 1, g: 1, b: 1 }, gain: 0.8,
      x: 0, y: 0, z: -100, radius: 900, aimX: 1, aimY: 0, aimZ: 0, halfConeRad: 0.5,
      coneFeatherRad: 0.1, falloffMode: 0, falloffDistance: 500,
    }];
    const scene = snapshotToFrameScene(snapshot([lit3d()], { camera3d: cam, lights3d }));
    expect(scene.camera3d?.eye).toEqual([960, 540, -1500]);
    expect(scene.lights3d).toHaveLength(1);
  });
});
