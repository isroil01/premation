/**
 * Video scopes — waveform, RGB parade, vectorscope and histogram.
 *
 * Pure functions over an RGBA byte buffer (an `ImageData.data`, straight
 * alpha). Nothing here touches the DOM except the `draw*` half, which only
 * ever writes into a 2D context the caller hands it — no element lookups, no
 * stores, no timers. That split is deliberate: the accumulators are the part
 * that has to be *correct* (and is unit-testable in a plain Node environment),
 * and the painters are the part that has to be *pretty*.
 *
 * ## Why accumulate rather than draw per pixel
 *
 * A 1080p frame is two million pixels. Drawing one mark per pixel into a 2D
 * context at 10 Hz is not a scope, it is a stall. So every scope reduces the
 * frame to a small integer histogram FIRST — a `Uint32Array` of hit counts —
 * and the painter's cost then depends only on the size of the panel, not on
 * the size of the comp. The accumulators are also what makes the traces read
 * correctly: a scope's brightness is *density*, and density is a count.
 *
 * ## Downsampling
 *
 * Input is point-sampled on a stride so no more than {@link SCOPE_SAMPLE_WIDTH}
 * columns are ever visited (and the same stride is used vertically, so the
 * sampling stays isotropic). Point sampling, not box filtering, and that is the
 * right choice for a scope specifically: averaging neighbours INVENTS code
 * values that are not in the frame, which is exactly the thing an engineer
 * opens a scope to rule out. A stride shows fewer real pixels; a box filter
 * shows pixels that were never there.
 *
 * ## Colour science
 *
 * Rec.709 throughout — luma coefficients and the chroma plane both. The
 * vectorscope's 75 % graticule targets are DERIVED from the same conversion
 * (see {@link VECTORSCOPE_TARGETS_75}) rather than typed in from a datasheet,
 * so the targets and the trace can never disagree about what "red" means.
 *
 * Note that 709 target angles are NOT the 601 angles printed on a hardware
 * vectorscope's faceplate (Mg lands near 50° here rather than 61°, G near 230°
 * rather than 241°). That is not an error: those faceplates are 601 graticules,
 * and a 709 signal read against them is the thing that is wrong.
 */

// ── Sampling ─────────────────────────────────────────────────────────

/** No accumulation ever visits more columns than this. */
export const SCOPE_SAMPLE_WIDTH = 320;

/** Code values per axis — 8-bit, so 256 bins and no rebinning. */
export const SCOPE_BINS = 256;

/** Stride that brings `width` down to at most {@link SCOPE_SAMPLE_WIDTH}. */
export function sampleStep(width: number): number {
  if (!(width > 0)) return 1;
  return Math.max(1, Math.ceil(width / SCOPE_SAMPLE_WIDTH));
}

/** Columns an accumulation over `width` will produce. */
export function sampledColumns(width: number): number {
  if (!(width > 0)) return 0;
  return Math.ceil(width / sampleStep(width));
}

// ── Colour ───────────────────────────────────────────────────────────

/** Rec.709 luma coefficients. */
export const REC709_LUMA = { r: 0.2126, g: 0.7152, b: 0.0722 } as const;

/**
 * Chroma plane scale factors — the divisors that put Cb/Cr in ±0.5 for
 * full-range RGB in 0..1. `2 * (1 - Kb)` and `2 * (1 - Kr)`.
 */
export const REC709_CB_SCALE = 2 * (1 - REC709_LUMA.b);
export const REC709_CR_SCALE = 2 * (1 - REC709_LUMA.r);

/** Rec.709 luma of an 8-bit RGB triple, as an 8-bit code value (unrounded). */
export function luma709(r: number, g: number, b: number): number {
  return REC709_LUMA.r * r + REC709_LUMA.g * g + REC709_LUMA.b * b;
}

/** Rec.709 chroma of RGB in 0..1. Both components land in ±0.5. */
export function chroma709(r: number, g: number, b: number): { cb: number; cr: number } {
  const y = luma709(r, g, b);
  return { cb: (b - y) / REC709_CB_SCALE, cr: (r - y) / REC709_CR_SCALE };
}

// ── Accumulator shapes ───────────────────────────────────────────────

export interface ScopeOptions {
  /**
   * Skip pixels whose alpha is exactly 0.
   *
   * Off by default, because for a comp rendered over black those pixels ARE
   * black and belong in the reading. The viewport tap turns it on: what it
   * hands over is a crop of a canvas that can include letterbox outside the
   * comp rect, and letterbox is not picture.
   */
  ignoreTransparent?: boolean;
}

export interface WaveformOptions extends ScopeOptions {
  /** `luma` is one Rec.709 trace; `rgb` is three overlaid channel traces. */
  mode?: 'luma' | 'rgb';
}

/**
 * A column histogram: for every sampled column, how many pixels held each of
 * the 256 code values. Backs both the waveform and the parade — they are the
 * same measurement drawn two ways (overlaid vs. side by side), which is why
 * they share a type instead of duplicating the hot loop.
 */
export interface WaveformAccum {
  readonly kind: 'waveform' | 'parade';
  readonly mode: 'luma' | 'rgb';
  /** Sampled columns, ≤ {@link SCOPE_SAMPLE_WIDTH}. */
  readonly width: number;
  /** Always {@link SCOPE_BINS}. Index 0 is code 0 (black). */
  readonly height: number;
  /** 1 for `luma`, 3 for `rgb` (planes in R, G, B order). */
  readonly channels: number;
  /** `data[(channel * height + value) * width + column]`. */
  readonly data: Uint32Array;
  /** Largest cell count — a normalisation ceiling for painters. */
  readonly peak: number;
  /** Pixels accumulated (after downsampling and any alpha skip). */
  readonly total: number;
}

/** Chroma-plane hit counts on a square raster. */
export interface VectorscopeAccum {
  readonly kind: 'vectorscope';
  /** Edge length of the square raster. */
  readonly size: number;
  /** `data[y * size + x]`, y already flipped so +Cr is toward row 0. */
  readonly data: Uint32Array;
  readonly peak: number;
  readonly total: number;
}

/** Per-channel code-value distribution over the whole frame. */
export interface HistogramAccum {
  readonly kind: 'histogram';
  readonly bins: number;
  readonly r: Uint32Array;
  readonly g: Uint32Array;
  readonly b: Uint32Array;
  readonly luma: Uint32Array;
  /** Largest bin across R, G and B — the painter's vertical ceiling. */
  readonly peak: number;
  /** Pixels accumulated. Each of the four arrays sums to exactly this. */
  readonly total: number;
}

export type ScopeAccum = WaveformAccum | VectorscopeAccum | HistogramAccum;

// ── Vectorscope geometry ─────────────────────────────────────────────

/**
 * Chroma magnitude that reaches the edge of the vectorscope raster.
 *
 * Not 0.5. The largest chroma magnitude a full-range 709 signal can produce is
 * green/magenta at ~0.5957 — normalising on 0.5 would clip both of them off
 * the raster, and a scope that silently discards the two most saturated hues
 * it can be shown is worse than no scope. 0.6 clears the whole gamut with a
 * hair of margin.
 */
export const VECTORSCOPE_MAX_CHROMA = 0.6;

/** Default raster edge. 256 keeps one cell ≈ one code step at typical sizes. */
export const VECTORSCOPE_SIZE = 256;

/** Chroma → raster coordinates (floats; the caller floors). */
export function vectorscopeXY(
  cb: number,
  cr: number,
  size: number = VECTORSCOPE_SIZE,
): { x: number; y: number } {
  const radius = (size - 1) / 2;
  return {
    x: radius + (cb / VECTORSCOPE_MAX_CHROMA) * radius,
    // Screen y grows downward; +Cr (red) must point UP, as on every scope.
    y: radius - (cr / VECTORSCOPE_MAX_CHROMA) * radius,
  };
}

export interface VectorscopeTarget {
  /** Faceplate label. */
  readonly label: 'R' | 'Mg' | 'B' | 'Cy' | 'G' | 'Yl';
  readonly cb: number;
  readonly cr: number;
  /** Degrees CCW from the +Cb axis, 0..360 — the hue angle. */
  readonly angleDeg: number;
  /** `hypot(cb, cr)` — the saturation the target sits at. */
  readonly radius: number;
}

/** The six 75 % colour-bar primaries, in faceplate order. */
const BARS_75: ReadonlyArray<{ label: VectorscopeTarget['label']; rgb: readonly [number, number, number] }> = [
  { label: 'R', rgb: [0.75, 0, 0] },
  { label: 'Mg', rgb: [0.75, 0, 0.75] },
  { label: 'B', rgb: [0, 0, 0.75] },
  { label: 'Cy', rgb: [0, 0.75, 0.75] },
  { label: 'G', rgb: [0, 0.75, 0] },
  { label: 'Yl', rgb: [0.75, 0.75, 0] },
];

/**
 * Graticule targets for 75 % bars, derived from {@link chroma709}.
 *
 * Derived, not tabulated. A hand-typed table is a second source of truth for
 * the colour matrix, and the day someone corrects one of them the graticule
 * and the trace start disagreeing about where red is — with the graticule, the
 * thing the user trusts, being the wrong one.
 */
export const VECTORSCOPE_TARGETS_75: readonly VectorscopeTarget[] = BARS_75.map(({ label, rgb }) => {
  const { cb, cr } = chroma709(rgb[0], rgb[1], rgb[2]);
  const deg = (Math.atan2(cr, cb) * 180) / Math.PI;
  return { label, cb, cr, angleDeg: deg < 0 ? deg + 360 : deg, radius: Math.hypot(cb, cr) };
});

// ── Accumulation ─────────────────────────────────────────────────────

function clampCode(v: number): number {
  if (v <= 0) return 0;
  if (v >= 255) return 255;
  return Math.round(v);
}

function accumulateColumns(
  px: Uint8ClampedArray,
  width: number,
  height: number,
  kind: WaveformAccum['kind'],
  mode: WaveformAccum['mode'],
  ignoreTransparent: boolean,
): WaveformAccum {
  const channels = mode === 'rgb' ? 3 : 1;
  const cols = sampledColumns(width);
  const data = new Uint32Array(channels * SCOPE_BINS * Math.max(1, cols));
  if (cols === 0 || !(height > 0)) {
    return { kind, mode, width: 0, height: SCOPE_BINS, channels, data, peak: 0, total: 0 };
  }
  const step = sampleStep(width);
  const plane = SCOPE_BINS * cols;
  let peak = 0;
  let total = 0;

  const bump = (index: number): void => {
    const n = (data[index] ?? 0) + 1;
    data[index] = n;
    if (n > peak) peak = n;
  };

  for (let y = 0; y < height; y += step) {
    const row = y * width;
    let col = 0;
    for (let x = 0; x < width; x += step, col++) {
      const o = (row + x) * 4;
      if (ignoreTransparent && px[o + 3] === 0) continue;
      const r = px[o] ?? 0;
      const g = px[o + 1] ?? 0;
      const b = px[o + 2] ?? 0;
      total++;
      if (channels === 1) {
        bump(clampCode(luma709(r, g, b)) * cols + col);
      } else {
        bump(clampCode(r) * cols + col);
        bump(plane + clampCode(g) * cols + col);
        bump(2 * plane + clampCode(b) * cols + col);
      }
    }
  }

  return { kind, mode, width: cols, height: SCOPE_BINS, channels, data, peak, total };
}

/**
 * Waveform: code value against horizontal position.
 *
 * `mode: 'luma'` is the exposure tool (one Rec.709 trace); `mode: 'rgb'`
 * overlays the three channel traces in one plot, which is the fastest way to
 * see a colour cast — a neutral frame draws the three on top of each other.
 */
export function waveform(
  px: Uint8ClampedArray,
  width: number,
  height: number,
  opts: WaveformOptions = {},
): WaveformAccum {
  return accumulateColumns(px, width, height, 'waveform', opts.mode ?? 'luma', !!opts.ignoreTransparent);
}

/**
 * RGB parade: the same three channel traces as `waveform({mode:'rgb'})`, but
 * side by side rather than overlaid. Overlaid answers "is there a cast";
 * side by side answers "in which channel, and at which end of the range".
 */
export function parade(
  px: Uint8ClampedArray,
  width: number,
  height: number,
  opts: ScopeOptions = {},
): WaveformAccum {
  return accumulateColumns(px, width, height, 'parade', 'rgb', !!opts.ignoreTransparent);
}

/** Chroma-plane density: hue as angle, saturation as radius. */
export function vectorscope(
  px: Uint8ClampedArray,
  width: number,
  height: number,
  opts: ScopeOptions & { size?: number } = {},
): VectorscopeAccum {
  const size = Math.max(8, Math.round(opts.size ?? VECTORSCOPE_SIZE));
  const data = new Uint32Array(size * size);
  if (!(width > 0) || !(height > 0)) {
    return { kind: 'vectorscope', size, data, peak: 0, total: 0 };
  }
  const step = sampleStep(width);
  const ignoreTransparent = !!opts.ignoreTransparent;
  const last = size - 1;
  let peak = 0;
  let total = 0;

  for (let y = 0; y < height; y += step) {
    const row = y * width;
    for (let x = 0; x < width; x += step) {
      const o = (row + x) * 4;
      if (ignoreTransparent && px[o + 3] === 0) continue;
      const { cb, cr } = chroma709((px[o] ?? 0) / 255, (px[o + 1] ?? 0) / 255, (px[o + 2] ?? 0) / 255);
      const p = vectorscopeXY(cb, cr, size);
      // Clamped rather than dropped: an out-of-gamut pixel from a bad
      // conversion is exactly what the operator wants to SEE piled on the rim,
      // not something the scope should quietly decline to report.
      const px0 = Math.min(last, Math.max(0, Math.round(p.x)));
      const py0 = Math.min(last, Math.max(0, Math.round(p.y)));
      const i = py0 * size + px0;
      const n = (data[i] ?? 0) + 1;
      data[i] = n;
      if (n > peak) peak = n;
      total++;
    }
  }

  return { kind: 'vectorscope', size, data, peak, total };
}

/** Per-channel code-value distribution, plus a Rec.709 luma distribution. */
export function histogram(
  px: Uint8ClampedArray,
  width: number,
  height: number,
  opts: ScopeOptions = {},
): HistogramAccum {
  const r = new Uint32Array(SCOPE_BINS);
  const g = new Uint32Array(SCOPE_BINS);
  const b = new Uint32Array(SCOPE_BINS);
  const luma = new Uint32Array(SCOPE_BINS);
  if (!(width > 0) || !(height > 0)) {
    return { kind: 'histogram', bins: SCOPE_BINS, r, g, b, luma, peak: 0, total: 0 };
  }
  const step = sampleStep(width);
  const ignoreTransparent = !!opts.ignoreTransparent;
  let peak = 0;
  let total = 0;

  for (let y = 0; y < height; y += step) {
    const row = y * width;
    for (let x = 0; x < width; x += step) {
      const o = (row + x) * 4;
      if (ignoreTransparent && px[o + 3] === 0) continue;
      const cr8 = clampCode(px[o] ?? 0);
      const cg8 = clampCode(px[o + 1] ?? 0);
      const cb8 = clampCode(px[o + 2] ?? 0);
      const nr = (r[cr8] ?? 0) + 1; r[cr8] = nr;
      const ng = (g[cg8] ?? 0) + 1; g[cg8] = ng;
      const nb = (b[cb8] ?? 0) + 1; b[cb8] = nb;
      const cl = clampCode(luma709(cr8, cg8, cb8));
      luma[cl] = (luma[cl] ?? 0) + 1;
      if (nr > peak) peak = nr;
      if (ng > peak) peak = ng;
      if (nb > peak) peak = nb;
      total++;
    }
  }

  return { kind: 'histogram', bins: SCOPE_BINS, r, g, b, luma, peak, total };
}

// ── Painting ─────────────────────────────────────────────────────────

/**
 * Colours a painter uses. Every field is a CSS colour string so the panel can
 * fill it straight from `--color-*` tokens and the scopes follow the theme
 * without this module knowing a thing about themes.
 */
export interface ScopeTheme {
  background: string;
  graticule: string;
  graticuleStrong: string;
  label: string;
  luma: string;
  red: string;
  green: string;
  blue: string;
}

/** Used when a token cannot be resolved (tests, a detached canvas). */
export const DEFAULT_SCOPE_THEME: ScopeTheme = {
  background: '#0b0b0c',
  graticule: 'rgba(255,255,255,0.10)',
  graticuleStrong: 'rgba(255,255,255,0.22)',
  label: 'rgba(255,255,255,0.45)',
  luma: '#d5dbe5',
  red: '#ef5a6a',
  green: '#34c98e',
  blue: '#4d8dff',
};

/** Target surface, in DEVICE pixels (the panel scales for dpr itself). */
export interface ScopeViewport {
  width: number;
  height: number;
  /** Device pixel ratio — hairlines and label sizes multiply by it. */
  dpr: number;
}

type Rgb = readonly [number, number, number];

/** `#rgb`, `#rrggbb`, `rgb()` and `rgba()` → 8-bit triple. Black on failure. */
export function parseCssColor(value: string): Rgb {
  const s = value.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (hex?.[1]) {
    const h = hex[1];
    if (h.length === 3) {
      const r = h[0] ?? '0', g = h[1] ?? '0', b = h[2] ?? '0';
      return [parseInt(r + r, 16), parseInt(g + g, 16), parseInt(b + b, 16)];
    }
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (fn?.[1]) {
    const parts = fn[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return [
      Math.min(255, Math.max(0, Math.round(parts[0] ?? 0))),
      Math.min(255, Math.max(0, Math.round(parts[1] ?? 0))),
      Math.min(255, Math.max(0, Math.round(parts[2] ?? 0))),
    ];
  }
  return [0, 0, 0];
}

/**
 * How many hits saturate a trace cell.
 *
 * NOT `peak`. Normalising on the peak means a single flat area — a black bar,
 * a title card — sets a ceiling so high that everything else in the frame is
 * invisible, and the scope goes dark exactly when the picture gets simple. So
 * the reference is a fixed FRACTION of a column's height: a quarter of the
 * sampled rows landing in one cell is full brightness, and anything denser
 * simply clips, which is what a real scope's phosphor does anyway.
 */
function traceReference(total: number, columns: number, channels: number): number {
  if (columns <= 0 || channels <= 0) return 1;
  const rows = total / channels / columns;
  return Math.max(1, rows * 0.25);
}

/** Perceptual lift so a one-hit cell is visible rather than 1/255ths of one. */
function traceAlpha(count: number, reference: number): number {
  if (count <= 0) return 0;
  const t = count / reference;
  return t >= 1 ? 1 : Math.pow(t, 0.45);
}

interface TraceSource {
  data: Uint32Array;
  /** Start of this channel's plane inside `data`. */
  offset: number;
  cols: number;
  rows: number;
  /** True when row 0 of the source is the TOP of the plot (waveforms). */
  flipY: boolean;
}

/**
 * Additively composite one trace plane into `img` over the given rect.
 *
 * Writing pixels instead of issuing one `fillRect` per cell is the difference
 * between a scope that repaints in a millisecond and one that repaints in
 * fifty: a 320×256 accumulator is 81 920 cells, and 81 920 canvas draw calls
 * at 10 Hz is half a million state changes a second for a 200-pixel-wide box.
 */
function paintTrace(
  img: ImageData,
  rect: { x: number; y: number; w: number; h: number },
  src: TraceSource,
  color: Rgb,
  reference: number,
): void {
  const { data: out, width: iw, height: ih } = img;
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(iw, Math.ceil(rect.x + rect.w));
  const y1 = Math.min(ih, Math.ceil(rect.y + rect.h));
  if (x1 <= x0 || y1 <= y0 || src.cols <= 0 || src.rows <= 0) return;
  const spanX = rect.w > 0 ? rect.w : 1;
  const spanY = rect.h > 0 ? rect.h : 1;
  const [cr, cg, cb] = color;

  for (let y = y0; y < y1; y++) {
    const ty = (y + 0.5 - rect.y) / spanY;
    let sr = Math.floor(ty * src.rows);
    if (src.flipY) sr = src.rows - 1 - sr;
    if (sr < 0 || sr >= src.rows) continue;
    const rowBase = src.offset + sr * src.cols;
    const outRow = y * iw;
    for (let x = x0; x < x1; x++) {
      const tx = (x + 0.5 - rect.x) / spanX;
      const sc = Math.floor(tx * src.cols);
      if (sc < 0 || sc >= src.cols) continue;
      const a = traceAlpha(src.data[rowBase + sc] ?? 0, reference);
      if (a <= 0) continue;
      const o = (outRow + x) * 4;
      // Additive, so overlapping channel traces read as their sum — a neutral
      // column in RGB mode goes white, which is the whole point of the overlay.
      out[o] = Math.min(255, (out[o] ?? 0) + cr * a);
      out[o + 1] = Math.min(255, (out[o + 1] ?? 0) + cg * a);
      out[o + 2] = Math.min(255, (out[o + 2] ?? 0) + cb * a);
    }
  }
}

function fillBackground(img: ImageData, color: Rgb): void {
  const { data } = img;
  const [r, g, b] = color;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  }
}

function labelFont(dpr: number): string {
  const px = Math.max(8, Math.round(9 * dpr));
  return `${px}px ui-sans-serif, system-ui, sans-serif`;
}

function hairline(dpr: number): number {
  return Math.max(1, Math.round(dpr));
}

/** Left gutter reserved for the IRE / code-value scale. */
function gutterWidth(dpr: number): number {
  return Math.round(22 * dpr);
}

/** The five graticule stops every level scope shares, in 0..1 of full scale. */
const LEVEL_STOPS: readonly number[] = [0, 0.25, 0.5, 0.75, 1];

function strokeLevelGraticule(
  ctx: CanvasRenderingContext2D,
  theme: ScopeTheme,
  vp: ScopeViewport,
  plot: { x: number; y: number; w: number; h: number },
  withLabels: boolean,
): void {
  ctx.save();
  ctx.lineWidth = hairline(vp.dpr);
  ctx.font = labelFont(vp.dpr);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const stop of LEVEL_STOPS) {
    const y = Math.round(plot.y + (1 - stop) * plot.h) + 0.5;
    ctx.strokeStyle = stop === 0 || stop === 1 ? theme.graticuleStrong : theme.graticule;
    ctx.beginPath();
    ctx.moveTo(plot.x, y);
    ctx.lineTo(plot.x + plot.w, y);
    ctx.stroke();
    if (withLabels) {
      ctx.fillStyle = theme.label;
      ctx.fillText(String(Math.round(stop * 100)), plot.x - Math.round(4 * vp.dpr), y);
    }
  }
  ctx.restore();
}

/** Waveform (luma or RGB overlay). */
export function drawWaveform(
  ctx: CanvasRenderingContext2D,
  accum: WaveformAccum,
  theme: ScopeTheme,
  vp: ScopeViewport,
): void {
  if (vp.width < 2 || vp.height < 2) return;
  const pad = Math.round(3 * vp.dpr);
  const gutter = gutterWidth(vp.dpr);
  const plot = { x: gutter, y: pad, w: vp.width - gutter - pad, h: vp.height - 2 * pad };
  if (plot.w <= 0 || plot.h <= 0) return;

  const img = ctx.createImageData(vp.width, vp.height);
  fillBackground(img, parseCssColor(theme.background));
  const ref = traceReference(accum.total, accum.width, accum.channels);
  const plane = accum.height * accum.width;
  const colors: Rgb[] =
    accum.channels === 1
      ? [parseCssColor(theme.luma)]
      : [parseCssColor(theme.red), parseCssColor(theme.green), parseCssColor(theme.blue)];
  for (let c = 0; c < accum.channels; c++) {
    paintTrace(
      img,
      plot,
      { data: accum.data, offset: c * plane, cols: accum.width, rows: accum.height, flipY: true },
      colors[c] ?? [255, 255, 255],
      ref,
    );
  }
  ctx.putImageData(img, 0, 0);
  strokeLevelGraticule(ctx, theme, vp, plot, true);
}

/** RGB parade — three level plots side by side, R then G then B. */
export function drawParade(
  ctx: CanvasRenderingContext2D,
  accum: WaveformAccum,
  theme: ScopeTheme,
  vp: ScopeViewport,
): void {
  if (vp.width < 2 || vp.height < 2) return;
  const pad = Math.round(3 * vp.dpr);
  const gutter = gutterWidth(vp.dpr);
  const gap = Math.round(4 * vp.dpr);
  const total = vp.width - gutter - pad;
  const cellW = (total - 2 * gap) / 3;
  if (cellW <= 1) return;
  const top = pad;
  const h = vp.height - 2 * pad;

  const img = ctx.createImageData(vp.width, vp.height);
  fillBackground(img, parseCssColor(theme.background));
  const ref = traceReference(accum.total, accum.width, accum.channels);
  const plane = accum.height * accum.width;
  const colors: Rgb[] = [parseCssColor(theme.red), parseCssColor(theme.green), parseCssColor(theme.blue)];
  for (let c = 0; c < 3; c++) {
    paintTrace(
      img,
      { x: gutter + c * (cellW + gap), y: top, w: cellW, h },
      { data: accum.data, offset: c * plane, cols: accum.width, rows: accum.height, flipY: true },
      colors[c] ?? [255, 255, 255],
      ref,
    );
  }
  ctx.putImageData(img, 0, 0);

  // One labelled scale on the left, then an unlabelled graticule over each
  // cell — repeating "0 25 50 75 100" three times in a 200px panel is noise,
  // and the three cells share one vertical scale by definition.
  strokeLevelGraticule(ctx, theme, vp, { x: gutter, y: top, w: cellW, h }, true);
  for (let c = 1; c < 3; c++) {
    strokeLevelGraticule(ctx, theme, vp, { x: gutter + c * (cellW + gap), y: top, w: cellW, h }, false);
  }
}

/** Vectorscope with the 75 % colour-bar graticule. */
export function drawVectorscope(
  ctx: CanvasRenderingContext2D,
  accum: VectorscopeAccum,
  theme: ScopeTheme,
  vp: ScopeViewport,
): void {
  if (vp.width < 2 || vp.height < 2) return;
  const pad = Math.round(6 * vp.dpr);
  const edge = Math.min(vp.width, vp.height) - 2 * pad;
  if (edge <= 4) return;
  const ox = (vp.width - edge) / 2;
  const oy = (vp.height - edge) / 2;
  const cx = ox + edge / 2;
  const cy = oy + edge / 2;
  const half = edge / 2;
  /** Chroma magnitude → screen radius. */
  const toRadius = (m: number): number => (m / VECTORSCOPE_MAX_CHROMA) * half;

  const img = ctx.createImageData(vp.width, vp.height);
  fillBackground(img, parseCssColor(theme.background));
  // A vectorscope has no "columns"; its density reference is the whole sample
  // spread over the raster, so a flat frame (every pixel in one cell) clips and
  // a noisy one spreads — the same behaviour as a phosphor tube.
  const ref = Math.max(1, accum.total / Math.max(1, accum.size));
  paintTrace(
    img,
    { x: ox, y: oy, w: edge, h: edge },
    { data: accum.data, offset: 0, cols: accum.size, rows: accum.size, flipY: false },
    parseCssColor(theme.luma),
    ref,
  );
  ctx.putImageData(img, 0, 0);

  ctx.save();
  ctx.lineWidth = hairline(vp.dpr);
  ctx.strokeStyle = theme.graticule;
  // Saturation rings at the 0.5 chroma amplitude (nominal 100 %) and at 0.375,
  // which is where a 75 % bar's most saturated primaries land.
  for (const m of [0.5, 0.375]) {
    ctx.beginPath();
    ctx.arc(cx, cy, toRadius(m), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(cx - half, cy);
  ctx.lineTo(cx + half, cy);
  ctx.moveTo(cx, cy - half);
  ctx.lineTo(cx, cy + half);
  ctx.stroke();

  ctx.strokeStyle = theme.graticuleStrong;
  ctx.fillStyle = theme.label;
  ctx.font = labelFont(vp.dpr);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const box = Math.max(3, Math.round(3 * vp.dpr));
  for (const t of VECTORSCOPE_TARGETS_75) {
    const tx = cx + toRadius(t.cb);
    const ty = cy - toRadius(t.cr);
    ctx.strokeRect(tx - box, ty - box, box * 2, box * 2);
    // Label pushed outward along the target's own ray so it never sits on the
    // trace it is naming.
    const out = Math.round(9 * vp.dpr);
    const len = Math.max(1e-6, Math.hypot(t.cb, t.cr));
    ctx.fillText(t.label, tx + (t.cb / len) * out, ty - (t.cr / len) * out);
  }
  ctx.restore();
}

/** RGB histogram with a luma outline over it. */
export function drawHistogram(
  ctx: CanvasRenderingContext2D,
  accum: HistogramAccum,
  theme: ScopeTheme,
  vp: ScopeViewport,
): void {
  if (vp.width < 2 || vp.height < 2) return;
  const pad = Math.round(3 * vp.dpr);
  const plot = { x: pad, y: pad, w: vp.width - 2 * pad, h: vp.height - 2 * pad };
  if (plot.w <= 0 || plot.h <= 0) return;

  ctx.save();
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, vp.width, vp.height);

  ctx.lineWidth = hairline(vp.dpr);
  ctx.strokeStyle = theme.graticule;
  for (const stop of LEVEL_STOPS) {
    const x = Math.round(plot.x + stop * plot.w) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, plot.y);
    ctx.lineTo(x, plot.y + plot.h);
    ctx.stroke();
  }

  // Clipped at the 99.5th percentile rather than the true peak: one enormous
  // spike (a black matte, a blown highlight) otherwise flattens the entire
  // distribution into the baseline and the histogram says nothing at all.
  const ceiling = Math.max(1, softCeiling(accum));
  const bar = plot.w / accum.bins;
  const fillChannel = (bins: Uint32Array, color: string): void => {
    ctx.fillStyle = color;
    for (let i = 0; i < accum.bins; i++) {
      const v = Math.min(1, (bins[i] ?? 0) / ceiling);
      if (v <= 0) continue;
      const h = v * plot.h;
      ctx.fillRect(plot.x + i * bar, plot.y + plot.h - h, Math.max(1, bar), h);
    }
  };
  // `lighter` so overlapping channels sum to white where the frame is neutral —
  // the same reading as the waveform's RGB overlay.
  ctx.globalCompositeOperation = 'lighter';
  fillChannel(accum.r, theme.red);
  fillChannel(accum.g, theme.green);
  fillChannel(accum.b, theme.blue);
  ctx.globalCompositeOperation = 'source-over';

  ctx.strokeStyle = theme.luma;
  ctx.beginPath();
  for (let i = 0; i < accum.bins; i++) {
    const v = Math.min(1, (accum.luma[i] ?? 0) / ceiling);
    const x = plot.x + (i + 0.5) * bar;
    const y = plot.y + plot.h - v * plot.h;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  ctx.strokeStyle = theme.graticuleStrong;
  ctx.strokeRect(plot.x + 0.5, plot.y + 0.5, plot.w - 1, plot.h - 1);
  ctx.restore();
}

/**
 * A vertical ceiling that ignores the tallest handful of bins.
 *
 * Exported for the tests, and separate from `peak` because they answer
 * different questions: `peak` is a fact about the data, this is a display
 * decision about it.
 */
export function softCeiling(accum: HistogramAccum): number {
  const all: number[] = [];
  for (let i = 0; i < accum.bins; i++) {
    all.push(accum.r[i] ?? 0, accum.g[i] ?? 0, accum.b[i] ?? 0);
  }
  all.sort((a, b) => a - b);
  const idx = Math.min(all.length - 1, Math.max(0, Math.floor(all.length * 0.995)));
  return Math.max(1, all[idx] ?? 1);
}

/** Dispatch to the right painter for whatever accumulator you have. */
export function drawScope(
  ctx: CanvasRenderingContext2D,
  accum: ScopeAccum,
  theme: ScopeTheme,
  vp: ScopeViewport,
): void {
  switch (accum.kind) {
    case 'waveform':
      drawWaveform(ctx, accum, theme, vp);
      return;
    case 'parade':
      drawParade(ctx, accum, theme, vp);
      return;
    case 'vectorscope':
      drawVectorscope(ctx, accum, theme, vp);
      return;
    case 'histogram':
      drawHistogram(ctx, accum, theme, vp);
      return;
  }
}
