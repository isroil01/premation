/**
 * MotionRendererBackend — drives the GPU @motion/renderer behind the app's
 * RenderBackend port, so it is a drop-in alternative to Canvas2DBackend.
 *
 * It owns a Renderer + Viewport + a concrete GPU backend (WebGL2 default,
 * WebGPU when available, Null for headless), and each frame converts the
 * immutable RenderSnapshot into the renderer's FrameScene (see
 * snapshotToFrameScene) and drives the camera from the snapshot's view.
 *
 * Async seam: the renderer/backend initialise asynchronously (WebGPU especially)
 * while the port's attach()/renderFrame() are synchronous. We init in the
 * background; frames requested before the device is ready are coalesced into a
 * single pending snapshot and flushed on ready.
 */

import {
  Renderer,
  Viewport,
  Color,
  NullBackend,
  WebGL2Backend,
  WebGPUBackend,
  type RenderBackend as GpuBackend,
} from '@motion/renderer';
import type { RenderBackend, RenderSnapshot } from './RenderBackend';
import { snapshotToFrameScene, viewToCamera } from './snapshotToFrameScene';
import { AppTextureProvider } from './AppTextureProvider';
import { getEventBus } from '@core/events/EventBus';

export type RendererBackendKind = 'webgl2' | 'webgpu' | 'null';

/** Void color behind the composition — transparent so the workspace shows
 *  through, matching Canvas2DBackend which clears the canvas to transparent. */
const VOID: Color = { r: 0, g: 0, b: 0, a: 0 };

export class MotionRendererBackend implements RenderBackend {
  readonly kind: string;
  readonly readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private readonly preferred: RendererBackendKind;

  private canvas: HTMLCanvasElement | null = null;
  private renderer: Renderer | null = null;
  private viewport: Viewport | null = null;
  private textures: AppTextureProvider | null = null;
  private ready = false;
  private disposed = false;
  private pending: RenderSnapshot | null = null;

  private cssW = 1;
  private cssH = 1;
  private dpr = 1;

  constructor(preferred: RendererBackendKind = 'webgl2') {
    this.preferred = preferred;
    this.kind = `motion-${preferred}`;
    this.readyPromise = new Promise<void>((resolve) => {
      this.resolveReady = resolve;
    });
  }

  attach(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    void this.init(canvas);
  }

  private createGpuBackend(): GpuBackend {
    if (this.preferred === 'null') return new NullBackend();
    if (
      this.preferred === 'webgpu' &&
      typeof navigator !== 'undefined' &&
      'gpu' in navigator
    ) {
      return new WebGPUBackend();
    }
    return new WebGL2Backend();
  }

  private async init(canvas: HTMLCanvasElement): Promise<void> {
    // The app-side texture provider decodes image assets to real GPU textures.
    // A finished decode fires onChange → we re-render so the pixels appear. The
    // `textures` factory runs synchronously inside the Renderer constructor.
    const renderer = new Renderer({
      backend: this.createGpuBackend(),
      textures: (resources) => (this.textures = new AppTextureProvider(resources)),
    });
    if (this.textures) {
      (this.textures as AppTextureProvider).onChange = () =>
        getEventBus().emit('AnimationChanged', { nodeId: '__texture__' });
    }
    try {
      await renderer.initialize({ canvas });
    } catch (err) {
      // No WebGL2/WebGPU (or context lost). Stay not-ready; the surface simply
      // shows nothing rather than throwing into React's render loop.
      // eslint-disable-next-line no-console
      console.warn('[MotionRendererBackend] init failed:', err);
      renderer.dispose();
      this.resolveReady();
      return;
    }
    if (this.disposed) {
      renderer.dispose();
      this.resolveReady();
      return;
    }
    this.renderer = renderer;
    this.viewport = renderer.createViewport({
      width: this.cssW,
      height: this.cssH,
      devicePixelRatio: this.dpr,
    });
    this.sizeCanvas();
    renderer.resize(this.cssW, this.cssH, this.dpr);
    this.ready = true;
    this.resolveReady();

    if (this.pending) {
      const snapshot = this.pending;
      this.pending = null;
      this.renderFrame(snapshot);
    }
  }

  /** The renderer's backend only sets the GL viewport; the canvas backing store
   *  is ours to size (device px), mirroring Canvas2DBackend. */
  private sizeCanvas(): void {
    const canvas = this.canvas;
    if (!canvas) return;
    canvas.width = Math.max(1, Math.round(this.cssW * this.dpr));
    canvas.height = Math.max(1, Math.round(this.cssH * this.dpr));
    canvas.style.width = `${this.cssW}px`;
    canvas.style.height = `${this.cssH}px`;
  }

  resize(width: number, height: number, dpr: number): void {
    this.cssW = Math.max(1, width);
    this.cssH = Math.max(1, height);
    this.dpr = dpr;
    if (this.ready && this.renderer && this.viewport) {
      this.sizeCanvas();
      this.viewport.resize(this.cssW, this.cssH, this.dpr);
      this.renderer.resize(this.cssW, this.cssH, this.dpr);
    }
  }

  renderFrame(snapshot: RenderSnapshot): void {
    if (!this.ready || !this.renderer || !this.viewport) {
      // Coalesce: only the latest frame matters once we're ready.
      this.pending = snapshot;
      return;
    }
    const vp = this.viewport;

    // Feed image asset sources for this frame (keyed to match snapshotToFrameScene's
    // `asset:<id>` or `path:<id>` textureKey), and forget layers that left the scene.
      if (this.textures) {
      const activeKeys = new Set<string>();
      for (const layer of snapshot.layers) {
        // 1. Base layer rasterization
        if (layer.kind === 'image' && layer.src) {
          const key = `asset:${layer.id}`;
          activeKeys.add(key);
          this.textures.setImage(key, layer.src);
        } else if (layer.kind === 'video' && layer.src) {
          const key = `asset:${layer.id}`;
          activeKeys.add(key);
          this.textures.setVideo(key, layer.src, snapshot.time ?? 0);
        } else if (layer.kind === 'text') {
          const key = `text:${layer.id}`;
          activeKeys.add(key);
          this.textures.setText(key, {
            text: layer.text ?? 'Text',
            fontSize: layer.fontSize ?? 48,
            color: layer.fill,
            width: layer.width,
            height: layer.height,
          });
        } else if (layer.kind === 'shape' && layer.primitive === 'path') {
          const key = `path:${layer.id}`;
          activeKeys.add(key);
          this.textures.setPath(key, layer);
        }

        // 2. Auxiliary alpha textures (masks/mattes)
        const hasMask = !!(layer.mask && layer.mask.paths.length > 0);
        if (hasMask) {
          const key = `mask:${layer.id}`;
          activeKeys.add(key);
          this.textures.setMask(key, layer);
        }
        
        const hasMatte = !!layer.matte;
        if (hasMatte) {
          // Mattes will be implemented similarly via setMatte(key, matteSource, consumer)
        }
      }
      this.textures.retain(activeKeys);
    }

    // Camera from the app's comp→canvas view (pan/zoom) or a centered fit.
    const cam = viewToCamera(snapshot.view, { width: snapshot.width, height: snapshot.height }, this.cssW, this.cssH);
    vp.camera.setState(cam);

    // Overlays: transparent void + only the guides the app has toggled on.
    vp.overlays.background = VOID;
    vp.overlays.checkerboard = false;
    vp.overlays.grid = snapshot.overlays?.grid ?? false;
    vp.overlays.safeArea = snapshot.overlays?.safeArea ?? false;
    vp.overlays.rulers = snapshot.overlays?.rulers ?? false;

    this.renderer.render(vp, snapshotToFrameScene(snapshot));
  }

  dispose(): void {
    this.disposed = true;
    this.ready = false;
    this.pending = null;
    this.renderer?.dispose();
    this.renderer = null;
    this.viewport = null;
    this.textures = null;
    this.canvas = null;
  }
}
