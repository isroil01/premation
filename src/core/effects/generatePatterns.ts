/**
 * Procedural pattern generators — Checkerboard, Grid, Cell Pattern and Vegas.
 *
 * The first three DRAW a pattern; Vegas TRACES the layer's own alpha edge. That
 * split is why Vegas lives here rather than in the stylize family: it is a
 * generator whose geometry happens to come from the layer instead of from a
 * formula.
 *
 * All four composite through the caller's canvas rather than returning pixel
 * buffers, because three of them are cheap vector draws and forcing them
 * through a per-pixel loop would cost more than it bought. Cell Pattern is the
 * exception and does own a pixel loop — Worley noise has no vector form.
 */

import type { Effect } from './effects';
import { effectNumber, paramsOf } from './effects';

const str = (e: Effect, k: string, fb: string): string => {
  const v = paramsOf(e)[k];
  return typeof v === 'string' ? v : fb;
};

/**
 * `source-atop` — the generated pattern replaces the layer's colour while
 * keeping the layer's alpha.
 *
 * Every generator here uses it, and it is the difference between "a pattern
 * inside my text" and "a pattern rectangle covering my text". `proceduralCanvas2d`
 * made the same choice for Gradient Ramp and Fractal Noise, deliberately
 * matched here so the whole generate family behaves alike.
 */
function withPatternClip(oc: CanvasRenderingContext2D, draw: () => void): void {
  oc.save();
  oc.globalCompositeOperation = 'source-atop';
  draw();
  oc.restore();
}

// ── Checkerboard ──────────────────────────────────────────────────

/**
 * Checkerboard — two alternating colours on a rectangular lattice.
 *
 * `anchorX/Y` shifts the lattice rather than the layer, so the pattern can be
 * animated sliding underneath static content. Sizes are clamped at a floor of
 * 1px: a zero size would make the loop below non-terminating, and it is
 * reachable from the inspector.
 */
export function drawCheckerboard(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const sizeW = Math.max(1, effectNumber(e, 'width'));
  const sizeH = Math.max(1, effectNumber(e, 'height'));
  const anchorX = effectNumber(e, 'anchorX');
  const anchorY = effectNumber(e, 'anchorY');
  const colorA = str(e, 'colorA', '#000000');
  const colorB = str(e, 'colorB', '#ffffff');
  const opacity = effectNumber(e, 'opacity') / 100;
  if (opacity <= 0) return;

  withPatternClip(oc, () => {
    oc.globalAlpha = Math.min(1, opacity);
    // Start one cell before the origin so a positive anchor still covers the
    // top-left corner instead of leaving a gap.
    const startX = -sizeW + (((anchorX % sizeW) + sizeW) % sizeW);
    const startY = -sizeH + (((anchorY % sizeH) + sizeH) % sizeH);
    let row = 0;
    for (let y = startY; y < h; y += sizeH, row++) {
      let col = 0;
      for (let x = startX; x < w; x += sizeW, col++) {
        oc.fillStyle = (row + col) % 2 === 0 ? colorA : colorB;
        oc.fillRect(x, y, sizeW, sizeH);
      }
    }
  });
}

// ── Grid ──────────────────────────────────────────────────────────

/**
 * Grid — ruled lines at a fixed pitch.
 *
 * Lines are stroked at half-pixel offsets so a 1px line lands ON a pixel rather
 * than straddling two and rendering as two half-intensity rows. That is the
 * single most common way a procedural grid looks soft when it should be crisp.
 */
export function drawGrid(oc: CanvasRenderingContext2D, w: number, h: number, e: Effect): void {
  const pitchX = Math.max(1, effectNumber(e, 'width'));
  const pitchY = Math.max(1, effectNumber(e, 'height'));
  const thickness = Math.max(0, effectNumber(e, 'thickness'));
  const anchorX = effectNumber(e, 'anchorX');
  const anchorY = effectNumber(e, 'anchorY');
  const opacity = effectNumber(e, 'opacity') / 100;
  if (thickness <= 0 || opacity <= 0) return;

  withPatternClip(oc, () => {
    oc.globalAlpha = Math.min(1, opacity);
    oc.strokeStyle = str(e, 'color', '#ffffff');
    oc.lineWidth = thickness;
    // Half-pixel snap only for odd integer widths, where it actually helps.
    const snap = Math.round(thickness) % 2 === 1 ? 0.5 : 0;
    oc.beginPath();
    for (let x = ((anchorX % pitchX) + pitchX) % pitchX; x <= w; x += pitchX) {
      oc.moveTo(Math.round(x) + snap, 0);
      oc.lineTo(Math.round(x) + snap, h);
    }
    for (let y = ((anchorY % pitchY) + pitchY) % pitchY; y <= h; y += pitchY) {
      oc.moveTo(0, Math.round(y) + snap);
      oc.lineTo(w, Math.round(y) + snap);
    }
    oc.stroke();
  });
}

// ── Cell Pattern ──────────────────────────────────────────────────

/** Deterministic hash → 0..1. No Math.random: playback must be reproducible
 *  and scrubbing back to a frame must give the same pattern. */
function hash01(x: number, y: number, seed: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
  return n - Math.floor(n);
}

/**
 * Cell Pattern — Worley (cellular) noise.
 *
 * For each pixel, the distance to the nearest of a set of feature points, one
 * jittered inside each lattice cell. Only the 3×3 neighbourhood is searched:
 * a feature point outside it cannot be nearest, because each cell holds exactly
 * one point and the cell's own point is at most one cell-diagonal away.
 *
 * `sharpness` selects between the two classic readings of the same field —
 * F1 alone gives blobs, F2−F1 gives the crystalline membrane look. Exposing one
 * without the other would ship half the effect, since they look nothing alike.
 */
export function cellPatternData(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  size: number,
  evolution: number,
  contrast: number,
  invert: boolean,
  membrane: boolean,
): Uint8ClampedArray {
  const cell = Math.max(2, size);
  const gain = Math.max(0.01, contrast / 100);

  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const i = (py * w + px) * 4;
      if (data[i + 3] === 0) continue;
      const gx = Math.floor(px / cell);
      const gy = Math.floor(py / cell);
      let f1 = Infinity;
      let f2 = Infinity;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const cx = gx + ox;
          const cy = gy + oy;
          // The feature point for this cell, jittered inside it. Evolution
          // moves the jitter, so animating it makes the cells drift rather
          // than the whole field slide.
          const fx = (cx + hash01(cx, cy, evolution)) * cell;
          const fy = (cy + hash01(cx, cy, evolution + 17.3)) * cell;
          const d = Math.hypot(px - fx, py - fy);
          if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
        }
      }
      const raw = membrane ? (f2 - f1) / cell : f1 / cell;
      let v = Math.max(0, Math.min(1, raw * gain));
      if (invert) v = 1 - v;
      const level = Math.round(v * 255);
      data[i] = level; data[i + 1] = level; data[i + 2] = level;
    }
  }
  return data;
}

// ── Vegas — deliberately NOT here ─────────────────────────────────
//
// Vegas runs lights ALONG the layer's alpha contour, and the contour is the
// whole effect: dash spacing, the direction the lights travel, and what `phase`
// animates are all defined in arc length around that outline. Without it there
// is no Vegas, only a dashed rectangle.
//
// Canvas cannot stroke a raster's alpha edge, so a real implementation needs
// marching squares over the alpha channel to extract closed contours, then an
// arc-length walk to place dashes — roughly the size of `distort.ts`, with its
// own geometry tests. That is a separate piece of work, not a corner of this
// module.
//
// The tempting shortcut is to stroke the layer's bounding box and call it
// Vegas. It renders something plausible on the rectangular layers people most
// often reach for, which is exactly what makes it dangerous: it would look
// correct until someone applied it to text, and it would be indistinguishable
// from the finished effect in a screenshot. Deferred rather than half-shipped.
