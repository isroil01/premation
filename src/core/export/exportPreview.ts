/**
 * Export preview — render what an export will actually contain, before running it.
 *
 * This exists because a bad export used to be undetectable until the file was
 * open in a player. The frames go through the SAME snapshot builder, the same
 * comp scoping and the same 1:1 comp→frame view as a real export, at a smaller
 * resolution, so what the dialog shows is what the encoder will receive.
 *
 * It also measures the frame. `coverage` is the fraction of pixels that differ
 * from the composition's own background, which is what makes "the export is a
 * black screen" a warning in the UI rather than a surprise on disk.
 */

import { createRenderBackend } from '@core/rendering/createRenderBackend';
import type { RenderBackend } from '@core/rendering/RenderBackend';
import { buildSnapshot, type SnapshotComp } from '@core/rendering/buildSnapshot';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { exportView, exportComp } from './offlineRenderer';
import { useMotionBlurStore } from '@stores/motionBlurStore';

export interface PreviewFrameRequest {
  /** Output size of the real export — the preview keeps its aspect ratio. */
  width: number;
  height: number;
  fps: number;
  /** Comp size, background and transparency, scoped with `rootId`. */
  comp?: SnapshotComp;
  /** Time in seconds. Snapped to the export's frame grid before rendering. */
  time: number;
}

export interface PreviewFrame {
  /** Fraction of pixels that differ from the comp background, 0–1. */
  coverage: number;
  /** True when nothing in the composition is visible at this frame. */
  blank: boolean;
  /**
   * The renderer's own diagnostics for this frame — the SAME list the export
   * REFUSES on (unsupported compositing ops, offline media drawn as colour
   * bars). The preview used to show such a frame without comment, and the
   * user learned about it when the render died at frame N.
   */
  warnings: string[];
}

/**
 * How different a pixel must be from the background to count as content. Small
 * enough to catch a dark shape on a dark comp, large enough to ignore codec-free
 * rounding in the compositor.
 */
const CONTENT_THRESHOLD = 6;

/** Below this, "there is technically something there" is not worth reporting. */
const BLANK_COVERAGE = 0.0005;

/**
 * Fraction of `pixels` that differ from `background` by more than the content
 * threshold. Pure, so the emptiness rule is testable without a GPU.
 *
 * A transparent export is judged on alpha alone: comparing colour against a
 * background that is not being drawn would call every transparent frame "full".
 */
export function frameCoverage(
  pixels: Uint8ClampedArray | Uint8Array,
  background: { r: number; g: number; b: number } | null,
): number {
  const total = pixels.length / 4;
  if (total === 0) return 0;
  let content = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const a = pixels[i + 3]!;
    if (!background) {
      if (a > CONTENT_THRESHOLD) content++;
      continue;
    }
    // A fully transparent pixel over an opaque comp still shows the background.
    if (a === 0) continue;
    if (
      Math.abs(pixels[i]! - background.r) > CONTENT_THRESHOLD ||
      Math.abs(pixels[i + 1]! - background.g) > CONTENT_THRESHOLD ||
      Math.abs(pixels[i + 2]! - background.b) > CONTENT_THRESHOLD
    ) {
      content++;
    }
  }
  return content / total;
}

/** `#rgb`, `#rrggbb`, `#rgba`, `#rrggbbaa` or `rgb/rgba` → 0–255 components, or null if unparseable. */
export function parseCssColor(color: string | undefined): { r: number; g: number; b: number } | null {
  if (!color) return null;
  const raw = color.trim();
  const hex = raw.replace('#', '');
  if (/^[0-9a-f]{3}$/i.test(hex)) {
    const [r, g, b] = hex.split('') as [string, string, string];
    return { r: parseInt(r + r, 16), g: parseInt(g + g, 16), b: parseInt(b + b, 16) };
  }
  if (/^[0-9a-f]{4}$/i.test(hex)) {
    const [r, g, b] = hex.slice(0, 3).split('') as [string, string, string];
    return { r: parseInt(r + r, 16), g: parseInt(g + g, 16), b: parseInt(b + b, 16) };
  }
  if (/^[0-9a-f]{6}$/i.test(hex)) {
    const n = parseInt(hex, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  if (/^[0-9a-f]{8}$/i.test(hex)) {
    const n = parseInt(hex.slice(0, 6), 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(raw);
  if (m) return { r: Math.round(+m[1]!), g: Math.round(+m[2]!), b: Math.round(+m[3]!) };
  return null;
}

/** Longest edge of a preview frame. Big enough to judge, cheap enough to scrub. */
export const PREVIEW_MAX_EDGE = 640;

export interface ExportPreviewRenderer {
  /** The canvas to display. Stable for the renderer's lifetime. */
  readonly canvas: HTMLCanvasElement;
  /** Render one frame and measure it. Resolves once pixels are on the canvas. */
  render(request: PreviewFrameRequest): Promise<PreviewFrame>;
  dispose(): void;
}

/**
 * A reusable preview renderer.
 *
 * One GPU backend is created and kept for the renderer's lifetime — scrubbing
 * the preview would otherwise create and destroy a GPU context per frame, which
 * is both slow and a reliable way to hit the browser's live-context cap.
 */
export function createExportPreviewRenderer(): ExportPreviewRenderer {
  const canvas = document.createElement('canvas');
  const backend: RenderBackend = createRenderBackend('auto', 'auxiliary');
  backend.attach(canvas);
  backend.setPreviewChrome?.(false);
  // Exact media timing is what makes `takeMediaWaits()` report anything at all.
  // Without it the convergence loop below finds nothing to await and returns on
  // the first pass — so every video and every not-yet-decoded image showed as its
  // white placeholder, which is exactly the "the preview is blank" report this
  // component exists to prevent. The offline renderer sets the same flag.
  backend.setExactMediaTiming?.(true);

  // Pixels are read through a 2D scratch canvas: the render canvas belongs to a
  // GPU context and can never hand out a 2D one.
  const scratch = document.createElement('canvas');
  let sized = { width: 0, height: 0 };
  let disposed = false;
  let currentGen = 0;
  /** Serializes renders. `takeMediaWaits()` is DESTRUCTIVE backend state —
   *  two overlapping renders raced it: the later one drained the waits the
   *  earlier one needed, broke out of convergence on pass one, and measured a
   *  frame whose decodes had not landed (reported as blank, painted as a
   *  placeholder — the exact failure exact-media-timing exists to prevent). */
  let chain: Promise<unknown> = Promise.resolve();

  const renderOne = async (request: PreviewFrameRequest, gen: number): Promise<PreviewFrame> => {
      const compW = request.comp?.width ?? request.width;
      const compH = request.comp?.height ?? request.height;
      const scale = Math.min(1, PREVIEW_MAX_EDGE / Math.max(compW, compH));
      const width = Math.max(1, Math.round(compW * scale));
      const height = Math.max(1, Math.round(compH * scale));

      if (sized.width !== width || sized.height !== height) {
        backend.resize(width, height, 1);
        sized = { width, height };
      }
      if (backend.readyPromise) await backend.readyPromise;
      if (disposed || gen !== currentGen) return { coverage: 0, blank: true, warnings: [] };
      if (backend.initFailed) {
        throw new Error(backend.initErrorMessage ?? 'The renderer could not be initialized.');
      }

      // Snap to the export's frame grid so the preview shows a frame the encoder
      // will actually produce, not one sampled between two of them.
      const time = request.fps > 0 ? Math.round(request.time * request.fps) / request.fps : request.time;
      // Motion blur mirrors the export (exportManager.exportMotionBlur): with
      // it on, an un-blurred preview was categorically not the file.
      const mb = useMotionBlurStore.getState();
      const motionBlur = mb.enabled
        ? { enabled: true, shutterAngle: mb.shutterAngle, shutterPhase: mb.shutterPhase, samples: mb.samples, adaptiveSampleLimit: mb.adaptiveSampleLimit, fps: request.fps }
        : undefined;
      const snapshot = buildSnapshot(
        defaultSceneGraph,
        defaultAnimation,
        time,
        undefined,
        undefined,
        exportView(width, height, request.comp),
        motionBlur,
        exportComp(request.comp),
      );
      if (disposed || gen !== currentGen) return { coverage: 0, blank: true, warnings: [] };
      backend.renderFrame(snapshot);
      // Converge async media (image decodes, video seeks) exactly like the
      // offline renderer does, or the preview shows placeholders for footage the
      // export would include.
      for (let pass = 0; pass < 4; pass++) {
        const waits = backend.takeMediaWaits?.();
        if (!waits || waits.length === 0) break;
        // Time-capped like the offline renderer: a wedged decode degrades the
        // preview frame instead of hanging it forever.
        let capTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          Promise.all(waits),
          new Promise<void>((resolve) => { capTimer = setTimeout(resolve, 15_000); }),
        ]);
        clearTimeout(capTimer);
        if (disposed || gen !== currentGen) return { coverage: 0, blank: true, warnings: [] };
        backend.renderFrame(snapshot);
      }

      if (disposed || gen !== currentGen) return { coverage: 0, blank: true, warnings: [] };

      // The refusal list the EXPORT will die on — shown here first, so "would
      // stop at frame N" is a banner in the dialog, not a surprise mid-render.
      const warnings = (backend.lastFrameDiagnostics?.() ?? []).map((d) => d.detail);

      scratch.width = width;
      scratch.height = height;
      const ctx = scratch.getContext('2d', { willReadFrequently: true });
      if (!ctx) return { coverage: 1, blank: false, warnings };
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(canvas, 0, 0);
      const data = ctx.getImageData(0, 0, width, height).data;
      const coverage = frameCoverage(
        data,
        request.comp?.transparent ? null : parseCssColor(request.comp?.background),
      );
      return { coverage, blank: coverage < BLANK_COVERAGE, warnings };
  };

  return {
    canvas,

    render(request: PreviewFrameRequest): Promise<PreviewFrame> {
      const gen = ++currentGen;
      const run = chain.then(() => renderOne(request, gen));
      // The stored chain absorbs rejections so one failed render does not
      // poison every later one; the caller still receives the real rejection.
      chain = run.catch(() => undefined);
      return run;
    },

    dispose(): void {
      disposed = true;
      currentGen++;
      backend.dispose();
    },
  };
}
