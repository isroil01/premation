/**
 * The rendering engine's public façade. Constructed with a `RenderBackend`
 * (Dependency Inversion — it never imports one), it owns the resource manager,
 * shader/material systems, the render graph, and viewports, and drives the frame
 * lifecycle. It consumes a `FrameScene` and renders it; it never touches the
 * scene graph, timeline, animation, React, or the DOM.
 */

import type { RenderBackend, RenderSurface } from '../../gpu/RenderBackend';
import type { TextureFormat } from '../../gpu/types';
import { ResourceManager, type ResourceManagerOptions, type ResourceManagerStats } from '../../gpu/ResourceManager';
import type { RenderTargetHandle } from '../../gpu/types';
import { ShaderRegistry } from '../../shaders/ShaderRegistry';
import { ShaderCache } from '../../shaders/ShaderCache';
import { MaterialSystem } from '../../shaders/Material';
import { QuadRenderer } from '../../pipeline/QuadRenderer';
import { CommandBuffer } from '../../commands/DrawCommand';
import { DefaultTextureProvider, type TextureProvider } from '../../resources/TextureProvider';
import { RenderGraph } from '../../rendergraph/RenderGraph';
import { buildDefaultGraph, EffectPass, SCENE_COLOR_TARGET } from '../../rendergraph/passes';
import { RenderDiagnostics, type RenderDiagnostic } from './RenderDiagnostics';
import { SURFACE, type RenderServices } from '../../rendergraph/RenderPass';
import { Viewport, type ViewportOptions } from '../../viewport/Viewport';
import type { FrameScene } from '../../scene/FrameScene';
import type { FrameInfo } from '../Frame';
import { Logger } from '../../utils/Logger';
import { needsEncodeBlit } from '../../shaders/linearWorkingSpace';

export interface RendererOptions {
  /** The GPU backend (WebGPU/WebGL2/Null). Injected — the renderer owns it. */
  backend: RenderBackend;
  /** Surface color format; defaults per backend. */
  colorFormat?: TextureFormat;
  resources?: ResourceManagerOptions;
  /** Texture resolver; defaults to a white-texel provider. */
  textures?: (resources: ResourceManager) => TextureProvider;
  /** Render graph; defaults to the standard pipeline. */
  graph?: RenderGraph;
  /** Clock for frame timing (injectable for deterministic tests). */
  now?: () => number;
  logger?: Logger;
}

export interface FrameResult {
  frame: FrameInfo;
  resources: ResourceManagerStats;
  /** Resources disposed by GC at the end of this frame. */
  collected: number;
  /** Compositing operations the renderer could not honour this frame. Empty on
   *  the overwhelmingly common path. The HOST decides what to do with them:
   *  preview warns and keeps the frame, export must refuse it. */
  diagnostics: RenderDiagnostic[];
}

export class Renderer {
  readonly backend: RenderBackend;
  readonly colorFormat: TextureFormat;
  private readonly resources: ResourceManager;
  private readonly registry: ShaderRegistry;
  private readonly shaderCache: ShaderCache;
  private readonly materials: MaterialSystem;
  private readonly quad: QuadRenderer;
  private readonly commands = new CommandBuffer();
  private readonly textures: TextureProvider;
  private readonly graph: RenderGraph;
  private readonly services: RenderServices;
  /** Drained by the host each frame — see FrameResult.diagnostics. */
  readonly diagnostics = new RenderDiagnostics();
  private readonly viewports = new Map<number, Viewport>();
  private readonly now: () => number;
  private readonly log: Logger;

  private initialized = false;
  private disposed = false;
  private frameIndex = 0;
  private lastTime = 0;
  private inFrame = false;
  private devicePixelRatio = 1;
  /** Last frame's scene-color RT (linear when LINEAR_INTERMEDIATE_STORAGE). */
  private lastSceneColor: RenderTargetHandle | null = null;
  private lastSceneSize = { width: 0, height: 0 };

  constructor(options: RendererOptions) {
    this.backend = options.backend;
    this.colorFormat = options.colorFormat ?? (this.backend.kind === 'webgpu' ? 'bgra8unorm' : 'rgba8unorm');
    this.now = options.now ?? defaultClock;
    this.log = options.logger ?? new Logger('renderer');

    this.resources = new ResourceManager(this.backend, options.resources);
    this.registry = new ShaderRegistry();
    this.shaderCache = new ShaderCache(this.backend);
    this.materials = new MaterialSystem(this.resources, this.registry, this.shaderCache);
    this.quad = new QuadRenderer(this.backend, this.resources, this.materials, this.colorFormat);
    this.textures = (options.textures ?? ((r) => new DefaultTextureProvider(r)))(this.resources);
    this.graph = options.graph ?? buildDefaultGraph();

    this.services = {
      backend: this.backend,
      resources: this.resources,
      materials: this.materials,
      quad: this.quad,
      textures: this.textures,
      colorFormat: this.colorFormat,
      commands: this.commands,
      diagnostics: this.diagnostics,
    };
  }

  // ── Lifecycle ───────────────────────────────────────────────────
  async initialize(surface?: RenderSurface): Promise<void> {
    if (this.initialized) return;
    await this.backend.initialize(surface);
    this.initialized = true;
    this.log.info(`initialized (${this.backend.kind})`);
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  // ── Viewports ───────────────────────────────────────────────────
  createViewport(options: ViewportOptions): Viewport {
    const vp = new Viewport(options);
    this.viewports.set(vp.id, vp);
    return vp;
  }

  destroyViewport(viewport: Viewport | number): boolean {
    const id = typeof viewport === 'number' ? viewport : viewport.id;
    return this.viewports.delete(id);
  }

  get viewportCount(): number {
    return this.viewports.size;
  }

  // ── Frame lifecycle (manual, multi-viewport) ────────────────────
  beginFrame(timeMs?: number): FrameInfo {
    this.assertReady();
    if (this.inFrame) throw new Error('beginFrame called while already in a frame');
    this.inFrame = true;
    this.frameIndex += 1;
    const time = timeMs ?? this.now();
    const delta = this.lastTime === 0 ? 0 : Math.max(0, time - this.lastTime);
    this.lastTime = time;
    this.resources.beginFrame(this.frameIndex);
    this.quad.beginFrame();
    this.backend.beginFrame();
    return { index: this.frameIndex, timeMs: time, deltaMs: delta, devicePixelRatio: this.devicePixelRatio };
  }

  /** Render one viewport's scene. Must be called between begin/endFrame. */
  renderViewport(viewport: Viewport, scene: FrameScene, frame: FrameInfo): void {
    if (!this.inFrame) throw new Error('renderViewport called outside a frame');
    
    // Dynamically toggle EffectPass. Linear RT storage always needs the encode
    // blit — otherwise packColor's linearized solids land in the 8-bit canvas.
    const effectPass = this.graph.getPass('effect');
    if (effectPass) {
      const needsEffect = needsEncodeBlit(!!scene.hasEffects);
      if (effectPass.enabled !== needsEffect) {
        effectPass.enabled = needsEffect;
        this.graph.invalidate();
      }
      // ALWAYS re-assert the routing target: `activeColorTarget` is a static
      // shared by every Renderer instance in the page. Setting it only on the
      // enabled-flip let another instance (the live viewport vs a headless
      // export renderer) leave it pointing at scene-color — this renderer's
      // passes then drew into a texture its own (disabled) EffectPass never
      // blitted, and the frame came out blank.
      EffectPass.activeColorTarget = needsEffect ? SCENE_COLOR_TARGET : SURFACE;
    }

    const targets = this.graph.execute({ services: this.services, frame, viewport, scene });
    this.lastSceneColor = targets.get(SCENE_COLOR_TARGET) ?? null;
    const { width, height } = viewport.pixelSize;
    this.lastSceneSize = { width, height };
  }

  /**
   * Linear RGBA float readback of the last composed scene-color target.
   * Null when EffectPass was off (drew straight to surface) or the backend
   * cannot read float RTs.
   */
  readLinearRgba(): Float32Array | null {
    if (!this.lastSceneColor) return null;
    const fn = this.backend.readRenderTargetFloat?.bind(this.backend);
    if (!fn) return null;
    return fn(this.lastSceneColor, this.lastSceneSize.width, this.lastSceneSize.height);
  }

  /** Async linear readback — required for WebGPU EXR export. */
  async readLinearRgbaAsync(): Promise<Float32Array | null> {
    if (!this.lastSceneColor) return null;
    const asyncFn = this.backend.readRenderTargetFloatAsync?.bind(this.backend);
    if (asyncFn) {
      return asyncFn(this.lastSceneColor, this.lastSceneSize.width, this.lastSceneSize.height);
    }
    return this.readLinearRgba();
  }

  endFrame(): number {
    if (!this.inFrame) throw new Error('endFrame called outside a frame');
    this.backend.endFrame();
    this.backend.present();
    const collected = this.resources.collectGarbage();
    this.inFrame = false;
    return collected;
  }

  /** Convenience: render a single viewport as a complete frame. */
  render(viewport: Viewport, scene: FrameScene, timeMs?: number): FrameResult {
    const frame = this.beginFrame(timeMs);
    this.renderViewport(viewport, scene, frame);
    const collected = this.endFrame();
    return { frame, resources: this.resources.stats(), collected, diagnostics: this.diagnostics.drain() };
  }

  resize(width: number, height: number, devicePixelRatio = this.devicePixelRatio): void {
    this.assertReady();
    this.devicePixelRatio = devicePixelRatio;
    this.backend.resize(width, height, devicePixelRatio);
  }

  // ── Introspection ───────────────────────────────────────────────
  get renderGraph(): RenderGraph {
    return this.graph;
  }
  get shaders(): ShaderRegistry {
    return this.registry;
  }
  resourceStats(): ResourceManagerStats {
    return this.resources.stats();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.viewports.clear();
    this.shaderCache.dispose();
    this.resources.dispose();
    this.backend.dispose();
    this.initialized = false;
    this.log.info('disposed');
  }

  private assertReady(): void {
    if (this.disposed) throw new Error('Renderer is disposed');
    if (!this.initialized) throw new Error('Renderer.initialize() must be called first');
  }
}

function defaultClock(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now();
  return Date.now();
}
