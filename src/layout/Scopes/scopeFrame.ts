/**
 * Getting the current composited frame's pixels to the Scopes panel.
 *
 * Two sources, in preference order, and neither one required a change to the
 * render loop to exist:
 *
 * 1. **The frame tap** ({@link subscribeFrames}). Exact, always current, and
 *    inert until one line is added to the viewport loop. When that line is
 *    present the panel simply reads the freshest published frame.
 *
 * 2. **The RAM preview cache** (`viewportFrameCache`). Its entries are plain 2D
 *    canvases — the cache copies the WebGL content canvas into one on the way
 *    in — so unlike the live viewport surface they can be read back at any
 *    time, from any task. That is what makes this path work with zero edits to
 *    Workspace or Providers, and it is the default.
 *
 * ## Why the cached frame has to be cropped
 *
 * A cache entry is the VIEWPORT, not the composition. It is the content canvas
 * at whatever pan, zoom and preview resolution were in force, so it holds the
 * comp somewhere inside a field of letterbox. Scoping it whole would fold the
 * letterbox into every reading — a zoomed-out comp would look like it had a
 * huge black floor, and zooming the viewport would visibly change the scope,
 * which is the single most misleading thing a scope can do.
 *
 * So the comp's rect is reconstructed from the same two facts the render loop
 * itself uses: the workspace camera's view transform (`canvasPx = compPx *
 * scale + offset`, in CSS pixels) and the ratio between the cached canvas's
 * pixel width and the viewport's CSS width — which folds device pixel ratio
 * and the Full/Half/Third/Quarter preview resolution into one number without
 * this module having to know that either of them exists.
 *
 * When the comp is only partly on screen the crop is clamped to what is
 * actually there and the result is flagged {@link ScopeFrame.partial}, because
 * a scope reading half a frame and not saying so is worse than one that
 * refuses. The panel says so on screen.
 */

import { viewportFrameCache } from '@core/rendering/frameCache';
import { latestTappedFrame } from '@core/rendering/frameTap';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import { getTimelineController } from '@core/timeline/TimelineController';
import { useCompositionStore } from '@stores/compositionStore';
import { SCOPE_SAMPLE_WIDTH } from '@core/video/scopes';

export interface ScopeFrame {
  /** RGBA, straight alpha. */
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  /** Which route produced it — surfaced in the panel's status line. */
  readonly source: 'tap' | 'cache';
  /** True when the comp rect was clipped by the viewport edge. */
  readonly partial: boolean;
  /** Composition frame this reading is of. */
  readonly frame: number;
}

/** Why there is nothing to show, when there is nothing to show. */
export type ScopeFrameMiss = 'no-frame' | 'off-screen';

export interface ScopeFrameResult {
  frame: ScopeFrame | null;
  miss: ScopeFrameMiss | null;
}

/** The comp's rect inside a cached viewport canvas, in that canvas's pixels. */
export interface CompRect {
  x: number;
  y: number;
  width: number;
  height: number;
  /** False when part of the comp lies outside the canvas. */
  whole: boolean;
}

/**
 * Where the comp sits inside a viewport canvas `canvasWidth` px wide.
 *
 * Pure, and exported for its test: the arithmetic is three multiplications and
 * every one of them is a place to get a factor backwards, with a symptom
 * (slightly wrong scope readings) nobody would catch by looking.
 */
export function compRectInCanvas(
  canvasWidth: number,
  canvasHeight: number,
  cssWidth: number,
  view: { scale: number; offsetX: number; offsetY: number },
  comp: { width: number; height: number },
): CompRect | null {
  if (!(canvasWidth > 0) || !(canvasHeight > 0) || !(cssWidth > 0)) return null;
  if (!(view.scale > 0) || !(comp.width > 0) || !(comp.height > 0)) return null;
  // One factor for dpr AND preview resolution together: the render loop sizes
  // the content buffer as cssWidth * dpr * previewScale, and their product is
  // exactly what this ratio recovers.
  const k = canvasWidth / cssWidth;
  const x = view.offsetX * k;
  const y = view.offsetY * k;
  const width = comp.width * view.scale * k;
  const height = comp.height * view.scale * k;

  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(canvasWidth, x + width);
  const y1 = Math.min(canvasHeight, y + height);
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;

  return {
    x: x0,
    y: y0,
    width: x1 - x0,
    height: y1 - y0,
    whole: x0 <= x + 0.5 && y0 <= y + 0.5 && x1 >= x + width - 0.5 && y1 >= y + height - 0.5,
  };
}

/** Current comp rect in the LIVE content canvas — the frame tap's region. */
export function liveCompRegion(canvasWidth: number, canvasHeight: number): CompRect | null {
  try {
    const controller = getWorkspaceController();
    const comp = useCompositionStore.getState();
    return compRectInCanvas(
      canvasWidth,
      canvasHeight,
      controller.ws.viewport.size.width,
      controller.getView(),
      { width: comp.width, height: comp.height },
    );
  } catch {
    return null;
  }
}

/** The composition frame the playhead is on. */
export function currentScopeFrame(): number {
  try {
    return Math.round(getTimelineController().timeline.currentFrame);
  } catch {
    return 0;
  }
}

let scratch: HTMLCanvasElement | null = null;
let scratchCtx: CanvasRenderingContext2D | null = null;

function readCanvasRegion(
  source: CanvasImageSource,
  rect: { x: number; y: number; width: number; height: number },
): { data: Uint8ClampedArray; width: number; height: number } | null {
  const scale = Math.min(1, SCOPE_SAMPLE_WIDTH / rect.width);
  const dw = Math.max(1, Math.round(rect.width * scale));
  const dh = Math.max(1, Math.round(rect.height * scale));
  if (!scratch) {
    scratch = document.createElement('canvas');
    scratchCtx = scratch.getContext('2d', { willReadFrequently: true });
  }
  const ctx = scratchCtx;
  if (!ctx || !scratch) return null;
  if (scratch.width !== dw || scratch.height !== dh) {
    scratch.width = dw;
    scratch.height = dh;
  }
  ctx.clearRect(0, 0, dw, dh);
  ctx.drawImage(source, rect.x, rect.y, rect.width, rect.height, 0, 0, dw, dh);
  const img = ctx.getImageData(0, 0, dw, dh);
  return { data: img.data, width: dw, height: dh };
}

/**
 * The freshest frame the panel can get, or a reason it got none.
 *
 * `maxTapAgeMs` is deliberately generous: while the editor sits paused nothing
 * re-renders, so the last published frame IS the current one no matter how old
 * it is — but it must still be for the frame the playhead is on, which is what
 * the frame comparison below checks.
 */
export function captureScopeFrame(maxTapAgeMs = 2000): ScopeFrameResult {
  const frame = currentScopeFrame();

  const tapped = latestTappedFrame(maxTapAgeMs);
  if (tapped) {
    return {
      frame: {
        data: tapped.data,
        width: tapped.width,
        height: tapped.height,
        source: 'tap',
        // The tap crops with `liveCompRegion`, which already clamps; treating
        // its output as whole would be a lie only in the same rare case the
        // cache path reports, and the tap has no way to tell us. Ask the
        // camera again — it is three field reads.
        partial: !(liveCompRegion(tapped.width, tapped.height)?.whole ?? true),
        frame,
      },
      miss: null,
    };
  }

  let cached: HTMLCanvasElement | null = null;
  try {
    cached = viewportFrameCache.get(frame);
  } catch {
    cached = null;
  }
  if (!cached || cached.width < 1 || cached.height < 1) return { frame: null, miss: 'no-frame' };

  const rect = liveCompRegion(cached.width, cached.height);
  if (!rect) return { frame: null, miss: 'off-screen' };

  let read: { data: Uint8ClampedArray; width: number; height: number } | null = null;
  try {
    read = readCanvasRegion(cached, rect);
  } catch {
    read = null;
  }
  if (!read) return { frame: null, miss: 'no-frame' };

  return {
    frame: {
      data: read.data,
      width: read.width,
      height: read.height,
      source: 'cache',
      partial: !rect.whole,
      frame,
    },
    miss: null,
  };
}
