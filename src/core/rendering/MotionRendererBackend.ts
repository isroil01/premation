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
 * while the port's attach/renderFrame are synchronous. We init in the
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
import { readCubeLutParam, cubeLutSignature } from '@core/effects/cubeLut';
import { layerIsBaked } from '@core/effects/effectBake';
import { useTextEditStore } from '@stores/textEditStore';
import { AppTextureProvider } from './AppTextureProvider';
import { getEventBus } from '@core/events/EventBus';
import { noteDeviceLoss } from '@core/plugins/pluginEffects';
import { setWebgpuAvailable } from '@core/plugins/capabilities';
import { markGpuOwned } from './canvasOwnership';
import { attachPluginEffects } from './pluginEffectBridge';

export type RendererBackendKind = 'webgl2' | 'webgpu' | 'null';

/** Minimal structural shapes for the WebGPU probe — the DOM lib in this repo
 *  does not ship @webgpu/types, and the probe needs only these members. */
interface GpuLike {
  requestAdapter(): Promise<{ requestDevice(): Promise<{ destroy?: () => void }> } | null>;
  getPreferredCanvasFormat(): string;
}
interface GpuCanvasLike {
  configure(config: { device: unknown; format: string }): void;
  unconfigure?(): void;
}

/** Void color behind the composition — transparent so the workspace shows
 *  through, matching Canvas2DBackend which clears the canvas to transparent. */
const VOID: Color = { r: 0, g: 0, b: 0, a: 0 };

/**
 * Ceiling on a single init attempt. `adapter.requestDevice` has no timeout of
 * its own and can hang indefinitely on a wedged driver; without this the whole
 * ladder stalls, readyPromise never settles and the viewport spins forever.
 */
const INIT_TIMEOUT_MS = 6000;

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

export class MotionRendererBackend implements RenderBackend {
  readonly kind: string;
  /**
   * The tier that ACTUALLY initialized, or null until one does.
   *
   * `kind` is the tier this backend was ASKED for and never changes, because
   * callers read it before init has resolved. That made it a poor answer to
   * "what rendered this frame": ask for WebGPU on a machine with no adapter and
   * `kind` still says `motion-webgpu` after the ladder has stepped down to
   * WebGL2. The render-tests harness believed it, so every WebGPU parity figure
   * this project has ever reported was measured on WebGL2 pixels read back
   * through the WebGPU path — see packages/render-tests/harness/renderEntry.ts,
   * which now refuses to render a backend whose resolvedKind is not the one it
   * asked for.
   *
   * Proven by: src/core/rendering/backendResolvedKind.test.ts.
   */
  resolvedKind: RendererBackendKind | null = null;
  /** Diagnostics from the most recent renderFrame (M8a). */
  private frameDiagnostics: ReadonlyArray<{ code: string; detail: string; layerId?: string }> = [];
  /** Details already surfaced, so a 60fps viewport reports each once. */
  private readonly reportedDiagnostics = new Set<string>();
  readonly readyPromise: Promise<void>;
  /**
   * True when EVERY init attempt (preferred tier + fallbacks + retry) failed.
   * readyPromise still resolves — so awaiting callers never hang — but the
   * surface cannot paint; the UI must check this flag instead of treating a
   * resolved readyPromise as success (the old behavior dismissed the loading
   * spinner into a silent blank canvas).
   */
  initFailed = false;
  /** Human-readable reason for the failure when initFailed is true. */
  initErrorMessage: string | null = null;
  /** Raw error text of the most recent failed init attempt (diagnostics only). */
  private lastInitErrorText: string | null = null;
  private resolveReady!: () => void;
  private readonly preferred: RendererBackendKind;

  private canvas: HTMLCanvasElement | null = null;
  private renderer: Renderer | null = null;
  /** Stops the plugin-effect subscription. Null until a renderer comes up. */
  private detachPluginEffects: (() => void) | null = null;
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

  readonly role: 'viewport' | 'auxiliary';

  /**
   * WebGPU is this product's PRIMARY engine; WebGL2 is the fallback rung.
   *
   * The default used to be `'webgl2'`, and that is not a cosmetic preference:
   * `initAttempts` only probes WebGPU when `preferred === 'webgpu'`, so any
   * caller that omitted the argument silently opted the whole process out of
   * WebGPU — it was never even attempted. `createRenderBackend` always passes a
   * resolved kind, so the shipping path was unaffected, but the default had the
   * wrong polarity for every other caller (tests, tools, future call sites).
   * `initAttempts` still degrades to WebGL2 on any hardware that can't deliver.
   */
  constructor(preferred: RendererBackendKind = 'webgpu', role: 'viewport' | 'auxiliary' = 'viewport') {
    this.preferred = preferred;
    this.role = role;
    this.kind = `motion-${preferred}`;
    this.readyPromise = new Promise<void>((resolve) => {
      this.resolveReady = resolve;
    });
  }

  attach(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    // Claim the element BEFORE the async init ladder runs. Init's first real
    // getContext is hundreds of ms away on a cold start (the WebGPU probe runs
    // first), and any 2d read that lands in that gap — the mousemove pixel
    // sampler was the one that did — binds the element to 2d and makes every
    // GPU rung return null forever. Marking is synchronous, so no event
    // handler can observe this canvas unclaimed.
    markGpuOwned(canvas);
    // init resolves readyPromise in a finally block and records initFailed, so
    // it should never reject — but attach is sync and an escaped rejection here
    // would be an unhandled promise rejection with the spinner left spinning.
    this.init(canvas).catch((err) => {

      console.error('[MotionRendererBackend] init threw unexpectedly:', err);
      this.initFailed = true;
      this.initErrorMessage = err instanceof Error ? err.message : String(err);
      this.resolveReady();
    });
  }

  /**
   * Can this document create AND configure a WebGPU context at all?
   *
   * Probed once per page on a THROWAWAY canvas. `getContext` permanently binds
   * a canvas element to one context type: if we asked the real viewport canvas
   * for 'webgpu' and `configure` then threw (device lost, format mismatch — the
   * classic intermittent on Windows hybrid graphics), that canvas could never
   * afterwards be given a 'webgl2' context. Both WebGL2 rungs of the ladder would
   * then see `getContext('webgl2') === null` and a recoverable WebGPU hiccup
   * would surface as a hard "Preview unavailable" on a perfectly good GPU.
   *
   * Probing first means the real canvas is only ever handed to a tier we already
   * know works.
   */
  private static webgpuProbe: Promise<boolean> | null = null;

  private static probeWebGpu(): Promise<boolean> {
    MotionRendererBackend.webgpuProbe ??= (async (): Promise<boolean> => {
      // Every step is recorded and forwarded to the main-process GPU log so a
      // packaged build (no DevTools) can still report exactly where WebGPU fails.
      const report: Record<string, unknown> = { where: 'probeWebGpu' };
      let device: { destroy?: () => void } | null = null;
      try {
        const gpu = (navigator as unknown as { gpu?: GpuLike }).gpu;
        report.hasNavigatorGpu = !!gpu;
        report.isSecureContext = typeof isSecureContext !== 'undefined' ? isSecureContext : null;
        report.origin = typeof location !== 'undefined' ? location.origin : null;
        if (!gpu || typeof document === 'undefined') { report.result = 'no-navigator-gpu'; return false; }
        const adapter = await withTimeout(gpu.requestAdapter(), INIT_TIMEOUT_MS, 'requestAdapter');
        report.gotAdapter = !!adapter;
        const adapterInfo = (adapter as unknown as { info?: unknown } | null)?.info;
        if (adapterInfo) report.adapterInfo = adapterInfo;
        // The one field that answers hardware-vs-software: true means Dawn gave a
        // software fallback (WARP), i.e. WebGPU "works" but on the CPU.
        report.isFallbackAdapter = (adapter as unknown as { isFallbackAdapter?: boolean } | null)?.isFallbackAdapter ?? null;
        try {
          const reqInfo = (adapter as unknown as { requestAdapterInfo?: () => Promise<unknown> } | null)?.requestAdapterInfo;
          if (reqInfo) report.requestedAdapterInfo = await reqInfo.call(adapter);
        } catch { /* older/newer API surface — ignore */ }
        if (!adapter) { report.result = 'no-adapter'; return false; }
        device = await withTimeout(adapter.requestDevice(), INIT_TIMEOUT_MS, 'requestDevice');
        report.gotDevice = !!device;
        if (!device) { report.result = 'no-device'; return false; }
        const ctx = document.createElement('canvas').getContext('webgpu') as GpuCanvasLike | null;
        report.gotContext = !!ctx;
        if (!ctx) { report.result = 'no-context'; return false; }
        ctx.configure({ device, format: gpu.getPreferredCanvasFormat() });
        ctx.unconfigure?.();
        report.result = 'ok';
        return true;
      } catch (err) {

        console.warn('[MotionRendererBackend] WebGPU probe failed, using WebGL2:', err);
        report.result = 'threw';
        report.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        return false;
      } finally {
        device?.destroy?.();
        try {
          (globalThis as unknown as { motionEditor?: { diag?: { gpuReport?: (r: unknown) => void } } })
            .motionEditor?.diag?.gpuReport?.(report);
        } catch { /* diagnostics must never break the probe */ }
      }
    })();
    return MotionRendererBackend.webgpuProbe;
  }

  private createGpuBackendFor(kind: RendererBackendKind): GpuBackend {
    if (kind === 'null') return new NullBackend();
    if (kind === 'webgpu') {
      const backend = new WebGPUBackend();
      /*
        Attached BEFORE `initialize`, which is where the device is acquired — a
        handler registered afterwards would miss a device lost during startup,
        which is a real case on a machine already in trouble.

        This is the production caller for plugin-effect attribution. A GPU
        cannot be preempted, so a plugin's fragment shader that hangs it causes
        a device reset that destroys every GPU context in the process. Without
        this the app learns the viewport died and nothing about why; with it,
        the effect that was mid-draw is named and disabled.

        `noteDeviceLoss` decides whether a plugin is implicated at all — a loss
        with nothing plugin-owned drawing blames nobody, which is the common
        case: driver updates, other applications, waking from sleep.
      */
      backend.onDeviceLost((reason) => { noteDeviceLoss(reason); });
      return backend;
    }
    return new WebGL2Backend();
  }

  /**
   * The context type a canvas ELEMENT has already been bound to.
   *
   * `getContext` binds a canvas to one context type permanently — asking the
   * same element for a different type afterwards returns null forever. The
   * throwaway-canvas probe protects the FIRST attempt from that, but nothing
   * protected the ladder itself: once the real WebGPU attempt called
   * `getContext('webgpu')`, the element was burned, and the WebGL2 rungs below
   * it could only ever get null. So a WebGPU attempt that failed for a purely
   * transient reason (device lost, init timeout while the project loads, a
   * resize race) took the whole ladder down with it and surfaced as
   * "WebGL2 is not available" on a machine where WebGPU works fine — the
   * intermittent blank preview on entering a project.
   */
  private static boundKind = new WeakMap<HTMLCanvasElement, RendererBackendKind>();

  /**
   * Record what this canvas is bound to after an attempt touched it.
   *
   * Asking for the kind we JUST tried is safe and cannot bind anything new: it
   * either hands back the context that attempt created, or null because it
   * never got one. Never call this for a kind that has not been attempted — that
   * would do the binding it is meant to detect.
   */
  private static noteBinding(canvas: HTMLCanvasElement, kind: RendererBackendKind): void {
    if (kind === 'null') return;
    const ctx = canvas.getContext(kind === 'webgpu' ? ('webgpu' as 'webgl2') : 'webgl2');
    if (ctx) MotionRendererBackend.boundKind.set(canvas, kind);
  }

  /**
   * The ladder of init attempts, in order. Real recovery, not just a badge:
   *   webgpu → webgpu retry → webgl2 → webgl2 retry (all delayed after the first).
   *
   * Two reasons a delayed same-tier retry beats stepping straight down:
   *  - A failed getContext usually means the page hit the browser's live-context
   *    cap; `dispose` explicitly loses its context, so a slot frees almost
   *    immediately and a short-delay retry succeeds where the first raced it.
   *  - Once a tier has bound the canvas (see `boundKind`), it is the ONLY tier
   *    that can ever succeed on that element. Retrying it is not optimism, it is
   *    the only move left — and `initLadder` skips the mismatched rungs rather
   *    than burning the ladder on guaranteed-null getContext calls.
   *
   * (NullBackend is NOT a fallback tier here — it produces no pixels, which is
   * indistinguishable from the blank-canvas bug this fixes. Total failure is
   * surfaced via initFailed instead.)
   */
  private async initAttempts(): Promise<Array<{ kind: RendererBackendKind; delayMs?: number }>> {
    if (this.preferred === 'null') return [{ kind: 'null' }];
    const attempts: Array<{ kind: RendererBackendKind; delayMs?: number }> = [];
    // Only offer WebGPU once the throwaway-canvas probe has proven the whole
    // adapter → device → configure path works. `'gpu' in navigator` alone is not
    // evidence of that, and being wrong there poisons the real canvas.
    if (
      this.preferred === 'webgpu' &&
      typeof navigator !== 'undefined' &&
      'gpu' in navigator &&
      (await MotionRendererBackend.probeWebGpu())
    ) {
      attempts.push({ kind: 'webgpu' });
      attempts.push({ kind: 'webgpu', delayMs: 250 });
    }
    attempts.push({ kind: 'webgl2' });
    attempts.push({ kind: 'webgl2', delayMs: 250 });
    return attempts;
  }

  private async init(canvas: HTMLCanvasElement): Promise<void> {
    try {
      await this.initLadder(canvas);
      // Cold-start GPU race recovery. On a freshly launched process the GPU
      // process can still be warming up when the first viewport mounts, so every
      // rung — WebGPU AND WebGL2 — fails and resolvedKind stays null even though
      // the hardware is fully capable (the throwaway-canvas probe already passed
      // and reported a non-fallback adapter). That is a transient race, not a
      // real inability, and previously surfaced as a permanent "GPU unavailable"
      // error on the first editor entry of a packaged build. Retry with backoff
      // before giving up. Bails the instant the backend is disposed (the caller
      // re-created it) so this never fights a newer instance for the canvas.
      for (let retry = 0; retry < 4 && this.resolvedKind === null && !this.disposed; retry++) {
        await new Promise((r) => setTimeout(r, 400 + retry * 600));
        if (this.disposed || this.resolvedKind !== null) break;
        this.initFailed = false;
        this.initErrorMessage = null;
        await this.initLadder(canvas);
      }
    } finally {
      // Unconditional: several statements below the initialize try/catch (the
      // Renderer constructor, createViewport, resize, the EngineReady emit) can
      // throw, and if resolveReady were only called on the success and
      // exhausted-ladder paths, readyPromise would stay pending forever and the
      // viewport would spin with no error to show.
      this.resolveReady();
      // The ground-truth of what the viewport actually renders with: 'webgpu'
      // means the real backend won, 'webgl2' means it fell back despite the probe.
      try {
        (globalThis as unknown as { motionEditor?: { diag?: { gpuReport?: (r: unknown) => void } } })
          .motionEditor?.diag?.gpuReport?.({ where: 'init', role: this.role, preferred: this.preferred, resolvedKind: this.resolvedKind, initFailed: this.initFailed, lastError: this.lastInitErrorText });
      } catch { /* diagnostics must never break init */ }
    }
  }

  private async initLadder(canvas: HTMLCanvasElement): Promise<void> {
    let lastError: unknown = null;
    /** True when a rung was skipped because the canvas is bound to another type. */
    let skippedForBinding = false;
    const attempts = await this.initAttempts();
    if (this.disposed) return;
    for (let i = 0; i < attempts.length; i++) {
      const attempt = attempts[i]!;
      if (this.disposed) break;
      // Skip any rung whose context type this canvas can no longer produce.
      // Once an earlier attempt bound the element, `getContext` for a different
      // type returns null forever — attempting it wastes a rung and, worse,
      // makes the LAST error "WebGL2 is not available" on a machine whose only
      // real problem was one transient WebGPU hiccup.
      const bound = MotionRendererBackend.boundKind.get(canvas);
      if (bound && bound !== attempt.kind) {
        skippedForBinding = true;
        continue;
      }
      if (attempt.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, attempt.delayMs));
        if (this.disposed) break;
      }
      // The app-side texture provider decodes image assets to real GPU textures.
      // A finished decode fires onChange → we re-render so the pixels appear. The
      // `textures` factory runs synchronously inside the Renderer constructor.
      // Held, not inlined: plugin effects need the backend itself to ask
      // whether their WGSL compiles, and `Renderer` does not expose it.
      const gpuBackend = this.createGpuBackendFor(attempt.kind);
      const renderer = new Renderer({
        backend: gpuBackend,
        textures: (resources) => (this.textures = new AppTextureProvider(resources)),
      });
      if (this.textures) {
        this.textures.setExactMediaTiming?.(this.exactMediaTiming);
        (this.textures as AppTextureProvider).onChange = () =>
          getEventBus().emit('AnimationChanged', { nodeId: '__texture__' });
      }
      try {
        await withTimeout(renderer.initialize({ canvas }), INIT_TIMEOUT_MS, `${attempt.kind} initialize`);
      } catch (err) {
        // No context for this tier (or context lost mid-init). Dispose the
        // failed renderer+backend and step down to the next attempt.
        //
        // Record the binding FIRST: a WebGPU attempt that got its context and
        // then failed to configure has still burned the element, and the rungs
        // below must know that before they try.
        MotionRendererBackend.noteBinding(canvas, attempt.kind);
        lastError = err;
        this.lastInitErrorText = err instanceof Error ? `${attempt.kind}: ${err.name}: ${err.message}` : `${attempt.kind}: ${String(err)}`;

        console.warn(`[MotionRendererBackend] init failed for ${attempt.kind}:`, err);
        try {
          renderer.dispose();
        } catch {
          /* teardown of a half-initialized renderer is best-effort */
        }
        this.textures = null;
        const isFinalAttempt = i === attempts.length - 1;
        // Only emit EngineError if this is webgpu (stepping down to webgl2) or the final retry attempt,
        // so temporary context races on an intermediate attempt don't trigger premature software badges.
        if (attempt.kind === 'webgpu' || isFinalAttempt) {
          getEventBus().emit('EngineError', { engine: `motion-${attempt.kind}`, role: this.role, error: err as Error });
        }
        continue;
      }
      // A SUCCESSFUL attempt binds the element too. Recording it matters for the
      // NEXT backend attached to this same canvas (re-entering a project reuses
      // the element): without it, a later backend that preferred the other tier
      // would spend its rungs on getContext calls that can only return null.
      MotionRendererBackend.noteBinding(canvas, attempt.kind);

      /*
        Tell the plugin system which tier actually won.

        Here, on the successful attempt, rather than from `preferred` at the top
        of the ladder — `preferred` is a request and this is the answer. Asking
        for WebGPU on a machine with no adapter steps down to WebGL2, and that
        exact confusion is what made `kind` unreliable (see its comment above).

        A plugin effect is WGSL; on WebGL2 it renders its input unchanged. So
        this is not a performance hint — it is the difference between an effect
        plugin working and being inert, and `capabilities.ts` turns it into an
        install refusal rather than a silent no-op.
      */
      setWebgpuAvailable(attempt.kind === 'webgpu');

      if (this.disposed) {
        renderer.dispose();
        break;
      }
      this.renderer = renderer;

      /*
        Plugin effects, now that there is a device to compile them against.

        Here rather than at plugin-enable time because the two events have no
        fixed order: a plugin enabled during startup has no renderer yet, and a
        renderer that comes up on a project with plugins already enabled has a
        backlog. Attaching syncs the backlog and then follows every later
        change, so neither order is the special case.

        Not gated on the tier. On WebGL2 a plugin effect compiles to a
        passthrough and draws its input unchanged — inert, but the effect still
        has to reach `ready` for the layer to render at all, and refusing to
        attach here would turn "does nothing" into "the layer disappears".
      */
      this.detachPluginEffects?.();
      this.detachPluginEffects = attachPluginEffects(renderer, gpuBackend);

      this.viewport = renderer.createViewport({
        width: this.cssW,
        height: this.cssH,
        devicePixelRatio: this.dpr,
      });
      this.sizeCanvas();
      renderer.resize(this.cssW, this.cssH, this.dpr);
      this.ready = true;
      // Set BEFORE EngineReady: a listener that reacts to the event and reads
      // the backend would otherwise see the previous rung's answer.
      this.resolvedKind = attempt.kind;
      // Corrects the tier badge after a successful fallback/retry (an earlier
      // EngineError may have flipped it to 'software' prematurely).
      getEventBus().emit('EngineReady', { engine: `motion-${attempt.kind}`, role: this.role });
      // readyPromise is resolved by init's finally — do not resolve here, or a
      // throw in the flush below would skip nothing but still split the contract
      // across two places.
      if (this.pending) {
        const snapshot = this.pending;
        this.pending = null;
        this.renderFrame(snapshot);
      }
      return;
    }
    // Disposed mid-init, or every attempt failed. Resolve readyPromise either
    // way (awaiters must not hang), but record failure so the UI shows an
    // error state instead of dismissing the spinner into a blank canvas.
    if (!this.disposed) {
      this.initFailed = true;
      const detail = lastError instanceof Error ? lastError.message : null;
      this.initErrorMessage = skippedForBinding
        // Don't blame a tier that was never allowed to run. The canvas was
        // already bound to another context type, so the fallback rungs were
        // skipped by design and quoting their error would be a lie.
        ? `The preview surface could not be re-initialized${detail ? ` (${detail})` : ''}. Reopening the project rebuilds it.`
        : detail ?? 'GPU rendering could not be initialized (WebGPU/WebGL2 unavailable).';
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
      // The GPU's real limit, not a guess: WebGL2 can report as little as 4096,
      // and a Continuous Rasterization raster over the limit fails to allocate
      // rather than degrading. See @core/scene/continuousRaster.
      const maxTex = this.renderer?.backend.capabilities.maxTextureSize;
      if (maxTex) this.textures.setMaxRasterDimension(maxTex);
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
              const layerScaleX = Math.abs(layer.scaleX ?? 1);
              const layerScaleY = Math.abs(layer.scaleY ?? 1);
              const maxLayerScale = Math.max(layerScaleX, layerScaleY);
              this.textures!.setParticles(
                key,
                layer.particles,
                layer.sourceTime !== undefined ? layer.sourceTime : (snapshot.time ?? 0),
                layer.width,
                layer.height,
                maxLayerScale,
              );
            } else if (layer.kind === 'image' && layer.src) {
              const key = `asset:${layer.id}`;
              activeKeys.add(key);
              // The FILE's alpha mode goes to the UPLOAD, not the draw: it
              // decides whether the browser multiplies, which is the only place
              // the question can be settled once per file. See the alpha
              // invariant on TextureSource.
              // Canvas2D-only effects have no GPU form, so they must be baked
              // into the bitmap or they render nothing at all on a photo. Gated
              // by the SAME predicate the snapshot adapter uses to withhold
              // them from the GPU, so they cannot both apply.
              const bakeImg = layerIsBaked(layer)
                ? {
                    effects: layer.effects!,
                    width: layer.width,
                    height: layer.height,
                    fillOpacity: layer.fillOpacity,
                    // Baked into the bitmap, so the GPU must not mask it again
                    // — the adapter drops maskTextureKey for a baked image.
                    ...(layer.mask && layer.mask.paths.length > 0 ? { mask: layer.mask } : {}),
                  }
                : undefined;
              this.textures!.setImage(
                key,
                layer.src,
                layer.fill,
                layer.premultipliedSource,
                bakeImg,
                layer.liveSvgPlayback ? (layer.sourceTime ?? snapshot.time ?? 0) : undefined,
              );
            } else if (layer.kind === 'video' && layer.src) {
              const bakeVid = layerIsBaked(layer)
                ? {
                    effects: layer.effects!,
                    width: layer.width,
                    height: layer.height,
                    fillOpacity: layer.fillOpacity,
                    ...(layer.mask && layer.mask.paths.length > 0 ? { mask: layer.mask } : {}),
                  }
                : undefined;
              if (bakeVid) {
                // Canvas2D-only styles on footage: bake the current frame so
                // interior styles / warps are not silent no-ops. Frame Mix is
                // skipped while baking — both brackets would need the same
                // round-trip and the style is the reason we are here.
                const key = `asset:${layer.id}`;
                activeKeys.add(key);
                const targetTime = layer.sourceTime !== undefined ? layer.sourceTime : (snapshot.time ?? 0);
                this.textures!.setVideoBaked(key, layer.src, targetTime, bakeVid);
              } else if (layer.frameBlend) {
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
                text: useTextEditStore.getState().nodeId === layer.id ? '' : (layer.text ?? 'Text'),
                fontSize: layer.fontSize ?? 48,
                color: layer.fill ?? '#ffffff',
                width: layer.width,
                height: layer.height,
                scaleX: layer.scaleX,
                scaleY: layer.scaleY,
                continuousRaster: layer.continuousRaster,
                fontFamily: layer.fontFamily,
                fontWeight: layer.fontWeight,
                fontStyle: layer.fontStyle,
                align: layer.align,
                letterSpacing: layer.letterSpacing,
                lineHeight: layer.lineHeight,
                paragraphSpacing: layer.paragraphSpacing,
                strokeOverFill: layer.strokeOverFill,
                runs: layer.runs,
                // Per-glyph animator output and path placement. buildSnapshot
                // resolves both; forwarding them is what makes text animators
                // and text-on-path produce pixels at all.
                glyphs: layer.glyphs,
                textPath: layer.textPath,
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

            // A light layer feeds its wash texture regardless of kind. The whole
            // light goes through, not just its colour: a spot's cone is baked
            // into the texture, so the cache key has to be able to see the cone.
            if (layer.light) {
              const key = `light:${layer.id}`;
              activeKeys.add(key);
              this.textures!.setLight(key, layer.light);
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

            /*
              4. Apply Color LUT — a 3D `.cube` table, uploaded as a STRIP.

              A SEPARATE key from the per-channel LUT above (`cubelut:` rather
              than `lut:`), because the two are different textures with different
              shapes and a layer can legitimately carry both — Levels and a
              creative LUT are not alternatives. Sharing the key would have the
              second registration silently replace the first, and the symptom
              would be one of the two grades disappearing depending on effect
              order.

              Only the FIRST is uploaded. The shader binds one strip, so a second
              Apply Color LUT on one layer would need a second pass; stacking two
              is rare enough that the honest thing is to render the first and
              leave the mechanism obvious rather than silently blend them.
            */
            const cubeFx = (layer.effects ?? [])
              .find((e) => e.enabled !== false && e.type === 'apply-color-lut');
            if (cubeFx) {
              const cube = readCubeLutParam(cubeFx);
              if (cube) {
                const key = `cubelut:${layer.id}`;
                activeKeys.add(key);
                this.textures!.setCubeLut(key, cube, cubeLutSignature(cubeFx));
              }
            }
          } catch (err) {
            if (!this.warnedTextureLayers.has(layer.id)) {
              this.warnedTextureLayers.add(layer.id);

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
    // has always done this with ctx.clip). Without it, a layer dragged off
    // the composition kept rendering on the pasteboard. Camera mapping:
    // screenCss = (world − center)·zoom + css/2, then × dpr for surface px.
    //
    // Region of Interest narrows that rect further. `snapshot.roi` was a declared
    // field with no producer and no consumer, so "Restrict to Region" / "Region to
    // Centre" toggled a checkbox and changed nothing on screen; clipping to it is
    // what makes the region actually restrict the render (and skip the work
    // outside it), which is the whole point of the feature.
    // Only the ACTIVE-CAMERA view is clipped to the comp frame.
    //
    // Ortho (Top/Front/Left/…) and custom views are inspection views: their whole
    // purpose is to show where layers sit in space, including well outside the
    // render frame. Clipping them to the comp rect meant a Top view of a 1080-tall
    // comp discarded everything outside z ∈ (−540, +540) — most of the scene —
    // which is a large part of "the 3D views don't work correctly". AE frames
    // those views to the viewport and draws the comp box as a guide instead.
    const roi = snapshot.roi;
    const clipsToFrame = snapshot.viewIsActiveCamera !== false;
    if (roi || clipsToFrame) {
      const clipX = roi ? roi.x : 0;
      const clipY = roi ? roi.y : 0;
      const clipW = roi ? roi.width : snapshot.width;
      const clipH = roi ? roi.height : snapshot.height;
      const toScreen = (world: number, center: number, cssExtent: number): number =>
        ((world - center) * cam.zoom + cssExtent / 2) * this.dpr;
      this.renderer.backend.setFrameClip?.({
        x: toScreen(clipX, cam.center.x, this.cssW),
        y: toScreen(clipY, cam.center.y, this.cssH),
        width: clipW * cam.zoom * this.dpr,
        height: clipH * cam.zoom * this.dpr,
      });
    } else {
      this.renderer.backend.setFrameClip?.(null);
    }

    // Overlays: transparent void + only the guides the app has toggled on.
    vp.overlays.background = VOID;
    vp.overlays.checkerboard = false;
    const ov = snapshot.overlays;
    vp.overlays.grid = ov?.grid ?? false;
    // Grid spacing / subdivisions / style / colour used to stop here: the
    // viewport kept the renderer's built-in defaults, so the Composition
    // Settings controls for them were inert. They are the app's now.
    vp.overlays.gridSpacing = ov?.gridSpacing ?? 100;
    vp.overlays.gridSubdivisions = ov?.gridSubdivisions ?? 1;
    vp.overlays.gridStyle = ov?.gridStyle ?? 'lines';
    // `#rrggbbaa` — the alpha IS the control for how faint the lines read.
    if (ov?.gridColor) vp.overlays.gridColor = Color.fromHex(ov.gridColor);
    vp.overlays.proportionalGrid = ov?.proportionalGrid ?? false;
    vp.overlays.proportionalColumns = ov?.proportionalColumns ?? 8;
    vp.overlays.proportionalRows = ov?.proportionalRows ?? 6;
    // The proportional grid divides the COMP, so it needs the comp rect in the
    // same world space the grid lines are emitted in (comp space, origin 0,0).
    vp.overlays.compRect = { x: 0, y: 0, width: snapshot.width, height: snapshot.height };
    vp.overlays.safeArea = ov?.safeArea ?? false;
    vp.overlays.rulers = ov?.rulers ?? false;

    const result = this.renderer.render(vp, snapshotToFrameScene(snapshot));

    // Preview half of the M8a split: keep the frame, but say what it is not.
    // Deduped by detail — a 60fps viewport would otherwise emit the same notice
    // every frame for as long as the layer is on screen.
    this.frameDiagnostics = result.diagnostics;
    for (const d of result.diagnostics) {
      if (this.reportedDiagnostics.has(d.detail)) continue;
      this.reportedDiagnostics.add(d.detail);
      getEventBus().emit('EngineError', {
        engine: `motion-${this.resolvedKind ?? this.preferred}`,
        role: this.role,
        error: new Error(d.detail),
      });
    }
  }

  lastFrameDiagnostics(): ReadonlyArray<{ code: string; detail: string; layerId?: string }> {
    return this.frameDiagnostics;
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
    // Nothing is rendering any more, so "which tier rendered" has no answer.
    this.resolvedKind = null;
    // Release retained media BEFORE the renderer goes: <video> elements keep a
    // decoder running and ImageBitmaps hold off-heap pixels, and neither is
    // reachable once `textures` is nulled. Also drop cached video frames — nothing
    // called retain/clear on that cache, so every source ever scrubbed kept its
    // hidden <video> and frame canvases alive for the whole page lifetime.
    this.textures?.dispose();
    viewportVideoFrames.clear();
    // Before the renderer goes. The subscription outlives this object
    // otherwise — the effect registry is module state, so a stale listener
    // would keep compiling shaders into a registry attached to a disposed
    // device every time a plugin is enabled, for the rest of the session.
    this.detachPluginEffects?.();
    this.detachPluginEffects = null;
    this.renderer?.dispose();
    this.renderer = null;
    this.viewport = null;
    this.textures = null;
    this.canvas = null;
  }
}
