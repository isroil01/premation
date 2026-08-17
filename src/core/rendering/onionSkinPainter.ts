/**
 * Painting the onion skins onto their own 2D layer.
 *
 * Split from the render loop because it owns three pieces of state that have no
 * business living in a 400-line closure: a scratch canvas, the memo signature,
 * and the show/hide of the layer. `onionSkin.ts` decides WHICH ghosts; this
 * decides how they get onto the screen.
 *
 * ── The two constraints that shape it ───────────────────────────────────────
 *
 * **Every ghost is a full comp render, into the SAME content canvas.** There is
 * one WebGL canvas and a render overwrites it, so a ghost has to be captured
 * into 2D before the next one is drawn, and the live frame must be rendered
 * last by the caller. That is also why the whole thing is memoized: at 4 ghosts
 * a side, an un-memoized repaint on every mouse move is 9 comp renders per
 * mouse move.
 *
 * **Ghosts are rendered with a transparent background** (the caller passes
 * `ghost`), so the captured frame carries alpha and the ghosts layer over each
 * other and over the live frame. With the comp background left on, each ghost
 * would be an opaque plate and only the last one drawn would be visible — the
 * feature would look like it was showing exactly one wrong frame.
 */

import { onionSkinPlan, onionSkinSignature, type OnionSkinSettings } from './onionSkin';

export interface OnionSkinPainterDeps {
  /** The WebGL content canvas the ghosts are rendered into and captured from. */
  content: () => HTMLCanvasElement | null;
  /** The 2D layer the ghosts are composited onto. */
  target: () => HTMLCanvasElement | null;
  settings: () => OnionSkinSettings;
  /** Frame range of the composition; ghosts outside it are dropped. */
  bounds: () => { min: number; max: number };
  /** Class that makes the target layer visible. */
  visibleClass: string;
}

export interface OnionSkinPainter {
  /**
   * Draw the ghosts for `frame`, or clear them.
   *
   * `renderAt` must render the scene into the content canvas at a given TIME,
   * with `ghost` selecting the transparent-background variant.
   */
  paint(
    renderAt: (t: number, ghost: boolean) => void,
    frame: number,
    fps: number,
    playing: boolean,
    invalidationKey: string,
  ): void;
  /** Number of ghosts drawn on the last paint that did work. For tests and for
   *  anything that wants to report the cost. */
  readonly lastDrawn: number;
}

/** How hard the tint is pushed into a ghost. Enough to read as past/future at a
 *  glance, light enough that the artwork underneath is still recognisable —
 *  a fully tinted ghost is a silhouette, which defeats the purpose. */
const TINT_STRENGTH = 0.55;

export function createOnionSkinPainter(deps: OnionSkinPainterDeps): OnionSkinPainter {
  let scratch: HTMLCanvasElement | null = null;
  let lastSignature = '';
  let drawn = 0;

  const hide = (): void => {
    const target = deps.target();
    if (!target) return;
    target.classList.remove(deps.visibleClass);
    const ctx = target.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, target.width, target.height);
  };

  return {
    get lastDrawn() {
      return drawn;
    },

    paint(renderAt, frame, fps, playing, invalidationKey) {
      const settings = deps.settings();

      // Never while playing. The ghosts would be re-rendered every frame at
      // several comp renders each, turning the one mode that needs to stay
      // responsive into the slowest thing in the app — and nobody reads onion
      // skins in motion anyway.
      if (!settings.enabled || playing || fps <= 0) {
        if (lastSignature !== '') {
          lastSignature = '';
          drawn = 0;
          hide();
        }
        return;
      }

      const signature = onionSkinSignature(frame, settings, invalidationKey);
      if (signature === lastSignature) return;

      const content = deps.content();
      const target = deps.target();
      if (!content || !target) return;

      const plan = onionSkinPlan(frame, settings, deps.bounds());
      lastSignature = signature;
      drawn = 0;
      if (plan.length === 0) {
        hide();
        return;
      }

      if (target.width !== content.width || target.height !== content.height) {
        target.width = content.width;
        target.height = content.height;
      }
      const ctx = target.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, target.width, target.height);

      if (!scratch) scratch = document.createElement('canvas');
      if (scratch.width !== content.width || scratch.height !== content.height) {
        scratch.width = content.width;
        scratch.height = content.height;
      }
      const sctx = scratch.getContext('2d');
      if (!sctx) return;

      // Farthest first — `onionSkinPlan` returns draw order, so this loop must
      // not be reordered or the nearest ghost ends up underneath.
      for (const ghost of plan) {
        renderAt(ghost.frame / fps, true);

        sctx.globalCompositeOperation = 'source-over';
        sctx.globalAlpha = 1;
        sctx.clearRect(0, 0, scratch.width, scratch.height);
        sctx.drawImage(content, 0, 0);

        if (ghost.tint) {
          // `source-atop` so the tint lands only where the ghost has pixels.
          // A plain fillRect would flood the transparent background too and the
          // ghost would arrive as a full-frame colour wash.
          sctx.globalCompositeOperation = 'source-atop';
          sctx.globalAlpha = TINT_STRENGTH;
          sctx.fillStyle = ghost.tint;
          sctx.fillRect(0, 0, scratch.width, scratch.height);
          sctx.globalCompositeOperation = 'source-over';
          sctx.globalAlpha = 1;
        }

        ctx.globalAlpha = ghost.opacity;
        ctx.drawImage(scratch, 0, 0);
        drawn++;
      }
      ctx.globalAlpha = 1;
      target.classList.add(deps.visibleClass);
    },
  };
}
