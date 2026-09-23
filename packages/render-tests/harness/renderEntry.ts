/**
 * Render entry — runs INSIDE the offscreen Electron renderer, where
 * document/canvas/WebGL2 are all real. It renders every registered scene
 * through the exact production path (createRenderBackend → buildSnapshot →
 * renderFrame), reads the frame back as raw RGBA, encodes a PNG, and streams
 * each frame to the Electron main process via the preload bridge.
 *
 * This is the ONLY new render-driving code in the suite, and it deliberately
 * mirrors renderOffline so references and actuals share one definition of
 * "document → pixels".
 */

import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import { createRenderBackend, type BackendChoice } from '@core/rendering/createRenderBackend';
import { buildSnapshot } from '@core/rendering/buildSnapshot';
import { exportView } from '@core/export/offlineRenderer';
import { setMediaRepaintScheduler, syncFlushScheduler } from '@core/rendering/repaintScheduler';
import { SCENES } from './scenes/registry';
import type { Scene } from './sceneKit';
import { registeredEffects } from '@core/plugins/pluginEffects';
import { BENCH_SCENES, RASTER_BENCH_SCENES } from './benchScenes';
import { useColorManagementStore } from '@stores/colorManagementStore';
import { useViewerLutStore } from '@stores/viewerLutStore';
import { setRasterCapture } from '@core/rendering/raster/rasterCapture';
import { createRasterRecorder } from './rasterRecorder';

/**
 * Block until no registered plugin effect is still `pending`.
 *
 * Bounded, and a timeout is NOT a failure here: it leaves the effect pending,
 * the scene renders without it, and the verifier that compares the two squares
 * then fails with a picture. Throwing instead would replace a diagnosis with a
 * stack trace from the wrong layer.
 */
async function waitForPluginEffects(timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (registeredEffects().some((e) => e.state === 'pending')) {
    if (Date.now() > deadline) {

      console.warn('[harness] plugin effects still pending after '
        + `${timeoutMs}ms: ${registeredEffects().filter((e) => e.state === 'pending').map((e) => e.id).join(', ')}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 16));
  }
}

interface HarnessBridge {
  config: { backends: BackendChoice[]; only?: string[]; exportScenes?: boolean; bench?: boolean; rasterBench?: boolean };
  /**
   * The `native` backend (docs/NATIVE_CORE_PLAN.md D2): one RenderFrameFile per
   * rendered webgpu frame — the FrameScene it was drawn from, for the C++
   * renderer to draw again. Present only when main was asked to export.
   */
  sceneFile?: (payload: { sceneId: string; frame: number; bytes: Uint8Array }) => Promise<void>;
  /** The measured readback table for the native backend (see measureReadbackTable). */
  readbackTable?: (payload: { pngBase64: string }) => Promise<void>;
  /** Sends one rendered frame to main. Resolves when written. */
  frame: (payload: {
    sceneId: string;
    backend: BackendChoice;
    frame: number;
    pngBase64: string;
  }) => Promise<void>;
  /** Sends the scene manifest (metadata only) to main. */
  manifest: (scenes: SceneManifestEntry[]) => Promise<void>;
  /** Signals completion (with an optional fatal error). */
  done: (error?: string) => Promise<void>;
}

interface SceneManifestEntry {
  id: string;
  description: string;
  frames: number[];
  size: { w: number; h: number };
  tolerance?: number;
  gpuParity: 'expect-pass' | 'known-divergent';
  divergence?: { why: string; wouldMatchWhen: string; proof?: string };
  oracle: 'canvas2d' | 'gpu';
  /** Scene id whose output is this scene's fidelity oracle (see sceneKit). */
  fidelityTwin?: string;
  fidelityTolerance?: number;
  fidelityException?: string;
  /** True when this scene exists only to BE a twin (no committed reference). */
  fidelityOnly?: boolean;
  /** True when this scene's own frames must DIFFER from each other (see sceneKit). */
  animates?: boolean;
  animatesMinChange?: number;
}

declare global {
  interface Window {
    harnessBridge: HarnessBridge;
  }
}

interface RGBA {
  width: number;
  height: number;
  data: Uint8Array;
}

/**
 * Read the current frame buffer as top-down RGBA, per RESOLVED backend tier.
 *
 * Takes the resolved tier rather than a free-form kind string. The old
 * substring matching (`kind.includes('webgpu')`) read whatever the backend had
 * been asked for, so a stepped-down WebGPU→WebGL2 run was read through the
 * WebGPU path — see the resolvedKind assertion in renderScene.
 */
function readCanvasRGBA(canvas: HTMLCanvasElement, kind: 'webgl2' | 'webgpu' | 'null' | string): RGBA {
  const w = canvas.width;
  const h = canvas.height;
  if (kind === 'webgpu') {
    // WebGPU canvas: no GL context to read from. Draw the presented canvas into
    // a scratch 2D canvas — rows come back top-down already (no flip; WebGPU's
    // framebuffer origin is top-left, unlike GL).
    const scratch = document.createElement('canvas');
    scratch.width = w;
    scratch.height = h;
    const sctx = scratch.getContext('2d')!;
    sctx.drawImage(canvas, 0, 0);
    const img = sctx.getImageData(0, 0, w, h);
    const data = new Uint8Array(img.data.buffer.slice(0));
    // RE-PREMULTIPLY (alpha untouched): getImageData is STRAIGHT alpha by
    // spec, while the WebGL2 branch's readPixels returns PREMULTIPLIED bytes
    // — the convention every reference was blessed in. On any FRACTIONAL-
    // alpha pixel the two backends' PNGs therefore disagreed by exactly the
    // un-premultiply; the whole stencil-luma / silhouette-luma /
    // alpha-add-seam "divergence" was this readback mismatch, not the
    // renderer (probed: the blend's inputs and outputs match bit-for-bit).
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3]!;
      if (a < 255) {
        data[i] = Math.round((data[i]! * a) / 255);
        data[i + 1] = Math.round((data[i + 1]! * a) / 255);
        data[i + 2] = Math.round((data[i + 2]! * a) / 255);
      }
    }
    return { width: w, height: h, data };
  }
  if (kind === 'webgl2') {
    // GPU backends: read the drawing buffer directly (no preserveDrawingBuffer
    // dependency) and flip vertically — GL's origin is bottom-left.
    const gl = canvas.getContext('webgl2') as WebGL2RenderingContext | null;
    if (!gl) throw new Error('expected a webgl2 context for GPU backend readback');
    const raw = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    const flipped = new Uint8Array(w * h * 4);
    const rowBytes = w * 4;
    for (let y = 0; y < h; y++) {
      const src = (h - 1 - y) * rowBytes;
      flipped.set(raw.subarray(src, src + rowBytes), y * rowBytes);
    }
    // Bytes are PREMULTIPLIED with true alpha — the convention every
    // reference is blessed in; the WebGPU branch converts its straight-alpha
    // getImageData read to match this form.
    return { width: w, height: h, data: flipped };
  }
  // 'null' and anything else: NullBackend produces no pixels, so there is no
  // frame to read and pretending otherwise would write a blank PNG that passes
  // a non-emptiness check nowhere and a golden diff loudly. Refuse instead.
  throw new Error(`no readback path for backend tier "${kind}" — only webgl2 and webgpu produce pixels`);
}

/** Encode raw top-down RGBA to a base64 PNG using a scratch 2D canvas. */
function rgbaToPngBase64(rgba: RGBA): string {
  const c = document.createElement('canvas');
  c.width = rgba.width;
  c.height = rgba.height;
  const ctx = c.getContext('2d')!;
  const img = new ImageData(new Uint8ClampedArray(rgba.data.buffer.slice(0)), rgba.width, rgba.height);
  ctx.putImageData(img, 0, 0);
  return c.toDataURL('image/png').split(',')[1]!;
}

/**
 * What this machine's readback + PNG encode does to every premultiplied
 * (value, alpha) byte pair — measured, for the `native` backend
 * (docs/NATIVE_CORE_PLAN.md D2).
 *
 * A webgpu PNG is not the surface bytes: readCanvasRGBA un-premultiplies through
 * getImageData and re-premultiplies, and rgbaToPngBase64 then puts those bytes
 * into a 2D canvas — which STORES PREMULTIPLIED 8-bit and takes putImageData
 * input as straight, so they are premultiplied a second time — and toDataURL
 * un-premultiplies once more. At low alpha that is heavy re-quantisation (at
 * a = 10/255 every value under 13 stores as 0), and it was the whole of the
 * D2 "7 low-alpha frames": the C++ surface bytes already equalled the TS
 * surface bytes. Skia's conversions round in float (and ties go either way),
 * so no closed form reproduces them on every machine; this table is the
 * conversion itself, run through the SAME two functions every frame uses, on
 * this run's Chromium. premation-render applies it to its surface bytes
 * (--readback-table), so a native frame is compared byte for byte with the
 * webgpu frame of the same FrameScene.
 *
 * Layout: a 256×256 webgpu canvas whose pixel (x = value, y = alpha) holds the
 * premultiplied grey (v, v, v, a) for v ≤ a, sent as the PNG it becomes.
 */
async function measureReadbackTable(): Promise<void> {
  if (!window.harnessBridge.readbackTable || !navigator.gpu) return;
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) return;
  const device = await adapter.requestDevice();
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    // The DOM lib types getContext('webgpu') as the 2D union; these two calls are all this needs.
    type WebGpuCanvas = {
      configure(c: { device: unknown; format: string; alphaMode: 'premultiplied'; usage: number }): void;
      getCurrentTexture(): unknown;
    };
    const ctx = canvas.getContext('webgpu') as unknown as WebGpuCanvas | null;
    if (!ctx) return;
    const RENDER_ATTACHMENT = 0x10; // GPUTextureUsage
    const COPY_DST = 0x02;
    ctx.configure({
      device,
      format: navigator.gpu.getPreferredCanvasFormat(),
      alphaMode: 'premultiplied',
      usage: RENDER_ATTACHMENT | COPY_DST,
    });
    // Grey texels, so the canvas's channel order (bgra/rgba) is irrelevant.
    const texels = new Uint8Array(256 * 256 * 4);
    for (let a = 0; a < 256; a++) {
      for (let v = 0; v <= a; v++) {
        const i = (a * 256 + v) * 4;
        texels[i] = v;
        texels[i + 1] = v;
        texels[i + 2] = v;
        texels[i + 3] = a;
      }
    }
    device.queue.writeTexture({ texture: ctx.getCurrentTexture() } as never, texels, { bytesPerRow: 256 * 4 }, { width: 256, height: 256 } as never);
    // Read in the same task, as renderScene does after renderFrame.
    const rgba = readCanvasRGBA(canvas, 'webgpu');
    await window.harnessBridge.readbackTable({ pngBase64: rgbaToPngBase64(rgba) });
  } finally {
    device.destroy();
  }
}

/** Render one scene on one backend for all its frames, streaming each out. */
/** One backend announcement per process, not one per scene. */
let announcedBackend = false;

/**
 * Build a scene's graph, treating ANY error as fatal to the run.
 *
 * Separate from the render below because the two failures are not the same
 * kind. A backend that cannot render is a per-scene, per-backend problem and
 * stays isolated. A scene whose SETUP throws did not produce a wrong image — it
 * produced NO image, and no image is not a measurement.
 *
 * `shape-path-op-zigzag` sat in exactly that state from schema 1.3.0 until
 * 2026-08-04. Its `graph.setPathOp(…)` had been renamed to `setPathOps`, so
 * `build` threw, no frame was ever written, and the comparator's
 * `!actual → { pass: false }` was then routed by `gpuParity: 'known-divergent'`
 * into the ACCEPTED-GAP bucket. The `divergence` prose that exists to stop
 * silent suppression is what suppressed it: "fail closed unless a cause is
 * written down" was designed for a pixel gap, and a stated cause cannot tell
 * "these pixels differ for a known reason" from "there are no pixels".
 */
function buildSceneOrThrow(scene: Scene): { graph: SceneGraph; anim: AnimationEngine } {
  const graph = new SceneGraph();
  const anim = new AnimationEngine();
  try {
    scene.build(graph, anim);
  } catch (err) {
    throw new Error(
      `scene setup threw for "${scene.id}" — the scene measures NOTHING until this is fixed: `
      + `${(err as Error)?.message ?? err}`,
    );
  }
  return { graph, anim };
}

/**
 * Apply a scene's `nativeSetup` (project bit depth, viewer LUT) for the length
 * of its render; returns the undo. Stores are module state shared by every
 * scene in this page, so a setup that leaked would silently re-render every
 * later scene at 32 bpc or through a LUT.
 */
function applyNativeSetup(scene: Scene): () => void {
  const setup = scene.nativeSetup;
  if (!setup) return () => {};
  const color = useColorManagementStore.getState();
  const prevDepth = color.bitDepth;
  if (setup.bitDepth) useColorManagementStore.setState({ bitDepth: setup.bitDepth });
  if (setup.viewerLutCube) {
    if (!useViewerLutStore.getState().loadFromText(setup.viewerLutCube, `${scene.id}.cube`)) {
      throw new Error(`${scene.id}: its viewer LUT did not parse`);
    }
  }
  return () => {
    useColorManagementStore.setState({ bitDepth: prevDepth });
    if (setup.viewerLutCube) useViewerLutStore.getState().clear();
  };
}

async function renderScene(scene: Scene, backend: BackendChoice): Promise<void> {
  const { graph, anim } = buildSceneOrThrow(scene);
  const undoSetup = applyNativeSetup(scene);
  try {
    await renderSceneFrames(scene, backend, graph, anim);
  } finally {
    undoSetup();
  }
}

async function renderSceneFrames(
  scene: Scene,
  backend: BackendChoice,
  graph: ReturnType<typeof buildSceneOrThrow>['graph'],
  anim: ReturnType<typeof buildSceneOrThrow>['anim'],
): Promise<void> {

  const { w, h } = scene.size;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const be = createRenderBackend(backend);
  be.attach(canvas);
  be.resize(w, h, 1);
  be.setExactMediaTiming?.(true);
  const exporting = backend === 'webgpu' && !!window.harnessBridge.config.exportScenes && !!window.harnessBridge.sceneFile;
  if (exporting) be.captureFrameScenes = true;
  if (be.readyPromise) await be.readyPromise;

  /*
    Wait for plugin effects to finish compiling.

    Compilation is asynchronous and begins when the renderer bridge attaches,
    which happens inside the init just awaited. `snapshotToFrameScene` emits
    only `ready` effects, so rendering before the compile lands silently drops
    the effect — producing a frame indistinguishable from the feature being
    broken. Without this the plugin scenes would be green on a fast machine and
    red on a slow one, with nothing in the output to say which.

    Returns immediately for the scenes with no plugin effects, which is all but
    two of them.
  */
  await waitForPluginEffects();

  // The backend we ASKED for must be the one that rendered.
  //
  // MotionRendererBackend's ladder steps WebGPU → WebGL2 on any init failure,
  // which is right for the product and wrong for a comparison harness: a
  // WebGPU run on a box with no adapter used to write WebGL2 pixels into
  // `actual/webgpu/`, and every parity figure computed from that directory was
  // comparing WebGL2 against WebGL2 while claiming otherwise. Fail loudly.
  if (be.resolvedKind !== backend) {
    throw new Error(
      `${scene.id} [${backend}]: asked for ${backend}, got ${be.resolvedKind ?? 'no backend'}` +
        `${be.initErrorMessage ? ` — ${be.initErrorMessage}` : ''}`,
    );
  }

  // POSITIVE emission, once per run, not per scene.
  //
  // The assertion above only speaks when it fails, so a green run said nothing
  // about which backend actually rendered — parity was inferred from the absence
  // of a throw. That is the same shape of mistake as a determinism gate that
  // vouches for a pipeline half it never exercises: silence read as evidence.
  // main.cjs forwards console output to the runner's stdout, so this lands in
  // the run log next to the results it is a claim about.
  if (!announcedBackend) {
    announcedBackend = true;

    console.log(`[harness] backend resolved: asked ${backend}, running ${be.resolvedKind}`);
    // One-time capability report: whether THIS environment can allocate float
    // render targets decides whether compositing runs linear (the product
    // contract) or falls back to display-referred 8-bit — which is the root of
    // the additive-family webgpu-vs-webgl2 divergences. Saying it out loud in
    // the log turns "80 scenes diverge, cause unknown" into a one-line fact.
    if (!(globalThis as Record<string, unknown>).__capsReported) {
      (globalThis as Record<string, unknown>).__capsReported = true;
      try {
        const probe = document.createElement('canvas');
        const gl = probe.getContext('webgl2');
        console.log(
          `[harness] webgl2 EXT_color_buffer_float: ${gl ? !!gl.getExtension('EXT_color_buffer_float') : 'no-context'}`,
        );
      } catch {
        console.log('[harness] webgl2 EXT_color_buffer_float: probe failed');
      }
      // WHICH adapter. The WebGPU run uses the machine's real GPU (see
      // main.cjs), and a laptop with two of them can hand the harness a
      // different one from run to run — every "known divergence" ceiling is
      // measured against ONE of those. A run that says which it used turns
      // "checkerboard drifted 1.5% since yesterday" into "yesterday was the
      // Radeon, today the GeForce" without a second thought.
      // The window's device pixel ratio feeds every raster scale (particle
      // fields, vector tiers), so a harness window that inherits the desktop's
      // display scaling renders DIFFERENT bytes on a 125% monitor than on a
      // 100% one — main.cjs pins it to 1; this line is the receipt.
      console.log(`[harness] devicePixelRatio: ${window.devicePixelRatio}`);
      try {
        const probe = document.createElement('canvas');
        const gl = probe.getContext('webgl2');
        const dbg = gl?.getExtension('WEBGL_debug_renderer_info') as { UNMASKED_RENDERER_WEBGL: number } | null;
        console.log(`[harness] webgl2 renderer: ${gl && dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'unknown'}`);
      } catch {
        console.log('[harness] webgl2 renderer: probe failed');
      }
      if (backend === 'webgpu') {
        try {
          const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
          type AdapterInfo = { vendor?: string; architecture?: string; device?: string; description?: string };
          const info = adapter
            ? ((adapter as { info?: AdapterInfo }).info
              ?? (await (adapter as { requestAdapterInfo?: () => Promise<AdapterInfo> }).requestAdapterInfo?.()))
            : undefined;
          console.log(`[harness] webgpu adapter: ${info ? [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' / ') : 'unknown'}`);
        } catch {
          console.log('[harness] webgpu adapter: probe failed');
        }
      }
    }
  }

  try {
    for (const i of scene.frames) {
      const t = i / scene.fps;
      const snap = buildSnapshot(
        graph,
        anim,
        t,
        undefined,
        scene.nativeSetup?.overlays,
        exportView(w, h, scene.comp),
        scene.motionBlur,
        scene.comp,
      );
      be.renderFrame(snap);
      // Converge any async media work (unlikely for Phase 0 scenes, but keeps the
      // path identical to renderOffline).
      for (let pass = 0; pass < 4; pass++) {
        const waits = be.takeMediaWaits?.();
        if (!waits || waits.length === 0) break;
        await Promise.all(waits);
        be.renderFrame(snap);
      }
      // Readback path is chosen from the RESOLVED tier, not the requested one:
      // WebGPU's framebuffer origin is top-left and GL's is bottom-left, so
      // reading a WebGL2 surface through the WebGPU path (or vice versa) is a
      // silently V-flipped or blank frame.
      const rgba = readCanvasRGBA(canvas, be.resolvedKind ?? be.kind);
      // The native backend's input: exactly the FrameScene (and texels) these
      // pixels were drawn from. Exported before the determinism re-render so
      // the capture is this frame's, not a re-render's.
      if (exporting) {
        const bytes = await be.exportLastFrameScene?.(scene.id, i);
        if (bytes) await window.harnessBridge.sceneFile!({ sceneId: scene.id, frame: i, bytes });
      }
      // Determinism gate (real GPU, not Null): re-render the scene's FIRST
      // frame from the same snapshot and require byte-identical output —
      // "same machine + same driver ⇒ same bytes".
      //
      // WHAT THIS DOES NOT COVER. It re-renders from the SAME `snap` object, so
      // it gates the BACK half of the pipeline (renderFrame → GPU → readback)
      // and silently vouches for the front half. Anything nondeterministic in
      // SNAPSHOT CONSTRUCTION is invisible here — a wall-clock seed, iteration
      // order over a Map, a Set serialized to an array, an id from a counter
      // that isn't reset — because it is sampled once into `snap` and then
      // replayed from identical input. Nor does it compare this path against
      // `offlineRenderer`, so it is not a preview-vs-export check.
      //
      // Frame 0 is also the WORST frame for exposing time-dependent
      // nondeterminism, since t = 0 collapses many time-derived values to a
      // constant. Do not read a green run here as "the pipeline is
      // deterministic" — it means "the renderer is, for this one frame".
      // D2 bench: the TS WebGPU frame time of this FrameScene, measured the way
      // premation-render --bench measures the C++ one — render + submit + GPU idle.
      if (window.harnessBridge.config.bench && backend === 'webgpu') {
        const device = (be as unknown as { renderer?: { backend?: { device?: { queue: { onSubmittedWorkDone(): Promise<void> } } } } })
          .renderer?.backend?.device;
        if (device) {
          const times: number[] = [];
          for (let k = 0; k < 110; k++) {
            const t0 = performance.now();
            be.renderFrame(snap);
            await device.queue.onSubmittedWorkDone();
            if (k >= 10) times.push(performance.now() - t0);
          }
          times.sort((a, b) => a - b);
          const mean = times.reduce((a, b) => a + b, 0) / times.length;
          console.log(`[harness] bench ${scene.id} webgpu frames=${times.length} meanMs=${mean.toFixed(3)} p50Ms=${times[times.length >> 1]!.toFixed(3)} p95Ms=${times[Math.floor(times.length * 0.95)]!.toFixed(3)}`);
        }
      }
      if (i === scene.frames[0]) {
        be.renderFrame(snap);
        const again = readCanvasRGBA(canvas, be.resolvedKind ?? be.kind);
        if (again.data.length !== rgba.data.length || !again.data.every((v, k) => v === rgba.data[k])) {
          throw new Error(`${scene.id}#${i} [${backend}] double-render bytes differ — non-deterministic output`);
        }
      }
      await window.harnessBridge.frame({
        sceneId: scene.id,
        backend,
        frame: i,
        pngBase64: rgbaToPngBase64(rgba),
      });
    }
  } finally {
    be.dispose();
  }
}

/**
 * Pin the GLYPHS the way SwiftShader pins the rasterizer.
 *
 * Scenes ask for `Arial` because that is the default text spec the Text tool
 * writes, and the harness's contract is to render the spec the tool produces.
 * But `Arial` names a SYSTEM font: real Arial on Windows (where references are
 * blessed), fontconfig's metric-compatible substitute (Liberation Sans) on a
 * Linux runner. Same spec, two sets of outlines — which held `text-scale-4x`
 * through `-8x` at 0.7–3.1% against their references on every CI run since they
 * were blessed, while smaller text sat inside the 0.5% tolerance looking fine.
 *
 * Registering a bundled font (Arimo, OFL, metric-compatible with Arial) under
 * the SAME family name fixes that at the resolution layer: document-registered
 * faces shadow installed fonts of the same family in CSS font matching, so
 * every platform now shapes and rasterizes identical outlines while the scene
 * specs stay exactly what the tool produces. Awaited before any scene renders —
 * an unloaded FontFace falls back to the system font, which is this bug again,
 * nondeterministically.
 */
async function loadHarnessFonts(): Promise<void> {
  const faces = [
    new FontFace('Arial', `url(${new URL('./fonts/arimo-latin-400-normal.woff2', import.meta.url)})`, { weight: '400' }),
    new FontFace('Arial', `url(${new URL('./fonts/arimo-latin-700-normal.woff2', import.meta.url)})`, { weight: '700' }),
    /*
      Non-Latin scripts, pinned the same way: bundled Noto subsets (SIL OFL 1.1,
      licence beside each file) registered under the SAME `Arial` family with a
      unicode-range, so the text-rtl-bidi / text-vertical-* scenes shape Arabic,
      Hebrew and Japanese with these outlines on every machine instead of
      whichever system font fallback finds. Each file holds only the glyphs the
      scenes use (plus their OpenType closure: Arabic joining forms, vertical
      forms); a character outside it would fall back — add it to the subset.
      Harness only — the app never registers these.
    */
    new FontFace('Arial', `url(${new URL('./fonts/noto-sans-arabic/noto-sans-arabic-400-subset.woff2', import.meta.url)})`, {
      weight: '400', unicodeRange: 'U+0600-06FF, U+0750-077F, U+FB50-FDFF, U+FE70-FEFF',
    }),
    new FontFace('Arial', `url(${new URL('./fonts/noto-sans-hebrew/noto-sans-hebrew-400-subset.woff2', import.meta.url)})`, {
      weight: '400', unicodeRange: 'U+0590-05FF, U+FB1D-FB4F',
    }),
    new FontFace('Arial', `url(${new URL('./fonts/noto-sans-jp/noto-sans-jp-400-subset.woff2', import.meta.url)})`, {
      weight: '400', unicodeRange: 'U+3000-30FF, U+4E00-9FFF, U+FE10-FE1F, U+FE30-FE4F, U+FF00-FFEF',
    }),
  ];
  for (const face of faces) document.fonts.add(await face.load());
}

/**
 * E3 raster bench (scripts/bench-raster.mjs): the TS text / vector raster time
 * of an animated scene, frame by frame, measured inside
 * Canvas2DVectorRasterizer (rasterCapture.ts): `draw` = the painter's Canvas2D
 * calls, `total` = draw + the texture upload that flushes the canvas (a GPU
 * canvas rasterises lazily, at that upload). Then a fresh backend re-renders the
 * first frames with the recorder on and exports them, so premation-raster can
 * time the C++ side on the same raster sources.
 */
async function rasterBenchScene(scene: Scene): Promise<void> {
  const { graph, anim } = buildSceneOrThrow(scene);
  const { w, h } = scene.size;
  const make = async () => {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const be = createRenderBackend('webgpu');
    be.attach(canvas);
    be.resize(w, h, 1);
    be.setExactMediaTiming?.(true);
    if (be.readyPromise) await be.readyPromise;
    return be;
  };
  const snapAt = (i: number) => buildSnapshot(graph, anim, i / scene.fps, undefined, undefined, exportView(w, h, scene.comp), scene.motionBlur, scene.comp);
  const be = await make();
  let begun = 0;
  let drawMs = 0;
  let totalMs = 0;
  let rasters = 0;
  let frameDraw = 0;
  let frameTotal = 0;
  const perFrame: number[] = [];
  setRasterCapture({
    begin() { begun = performance.now(); },
    drawn() { frameDraw += performance.now() - begun; },
    end() { frameTotal += performance.now() - begun; rasters++; },
    rasterOf() { return undefined; },
  });
  // Frame 0 warms fonts, pipelines and shaders; it is not timed.
  be.renderFrame(snapAt(0));
  for (const i of scene.frames) {
    frameDraw = 0;
    frameTotal = 0;
    be.renderFrame(snapAt(i));
    drawMs += frameDraw;
    totalMs += frameTotal;
    perFrame.push(frameTotal);
  }
  setRasterCapture(null);
  be.dispose();
  perFrame.sort((a, b) => a - b);
  const n = scene.frames.length;
  console.log(`[harness] raster-bench ${scene.id} frames=${n} rasters=${rasters} drawMsPerFrame=${(drawMs / n).toFixed(3)} `
    + `totalMsPerFrame=${(totalMs / n).toFixed(3)} p50TotalMs=${perFrame[n >> 1]!.toFixed(3)}`);
  // Export frames 1..3 with the recorder, from a fresh backend (a cold raster cache).
  const ex = await make();
  ex.captureFrameScenes = true;
  setRasterCapture(createRasterRecorder());
  try {
    for (const i of scene.frames.slice(0, 3)) {
      ex.renderFrame(snapAt(i));
      const bytes = await ex.exportLastFrameScene?.(scene.id, i);
      if (bytes) await window.harnessBridge.sceneFile!({ sceneId: scene.id, frame: i, bytes });
    }
  } finally {
    setRasterCapture(null);
    ex.dispose();
  }
}

async function main(): Promise<void> {
  // No wall clock on an offline render: `requestAnimationFrame` in an offscreen
  // Electron window is throttled (and can stop firing once occluded), so the
  // media-repaint coalescer flushes synchronously here. See repaintScheduler.ts.
  setMediaRepaintScheduler(syncFlushScheduler);
  try {
    await loadHarnessFonts();
    if (window.harnessBridge.config.rasterBench) {
      for (const scene of RASTER_BENCH_SCENES) await rasterBenchScene(scene);
      await window.harnessBridge.manifest([]);
      await window.harnessBridge.done();
      return;
    }
    // E3: with FrameScene export on, every text / vector raster also exports
    // what it was drawn from (rasterRecorder.ts). Recording forwards every call
    // unchanged, so the rendered pixels are the same with or without it.
    if (window.harnessBridge.config.exportScenes) setRasterCapture(createRasterRecorder());
    const backends = window.harnessBridge.config.backends;
    /*
      Debug-only scene filter. Empty means every scene, which is what the gate
      always runs — `run.mjs --scene` narrows the comparison but not the render,
      so investigating one scene otherwise costs a full pass over all of them.
      The MANIFEST is still written from the full set: it describes the suite,
      not this run, and truncating it would make the runner report every
      unrendered scene as missing.
    */
    const only = new Set(window.harnessBridge.config.only ?? []);
    const toRender = window.harnessBridge.config.bench
      ? BENCH_SCENES
      : only.size > 0 ? SCENES.filter((s) => only.has(s.id)) : SCENES;
    await window.harnessBridge.manifest(
      SCENES.map((s) => ({
        id: s.id,
        description: s.description,
        frames: s.frames,
        size: s.size,
        tolerance: s.tolerance,
        gpuParity: s.gpuParity ?? 'expect-pass',
        ...(s.divergence ? { divergence: s.divergence } : {}),
        oracle: s.oracle ?? 'canvas2d',
        fidelityTwin: s.fidelityTwin,
        fidelityTolerance: s.fidelityTolerance,
        fidelityException: s.fidelityException,
        fidelityOnly: s.fidelityOnly,
        animates: s.animates,
        animatesMinChange: s.animatesMinChange,
      })),
    );
    // PRE-FLIGHT: every scene must build before anything renders.
    //
    // Backend-independent, so it runs once rather than once per backend, and it
    // aborts the run rather than being absorbed by the isolation below. A scene
    // that cannot build is not a scene with a visual gap — it is a scene that
    // silently stopped testing its subject, which is the failure this whole
    // check exists for (see `buildSceneOrThrow`).
    const setupFailures: string[] = [];
    for (const scene of toRender) {
      try {
        buildSceneOrThrow(scene);
      } catch (err) {
        setupFailures.push((err as Error)?.message ?? String(err));
      }
    }
    if (setupFailures.length) {
      await window.harnessBridge.done(
        `${setupFailures.length} scene(s) failed SETUP:\n  ${setupFailures.join('\n  ')}`,
      );
      return;
    }

    const failures: string[] = [];
    /*
      Per-scene wall clock, reported at the end.

      This run has taken anywhere from ~3 minutes to over 10 for the same
      scenes, and there was no way to tell WHICH scene absorbed the difference —
      the only output was the total, so every diagnosis started with a guess.
      A run that is slow for a reason and a run that is slow everywhere are
      different problems, and the summary below distinguishes them: if one
      scene holds the whole excess it names it, and if the cost is spread the
      per-scene mean says so.

      Timings only, never a threshold. A wall-clock assertion in a correctness
      gate is a test that fails on a loaded CI runner for no reason — the same
      mistake `svgHybridImport`'s linearity check made.
    */
    const timings: Array<{ id: string; backend: string; ms: number }> = [];
    if (backends.includes('webgpu') && window.harnessBridge.config.exportScenes) {
      try {
        await measureReadbackTable();
      } catch (err) {
        // The native gate falls back to its closed-form model (≤ 1/255 off at ties).
        console.warn(`[harness] readback table not measured: ${(err as Error)?.message ?? err}`);
      }
    }
    for (const scene of toRender) {
      for (const backend of backends) {
        const startedAt = Date.now();
        try {
          await renderScene(scene, backend);
        } catch (err) {
          // Per-scene isolation for RENDER failures only — setup already passed
          // above, so anything here is a backend problem, not a dead scene.
          failures.push(`${scene.id}/${backend}: ${(err as Error)?.message ?? err}`);

          console.error(`[scene-fail] ${scene.id}/${backend}:`, err);
        } finally {
          // Recorded on the failure path too: a scene that took 40 seconds and
          // then threw is the most interesting row in the table, and dropping
          // it would hide exactly the case this exists for.
          timings.push({ id: scene.id, backend, ms: Date.now() - startedAt });
        }
      }
    }
    if (timings.length) {
      const total = timings.reduce((a, t) => a + t.ms, 0);
      const slowest = [...timings].sort((a, b) => b.ms - a.ms).slice(0, 8);
      console.log(`[harness] rendered ${timings.length} scene-backend pair(s) in ${(total / 1000).toFixed(1)}s `
        + `(mean ${Math.round(total / timings.length)}ms). Slowest: `
        + slowest.map((t) => `${t.id}/${t.backend} ${t.ms}ms`).join(', '));
    }
    if (failures.length) console.error(`[render-fails] ${failures.length}: ${failures.join(' | ')}`);
    await window.harnessBridge.done();
  } catch (err) {
    await window.harnessBridge.done(String((err as Error)?.stack ?? err));
  }
}

void main();
