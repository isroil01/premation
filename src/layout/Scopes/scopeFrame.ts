/**
 * Getting the current composited frame's pixels to the Scopes panel.
 *
 * One source: **the frame tap** (`@core/engine/frameTap`). `EngineSurface`
 * publishes the engine's frame as it draws it — a detached copy, rate-limited,
 * and nothing at all while no scope is open — and the panel reads the freshest
 * one on its own timer. (The page preview cache used to be a second source; it
 * went with the page renderer, and the engine's frame cache is video memory
 * the page cannot read.)
 *
 * ## Why the frame has to be cropped
 *
 * The published frame is the VIEWPORT, not the composition: it holds the comp
 * at whatever pan and zoom are in force, somewhere inside a field of letterbox.
 * Scoping it whole would fold the letterbox into every reading — a zoomed-out
 * comp would look like it had a huge black floor, and zooming the viewport
 * would visibly change the scope, which is the single most misleading thing a
 * scope can do.
 *
 * So the comp's rect is reconstructed from the workspace camera's view
 * transform (`canvasPx = compPx * scale + offset`, in CSS pixels) and the
 * ratio between the frame's pixel width and the viewport's CSS width — which
 * folds device pixel ratio and the preview resolution into one number without
 * this module having to know that either of them exists. The panel installs
 * {@link liveCompRegion} as the tap's crop.
 *
 * ## What a miss means
 *
 *   `no-frame`    nothing has been published recently (the panel just opened,
 *                 or the engine has not drawn since).
 *   `off-screen`  the comp is wholly outside the viewport. The tap has no rect
 *                 to crop to then, so what it copied is letterbox — refused
 *                 rather than plotted.
 *
 * When the comp is only partly on screen the crop is clamped to what is
 * actually there and the result is flagged {@link ScopeFrame.partial}, because
 * a scope reading half a frame and not saying so is worse than one that
 * refuses. The panel says so on screen.
 */

import { latestTappedFrame } from '@core/engine/frameTap';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import { playheadSeconds } from '@core/timeline/timelineView';
import { activeCompSettingsNow } from '@hooks/useMirrorFrame';
import { settingsFps } from '@core/mirror/compFacts';

export interface ScopeFrame {
  /** RGBA, straight alpha. */
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  /** Which route produced it — surfaced in the panel's status line. */
  readonly source: 'tap';
  /** True when the comp rect was clipped by the viewport edge. */
  readonly partial: boolean;
  /** Composition frame this reading is of. */
  readonly frame: number;
}

/** Why there is nothing to show, when there is nothing to show (see the module header). */
export type ScopeFrameMiss = 'no-frame' | 'off-screen';

export interface ScopeFrameResult {
  frame: ScopeFrame | null;
  miss: ScopeFrameMiss | null;
}

/** The comp's rect inside a viewport canvas, in that canvas's pixels. */
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
    // B4: the active composition's size from the document mirror.
    const comp = activeCompSettingsNow();
    if (!comp) return null;
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
    // The playhead (transport seam) on the active composition's frame grid.
    return Math.round(playheadSeconds() * settingsFps(activeCompSettingsNow()));
  } catch {
    return 0;
  }
}

/**
 * Where the comp sits in the viewport right now, in CSS pixels.
 *
 * `known: false` when the question cannot be asked (no workspace, no active
 * composition, a viewport with no size yet) — which is not the same as the
 * comp being off screen, and must not be reported as that.
 */
export function compRegionInViewport(): { known: boolean; rect: CompRect | null } {
  try {
    const controller = getWorkspaceController();
    const comp = activeCompSettingsNow();
    const size = controller.ws.viewport.size;
    if (!comp || !(size.width > 0) || !(size.height > 0)) return { known: false, rect: null };
    // CSS pixels on both sides, so the dpr / resolution factor is 1.
    const rect = compRectInCanvas(size.width, size.height, size.width, controller.getView(), {
      width: comp.width,
      height: comp.height,
    });
    return { known: true, rect };
  } catch {
    return { known: false, rect: null };
  }
}

/**
 * The freshest frame the panel can get, or a reason it got none.
 *
 * `maxTapAgeMs` is deliberately generous: while the editor sits paused nothing
 * re-renders, so the last published frame IS the current one no matter how old
 * it is.
 */
export function captureScopeFrame(maxTapAgeMs = 2000): ScopeFrameResult {
  const tapped = latestTappedFrame(maxTapAgeMs);
  if (!tapped) return { frame: null, miss: 'no-frame' };

  // The tap crops to the comp's rect and has no way to say whether it could.
  // Ask the camera — it is three field reads. No rect at all means the tap
  // copied the whole viewport, and that is letterbox, not the picture.
  const region = compRegionInViewport();
  if (region.known && !region.rect) return { frame: null, miss: 'off-screen' };

  return {
    frame: {
      data: tapped.data,
      width: tapped.width,
      height: tapped.height,
      source: 'tap',
      partial: region.rect ? !region.rect.whole : false,
      frame: currentScopeFrame(),
    },
    miss: null,
  };
}
