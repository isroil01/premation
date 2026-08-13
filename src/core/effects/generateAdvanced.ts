/**
 * Generate, round four — Circle, Ellipse, Radio Waves, Lightning, Light Rays,
 * Light Sweep, Audio Waveform.
 *
 * ## These DRAW, they do not transform
 *
 * Like Beam, Lens Flare and Checkerboard before them, these take the 2D context
 * and paint onto it rather than taking a pixel buffer and returning one. That is
 * why they live here beside `generateText.ts`/`generatePatterns.ts` rather than
 * with the kernels: there is nothing to unit-test as arithmetic on an array,
 * and forcing them into a `Uint8ClampedArray` signature would mean
 * reimplementing arc, gradient and path filling by hand for no gain.
 *
 * ## Composite mode is a real parameter, not a detail
 *
 * A generator that always drew `source-over` would be a sticker: it would hide
 * the layer instead of interacting with it. Light Rays and Light Sweep are only
 * convincing in `lighter`, and Circle is used both as a solid shape and as an
 * additive glow. Each effect that can meaningfully composite differently
 * exposes it, and each restores `globalCompositeOperation` before returning —
 * leaking it would silently change how every LATER effect in the stack draws.
 */

import { clamp01 } from './colorSpace';

/** `#rrggbb` → `rgba(r,g,b,a)`, so callers can set alpha without string maths. */
function rgba(hex: string, alpha: number): string {
  const s = hex.trim();
  const m = /^#([0-9a-f]{6})$/i.exec(s) ?? /^#([0-9a-f]{3})$/i.exec(s);
  if (!m) return `rgba(128,128,128,${alpha})`;
  const raw = m[1]!;
  const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/**
 * Run `fn` with a composite mode, always restoring the previous one.
 *
 * Wrapped rather than set-and-reset inline because an early return inside a
 * generator would otherwise leave the mode set for the rest of the stack — a
 * bug that shows up as an unrelated effect later in the list looking wrong.
 */
function withComposite(oc: CanvasRenderingContext2D, mode: number, fn: () => void): void {
  const prev = oc.globalCompositeOperation;
  oc.globalCompositeOperation = compositeFor(mode);
  try {
    fn();
  } finally {
    oc.globalCompositeOperation = prev;
  }
}

/** 0 over · 1 add · 2 screen · 3 multiply · 4 inside (source-atop). */
function compositeFor(mode: number): GlobalCompositeOperation {
  switch (Math.round(mode)) {
    case 1: return 'lighter';
    case 2: return 'screen';
    case 3: return 'multiply';
    case 4: return 'source-atop';
    default: return 'source-over';
  }
}

// ── Circle ──────────────────────────────────────────────────────────

/**
 * Circle — a filled or stroked disc with a feathered edge.
 *
 * The feather is a radial gradient rather than a blur: blurring afterwards
 * would soften a hard disc symmetrically, but AE's Feather eats INWARD from the
 * radius, so the outer extent stays exactly where the radius says it is. That
 * distinction matters the moment the radius is keyframed.
 */
export function drawCircle(
  oc: CanvasRenderingContext2D,
  w: number,
  h: number,
  centerX: number,
  centerY: number,
  radius: number,
  color: string,
  opacity: number,
  feather: number,
  thickness: number,
  invert: boolean,
  composite: number,
): void {
  const r = Math.max(0, radius);
  if (r <= 0) return;
  const a = clamp01(opacity / 100);
  if (a <= 0) return;
  const cx = w / 2 + centerX;
  const cy = h / 2 + centerY;
  const feath = Math.max(0, Math.min(r, feather));

  withComposite(oc, composite, () => {
    oc.save();
    if (invert) {
      // Everything EXCEPT the disc. Drawn as a full-frame fill with the disc
      // punched out, so the feather still applies to the hole's edge.
      oc.fillStyle = rgba(color, a);
      oc.fillRect(0, 0, w, h);
      oc.globalCompositeOperation = 'destination-out';
    }
    if (thickness > 0) {
      // Ring: an annulus between r−thickness and r, feathered on both sides by
      // the same gradient construction so a thin ring does not lose its inner
      // edge to the feather.
      const inner = Math.max(0, r - thickness);
      const g = oc.createRadialGradient(cx, cy, 0, cx, cy, r);
      const i0 = inner / r;
      g.addColorStop(0, rgba(color, 0));
      g.addColorStop(Math.max(0, i0 - 1e-4), rgba(color, 0));
      g.addColorStop(Math.min(1, i0 + feath / r), rgba(color, a));
      g.addColorStop(Math.max(0, 1 - feath / r), rgba(color, a));
      g.addColorStop(1, rgba(color, 0));
      oc.fillStyle = g;
    } else if (feath > 0) {
      const g = oc.createRadialGradient(cx, cy, Math.max(0, r - feath), cx, cy, r);
      g.addColorStop(0, rgba(color, a));
      g.addColorStop(1, rgba(color, 0));
      oc.fillStyle = g;
    } else {
      oc.fillStyle = rgba(color, a);
    }
    oc.beginPath();
    oc.arc(cx, cy, r, 0, Math.PI * 2);
    oc.fill();
    oc.restore();
  });
}

// ── Ellipse ─────────────────────────────────────────────────────────

/**
 * Ellipse — an axis-independent ring, rotatable.
 *
 * Separate from Circle rather than Circle gaining a second radius: AE ships
 * both, and the reason is that Ellipse is a RING primitive (it has inner and
 * outer thickness and no fill mode) where Circle is a disc. Merging them would
 * give one effect where half the controls do nothing in either configuration.
 */
export function drawEllipse(
  oc: CanvasRenderingContext2D,
  w: number,
  h: number,
  centerX: number,
  centerY: number,
  width: number,
  height: number,
  rotation: number,
  thickness: number,
  softness: number,
  color: string,
  opacity: number,
  composite: number,
): void {
  const rx = Math.max(0, width / 2);
  const ry = Math.max(0, height / 2);
  const a = clamp01(opacity / 100);
  if (rx <= 0 || ry <= 0 || a <= 0) return;

  withComposite(oc, composite, () => {
    oc.save();
    oc.translate(w / 2 + centerX, h / 2 + centerY);
    oc.rotate((rotation * Math.PI) / 180);
    oc.strokeStyle = rgba(color, a);
    oc.lineWidth = Math.max(0.5, thickness);
    // Softness as a shadow on the stroke: a blur filter would soften the whole
    // canvas, and drawing N concentric strokes at falling alpha (the other
    // common trick) banks visibly at large softness.
    if (softness > 0) {
      oc.shadowColor = rgba(color, a);
      oc.shadowBlur = softness;
    }
    oc.beginPath();
    oc.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    oc.stroke();
    oc.restore();
  });
}

// ── Radio Waves ─────────────────────────────────────────────────────

/**
 * Radio Waves — concentric rings expanding from a point over time.
 *
 * `phase` drives the expansion, so keyframing it linearly emits a steady
 * stream. Each ring's radius is `((phase/360 + i) / count) · maxRadius` wrapped
 * into 0..1, which is what makes rings recycle seamlessly: ring `i` reaching
 * the edge is indistinguishable from a new ring leaving the centre, so the
 * animation loops with no pop.
 *
 * Rings fade with radius so the outermost dissolves rather than clipping at the
 * frame edge — the single thing that makes this read as a broadcast pulse
 * rather than as a stack of circles.
 */
export function drawRadioWaves(
  oc: CanvasRenderingContext2D,
  w: number,
  h: number,
  centerX: number,
  centerY: number,
  count: number,
  maxRadius: number,
  phase: number,
  thickness: number,
  color: string,
  opacity: number,
  fadeOut: number,
  composite: number,
): void {
  const n = Math.max(1, Math.min(64, Math.round(count)));
  const maxR = maxRadius > 0 ? maxRadius : Math.hypot(w, h) / 2;
  const a = clamp01(opacity / 100);
  if (a <= 0) return;
  const cx = w / 2 + centerX;
  const cy = h / 2 + centerY;
  const fade = clamp01(fadeOut / 100);

  withComposite(oc, composite, () => {
    oc.save();
    oc.lineWidth = Math.max(0.5, thickness);
    for (let i = 0; i < n; i++) {
      // Wrapped into 0..1 so a ring leaving the edge re-enters at the centre.
      const t = (((phase / 360) + i / n) % 1 + 1) % 1;
      const r = t * maxR;
      if (r <= 0.5) continue;
      const alpha = a * (1 - fade * t);
      if (alpha <= 0) continue;
      oc.strokeStyle = rgba(color, alpha);
      oc.beginPath();
      oc.arc(cx, cy, r, 0, Math.PI * 2);
      oc.stroke();
    }
    oc.restore();
  });
}

// ── Lightning ───────────────────────────────────────────────────────

/**
 * Lightning — a recursive midpoint-displaced bolt.
 *
 * The classic construction: take the segment, displace its midpoint
 * perpendicular by a random amount, recurse on both halves with the amount
 * halved. That self-similar falloff is what makes it look electrical rather
 * than like a jagged polyline.
 *
 * `seed` makes it DETERMINISTIC, which is not optional here. The renderer may
 * draw the same frame more than once (preview, then export, then a cache
 * refill), and a bolt built from `Math.random()` would differ every time —
 * making the layer's content hash useless and the export flicker. The generator
 * below is a tiny LCG seeded from `seed` and the recursion depth.
 */
export function drawLightning(
  oc: CanvasRenderingContext2D,
  w: number,
  h: number,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  detail: number,
  amplitude: number,
  branches: number,
  thickness: number,
  color: string,
  glow: number,
  opacity: number,
  seed: number,
  composite: number,
): void {
  const a = clamp01(opacity / 100);
  if (a <= 0) return;
  const depth = Math.max(1, Math.min(9, Math.round(detail)));

  // Deterministic PRNG — see the doc comment. Small, fast, and repeatable.
  let state = (Math.round(seed) * 1103515245 + 12345) >>> 0;
  const rand = (): number => {
    state = (state * 1103515245 + 12345) >>> 0;
    return state / 4294967296;
  };

  const x0 = w / 2 + startX, y0 = h / 2 + startY;
  const x1 = w / 2 + endX, y1 = h / 2 + endY;

  const bolt = (ax: number, ay: number, bx: number, by: number, amp: number, d: number, out: number[][]): void => {
    if (d <= 0) { out.push([ax, ay], [bx, by]); return; }
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    // Perpendicular displacement, symmetric about the segment.
    const off = (rand() - 0.5) * amp;
    const px = mx + (-dy / len) * off;
    const py = my + (dx / len) * off;
    bolt(ax, ay, px, py, amp / 2, d - 1, out);
    bolt(px, py, bx, by, amp / 2, d - 1, out);
  };

  const strokePath = (pts: number[][], width: number, alpha: number): void => {
    if (pts.length < 2) return;
    oc.strokeStyle = rgba(color, alpha);
    oc.lineWidth = Math.max(0.5, width);
    oc.lineJoin = 'round';
    oc.lineCap = 'round';
    oc.beginPath();
    oc.moveTo(pts[0]![0]!, pts[0]![1]!);
    for (let i = 1; i < pts.length; i++) oc.lineTo(pts[i]![0]!, pts[i]![1]!);
    oc.stroke();
  };

  withComposite(oc, composite, () => {
    oc.save();
    const main: number[][] = [];
    bolt(x0, y0, x1, y1, amplitude, depth, main);

    // Glow first, under the core, as a wide soft pass. Two strokes rather than
    // a shadow so the core stays crisp at any glow radius.
    if (glow > 0) strokePath(main, thickness + glow, a * 0.35);
    strokePath(main, thickness, a);

    const nb = Math.max(0, Math.min(12, Math.round(branches)));
    for (let i = 0; i < nb; i++) {
      // Branch off a random vertex, heading away at a shallow angle — real
      // lightning forks forward, so the branch inherits the main direction
      // rather than pointing anywhere.
      const idx = 1 + Math.floor(rand() * Math.max(1, main.length - 2));
      const p = main[idx]!;
      const prev = main[idx - 1]!;
      const dx = p[0]! - prev[0]!, dy = p[1]! - prev[1]!;
      const ang = Math.atan2(dy, dx) + (rand() - 0.5) * 1.2;
      const blen = Math.hypot(x1 - x0, y1 - y0) * (0.15 + rand() * 0.25);
      const sub: number[][] = [];
      bolt(p[0]!, p[1]!, p[0]! + Math.cos(ang) * blen, p[1]! + Math.sin(ang) * blen,
        amplitude * 0.5, Math.max(1, depth - 2), sub);
      if (glow > 0) strokePath(sub, thickness * 0.6 + glow * 0.5, a * 0.2);
      strokePath(sub, thickness * 0.6, a * 0.7);
    }
    oc.restore();
  });
}

// ── Light Rays ──────────────────────────────────────────────────────

/**
 * Light Rays — radial god-rays from a point.
 *
 * Drawn as a fan of tapered wedges rather than by the usual radial-blur-of-a-
 * threshold trick, because that trick needs the layer's own bright pixels and
 * this is a GENERATOR: it must produce rays on an empty layer too. `rayCount`
 * with a per-ray length jitter (deterministic, same reasoning as Lightning)
 * keeps the fan from looking mechanical.
 */
export function drawLightRays(
  oc: CanvasRenderingContext2D,
  w: number,
  h: number,
  centerX: number,
  centerY: number,
  rayCount: number,
  length: number,
  spread: number,
  rotation: number,
  color: string,
  opacity: number,
  falloff: number,
  seed: number,
  composite: number,
): void {
  const n = Math.max(1, Math.min(256, Math.round(rayCount)));
  const a = clamp01(opacity / 100);
  if (a <= 0 || length <= 0) return;
  const cx = w / 2 + centerX;
  const cy = h / 2 + centerY;
  const rot = (rotation * Math.PI) / 180;
  const arc = (clamp01(spread / 100) * Math.PI * 2) || Math.PI * 2;

  let state = (Math.round(seed) * 22695477 + 1) >>> 0;
  const rand = (): number => { state = (state * 22695477 + 1) >>> 0; return state / 4294967296; };

  withComposite(oc, composite, () => {
    oc.save();
    for (let i = 0; i < n; i++) {
      const ang = rot + (i / n) * arc - arc / 2 + (rand() - 0.5) * (arc / n) * 0.6;
      const len = length * (0.55 + rand() * 0.45);
      const halfWidth = (arc / n) * 0.35;
      // Alpha falls along the ray via a gradient, so the tip dissolves instead
      // of ending in a visible edge.
      const g = oc.createLinearGradient(cx, cy, cx + Math.cos(ang) * len, cy + Math.sin(ang) * len);
      g.addColorStop(0, rgba(color, a));
      g.addColorStop(clamp01(1 - falloff / 100), rgba(color, a * 0.35));
      g.addColorStop(1, rgba(color, 0));
      oc.fillStyle = g;
      oc.beginPath();
      oc.moveTo(cx, cy);
      oc.lineTo(cx + Math.cos(ang - halfWidth) * len, cy + Math.sin(ang - halfWidth) * len);
      oc.lineTo(cx + Math.cos(ang + halfWidth) * len, cy + Math.sin(ang + halfWidth) * len);
      oc.closePath();
      oc.fill();
    }
    oc.restore();
  });
}

// ── Light Sweep ─────────────────────────────────────────────────────

/**
 * Light Sweep — a moving specular band, the "shine" pass.
 *
 * `position` runs −100..200 so the band can start fully off one side and end
 * fully off the other; a 0..100 range would make the sweep pop in and out at
 * the extremes, which is exactly the frame where it is most visible.
 *
 * Defaults to `source-atop` composite so the shine is clipped to the layer it
 * is applied to — a sweep that spilled past the logo it is lighting would read
 * as a separate object.
 */
export function drawLightSweep(
  oc: CanvasRenderingContext2D,
  w: number,
  h: number,
  position: number,
  width: number,
  angle: number,
  color: string,
  intensity: number,
  softness: number,
  composite: number,
): void {
  const a = clamp01(intensity / 100);
  if (a <= 0 || width <= 0) return;
  const rad = (angle * Math.PI) / 180;
  // Sweep travels along the angle's normal, across the layer's full extent.
  const span = Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad));
  const t = position / 100;
  const cx = w / 2 + Math.cos(rad) * (t - 0.5) * span;
  const cy = h / 2 + Math.sin(rad) * (t - 0.5) * span;
  const half = width / 2;
  const soft = clamp01(softness / 100);

  withComposite(oc, composite, () => {
    oc.save();
    const g = oc.createLinearGradient(
      cx - Math.cos(rad) * half, cy - Math.sin(rad) * half,
      cx + Math.cos(rad) * half, cy + Math.sin(rad) * half,
    );
    // A soft-shouldered band: transparent, up to full at the centre, back down.
    // `softness` moves the shoulders toward the middle, so 0 is a hard bar and
    // 100 is a pure gaussian-ish falloff.
    g.addColorStop(0, rgba(color, 0));
    g.addColorStop(Math.max(0.001, 0.5 - 0.5 * (1 - soft)), rgba(color, a * 0.5));
    g.addColorStop(0.5, rgba(color, a));
    g.addColorStop(Math.min(0.999, 0.5 + 0.5 * (1 - soft)), rgba(color, a * 0.5));
    g.addColorStop(1, rgba(color, 0));
    oc.fillStyle = g;
    oc.fillRect(0, 0, w, h);
    oc.restore();
  });
}

// ── Audio Waveform ──────────────────────────────────────────────────

/**
 * Audio Waveform — the sample envelope as a line or bars.
 *
 * Distinct from Audio Spectrum, which is the FFT: a spectrum shows frequency
 * content at one instant, a waveform shows amplitude over TIME. They look
 * nothing alike and are used for different things, which is why AE ships both.
 *
 * `samples` are supplied by the render pipeline as a resolved param (the same
 * arrangement Audio Spectrum's `magnitudes` uses), because the values come from
 * decoding another layer every frame and there is no control that could
 * meaningfully edit them.
 *
 * `displayMode` 0 = line, 1 = mirrored bars, 2 = filled envelope.
 */
export function drawAudioWaveform(
  oc: CanvasRenderingContext2D,
  w: number,
  h: number,
  samples: ReadonlyArray<number>,
  displayMode: number,
  maxHeight: number,
  thickness: number,
  insideColor: string,
  outsideColor: string,
  opacity: number,
  composite: number,
): void {
  const a = clamp01(opacity / 100);
  if (a <= 0) return;
  const n = samples.length;
  // A silent or unwired source draws NOTHING rather than a flat line: a flat
  // line is indistinguishable from "wired up and silent", and the difference
  // is the first thing anyone debugging this needs to see.
  if (n < 2) return;

  const mid = h / 2;
  const amp = maxHeight / 2;
  const mode = Math.round(displayMode);

  withComposite(oc, composite, () => {
    oc.save();
    const g = oc.createLinearGradient(0, mid - amp, 0, mid + amp);
    g.addColorStop(0, rgba(outsideColor, a));
    g.addColorStop(0.5, rgba(insideColor, a));
    g.addColorStop(1, rgba(outsideColor, a));

    if (mode === 1) {
      oc.fillStyle = g;
      const bw = w / n;
      for (let i = 0; i < n; i++) {
        const v = Math.abs(samples[i] ?? 0);
        const bh = v * amp;
        oc.fillRect(i * bw, mid - bh, Math.max(1, bw * 0.8), bh * 2);
      }
    } else if (mode === 2) {
      oc.fillStyle = g;
      oc.beginPath();
      oc.moveTo(0, mid);
      for (let i = 0; i < n; i++) oc.lineTo((i / (n - 1)) * w, mid - (samples[i] ?? 0) * amp);
      // Back along the mirrored side, so the shape closes as an envelope
      // rather than as a wedge down to the baseline.
      for (let i = n - 1; i >= 0; i--) oc.lineTo((i / (n - 1)) * w, mid + (samples[i] ?? 0) * amp);
      oc.closePath();
      oc.fill();
    } else {
      oc.strokeStyle = g;
      oc.lineWidth = Math.max(0.5, thickness);
      oc.lineJoin = 'round';
      oc.beginPath();
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * w;
        const y = mid - (samples[i] ?? 0) * amp;
        if (i === 0) oc.moveTo(x, y); else oc.lineTo(x, y);
      }
      oc.stroke();
    }
    oc.restore();
  });
}
