/**
 * Deterministic offline renderer (Prompt 9). Replaces realtime MediaRecorder
 * sampling (which drops frames and is non-reproducible) with a fixed-timestep
 * loop: every frame's time is `index / fps` exactly, so the same project always
 * renders byte-identical frames regardless of machine speed.
 *
 * The loop renders each frame into an offscreen Canvas2D backend and hands the
 * canvas to a sink (`onFrame`) — PNG-sequence zipping, MediaRecorder feeding,
 * etc. It yields between frames so the UI stays responsive and supports
 * cancellation via an AbortSignal.
 *
 * The frame-timing maths is pure and unit-tested; the render loop needs a DOM
 * canvas so it runs in the browser / render worker, not under jsdom.
 */

import { createRenderBackend } from '@core/rendering/createRenderBackend';
import { buildSnapshot, COMP_WIDTH, COMP_HEIGHT, type SnapshotComp } from '@core/rendering/buildSnapshot';
import type { MotionBlurConfig } from '@core/effects/motionBlur';
import type { RenderView } from '@core/rendering/RenderBackend';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';

export interface OfflineRenderParams {
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  /** Comp size + background/transparency; defaults handled by buildSnapshot. */
  comp?: SnapshotComp;
  /** Optional inclusive frame range (defaults to the whole duration). */
  startFrame?: number;
  endFrame?: number;
  /** Motion blur (threaded from the viewport settings so export matches). */
  motionBlur?: MotionBlurConfig;
}

/**
 * Exact fit-contain of the comp into the output frame — the backend's implicit
 * fallback fit insets by 8% (preview "float" framing), which exported every
 * frame with a border. Pure, exported for tests.
 */
export function exportView(
  outW: number,
  outH: number,
  comp?: SnapshotComp,
): RenderView {
  const cw = comp?.width ?? COMP_WIDTH;
  const ch = comp?.height ?? COMP_HEIGHT;
  const scale = Math.min(outW / cw, outH / ch);
  return { scale, offsetX: (outW - cw * scale) / 2, offsetY: (outH - ch * scale) / 2 };
}

// ── Pure frame timing (deterministic, tested) ────────────────────────

/** Total frames for a duration at a frame rate (at least 1). */
export function frameCount(durationSec: number, fps: number): number {
  return Math.max(1, Math.round(durationSec * fps));
}

/** Exact time (seconds) of frame `index` — the fixed timestep. */
export function frameTimeAt(index: number, fps: number): number {
  return index / fps;
}

/** Every frame time across the duration (fixed timestep). */
export function frameTimes(durationSec: number, fps: number): number[] {
  const n = frameCount(durationSec, fps);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(i / fps);
  return out;
}

/** Resolve an inclusive [start,end] frame range within the duration. */
export function resolveRange(params: OfflineRenderParams): { start: number; end: number } {
  const total = frameCount(params.durationSec, params.fps);
  const start = Math.max(0, params.startFrame ?? 0);
  const end = Math.min(total - 1, params.endFrame ?? total - 1);
  return { start, end: Math.max(start, end) };
}

// ── The render loop ──────────────────────────────────────────────────

export type FrameSink = (
  canvas: HTMLCanvasElement,
  frame: number,
  total: number,
) => void | Promise<void>;

/**
 * Render each frame deterministically into an offscreen canvas and pass it to
 * `onFrame`. Returns the number of frames rendered. Aborts cleanly if the
 * signal fires (throws AbortError).
 */
export async function renderOffline(
  params: OfflineRenderParams,
  onFrame: FrameSink,
  signal?: AbortSignal,
): Promise<number> {
  const canvas = document.createElement('canvas');
  const backend = createRenderBackend('auto', 'auxiliary');
  try {
    backend.attach(canvas);
    backend.resize(params.width, params.height, 1);
    // Frame-accurate media: sub-millisecond video seeks + collected waits, so a
    // captured frame can never show the PREVIOUS frame's footage. Without this,
    // seeks were async fire-and-forget with a ±0.05s deadband — every exported
    // video layer lagged a frame and stuttered at ~half rate.
    backend.setExactMediaTiming?.(true);

    if (backend.readyPromise) {
      await backend.readyPromise;
    }

    const { start, end } = resolveRange(params);
    const total = end - start + 1;
    for (let i = start; i <= end; i++) {
      if (signal?.aborted) throw new DOMException('Render cancelled', 'AbortError');
      const t = frameTimeAt(i, params.fps);
      const snap = buildSnapshot(
        defaultSceneGraph,
        defaultAnimation,
        t,
        undefined,
        undefined,
        exportView(params.width, params.height, params.comp), // 1:1 comp→frame (no preview inset)
        params.motionBlur,
        params.comp,
      );
      backend.renderFrame(snap);
      // Converge media: while a render started async media work (video seeks,
      // first decode, blend-cache fills), await it and re-render. Every wait is
      // internally time-capped, and the pass cap bounds a pathological source.
      for (let pass = 0; pass < 4; pass++) {
        const waits = backend.takeMediaWaits?.();
        if (!waits || waits.length === 0) break;
        await Promise.all(waits);
        if (signal?.aborted) throw new DOMException('Render cancelled', 'AbortError');
        backend.renderFrame(snap);
      }
      await onFrame(canvas, i - start, total);
      // Yield so progress paints and cancellation can interrupt.
      await new Promise<void>((r) => setTimeout(r, 0));
    }
    return total;
  } finally {
    backend.dispose();
  }
}

/**
 * Render a SINGLE frame to a PNG blob (AE's "Save Frame As"). Reuses the exact
 * deterministic offline path — same backend, same 1:1 comp→frame view — so a
 * saved still matches a video export frame-for-frame. Returns null if the
 * canvas can't encode. `mime` may be 'image/png' (lossless, default) or
 * 'image/jpeg'.
 */
export async function renderStillFrame(
  params: OfflineRenderParams,
  frameIndex: number,
  mime: 'image/png' | 'image/jpeg' = 'image/png',
  quality = 0.92,
): Promise<Blob | null> {
  let blob: Blob | null = null;
  await renderOffline(
    { ...params, startFrame: frameIndex, endFrame: frameIndex },
    async (canvas) => {
      blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((b) => resolve(b), mime, quality),
      );
    },
  );
  return blob;
}
