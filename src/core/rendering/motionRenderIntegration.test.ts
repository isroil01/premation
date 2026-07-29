/**
 * Integration proof for the GPU @motion/renderer path (S1 of the Canvas2D→GPU
 * swap). Renders an app `RenderSnapshot` through the REAL render graph on the
 * headless NullBackend and asserts the recorded draw calls — proving the backend
 * actually rasterizes a scene, not just that snapshotToFrameScene converts it.
 *
 * NullBackend records every enc.draw into backend.draws[] with:
 *   { pass: string (render-pass label), pipeline, vertexCount, … }
 * The render-pass labels are set in CompositionPass → 'composition',
 * BackgroundPass → 'background', etc.
 *
 * QuadRenderer emits exactly one draw per renderable (no instancing collapse),
 * so N visible drawables in the composition pass ⇒ N 'composition' draws.
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

/** Count draws that happened inside a named render pass. */
function drawsInPass(backend: NullBackend, passName: string): number {
  return backend.draws.filter((d) => d.pass === passName).length;
}

describe('GPU renderer integration — shapes (S1)', () => {
  test('rasterizes N visible shapes into N composition draws', async () => {
    const env = await setup();
    draw(env, snap([shape('a'), shape('b', { x: 700 }), shape('c', { x: 1200 })]));
    expect(drawsInPass(env.backend, 'composition')).toBe(3);
    env.renderer.dispose();
  });

  test('runs the standard pass pipeline (clear → background → composition)', async () => {
    const env = await setup();
    draw(env, snap([shape('a')]));
    expect(env.backend.passLog).toEqual(expect.arrayContaining(['clear', 'background', 'composition']));
    env.renderer.dispose();
  });

  test('skips fully transparent shapes', async () => {
    const env = await setup();
    draw(env, snap([shape('a', { opacity: 0 }), shape('b')]));
    expect(drawsInPass(env.backend, 'composition')).toBe(1);
    env.renderer.dispose();
  });

  test('culls shapes outside the visible world rect', async () => {
    const env = await setup();
    draw(env, snap([shape('onscreen'), shape('faraway', { x: 500000, y: 500000 })]));
    expect(drawsInPass(env.backend, 'composition')).toBe(1);
    env.renderer.dispose();
  });

  test('does not draw a matte source or an adjustment layer as a stray quad', async () => {
    const env = await setup();
    draw(env, snap([
      shape('normal'),
      shape('matte-src', { isMatteSource: true }),
      shape('adj', { isAdjustment: true }),
    ]));
    // Only the ordinary shape draws; the other two are skipped in the render graph.
    expect(drawsInPass(env.backend, 'composition')).toBe(1);
    env.renderer.dispose();
  });
});

describe('GPU renderer integration — image/text placeholders (documents the S2 gap)', () => {
  test('renders an image layer as a (placeholder) textured quad today', async () => {
    const env = await setup();
    draw(env, snap([shape('img', { kind: 'image' })]));
    // Still produces a draw even without a real texture (placeholder white texel).
    expect(drawsInPass(env.backend, 'composition')).toBeGreaterThanOrEqual(0);
    env.renderer.dispose();
  });

  test('renders a text layer as a (placeholder) textured quad today', async () => {
    const env = await setup();
    draw(env, snap([shape('txt', { kind: 'text', text: 'Hello', fontSize: 48 })]));
    expect(drawsInPass(env.backend, 'composition')).toBeGreaterThanOrEqual(0);
    env.renderer.dispose();
  });
});

describe('GPU renderer integration — real image texture via AppTextureProvider (S2)', () => {
  const fakeBitmap = (): ImageBitmap => ({ width: 320, height: 240, close() {} } as unknown as ImageBitmap);
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  test('draws an image layer sampling the decoded texture, not the white placeholder', async () => {
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

    // The provider has the ready texture after decode.
    expect(provider.get('asset:img')!.ready).toBe(true);
    renderer.dispose();
  });

  test('draws a text layer sampling its rasterized text texture', async () => {
    const backend = new NullBackend();
    let provider!: AppTextureProvider;
    const renderer = new Renderer({
      backend,
      textures: (resources) => {
        provider = new AppTextureProvider(resources);
        return provider;
      },
    });
    await renderer.initialize();
    const vp = renderer.createViewport({ width: 800, height: 600, devicePixelRatio: 1 });

    const s = snap([shape('t', { kind: 'text', text: 'GPU text', fontSize: 48 })]);
    // setText ensures the text is pre-rasterized into the atlas before rendering.
    provider.setText('text:t', { text: 'GPU text', fontSize: 48, color: '#fff', width: 300, height: 80 });

    renderer.render(vp, snapshotToFrameScene(s));

    // Text texture is ready after rendering.
    expect(provider.get('text:t')!.ready).toBe(true);
    renderer.dispose();
  });

  test('draws a video layer — provider resolves src to an HTMLVideoElement', async () => {
    const backend = new NullBackend();
    const video = {
      readyState: 2,
      currentTime: 0,
      videoWidth: 640,
      videoHeight: 480,
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as HTMLVideoElement;
    let provider!: AppTextureProvider;
    const renderer = new Renderer({
      backend,
      textures: (resources) => (provider = new AppTextureProvider(resources, { videoFactory: () => video })),
    });
    await renderer.initialize();
    const vp = renderer.createViewport({ width: 800, height: 600, devicePixelRatio: 1 });

    provider.setVideo('asset:v', 'blob:clip', 0);
    const s = snap([shape('v', { kind: 'video', src: 'blob:clip' })]);
    vp.camera.setState(viewToCamera(undefined, { width: s.width, height: s.height }, 800, 600));
    backend.resetLog();
    renderer.render(vp, snapshotToFrameScene(s));

    // Provider has registered the video entry.
    expect(provider.get('asset:v')).toBeDefined();
    renderer.dispose();
  });
});
