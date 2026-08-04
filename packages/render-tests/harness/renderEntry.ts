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
import { SCENES } from './scenes/registry';
import type { Scene } from './sceneKit';

interface HarnessBridge {
  config: { backends: BackendChoice[] };
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
    return { width: w, height: h, data: new Uint8Array(img.data.buffer.slice(0)) };
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

async function renderScene(scene: Scene, backend: BackendChoice): Promise<void> {
  const { graph, anim } = buildSceneOrThrow(scene);

  const { w, h } = scene.size;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const be = createRenderBackend(backend);
  be.attach(canvas);
  be.resize(w, h, 1);
  be.setExactMediaTiming?.(true);
  if (be.readyPromise) await be.readyPromise;

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
    // eslint-disable-next-line no-console
    console.log(`[harness] backend resolved: asked ${backend}, running ${be.resolvedKind}`);
  }

  try {
    for (const i of scene.frames) {
      const t = i / scene.fps;
      const snap = buildSnapshot(
        graph,
        anim,
        t,
        undefined,
        undefined,
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

async function main(): Promise<void> {
  try {
    const backends = window.harnessBridge.config.backends;
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
    for (const scene of SCENES) {
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
    for (const scene of SCENES) {
      for (const backend of backends) {
        try {
          await renderScene(scene, backend);
        } catch (err) {
          // Per-scene isolation for RENDER failures only — setup already passed
          // above, so anything here is a backend problem, not a dead scene.
          failures.push(`${scene.id}/${backend}: ${(err as Error)?.message ?? err}`);
          // eslint-disable-next-line no-console
          console.error(`[scene-fail] ${scene.id}/${backend}:`, err);
        }
      }
    }
    if (failures.length) console.error(`[render-fails] ${failures.length}: ${failures.join(' | ')}`);
    await window.harnessBridge.done();
  } catch (err) {
    await window.harnessBridge.done(String((err as Error)?.stack ?? err));
  }
}

void main();
