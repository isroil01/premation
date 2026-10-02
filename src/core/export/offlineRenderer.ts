/**
 * Deterministic offline renderer. Replaces realtime MediaRecorder
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
import { buildSnapshot, COMP_WIDTH, COMP_HEIGHT, DEFAULT_COMP, type SnapshotComp } from '@core/rendering/buildSnapshot';
import type { MotionBlurConfig } from '@core/effects/motionBlur';
import type { RenderView } from '@core/workspace/renderView';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
// Shared with the tracking walks — see that module for why an `await` alone
// does not hand the thread back.
import { yieldToUi } from '@core/loading/yieldToUi';
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
  /**
   * Hand the thread back only once this many ms have passed since the last
   * yield, instead of after every frame. Absent: yield every frame, which is
   * what the interactive walks built on this loop (auto-trace, reframe) want.
   *
   * A delivered export sets it. Electron 32 has no `scheduler.yield`, so each
   * yield is a `setTimeout(0)` — clamped to 4 ms once nested — and on a comp
   * that renders in 10 ms that clamp alone was a third of the export's wall
   * clock. Frames still yield promptly when they are slow (one heavy frame
   * already exceeds the budget), so progress and Cancel stay responsive.
   */
  yieldBudgetMs?: number;
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

/**
 * The comp settings for a DELIVERED frame — today, drop guide layers.
 *
 * Deliberately a sibling of `exportView`, meant to be called on the adjacent
 * line, because there is no single funnel every export path passes through:
 * `offlineRenderer`, `exportManager` (both the sequence and the poster
 * thumbnail) and `exportPreview` each call `buildSnapshot` themselves. Four
 * call sites is four chances to forget, which is the §2·0 shape.
 *
 * Two things narrow it. One DEFINITION of "for export" lives here, so the rule
 * cannot drift between the four. And `exportPathsMarkForExport.test.ts` reads
 * this directory's source, finds every `buildSnapshot(` call in it, and asserts
 * each is paired with this helper — derived from the code rather than from a
 * list someone maintains, so a fifth export path is caught the day it appears.
 *
 * `exportPreview` counts as an export path on purpose: it shows what the file
 * will contain, so a guide layer visible there would be a preview that lies.
 */
export function exportComp(comp?: SnapshotComp): SnapshotComp & { forExport: true } {
  // `comp` is optional on every export path, and `buildSnapshot` would have
  // substituted its defaults for `undefined`. Substituting them HERE keeps that
  // behaviour while still marking the frame — passing `undefined` through would
  // be the one case that silently kept guide layers in the output.
  return { ...DEFAULT_COMP, ...comp, forExport: true };
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

/**
 * The yield budget a DELIVERED export renders with (`yieldBudgetMs`): about
 * twenty progress repaints a second, which is as responsive as a progress bar
 * and a Cancel button need to be.
 */
export const EXPORT_YIELD_BUDGET_MS = 48;

export type FrameSink = (
  canvas: HTMLCanvasElement,
  frame: number,
  total: number,
  backend?: import('@core/rendering/RenderBackend').RenderBackend,
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

    // A backend that failed to initialise still accepts renderFrame — it just
    // stores the snapshot and draws nothing. Every frame then reads back as an
    // untouched canvas, and the export completes "successfully" with a file that
    // is uniformly black. That is the single worst failure this pipeline can
    // have, because nothing anywhere reports it, so it is checked here.
    if (backend.initFailed) {
      throw new Error(
        backend.initErrorMessage ??
          'The renderer could not be initialized, so there is nothing to export. Restarting the app usually clears this.',
      );
    }

    const { start, end } = resolveRange(params);
    const total = end - start + 1;
    const yieldBudget = params.yieldBudgetMs ?? 0;
    let lastYield = performance.now();
    // One frame's snapshot (`exportPathsMarkForExport.test.ts` reads this call site).
    const buildFrame = (t: number) => buildSnapshot(
      defaultSceneGraph,
      defaultAnimation,
      t,
      undefined,
      undefined,
      exportView(params.width, params.height, params.comp), // 1:1 comp→frame (no preview inset)
      params.motionBlur,
      exportComp(params.comp),
    );

    for (let i = start; i <= end; i++) {
      if (signal?.aborted) throw new DOMException('Render cancelled', 'AbortError');
      const t = frameTimeAt(i, params.fps);
      const snap = buildFrame(t);
      backend.renderFrame(snap);
      // Converge media: while a render started async media work (video seeks,
      // first decode, blend-cache fills), await it and re-render. The element
      // waits are internally time-capped; the exact-decoder waits are not, so
      // each pass carries its own ceiling — a wedged decode must degrade the
      // frame, never hang the export forever with no error and no progress.
      for (let pass = 0; pass < 4; pass++) {
        const waits = backend.takeMediaWaits?.();
        if (!waits || waits.length === 0) break;
        let capTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          Promise.all(waits),
          new Promise<void>((resolve) => { capTimer = setTimeout(resolve, 15_000); }),
        ]);
        clearTimeout(capTimer);
        if (signal?.aborted) throw new DOMException('Render cancelled', 'AbortError');
        backend.renderFrame(snap);
      }
      // EXPORT half of the M8a split: FAIL, do not warn.
      //
      // The preview shows the same notice and keeps the frame, because a human
      // is looking at it and can act. Here the frame is about to be encoded into
      // a file someone ships, and a warning in a log next to a delivered MP4 is
      // not a warning anyone acts on. Wrong pixels on screen are recoverable;
      // wrong pixels in a deliverable are not.
      //
      // Thrown BEFORE onFrame, so a frame known to be wrong is never handed to
      // the sink. A refused export beats a half-written file that looks finished.
      //
      // Read BEFORE the media-exactness gate below, deliberately: a lost GPU
      // device or a layer that threw also leaves that frame's footage
      // unconverged, and checking exactness first reported a device loss as
      // "the video decode did not finish" — sending the user to transcode
      // footage that was never the problem. The diagnostic names the cause.
      const diags = backend.lastFrameDiagnostics?.() ?? [];
      if (diags.length > 0) {
        const lines = diags.map((d) => `  • ${d.detail}${d.layerId ? ` (layer ${d.layerId})` : ''}`);
        throw new Error(
          `Export stopped at frame ${i}: ${diags.length} compositing operation(s) could not be `
          + `honoured, so this frame would not match the composition.\n${lines.join('\n')}`,
        );
      }

      // The exactness gate, closing the loophole the header promises is shut:
      // the renderer KNOWS when a frame holds stand-in video pixels
      // (nearest-neighbour while a decode is in flight, an element mid-seek,
      // a warming source) via lastFrameMediaExact() — but only the RAM
      // preview cache ever read it. The DELIVERABLE accepted the stale frame:
      // after the 4-pass cap or the 15s race, the loop fell through and
      // encoded whatever pixels were there, silently. M8b's rule is the
      // opposite — wrong pixels on screen are recoverable; wrong pixels in a
      // file are not — so a frame that never converged REFUSES, like every
      // other known-bad frame above.
      if (backend.lastFrameMediaExact?.() === false) {
        throw new Error(
          `Export stopped at frame ${i}: the video decode for this frame did not finish in time, `
          + 'so the frame would contain stale footage pixels. Re-run the export; if this repeats, '
          + 'generate a proxy for the footage or transcode it (Media Settings ▸ Proxy).',
        );
      }

      await onFrame(canvas, i - start, total, backend);
      // Yield so progress paints, the editor stays usable, and cancellation can
      // interrupt between frames — on a time budget when the caller set one.
      if (yieldBudget <= 0 || performance.now() - lastYield >= yieldBudget) {
        await yieldToUi();
        lastYield = performance.now();
      }
    }
    return total;
  } finally {
    backend.dispose();
  }
}

