/**
 * Render entry — runs INSIDE the offscreen Electron renderer, where
 * document/canvas/WebGL2 are all real. It renders every registered scene
 * through the exact production path (createRenderBackend → buildSnapshot →
 * renderFrame), reads the frame back as raw RGBA, encodes a PNG, and streams
 * each frame to the Electron main process via the preload bridge.
 *
 * This is the ONLY new render-driving code in the suite, and it deliberately
 * mirrors renderOffline() so references and actuals share one definition of
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
  oracle: 'canvas2d' | 'gpu';
  /** Scene id whose output is this scene's fidelity oracle (see sceneKit). */
  fidelityTwin?: string;
  fidelityTolerance?: number;
  fidelityException?: string;
  /** True when this scene exists only to BE a twin (no committed reference). */
  fidelityOnly?: boolean;
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

/** Read the current frame buffer as top-down RGBA, per backend kind. */
function readCanvasRGBA(canvas: HTMLCanvasElement, kind: string): RGBA {
  const w = canvas.width;
  const h = canvas.height;
  if (kind.includes('webgpu')) {
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
  if (kind.includes('motion') || kind.includes('webgl')) {
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
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | null;
  if (!ctx) throw new Error('expected a 2d context for Canvas2D backend readback');
  const img = ctx.getImageData(0, 0, w, h);
  return { width: w, height: h, data: new Uint8Array(img.data.buffer.slice(0)) };
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
async function renderScene(scene: Scene, backend: BackendChoice): Promise<void> {
  const graph = new SceneGraph();
  const anim = new AnimationEngine();
  scene.build(graph, anim);

  const { w, h } = scene.size;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const be = createRenderBackend(backend);
  be.attach(canvas);
  be.resize(w, h, 1);
  be.setExactMediaTiming?.(true);
  if (be.readyPromise) await be.readyPromise;

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
      const rgba = readCanvasRGBA(canvas, be.kind);
      // Determinism gate (real GPU, not Null): re-render the scene's FIRST
      // frame from the same snapshot and require byte-identical output —
      // "same machine + same driver ⇒ same bytes" (the AE-level promise).
      if (i === scene.frames[0]) {
        be.renderFrame(snap);
        const again = readCanvasRGBA(canvas, be.kind);
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
        oracle: s.oracle ?? 'canvas2d',
        fidelityTwin: s.fidelityTwin,
        fidelityTolerance: s.fidelityTolerance,
        fidelityException: s.fidelityException,
        fidelityOnly: s.fidelityOnly,
      })),
    );
    const failures: string[] = [];
    for (const scene of SCENES) {
      for (const backend of backends) {
        try {
          await renderScene(scene, backend);
        } catch (err) {
          // Per-scene isolation: a bad scene must not abort the whole batch.
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
