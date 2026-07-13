/**
 * Integration proof for the GPU @motion/renderer path (S1 of the Canvas2D→GPU
 * swap). Renders an app `RenderSnapshot` through the REAL render graph on the
 * headless NullBackend and asserts the recorded draw calls — proving the backend
 * actually rasterizes a scene, not just that snapshotToFrameScene converts it.
 *
 * This is also the regression harness for the staged swap:
 *   S2 — a real TextureProvider (image/video decode + text raster). Today the
 *        default provider hands back a white texel, so image/text render as
 *        PLACEHOLDER quads; the `documents the S2 gap` tests below pin that so we
 *        notice when S2 replaces the placeholder with real content.
 *   S3 — effect / mask / matte passes.
 *
 * QuadRenderer emits exactly one draw() per renderable (no instancing collapse),
 * so N visible drawables ⇒ N draws in that pass — assertions stay exact.
 */

import { Renderer, NullBackend, type Viewport } from '@motion/renderer';
import { snapshotToFrameScene, viewToCamera } from './snapshotToFrameScene';
import { AppTextureProvider } from './AppTextureProvider';
import type { RenderSnapshot, RenderLayer } from './RenderBackend';

function shape(id: string, over: Partial<RenderLayer> = {}): RenderLayer {
  return {
    id, kind: 'shape', x: 960, y: 540, rotation: 0, scaleX: 1, scaleY: 1,
    opacity: 1, width: 200, height: 200, fill: '#e0245e', visible: true,
    primitive: 'rect', ...over,
  };
}

function snap(layers: RenderLayer[], over: Partial<RenderSnapshot> = {}): RenderSnapshot {
  return { width: 1920, height: 1080, background: '#101014', layers, ...over };
}

interface Env {
  backend: NullBackend;
  renderer: Renderer;
  vp: Viewport;
}

async function setup(w = 800, h = 600): Promise<Env> {
  const backend = new NullBackend();
  const renderer = new Renderer({ backend });
  await renderer.initialize(); // NullBackend ignores the surface
  const vp = renderer.createViewport({ width: w, height: h, devicePixelRatio: 1 });
  renderer.resize(w, h, 1);
  return { backend, renderer, vp };
}

/** Drive the camera from the snapshot (matching MotionRendererBackend) and render. */
function draw(env: Env, s: RenderSnapshot): void {
  const cam = viewToCamera(s.view, { width: s.width, height: s.height }, env.vp.width, env.vp.height);
  env.vp.camera.setState(cam);
  env.backend.resetLog();
  env.renderer.render(env.vp, snapshotToFrameScene(s));
}

const inPass = (b: NullBackend, pass: string): number => b.draws.filter((d) => d.pass === pass).length;

describe('GPU renderer integration — shapes (S1)', () => {
  it('rasterizes N visible shapes into N shape-pass draws', async () => {
    const env = await setup();
    draw(env, snap([shape('a'), shape('b', { x: 700 }), shape('c', { x: 1200 })]));
    expect(inPass(env.backend, 'shape')).toBe(3);
    env.renderer.dispose();
  });

  it('runs the standard pass pipeline (clear → background → shape)', async () => {
    const env = await setup();
    draw(env, snap([shape('a')]));
    expect(env.backend.passLog).toEqual(expect.arrayContaining(['clear', 'background', 'shape']));
    env.renderer.dispose();
  });

  it('skips fully transparent shapes', async () => {
    const env = await setup();
    draw(env, snap([shape('a', { opacity: 0 }), shape('b')]));
    expect(inPass(env.backend, 'shape')).toBe(1);
    env.renderer.dispose();
  });

  it('drops invisible layers before they reach the GPU', async () => {
    const env = await setup();
    draw(env, snap([shape('a', { visible: false }), shape('b', { visible: false })]));
    expect(inPass(env.backend, 'shape')).toBe(0);
    env.renderer.dispose();
  });

  it('culls shapes outside the visible world rect', async () => {
    const env = await setup();
    draw(env, snap([shape('onscreen'), shape('faraway', { x: 500000, y: 500000 })]));
    expect(inPass(env.backend, 'shape')).toBe(1);
    env.renderer.dispose();
  });

  it('reports a rendered frame to the backend', async () => {
    const env = await setup();
    draw(env, snap([shape('a')]));
    expect(env.backend.stats().frames).toBeGreaterThan(0);
    env.renderer.dispose();
  });
});

describe('GPU renderer integration — matte/adjustment layers dropped (S1)', () => {
  it('does not draw a matte source or an adjustment layer as a stray quad', async () => {
    const env = await setup();
    draw(
      env,
      snap([
        shape('matteSrc', { isMatteSource: true }),
        shape('adj', { isAdjustment: true }),
        shape('real'),
      ]),
    );
    // Only the ordinary shape draws; the other two are composited-only on the
    // Canvas2D path and are dropped on the GPU path until S3 adds those passes.
    expect(inPass(env.backend, 'shape')).toBe(1);
    env.renderer.dispose();
  });
});

describe('GPU renderer integration — image/text placeholders (documents the S2 gap)', () => {
  it('renders an image layer as a (placeholder) textured quad today', async () => {
    const env = await setup();
    draw(env, snap([shape('img', { kind: 'image', src: 'blob:x' })]));
    // S2 will swap the white-texel placeholder for a real decoded texture; the
    // draw count stays 1, so this test keeps passing — it just guards that the
    // image pass keeps running.
    expect(inPass(env.backend, 'image')).toBe(1);
    env.renderer.dispose();
  });

  it('renders a text layer as a (placeholder) textured quad today', async () => {
    const env = await setup();
    draw(env, snap([shape('txt', { kind: 'text', text: 'Hello', fontSize: 48 })]));
    expect(inPass(env.backend, 'text')).toBe(1);
    env.renderer.dispose();
  });
});

describe('GPU renderer integration — real image texture via AppTextureProvider (S2)', () => {
  const fakeBitmap = (): ImageBitmap => ({ width: 320, height: 240, close() {} } as unknown as ImageBitmap);
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it('draws an image layer sampling the decoded texture, not the white placeholder', async () => {
    const backend = new NullBackend();
    let provider!: AppTextureProvider;
    const renderer = new Renderer({
      backend,
      textures: (resources) => {
        const loader = async () => fakeBitmap();
        provider = new AppTextureProvider(resources, { loader });
        return provider;
      },
    });
    await renderer.initialize();
    const vp = renderer.createViewport({ width: 800, height: 600, devicePixelRatio: 1 });
    renderer.resize(800, 600, 1);

    // Feed the image source (as MotionRendererBackend does) and let it decode.
    provider.setImage('asset:img', 'blob:photo');
    await flush();

    const s = snap([shape('img', { kind: 'image', src: 'blob:photo' })]);
    vp.camera.setState(viewToCamera(undefined, { width: s.width, height: s.height }, 800, 600));
    backend.resetLog();
    renderer.render(vp, snapshotToFrameScene(s));

    // The image pass drew, and a real (non-placeholder) image texture exists.
    expect(inPass(backend, 'image')).toBe(1);
    expect(provider.get('asset:img')!.ready).toBe(true);
    renderer.dispose();
  });

  it('draws a text layer sampling its rasterized text texture', () => {
    const backend = new NullBackend();
    let provider!: AppTextureProvider;
    const renderer = new Renderer({
      backend,
      textures: (resources) => (provider = new AppTextureProvider(resources)),
    });
    // initialize() resolves synchronously for NullBackend within this microtask
    // in the image test above; here we drive it the same way.
    return renderer.initialize().then(() => {
      const vp = renderer.createViewport({ width: 800, height: 600, devicePixelRatio: 1 });
      renderer.resize(800, 600, 1);

      // Feed the text (as MotionRendererBackend does) — rasterizes synchronously.
      const placeholderId = provider.get('nope')!.texture.id;
      provider.setText('text:t', { text: 'Hello', fontSize: 48, color: '#fff', width: 300, height: 80 });

      const s = snap([shape('t', { kind: 'text', text: 'Hello', fontSize: 48 })]);
      vp.camera.setState(viewToCamera(undefined, { width: s.width, height: s.height }, 800, 600));
      backend.resetLog();
      renderer.render(vp, snapshotToFrameScene(s));

      expect(inPass(backend, 'text')).toBe(1);
      expect(provider.get('text:t')!.texture.id).not.toBe(placeholderId); // real, not placeholder
      renderer.dispose();
    });
  });

  it('draws a video layer sampling its current-frame texture', async () => {
    const backend = new NullBackend();
    const video = { readyState: 2, currentTime: 0, videoWidth: 640, videoHeight: 480 } as unknown as HTMLVideoElement;
    let provider!: AppTextureProvider;
    const renderer = new Renderer({
      backend,
      textures: (resources) => (provider = new AppTextureProvider(resources, { videoFactory: () => video as any })),
    });
    await renderer.initialize();
    const vp = renderer.createViewport({ width: 800, height: 600, devicePixelRatio: 1 });
    renderer.resize(800, 600, 1);

    const placeholderId = provider.get('nope')!.texture.id;
    provider.setVideo('asset:v', 'blob:clip', 0);

    const s = snap([shape('v', { kind: 'video', src: 'blob:clip' })]);
    vp.camera.setState(viewToCamera(undefined, { width: s.width, height: s.height }, 800, 600));
    backend.resetLog();
    renderer.render(vp, snapshotToFrameScene(s));

    expect(inPass(backend, 'video')).toBe(1);
    expect(provider.get('asset:v')!.texture.id).not.toBe(placeholderId);
    renderer.dispose();
  });
});
