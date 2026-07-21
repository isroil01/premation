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
import type { RenderBackend, RenderLayer, RenderSnapshot } from './RenderBackend';
import { snapshotToFrameScene, viewToCamera, needsShapeRaster } from './snapshotToFrameScene';
import { viewportVideoFrames } from './videoFrameCache';
import { isLutEffect, buildChannelLut } from '@core/effects/colorLut';
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
  private exactMediaTiming = false;

  /** Layer ids whose texture feed already failed — warn once, not every frame. */
  private readonly warnedTextureLayers = new Set<string>();

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
      this.textures.setExactMediaTiming?.(this.exactMediaTiming);
      (this.textures as AppTextureProvider).onChange = () =>
        getEventBus().emit('AnimationChanged', { nodeId: '__texture__' });
    }
    try {
      await renderer.initialize({ canvas });
    } catch (err) {
      // No WebGL2/WebGPU (or context lost). Stay not-ready; the surface simply
      // shows nothing rather than throwing into React's render loop.
      // eslint-disable-next-line no-console
      console.warn(`[MotionRendererBackend] init failed for ${this.preferred}:`, err);
      renderer.dispose();
      getEventBus().emit('EngineError', { engine: `motion-${this.preferred}`, error: err as Error });
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
      // Target device scale for vector rasterization this frame: comp→canvas
      // scale × dpr. Drives the resolution tier so a 4K export re-rasters vectors
      // at native instead of upscaling a viewport-resolution texture.
      this.textures.setRasterScale((snapshot.view?.scale ?? 1) * this.dpr);
      // Walks the full layer tree (including layers nested inside precomps —
      // snapshotToFrameScene.flattenLayers recurses the same way, so every
      // textureKey it emits must be registered here or it renders as a white
      // placeholder quad).
      const processLayers = (layers: ReadonlyArray<RenderLayer>) => {
        for (const layer of layers) {
          // One bad asset (broken src, rasterization failure, upload error)
          // must not abort texture feeding for the rest of the frame.
          try {
            // 1. Base layer rasterization
            if (layer.particles) {
              // Particle emitter: rasterize the deterministic field for this
              // frame (sourceTime-aware, so time-remapped/stretched layers sim
              // the right instant). snapshotToFrameScene routes the layer to a
              // textured renderable under the same `particles:` key.
              const key = `particles:${layer.id}`;
              activeKeys.add(key);
              this.textures!.setParticles(
                key,
                layer.particles,
                layer.sourceTime !== undefined ? layer.sourceTime : (snapshot.time ?? 0),
                layer.width,
                layer.height,
              );
            } else if (layer.kind === 'image' && layer.src) {
              const key = `asset:${layer.id}`;
              activeKeys.add(key);
              this.textures!.setImage(key, layer.src);
            } else if (layer.kind === 'video' && layer.src) {
              if (layer.frameBlend) {
                // Frame Mix: feed both bracket frames. Cache hits upload the
                // exact decoded canvases; misses queue a decode (onChange →
                // re-render) and fall back to element-seeked frames near each
                // bracket time — nearest-frame until the cache lands.
                const ka = `vfa:${layer.id}`;
                const kb = `vfb:${layer.id}`;
                activeKeys.add(ka);
                activeKeys.add(kb);
                const fa = viewportVideoFrames.get(layer.src, layer.frameBlend.a);
                const fb = viewportVideoFrames.get(layer.src, layer.frameBlend.b);
                if (fa) this.textures!.setFrame(ka, fa, `t:${layer.frameBlend.a}`);
                else this.textures!.setVideo(ka, layer.src, layer.frameBlend.a);
                if (fb) this.textures!.setFrame(kb, fb, `t:${layer.frameBlend.b}`);
                else this.textures!.setVideo(kb, layer.src, layer.frameBlend.b);
              } else {
                const key = `asset:${layer.id}`;
                activeKeys.add(key);
                const targetTime = layer.sourceTime !== undefined ? layer.sourceTime : (snapshot.time ?? 0);
                this.textures!.setVideo(key, layer.src, targetTime);
              }
            } else if (layer.kind === 'text') {
              const key = `text:${layer.id}`;
              activeKeys.add(key);
              this.textures!.setText(key, {
                text: layer.text ?? 'Text',
                fontSize: layer.fontSize ?? 48,
                color: layer.fill,
                width: layer.width,
                height: layer.height,
                scaleX: layer.scaleX,
                scaleY: layer.scaleY,
                fontFamily: layer.fontFamily,
                fontWeight: layer.fontWeight,
                fontStyle: layer.fontStyle,
                align: layer.align,
                letterSpacing: layer.letterSpacing,
                lineHeight: layer.lineHeight,
                paragraphSpacing: layer.paragraphSpacing,
                runs: layer.runs,
                // Canvas2D-only effects (Fill/Stroke/Sharpen/Noise/…) + mask
                // are baked into the text texture — they have no GPU shader
                // form. layerToRenderable drops them from the GPU draw so
                // nothing double-applies.
                effects: layer.effects,
                mask: layer.mask,
              });
            } else if (!(layer.precompLayers && layer.precompLayers.length > 0) && needsShapeRaster(layer)) {
              // (Precomp containers draw their offscreen subtree texture, never
              // their own shape — skipping the raster avoids uploading a
              // comp-sized black texture per container.)
              // Custom paths, gradient-filled and masked shapes — the SAME
              // predicate layerToRenderable routes by, so the `path:` texture
              // this uploads is exactly the one the renderable references.
              const key = `path:${layer.id}`;
              activeKeys.add(key);
              this.textures!.setPath(key, layer);
            }

            // A light layer feeds its radial-gradient texture regardless of kind.
            if (layer.light) {
              const key = `light:${layer.id}`;
              activeKeys.add(key);
              this.textures!.setLight(key, layer.light.color);
            }

            // 2. Auxiliary alpha textures (masks/mattes)
            const hasMask = !!(layer.mask && layer.mask.paths.length > 0);
            if (hasMask) {
              const key = `mask:${layer.id}`;
              activeKeys.add(key);
              this.textures!.setMask(key, layer);
            }

            // 3. Colour LUT (Levels/Curves/Posterize) — build the per-channel
            // table and upload it as a 256×1 texture (the second sampler the
            // WebGL2 binding fix enabled). snapshotToFrameScene flags the layer
            // with the same `lut:<id>` key so the LUT shader runs.
            const lutEffects = (layer.effects ?? []).filter((e) => e.enabled !== false && isLutEffect(e.type));
            if (lutEffects.length > 0) {
              const lut = buildChannelLut(lutEffects);
              if (lut) {
                const key = `lut:${layer.id}`;
                activeKeys.add(key);
                const sig = lutEffects.map((e) => `${e.id}:${JSON.stringify(e.params ?? {})}`).join('|');
                this.textures!.setLut(key, lut, sig);
              }
            }
          } catch (err) {
            if (!this.warnedTextureLayers.has(layer.id)) {
              this.warnedTextureLayers.add(layer.id);
              // eslint-disable-next-line no-console
              console.warn(`[MotionRendererBackend] texture feed failed for layer ${layer.id}:`, err);
            }
          }

          // Recurse outside the try so a bad parent asset never skips children.
          if (layer.precompLayers && layer.precompLayers.length > 0) {
            processLayers(layer.precompLayers);
          }
        }
      };
      processLayers(snapshot.layers);

      // Gradient composition background → a baked texture stretched across a
      // full-comp quad (see snapshotToFrameScene). Solid backgrounds stay on the
      // renderer's flat composition.background (no texture needed).
      const bgPaint = snapshot.backgroundPaint;
      if (bgPaint && bgPaint.type !== 'solid' && !snapshot.transparent) {
        this.textures.setGradient('bg-gradient', bgPaint, snapshot.width, snapshot.height);
        activeKeys.add('bg-gradient');
      }

      this.textures.retain(activeKeys);
    }

    // Camera from the app's comp→canvas view (pan/zoom) or a centered fit.
    const cam = viewToCamera(snapshot.view, { width: snapshot.width, height: snapshot.height }, this.cssW, this.cssH);
    vp.camera.setState(cam);

    // Clip surface draws to the comp rect (AE comp-panel behaviour — Canvas2D
    // has always done this with ctx.clip()). Without it, a layer dragged off
    // the composition kept rendering on the pasteboard. Camera mapping:
    // screenCss = (world − center)·zoom + css/2, then × dpr for surface px.
    this.renderer.backend.setFrameClip?.({
      x: ((0 - cam.center.x) * cam.zoom + this.cssW / 2) * this.dpr,
      y: ((0 - cam.center.y) * cam.zoom + this.cssH / 2) * this.dpr,
      width: snapshot.width * cam.zoom * this.dpr,
      height: snapshot.height * cam.zoom * this.dpr,
    });

    // Overlays: transparent void + only the guides the app has toggled on.
    vp.overlays.background = VOID;
    vp.overlays.checkerboard = false;
    vp.overlays.grid = snapshot.overlays?.grid ?? false;
    vp.overlays.safeArea = snapshot.overlays?.safeArea ?? false;
    vp.overlays.rulers = snapshot.overlays?.rulers ?? false;

    this.renderer.render(vp, snapshotToFrameScene(snapshot));
  }

  setExactMediaTiming(on: boolean): void {
    this.exactMediaTiming = on;
    this.textures?.setExactMediaTiming?.(on);
  }

  takeMediaWaits(): Promise<void>[] {
    if (this.textures?.takeMediaWaits) {
      return this.textures.takeMediaWaits();
    }
    return [];
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
