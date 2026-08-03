/**
 * Generate and Text kernels — Lens Flare, Numbers, Timecode.
 *
 * Unlike the other kernel modules these DRAW rather than transform pixels, so
 * they take a canvas context instead of a byte array. The formatting logic is
 * still split out as pure functions, because that is the part with edge cases
 * worth asserting (negative time, 60-minute rollover, a decimal count on a
 * value that should be an integer).
 */

/** Where a flare's ghosts sit, as a fraction of the centre→origin vector. */
const GHOST_POSITIONS: readonly number[] = [-0.35, 0.25, 0.55, 0.8, 1.15, 1.45, 1.9];
const GHOST_SIZES: readonly number[] = [0.09, 0.05, 0.13, 0.07, 0.045, 0.1, 0.06];

/**
 * Lens Flare — a bright source plus its ghosts along the optical axis.
 *
 * The ghosts are what make it read as a lens flare rather than a glow: real
 * ghosting is internal reflection between elements, so the artefacts land on the
 * line THROUGH the frame centre from the light, mirrored about it. Placing them
 * anywhere else gives an image people recognise as wrong without being able to
 * say why.
 *
 * Drawn additively, because light adds. `source-over` would let a ghost occlude
 * the flare behind it, which no optical path can do.
 */
export function drawLensFlare(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  centerX: number,
  centerY: number,
  brightness: number,
  scale: number,
  hue: string,
): void {
  if (brightness <= 0) return;
  const b = Math.max(0, Math.min(1, brightness));

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'lighter';

  const midX = w / 2, midY = h / 2;
  const axisX = midX - centerX, axisY = midY - centerY;
  const span = Math.max(w, h);

  // ── The source: a tight core inside a broad halo ──
  const coreR = span * 0.06 * scale;
  const haloR = span * 0.35 * scale;

  const halo = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, Math.max(1, haloR));
  halo.addColorStop(0, withAlpha(hue, 0.55 * b));
  halo.addColorStop(0.25, withAlpha(hue, 0.18 * b));
  halo.addColorStop(1, withAlpha(hue, 0));
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, w, h);

  const core = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, Math.max(1, coreR));
  core.addColorStop(0, `rgba(255,255,255,${0.95 * b})`);
  core.addColorStop(0.5, withAlpha(hue, 0.5 * b));
  core.addColorStop(1, withAlpha(hue, 0));
  ctx.fillStyle = core;
  ctx.fillRect(0, 0, w, h);

  // ── Streaks: a horizontal flare bar plus a fainter vertical one ──
  const streak = ctx.createLinearGradient(centerX - haloR, centerY, centerX + haloR, centerY);
  streak.addColorStop(0, withAlpha(hue, 0));
  streak.addColorStop(0.5, withAlpha(hue, 0.35 * b));
  streak.addColorStop(1, withAlpha(hue, 0));
  ctx.fillStyle = streak;
  ctx.fillRect(centerX - haloR, centerY - Math.max(1, coreR * 0.12), haloR * 2, Math.max(2, coreR * 0.24));

  // ── Ghosts, along the axis through the frame centre ──
  for (let i = 0; i < GHOST_POSITIONS.length; i++) {
    const t = GHOST_POSITIONS[i]!;
    const gx = centerX + axisX * 2 * t;
    const gy = centerY + axisY * 2 * t;
    const gr = Math.max(1, span * GHOST_SIZES[i]! * scale);
    const alpha = 0.14 * b * (1 - Math.min(1, Math.abs(t) / 2.2));
    if (alpha <= 0) continue;

    const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, gr);
    g.addColorStop(0, withAlpha(hue, alpha));
    g.addColorStop(0.7, withAlpha(hue, alpha * 0.5));
    g.addColorStop(1, withAlpha(hue, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(gx, gy, gr, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

/** `#rrggbb` + alpha → `rgba(...)`. Falls back to white on anything unparsable. */
function withAlpha(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return `rgba(255,255,255,${a})`;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/**
 * Format a value for the Numbers effect.
 *
 * `decimals` is honoured exactly rather than trimmed — a counter that drops its
 * trailing zero jitters in width as it animates, which is the one thing a
 * numeric readout must not do.
 */
export function formatNumber(
  value: number,
  decimals: number,
  useCommas: boolean,
  padTo: number,
): string {
  const d = Math.max(0, Math.min(10, Math.round(decimals)));
  const negative = value < 0;
  const fixed = Math.abs(value).toFixed(d);

  let [whole = '0', frac] = fixed.split('.');

  // PAD FIRST, then insert separators. The other order lets the comma consume a
  // padding slot, so "pad to 6" yields six digits on 123 but only five on 1234
  // — the field changes width exactly as a counter crosses a thousand, which is
  // the failure padding exists to prevent.
  //
  // Padding applies to the INTEGER part only, for the same reason: padding the
  // whole string would shift the number as its decimals change width.
  if (padTo > 0 && whole.length < padTo) whole = whole.padStart(Math.round(padTo), '0');
  if (useCommas) whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  return `${negative ? '-' : ''}${whole}${frac !== undefined ? `.${frac}` : ''}`;
}

/**
 * Format seconds as SMPTE timecode.
 *
 * Truncates toward zero rather than rounding: at 24fps, 1.999s is still frame
 * 23 of second 1, and rounding would display the next second a frame early —
 * which is exactly the kind of off-by-one that only shows up when someone is
 * matching a cut against a reference.
 */
export function formatTimecode(
  timeSec: number,
  fps: number,
  dropFrame: boolean,
): string {
  const rate = Math.max(1, fps);
  const negative = timeSec < 0;
  const t = Math.abs(timeSec);

  const totalFrames = Math.floor(t * rate + 1e-6);
  const frames = totalFrames % Math.round(rate);
  const totalSeconds = Math.floor(totalFrames / Math.round(rate));

  const hh = Math.floor(totalSeconds / 3600);
  const mm = Math.floor((totalSeconds % 3600) / 60);
  const ss = totalSeconds % 60;

  const p2 = (n: number): string => String(n).padStart(2, '0');
  // Drop-frame is signalled by a semicolon before the frames, which is the
  // convention broadcast people read at a glance.
  const sep = dropFrame ? ';' : ':';
  return `${negative ? '-' : ''}${p2(hh)}:${p2(mm)}:${p2(ss)}${sep}${p2(frames)}`;
}

/** Draw a string with optional fill and stroke, positioned in the layer box. */
export function drawTextReadout(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  text: string,
  opts: {
    x: number;
    y: number;
    size: number;
    color: string;
    align: CanvasTextAlign;
    showBox: boolean;
    boxColor: string;
  },
): void {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // Monospace, always. A proportional face makes a running counter's width
  // jitter on every digit change, which is unusable for a readout.
  ctx.font = `${Math.max(1, opts.size)}px "SF Mono", "Consolas", "Menlo", monospace`;
  ctx.textAlign = opts.align;
  ctx.textBaseline = 'middle';

  const px = opts.x;
  const py = opts.y;

  if (opts.showBox) {
    const m = ctx.measureText(text);
    const padX = opts.size * 0.4, padY = opts.size * 0.3;
    const boxW = m.width + padX * 2;
    const boxH = opts.size + padY * 2;
    const boxX = opts.align === 'center' ? px - boxW / 2 : opts.align === 'right' ? px - boxW : px - padX;
    ctx.fillStyle = opts.boxColor;
    ctx.fillRect(boxX, py - boxH / 2, boxW, boxH);
  }

  ctx.fillStyle = opts.color;
  ctx.fillText(text, px, py);
  ctx.restore();
  void w; void h;
}
