/**
 * AppTextureProvider — the app-side `TextureProvider` for the GPU @motion/renderer
 * path (S2 of the Canvas2D→GPU swap). It resolves a renderable's `textureKey`
 * (`asset:<id>` for image/video, `text:<id>` for text) to a real GPU texture.
 *
 * The renderer's passes call `get(key)` synchronously mid-frame, but image decode
 * is async, so the flow is:
 *   1. Each frame, MotionRendererBackend feeds current sources via `setImage`.
 *   2. `get` returns the decoded texture once ready, else a shared 1×1 white
 *      placeholder (so a box still shows while loading — matching Canvas2D — and
 *      no textured layer ever silently vanishes).
 *   3. When a decode completes we flip the entry to ready and fire `onChange`,
 *      which the app turns into a re-render so the real pixels appear next frame.
 *
 * Text rasterizes synchronously with the layer's full font (family/weight/style/
 * size, letter spacing, alignment, multi-line) — parity with Canvas2DBackend,
 * verified with real pixels through the WebGL2 backend. Video resolves to the
 * placeholder until the element decodes a frame. (Per-glyph text animators
 * remain Canvas2D-only — a documented gap, not part of font styling.)
 */

import type {
  ResourceManager,
  ResolvedTexture,
  TextureProvider,
  TextureHandle,
  SamplerHandle,
} from '@motion/renderer';
import type { RenderLayer } from './RenderBackend';
import { makeCanvasGradient, type LinearFill, type RadialFill } from '@core/paint/fill';
import { rasterPadding } from './raster/vectorDraw';
import { resolutionTier, paddingClass, continuousResolutionTier, DEFAULT_MAX_RASTER_DIMENSION } from '@motion/renderer';
import { Canvas2DVectorRasterizer } from './raster/Canvas2DVectorRasterizer';
import { type RichRun } from '@core/text/textLayout';
import { effectsNeedCpuBake } from '@core/effects/effectBake';
import { drawParticleField, particleFieldSignature } from '@core/particles/particleRender';
import type { ParticleConfig } from '@core/particles/particleSim';
import { isLocalBlobRef, loadLocalBlobObjectUrl } from './localBlobSource';

interface PathEntry {
  kind: 'path';
  signature: string;
  texture: TextureHandle;
}

interface MaskEntry {
  kind: 'mask';
  signature: string;
  texture: TextureHandle;
}

/** Decodes a source URL to something the GPU can upload. Injectable for tests. */
export type ImageLoader = (src: string, fillColor?: string) => Promise<ImageBitmap>;

const RASTER_MAX = 4096;

/**
 * Decode options for EVERY bitmap that becomes a GPU texture.
 *
 * THE ALPHA INVARIANT (stated in full on `TextureSource`,
 * packages/renderer/src/gpu/types.ts): textures hold STRAIGHT alpha.
 *
 * This is the half of it the backends cannot do themselves.
 * `createImageBitmap`'s default is `'default'`, which in Chromium means
 * PREMULTIPLIED — and WebGL2's `UNPACK_PREMULTIPLY_ALPHA_WEBGL` can only
 * multiply, never divide, so a premultiplied bitmap stays premultiplied however
 * the unpack flags are set. Asking for straight at DECODE is the only place the
 * conversion can happen on that backend.
 *
 * It also has to be on every call, not most: a single loader path left at the
 * default would premultiply exactly the formats that take that path (the
 * `<img>` fallback handles GIF/WebP/exotic types) and leave a backend-specific
 * fringe on those files alone.
 *
 * Proven by: packages/render-tests/scripts/verify-alpha.mjs
 * (`a straight source composites LINEARLY in alpha`).
 */
const STRAIGHT_ALPHA: ImageBitmapOptions = { premultiplyAlpha: 'none' };

/** Draw an already-decoded <img> to a canvas at w×h and hand back a bitmap. */
async function imageToBitmap(img: HTMLImageElement, w: number, h: number): Promise<ImageBitmap> {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.min(RASTER_MAX, Math.round(w)));
  canvas.height = Math.max(1, Math.min(RASTER_MAX, Math.round(h)));
  const ctx = canvas.getContext('2d');
  if (!ctx) return createImageBitmap(img, STRAIGHT_ALPHA);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return createImageBitmap(canvas, STRAIGHT_ALPHA);
}

/**
 * Faithfully rasterize an SVG. The browser draws the vector exactly as authored
 * — gradients, text, clips, embedded raster, filters — none of which the shape
 * parser could reproduce. We fetch the source, inject explicit `width`/`height`
 * (derived from the existing size or the viewBox aspect) so the <img> can't
 * letterbox a viewBox-only file into its bogus 300×150 default, then draw it to
 * a canvas. This also sidesteps Chromium's flaky `createImageBitmap(svgBlob)`.
 */
export function decodeSvgDataUrl(src: string): string {
  const comma = src.indexOf(',');
  const meta = src.slice(0, comma);
  const body = src.slice(comma + 1);
  if (!/;base64/i.test(meta)) return decodeURIComponent(body);
  // `atob` yields one char per BYTE, not per character — feeding that straight
  // to the parser renders every non-ASCII glyph as mojibake (`안녕` → `ìêµ`).
  // SVG data URLs are UTF-8, so the bytes have to be decoded as UTF-8.
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

async function rasterizeSvg(src: string, fillColor?: string): Promise<ImageBitmap> {
  // `data:` SVGs are decoded inline — the app's CSP `connect-src` forbids
  // fetch(data:), and there's no need to round-trip through the network anyway.
  const text = src.startsWith('data:') ? decodeSvgDataUrl(src) : await (await fetch(src)).text();
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const svg = doc.documentElement;

  if (fillColor && fillColor !== 'none' && fillColor !== 'transparent') {
    const styleEl = doc.createElementNS('http://www.w3.org/2000/svg', 'style');
    styleEl.textContent = `path, circle, rect, polygon, polyline, ellipse, text { fill: ${fillColor} !important; }`;
    svg.appendChild(styleEl);
  }

  const parseLen = (v: string | null): number => {
    if (!v) return 0;
    const n = parseFloat(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  let w = parseLen(svg.getAttribute('width'));
  let h = parseLen(svg.getAttribute('height'));
  const vb = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
  const vbW = vb.length === 4 && vb[2]! > 0 ? vb[2]! : 0;
  const vbH = vb.length === 4 && vb[3]! > 0 ? vb[3]! : 0;
  if ((!w || !h) && vbW && vbH) {
    if (w && !h) h = (w * vbH) / vbW;
    else if (h && !w) w = (h * vbW) / vbH;
    else { w = vbW; h = vbH; }
  }
  if (!w || !h) { w = 512; h = 512; }

  // Rasterize crisply, preserving aspect. SVG is resolution-independent, so a
  // small intrinsic size (a 24px icon, a 200px logo) must NOT dictate the raster
  // size — otherwise scaling the layer up in the scene reveals a blurry, low-res
  // texture. Target a generous 2048px long edge so enlarged SVGs stay sharp,
  // bounded by RASTER_MAX (4096) and never downscaling a source that's smaller.
  const SVG_TARGET_LONG = 2048;
  const longEdge = Math.max(w, h);
  const targetLong = Math.min(RASTER_MAX, Math.max(longEdge, SVG_TARGET_LONG));
  const scale = targetLong / longEdge;
  const rw = Math.max(1, Math.min(RASTER_MAX, Math.round(w * scale)));
  const rh = Math.max(1, Math.min(RASTER_MAX, Math.round(h * scale)));
  svg.setAttribute('width', String(rw));
  svg.setAttribute('height', String(rh));
  if (!svg.getAttribute('viewBox') && vbW === 0) svg.setAttribute('viewBox', `0 0 ${w} ${h}`);

  const serialized = new XMLSerializer().serializeToString(svg);
  const url = URL.createObjectURL(new Blob([serialized], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return await imageToBitmap(img, rw, rh);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Decode the first frame of any browser-displayable format (GIF/WebP/exotic). */
async function rasterizeViaImage(src: string): Promise<ImageBitmap> {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = src;
  await img.decode();
  return imageToBitmap(img, img.naturalWidth || 512, img.naturalHeight || 512);
}

/** True when the blob/data URL is an SVG. */
function isSvgBlob(blob: Blob, src: string): boolean {
  return blob.type === 'image/svg+xml' || /^data:image\/svg\+xml/i.test(src) || /\.svg(\?|#|$)/i.test(src);
}

const defaultLoader: ImageLoader = async (src, fillColor) => {
  // Local-first asset (`motion-blob:<hash>`): resolve bytes from the bundle blob
  // store to a temporary object URL, decode it, then revoke. No network — the
  // bytes are already on disk.
  if (isLocalBlobRef(src)) {
    const url = await loadLocalBlobObjectUrl(src);
    if (!url) return rasterizeViaImage(src); // resolver missing → let <img> try (and fail visibly)
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      if (isSvgBlob(blob, src)) return await rasterizeSvg(url, fillColor);
      try {
        return await createImageBitmap(blob, STRAIGHT_ALPHA);
      } catch {
        return await rasterizeViaImage(url);
      }
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  // Inline SVG (UI Kit components, etc.) — decode directly; fetch(data:) is
  // CSP-blocked and createImageBitmap can't handle SVG anyway.
  if (/^data:image\/svg\+xml/i.test(src)) return rasterizeSvg(src, fillColor);
  let blob: Blob;
  try {
    const res = await fetch(src);
    blob = await res.blob();
  } catch {
    // Unfetchable — let the <img> element try directly.
    return rasterizeViaImage(src);
  }
  // SVG must be rasterized explicitly: createImageBitmap on an SVG blob is
  // unreliable in Chromium and is the reason uploaded SVGs rendered broken.
  if (isSvgBlob(blob, src)) return rasterizeSvg(src, fillColor);
  try {
    return await createImageBitmap(blob, STRAIGHT_ALPHA);
  } catch {
    // GIF/WebP/exotic types createImageBitmap chokes on — fall back to <img>,
    // which decodes the first frame of any format the browser can display.
    return rasterizeViaImage(src);
  }
};

interface ImageEntry {
  kind: 'image';
  src: string;
  texture: TextureHandle | null;
  bitmap: ImageBitmap | null;
  width: number;
  height: number;
  ready: boolean;
}

/** What a text layer needs rasterized: string + full font + colour + box size.
 *  The font fields mirror `RenderLayer`'s text props so the GPU raster matches
 *  Canvas2DBackend's text exactly (was: hardcoded 600 Inter, centred). */
export interface TextSpec {
  text: string;
  /** 0..1; fades the glyphs but not the layer styles. See applyEffectChain. */
  fillOpacity?: number;
  fontSize: number;
  color: string;
  width: number;
  height: number;
  scaleX?: number;
  scaleY?: number;
  /** Continuous Rasterization — see `RenderLayer.continuousRaster`. Threaded
   *  here because the text path sizes its own raster and once silently dropped
   *  a scale field it was handed. */
  continuousRaster?: boolean;
  fontFamily?: string;
  fontWeight?: string;
  fontStyle?: string;
  /** 'left' | 'center' | 'right' | 'justify' — horizontal anchor in the box. */
  align?: string;
  letterSpacing?: number;
  /** Multiple of font size between lines (defaults 1.2). */
  lineHeight?: number;
  /** Extra px between paragraphs (every newline starts one). */
  paragraphSpacing?: number;
  /** Paint the per-glyph stroke over the fill rather than under it. */
  strokeOverFill?: boolean;
  /** Per-character style overrides. Free on the GPU path: the runs are baked
   *  into the texture, so the shader never learns text had more than one font. */
  runs?: ReadonlyArray<RichRun>;
  /**
   * Per-glyph transforms from the layer's text animators.
   *
   * Was computed by buildSnapshot and then DROPPED here: `setText` never passed
   * it on, so `drawText` never saw it and every 2D text animator rendered
   * exactly nothing. (Per-character-3D text escaped, because buildSnapshot
   * splits those into one layer per glyph before this point.) Presence forces
   * the glyph-by-glyph draw.
   */
  glyphs?: ReadonlyArray<import('@core/text/textAnimators').GlyphTransform>;
  /** Text riding a mask path, already flattened to a polyline in layer-local
   *  space by buildSnapshot. Dropped at the same seam as `glyphs`, for the same
   *  reason. */
  textPath?: {
    points: ReadonlyArray<{ x: number; y: number }>;
    closed: boolean;
    firstMargin: number;
    reversed: boolean;
    perpendicular: boolean;
  };
  /** A Canvas2D-only effect stack (Fill/Stroke/Sharpen/Noise/…) baked into the
   *  text texture — those effects have no GPU shader form. Undefined when the
   *  layer has none (the common case). */
  effects?: ReadonlyArray<import('@core/effects/effects').Effect>;
  /** The layer's mask, baked before the effects (AE order) when baking. */
  mask?: import('@core/effects/mask').LayerMask;
}

/** The CSS `font` shorthand for a text spec — identical to the string
 *  Canvas2DBackend builds, so both backends resolve the same face. */
export function textCssFont(spec: Pick<TextSpec, 'fontSize' | 'fontFamily' | 'fontWeight' | 'fontStyle'>): string {
  const style = spec.fontStyle === 'italic' ? 'italic ' : '';
  const weight = spec.fontWeight ?? '600';
  const family = spec.fontFamily ?? 'Inter';
  return `${style}${weight} ${spec.fontSize}px "${family}", Inter, system-ui, sans-serif`;
}

interface TextEntry {
  kind: 'text';
  signature: string;
  texture: TextureHandle;
}

interface LightEntry {
  kind: 'light';
  signature: string;
  texture: TextureHandle;
}

interface GradientEntry {
  kind: 'gradient';
  signature: string;
  texture: TextureHandle;
}

interface LutEntry {
  kind: 'lut';
  signature: string;
  texture: TextureHandle;
}

/** Fixed raster size for a light's radial-gradient texture — scale-invariant, so
 *  the renderable stretches this to the light's actual 2·radius box. */
const LIGHT_TEX_SIZE = 128;

/** Longest edge of a baked gradient-background texture. Gradients are smooth
 *  (low-frequency), so a modest raster upscales across the comp quad with no
 *  visible banding, while keeping the upload cheap. */
const GRADIENT_TEX_MAX = 512;

/** Creates the HTMLVideoElement backing a video layer. Injectable for tests. */
export type VideoFactory = (src: string) => HTMLVideoElement;

const defaultVideoFactory: VideoFactory = (src) => {
  const v = document.createElement('video');
  v.muted = true;
  v.autoplay = false;
  v.loop = true;
  v.crossOrigin = 'anonymous';
  v.playsInline = true;
  v.preload = 'auto';
  v.src = src;
  v.load();
  return v;
};

interface VideoEntry {
  kind: 'video';
  src: string;
  video: HTMLVideoElement;
  texture: TextureHandle | null;
  w: number;
  h: number;
  /**
   * True once this element has completed (or at least requested) one seek.
   *
   * A loaded-but-never-seeked `<video>` presents a black surface, so the first
   * upload must always be preceded by a seek even when the requested time already
   * equals `currentTime`. See setVideo.
   */
  hasSeeked: boolean;
  /** Kept so `releaseVideoEntry` can detach it — an anonymous handler could not
   *  be removed, and it drives renders via `onChange`. */
  onSeeked?: (() => void) | undefined;
  /** ResourceManager pool key of `texture`, so it can actually be freed. */
  poolKey?: string | undefined;
  /** Last time we ASKED the element to seek to (not where it landed). Breaks the
   *  seek → render → seek feedback loop; see setVideo. */
  requestedTime: number | null;
}

interface ParticleEntry {
  kind: 'particles';
  signature: string;
  canvas: HTMLCanvasElement;
  texture: TextureHandle | null;
  w: number;
  h: number;
}

/** Longest edge of a rasterized particle field (device px). Fields are soft
 *  (round sprites, additive glow), so capping the raster keeps per-frame
 *  uploads bounded while staying visually lossless at export sizes. */
const PARTICLE_TEX_MAX = 4096;



/** HTMLMediaElement.HAVE_CURRENT_DATA — enough decoded to sample a frame. */
const HAVE_CURRENT_DATA = 2;
/** Only re-seek a video when the playhead drifts past this (seconds). */
const SEEK_EPSILON = 0.05;
/**
 * How far past the target the FIRST seek of a video goes, in seconds.
 *
 * Assigning `currentTime` a value it already holds is a no-op that fires no
 * `seeked` event, so a video sitting at 0 asked to show 0 would never decode.
 * 0.5 ms is orders of magnitude inside a single frame at any frame rate, so the
 * decoded frame is still the correct one.
 */
const FIRST_DECODE_NUDGE = 0.0005;

export class AppTextureProvider implements TextureProvider {
  /** Fired when an async decode finishes and a texture becomes ready. */
  onChange: (() => void) | null = null;

  private exactMediaTiming = false;
  private mediaWaits: Promise<void>[] = [];

  setExactMediaTiming(on: boolean): void {
    this.exactMediaTiming = on;
    if (!on) this.mediaWaits = [];
  }

  takeMediaWaits(): Promise<void>[] {
    const out = this.mediaWaits;
    this.mediaWaits = [];
    return out;
  }

  private static eventWait(el: EventTarget, event: string, timeoutMs = 4000): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = (): void => {
        el.removeEventListener(event, done);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      el.addEventListener(event, done);
    });
  }

  private readonly entries = new Map<string, ImageEntry>();
  private readonly textEntries = new Map<string, TextEntry>();
  private readonly videoEntries = new Map<string, VideoEntry>();
  private readonly pathEntries = new Map<string, PathEntry>();
  private readonly maskEntries = new Map<string, MaskEntry>();
  private readonly lightEntries = new Map<string, LightEntry>();
  private readonly gradientEntries = new Map<string, GradientEntry>();
  private readonly lutEntries = new Map<string, LutEntry>();
  /** Externally-rasterized frames (decoded video frames for Frame Mix). */
  private readonly frameEntries = new Map<string, { signature: string; texture: TextureHandle; poolKey: string }>();
  private readonly particleEntries = new Map<string, ParticleEntry>();
  private readonly loader: ImageLoader;
  private readonly videoFactory: VideoFactory;
  private hasInitWhite = false;
  /** Device px per comp unit for THIS frame (view.scale × dpr). Vector rasters
   *  are sized at their box × resolutionTier(scale) × supersample, so a 4K
   *  export re-rasters at native instead of upscaling a viewport-res texture.
   *  Set once per frame by MotionRendererBackend before feeding layers. */
  private rasterScale = 1;

  /** Set the per-frame target device scale for vector rasterization. */
  setRasterScale(scale: number): void {
    this.rasterScale = scale > 0 && Number.isFinite(scale) ? scale : 1;
  }

  /**
   * The GPU's real maximum texture dimension, from backend capabilities.
   *
   * A hardware fact, not a policy: exceeding it fails the allocation outright,
   * and WebGL2 in particular can report as little as 4096. Kept as a setter
   * rather than read from `resources` so this class stays independent of which
   * backend is attached; the default is the conservative guarantee.
   */
  private maxRasterDimension = DEFAULT_MAX_RASTER_DIMENSION;

  setMaxRasterDimension(px: number): void {
    this.maxRasterDimension = px > 0 && Number.isFinite(px) ? px : DEFAULT_MAX_RASTER_DIMENSION;
  }

  /**
   * The tier to rasterize a drawable at: the clamped ladder by default, the
   * extended one when the layer opted into Continuous Rasterization.
   *
   * One helper for both the text and path paths so they cannot diverge — they
   * did once already, over the `deviceScale` the text path silently dropped.
   */
  private tierFor(scale: number, continuous: boolean | undefined, boxW: number, boxH: number): number {
    return continuous
      ? continuousResolutionTier(scale, boxW, boxH, undefined, this.maxRasterDimension)
      : resolutionTier(scale);
  }

  /**
   * What to hand the rasterizer as its draw scale.
   *
   * CR ON: the tier, so the pixels drawn and the cache key AGREE. CR OFF: the
   * raw effective scale, which is what this has always passed.
   *
   * Those two being different is a real, pre-existing defect and it is left
   * alone on the OFF path deliberately. `Canvas2DVectorRasterizer` draws at the
   * raw scale but keys on `resolutionTier(scale)`, which clamps at 4 — so above
   * 4× distinct scales collide on one key and whichever rasterized FIRST is
   * reused for all of them. Measured in rasterResolution.probe.test.ts: scale 6
   * produced 1200px, then scale 12 came back a cache hit at 1200px. The
   * user-visible symptom is that zooming past 4× stops re-rasterizing.
   *
   * It is not fixed here because every consistent fix changes the rendered
   * output of existing projects (quantizing the draw up makes rasters bigger,
   * down makes them softer) and today's behaviour is order-dependent, so there
   * is no byte-identical target to preserve. Filed rather than fixed; opting a
   * layer into CR is the supported way to get correct, bounded, deterministic
   * behaviour above 4×.
   */
  private drawScaleFor(scale: number, continuous: boolean | undefined, tier: number): number {
    return continuous ? tier : scale;
  }

  /** Vector-raster cache hit/miss counters. A hit = a set* call whose content
   *  signature was unchanged (no re-rasterization) — the transform-only-animation
   *  fast path. Exposed so the hot path can be asserted (Phase 1 cache gate). */
  private readonly rasterizer: Canvas2DVectorRasterizer;

  /** Cumulative vector-raster cache stats (path + text). */
  rasterStats(): { hits: number; misses: number; hitRate: number } {
    const stats = this.rasterizer.stats();
    const total = stats.hits + stats.misses;
    return { hits: stats.hits, misses: stats.misses, hitRate: total === 0 ? 0 : stats.hits / total };
  }

  constructor(
    private readonly resources: ResourceManager,
    opts: {
      loader?: ImageLoader;
      videoFactory?: VideoFactory;
    } = {},
  ) {
    this.loader = opts.loader ?? defaultLoader;
    this.videoFactory = opts.videoFactory ?? defaultVideoFactory;
    this.rasterizer = new Canvas2DVectorRasterizer(this.resources);
  }

  /**
   * Register/refresh the image source behind a renderable key. Idempotent: the
   * same (key, src, fillColor) never re-decodes. A changed src supersedes the old decode.
   */
  setImage(key: string, src: string, fillColor?: string): void {
    const fullKey = fillColor ? `${src}#fill=${fillColor}` : src;
    const existing = this.entries.get(key);
    if (existing && existing.src === fullKey) return; // already loading or loaded
    const entry: ImageEntry = { kind: 'image', src: fullKey, texture: null, bitmap: null, width: 1, height: 1, ready: false };
    this.entries.set(key, entry);
    const decoding = this.decode(key, src, fillColor, entry);
    // Under exact media timing (offline render / the golden-frame harness) the
    // caller renders, awaits the waits, then re-renders. Video registered here
    // but image decode did NOT, so a freshly-created backend — which is what
    // export builds — could capture the 1×1 white placeholder instead of the
    // picture. In the viewport that self-corrects via onChange a frame later;
    // in a one-shot render there is no later.
    if (this.exactMediaTiming) this.mediaWaits.push(decoding);
    void decoding;
  }

  /**
   * Register/refresh the text behind a renderable key.
   */
  setText(key: string, spec: TextSpec): void {
    const layerScale = Math.max(1, Math.abs(spec.scaleX || 1), Math.abs(spec.scaleY || 1));
    const effectiveScale = this.rasterScale * layerScale;
    const tier = this.tierFor(effectiveScale, spec.continuousRaster, spec.width ?? 1, spec.height ?? 1);
    // Fill opacity changes the baked pixels, so it belongs in the cache key.
    const fillSig = spec.fillOpacity !== undefined && spec.fillOpacity < 1 ? `|fo${spec.fillOpacity}` : '';
    const fxSig = effectsNeedCpuBake(spec.effects)
      ? `|fx:${JSON.stringify(spec.effects)}|mask:${spec.mask ? JSON.stringify(spec.mask.paths) : 0}`
      : '';
    const signature =
      `${spec.text}|${spec.fontSize}|${spec.color}|${Math.round(spec.width)}x${Math.round(spec.height)}` +
      `|${spec.fontFamily ?? ''}|${spec.fontWeight ?? ''}|${spec.fontStyle ?? ''}` +
      `|${spec.align ?? ''}|${spec.letterSpacing ?? 0}|${spec.lineHeight ?? ''}` +
      `|${spec.paragraphSpacing ?? 0}|${spec.strokeOverFill ? 'sof' : ''}` +
      `|${spec.runs && spec.runs.length ? JSON.stringify(spec.runs) : ''}${fxSig}${fillSig}` +
      // Animator output and path placement change the baked pixels, so they
      // belong in the cache key — otherwise frame 1 of a sweep is reused for
      // every frame of it.
      `${spec.glyphs && spec.glyphs.length ? `|g${JSON.stringify(spec.glyphs)}` : ''}` +
      `${spec.textPath ? `|tp${JSON.stringify(spec.textPath)}` : ''}` +
      `|t${tier}`;

    // Non-zero only when a CPU-baked chain would bleed outside the text box
    // (see rasterPadding) — otherwise this stays 0 exactly as before.
    const pad = rasterPadding({ ...spec, kind: 'text' } as unknown as RenderLayer);
    const result = this.rasterizer.rasterize({
      drawable: {
        ...spec,
        kind: 'text',
        contentHash: signature,
      },
      resolutionScale: this.drawScaleFor(effectiveScale, spec.continuousRaster, tier),
      padding: pad,
    });

    const texKey = `raster:${signature}@${tier}~${paddingClass(pad)}`;
    const texture = this.resources.texture(texKey, {
      label: `raster:${signature}`,
      width: result.texture.width,
      height: result.texture.height,
      format: 'rgba8unorm',
    });
    this.textEntries.set(key, { kind: 'text', signature, texture });
  }

  /**
   * Register/refresh a 2D light's radial-gradient texture behind a renderable
   * key. The gradient (colour at centre → transparent at the edge) is
   * scale-invariant, so it depends only on the colour; the renderable stretches
   * it to the light's 2·radius box and screen-blends it (see snapshotToFrameScene).
   */
  setLight(key: string, color: string): void {
    const signature = color;
    const existing = this.lightEntries.get(key);
    if (existing && existing.signature === signature) return;
    if (existing) {
      this.resources.freeTexture(`light:${key}:${existing.signature}`);
    }
    const canvas = rasterizeLight(color);
    const tex = this.resources.texture(
      `light:${key}:${signature}`,
      { label: `light:${key}`, width: canvas.width, height: canvas.height, format: 'rgba8unorm', externalCopy: true },
      /* pinned */ true,
    );
    this.resources.writeTexture(tex, { type: 'canvas', canvas });
    this.lightEntries.set(key, { kind: 'light', signature, texture: tex });
  }

  /**
   * Register/refresh the composition's gradient background texture. Baked on the
   * CPU (same gradient maths as the Canvas2D backend) and stretched across a
   * full-comp quad by snapshotToFrameScene — the GPU parity for a gradient
   * `background`. Signature-keyed on the paint + comp aspect so it only re-bakes
   * when the gradient (or the comp shape) actually changes.
   */
  setGradient(key: string, paint: LinearFill | RadialFill, w: number, h: number): void {
    const signature = `${JSON.stringify(paint)}:${Math.round(w)}x${Math.round(h)}`;
    const existing = this.gradientEntries.get(key);
    if (existing && existing.signature === signature) return;
    if (existing) {
      this.resources.freeTexture(`gradient:${key}:${existing.signature}`);
    }
    const canvas = rasterizeGradient(paint, w, h);
    const tex = this.resources.texture(
      `gradient:${key}:${signature}`,
      { label: `gradient:${key}`, width: canvas.width, height: canvas.height, format: 'rgba8unorm', externalCopy: true },
      /* pinned */ true,
    );
    this.resources.writeTexture(tex, { type: 'canvas', canvas });
    this.gradientEntries.set(key, { kind: 'gradient', signature, texture: tex });
  }

  /**
   * Register/refresh a per-channel colour LUT (Levels/Curves/Posterize) as a
   * 256×1 RGBA texture: texel i packs (r[i], g[i], b[i]). The `lut-textured`
   * shader samples it at U = channel value to remap that channel. Signature-keyed
   * on the table bytes so it only re-uploads when the effect actually changes.
   */
  setLut(key: string, lut: { r: Uint8Array; g: Uint8Array; b: Uint8Array }, signature: string): void {
    const existing = this.lutEntries.get(key);
    if (existing && existing.signature === signature) return;
    if (existing) {
      this.resources.freeTexture(`lut:${key}:${existing.signature}`);
    }
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 1;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(256, 1);
    for (let i = 0; i < 256; i++) {
      img.data[i * 4] = lut.r[i]!;
      img.data[i * 4 + 1] = lut.g[i]!;
      img.data[i * 4 + 2] = lut.b[i]!;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const tex = this.resources.texture(
      `lut:${key}:${signature}`,
      { label: `lut:${key}`, width: 256, height: 1, format: 'rgba8unorm', externalCopy: true },
      /* pinned */ true,
    );
    this.resources.writeTexture(tex, { type: 'canvas', canvas });
    this.lutEntries.set(key, { kind: 'lut', signature, texture: tex });
  }

  /**
   * Register/refresh the custom vector path behind a renderable key.
   * Rasterizes synchronously and uploads the generated path texture to the GPU.
   */
  setPath(key: string, layer: RenderLayer): void {
    const layerScale = Math.max(1, Math.abs(layer.scaleX || 1), Math.abs(layer.scaleY || 1));
    const effectiveScale = this.rasterScale * layerScale;
    const ptsSig = layer.pathPoints ? layer.pathPoints.map(p => `${p.x},${p.y},${p.inX},${p.inY},${p.outX},${p.outY}`).join('|') : '';
    const strokeSig = layer.stroke ? `${layer.stroke.width},${layer.stroke.color},${layer.stroke.align}` : 'no-stroke';
    const paintSig = layer.fillPaint && layer.fillPaint.type !== 'solid' ? JSON.stringify(layer.fillPaint) : 'solid';
    const fillSig = layer.fillOpacity !== undefined && layer.fillOpacity < 1 ? `|fo${layer.fillOpacity}` : '';
    const fxSig = effectsNeedCpuBake(layer.effects)
      ? `|fx:${JSON.stringify(layer.effects)}|mask:${layer.mask ? JSON.stringify(layer.mask.paths) : 0}`
      : '';
    const tier = this.tierFor(effectiveScale, layer.continuousRaster, layer.width ?? 1, layer.height ?? 1);
    const signature = `h:${layer.contentHash ?? ''}|${layer.width}x${layer.height}|${layer.primitive ?? 'path'}|r:${layer.cornerRadius ?? 0}|${ptsSig}|${layer.fill}|${paintSig}|${strokeSig}|${layer.pathOpen ? 'open' : 'closed'}${fxSig}${fillSig}|t${tier}`;

    const pad = rasterPadding(layer);
    const result = this.rasterizer.rasterize({
      drawable: {
        ...layer,
        kind: 'path',
        contentHash: signature,
      },
      resolutionScale: this.drawScaleFor(effectiveScale, layer.continuousRaster, tier),
      padding: pad,
    });

    const texKey = `raster:${signature}@${tier}~${paddingClass(pad)}`;
    const texture = this.resources.texture(texKey, {
      label: `raster:${signature}`,
      width: result.texture.width,
      height: result.texture.height,
      format: 'rgba8unorm',
    });
    this.pathEntries.set(key, { kind: 'path', signature, texture });
  }

  /**
   * Register/refresh the video behind a renderable key and upload the frame at
   * `timeSec`. Reuses one HTMLVideoElement per source, seeks it toward the
   * playhead, and re-uploads the current frame each call (video content changes
   * every frame, so there is no signature cache). Returns the placeholder via
   * get until the element has decoded a frame.
   */
  setVideo(key: string, src: string, timeSec: number): void {
    let entry = this.videoEntries.get(key);
    if (!entry || entry.src !== src) {
      // Swapping the source must release the outgoing element and its texture —
      // replacing the map entry alone left a decoding <video> and a pinned texture
      // alive for the rest of the session.
      if (entry) this.releaseVideoEntry(entry);
      const video = this.videoFactory(src);
      const onSeeked = (): void => this.onChange?.();
      entry = { kind: 'video', src, video, texture: null, w: 1, h: 1, onSeeked, requestedTime: null, hasSeeked: false };
      this.videoEntries.set(key, entry);
      video.addEventListener('loadeddata', () => this.onChange?.(), { once: true });
      video.addEventListener('seeked', onSeeked);
    }
    const v = entry.video;
    if (v.readyState < HAVE_CURRENT_DATA) {
      if (this.exactMediaTiming) {
        this.mediaWaits.push(AppTextureProvider.eventWait(v, 'loadeddata', 8000));
      }
      return; // not decoded yet → placeholder
    }
    const deadband = this.exactMediaTiming ? 1e-4 : SEEK_EPSILON;
    // Seek only when the TARGET changes, not whenever the element's currentTime is
    // off-target. `seeked` fires onChange → requestRender → setVideo, and on
    // long-GOP sources the decoder often cannot land within the deadband — so
    // re-requesting the same time on every pass was a self-sustaining full-render
    // loop at rAF rate even with playback paused.
    //
    // `hasSeeked` is what makes time 0 work. A `<video>` that has loaded but never
    // seeked presents a BLACK surface even at readyState 4 (measured: drawImage of
    // a fully-loaded element at currentTime 0 yields all-zero pixels; the same
    // element after seeking to 0.1s yields the real frame). At comp time 0 the
    // target and `currentTime` are both 0, so the deadband check alone declined to
    // seek and this uploaded that black surface — which is why a video layer read
    // as a black rectangle at the start of every composition, exactly where the
    // playhead sits when a preview opens.
    const needsFirstDecode = !entry.hasSeeked;
    const wantsSeek =
      needsFirstDecode ||
      (Math.abs(v.currentTime - timeSec) > deadband &&
        (entry.requestedTime === null || Math.abs(entry.requestedTime - timeSec) > deadband));
    if (wantsSeek) {
      entry.hasSeeked = true;
      entry.requestedTime = timeSec;
      // Seeking to exactly the current position is a no-op that fires no `seeked`
      // event, so nudge the first decode a hair forward. A sub-millisecond offset
      // is far inside one frame at any frame rate, so the frame shown is still the
      // right one.
      v.currentTime = needsFirstDecode && Math.abs(v.currentTime - timeSec) <= deadband
        ? timeSec + FIRST_DECODE_NUDGE
        : timeSec;
      if (this.exactMediaTiming) {
        this.mediaWaits.push(AppTextureProvider.eventWait(v, 'seeked'));
      }
    }
    const w = v.videoWidth || 1;
    const h = v.videoHeight || 1;
    if (entry.texture === null || entry.w !== w || entry.h !== h) {
      if (entry.texture) this.resources.freeTexture(`vid:${key}:${entry.w}x${entry.h}`);
      entry.texture = this.resources.texture(
        `vid:${key}:${w}x${h}`,
        { label: `video:${key}`, width: w, height: h, format: 'rgba8unorm', externalCopy: true },
        /* pinned */ true,
      );
      entry.w = w;
      entry.h = h;
      entry.poolKey = `vid:${key}:${w}x${h}`;
    }
    this.resources.writeTexture(entry.texture, { type: 'video', video: v });
  }

  /**
   * Upload an externally-rasterized canvas under `key` (decoded video frames
   * for Frame Mix). The signature dedupes uploads — pass the source time so a
   * new frame re-uploads and a repeat render doesn't.
   */
  setFrame(key: string, canvas: HTMLCanvasElement, signature: string): void {
    if (canvas.width < 1 || canvas.height < 1) return;
    const existing = this.frameEntries.get(key);
    if (existing && existing.signature === signature) return;
    // ONE texture per key, rewritten in place — the setVideo/setParticles pattern.
    //
    // This used to include `signature` (the source TIME) in the pool key, so every
    // decoded frame minted a brand-new `pinned: true` texture. Pinned entries are
    // skipped by the pool's idle GC, and overwriting `frameEntries[key]` threw away
    // the only record of the previous pool key — so nothing could ever free it.
    // Playing ten seconds of 1080p footage with Frame Mix on leaked ~600 textures,
    // several GB of VRAM.
    const poolKey = `frame:${key}:${canvas.width}x${canvas.height}`;
    let tex = existing?.texture;
    if (!tex || existing?.poolKey !== poolKey) {
      if (existing?.poolKey) this.resources.freeTexture(existing.poolKey);
      tex = this.resources.texture(
        poolKey,
        { label: `frame:${key}`, width: canvas.width, height: canvas.height, format: 'rgba8unorm', externalCopy: true },
        /* pinned */ true,
      );
    }
    this.resources.writeTexture(tex, { type: 'canvas', canvas });
    this.frameEntries.set(key, { signature, texture: tex, poolKey });
  }

  /**
   * Register/refresh a particle emitter's rasterized field for this frame.
   * The simulation is a pure function of (config, time) — see particleSim —
   * so the field is deterministic at any scrub time; the content signature
   * (config + time + box + raster scale) skips the redraw/re-upload whenever
   * the frame genuinely repeats (paused playhead, media-settle re-renders).
   * One persistent texture per key is rewritten in place (the setVideo
   * pattern), so playback doesn't churn GPU allocations.
   */
  setParticles(
    key: string,
    cfg: ParticleConfig,
    timeSec: number,
    fieldW: number,
    fieldH: number,
    transformScale = 1,
  ): void {
    const w = Math.max(1, Math.round(fieldW));
    const h = Math.max(1, Math.round(fieldH));
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const requestedScale = dpr * Math.max(1, transformScale) * (this.rasterScale || 1);
    const scale = Math.max(0.5, Math.min(requestedScale, PARTICLE_TEX_MAX / Math.max(w, h)));
    const time = Math.max(0, timeSec);
    const signature = particleFieldSignature(cfg, time, w, h, scale);
    let entry = this.particleEntries.get(key);
    if (!entry) {
      entry = { kind: 'particles', signature: '', canvas: document.createElement('canvas'), texture: null, w: 0, h: 0 };
      this.particleEntries.set(key, entry);
    }
    if (entry.texture && entry.signature === signature) return;

    const pxW = Math.max(1, Math.round(w * scale));
    const pxH = Math.max(1, Math.round(h * scale));
    if (entry.canvas.width !== pxW || entry.canvas.height !== pxH) {
      entry.canvas.width = pxW;
      entry.canvas.height = pxH;
    }
    const ctx = entry.canvas.getContext('2d');
    if (!ctx) return;
    drawParticleField(ctx, cfg, time, w, h, scale);

    if (entry.texture === null || entry.w !== pxW || entry.h !== pxH) {
      entry.texture = this.resources.texture(
        `particles:${key}:${pxW}x${pxH}`,
        { label: `particles:${key}`, width: pxW, height: pxH, format: 'rgba8unorm', externalCopy: true },
        /* pinned */ true,
      );
      entry.w = pxW;
      entry.h = pxH;
    }
    this.resources.writeTexture(entry.texture, { type: 'canvas', canvas: entry.canvas });
    entry.signature = signature;
  }

  /**
   * Release keys no longer present in the scene.
   *
   * This used to only `delete` from the maps, on the stated assumption that GC
   * would reclaim the textures. It does not: every texture here is created
   * `pinned: true`, which excludes it from the ResourceManager pool's idle GC, and
   * the pool holds the handle (and the live WebGLTexture) regardless of whether
   * this class still references it. Dropping a video entry additionally abandoned
   * an HTMLVideoElement that still owned a decoder pipeline and two live
   * listeners, and an image entry's decoded ImageBitmap holds off-heap pixel
   * memory until explicitly closed. Deleting a layer while scrubbing therefore
   * stranded a texture, a decoder and a bitmap every time.
   */
  retain(activeKeys: ReadonlySet<string>): void {
    for (const [key, entry] of [...this.entries]) {
      if (activeKeys.has(key)) continue;
      this.resources.freeTexture(`img:${entry.src}`);
      entry.bitmap?.close();
      this.entries.delete(key);
    }
    for (const key of this.textEntries.keys()) {
      if (!activeKeys.has(key)) this.textEntries.delete(key);
    }
    for (const [key, entry] of [...this.videoEntries]) {
      if (activeKeys.has(key)) continue;
      this.releaseVideoEntry(entry);
      this.videoEntries.delete(key);
    }
    for (const key of this.pathEntries.keys()) {
      if (!activeKeys.has(key)) this.pathEntries.delete(key);
    }
    for (const key of this.maskEntries.keys()) {
      if (!activeKeys.has(key)) this.maskEntries.delete(key);
    }
    for (const key of this.lightEntries.keys()) {
      if (!activeKeys.has(key)) this.lightEntries.delete(key);
    }
    for (const key of this.gradientEntries.keys()) {
      if (!activeKeys.has(key)) this.gradientEntries.delete(key);
    }
    for (const [key, entry] of [...this.frameEntries]) {
      if (activeKeys.has(key)) continue;
      this.resources.freeTexture(entry.poolKey);
      this.frameEntries.delete(key);
    }
    for (const key of this.particleEntries.keys()) {
      if (!activeKeys.has(key)) this.particleEntries.delete(key);
    }
  }

  /**
   * Tear a video entry all the way down. `src = ''` alone does not reliably stop
   * Chromium's decoder; pause + removeAttribute + load does, and the `seeked`
   * listener must go with it — it calls `onChange`, which requests a render, so a
   * stranded element could still drive the render loop after its layer was gone.
   */
  private releaseVideoEntry(entry: VideoEntry): void {
    if (entry.onSeeked) entry.video.removeEventListener('seeked', entry.onSeeked);
    try {
      entry.video.pause();
      entry.video.removeAttribute('src');
      entry.video.load();
    } catch {
      /* element already detached — nothing left to release */
    }
    if (entry.poolKey) this.resources.freeTexture(entry.poolKey);
  }

  /** Release every retained GPU/media resource. Call before dropping the provider. */
  dispose(): void {
    this.retain(new Set());
  }

  private async decode(key: string, src: string, fillColor: string | undefined, entry: ImageEntry): Promise<void> {
    let bitmap: ImageBitmap;
    try {
      bitmap = await this.loader(src, fillColor);
    } catch {
      return; // broken source — leave the placeholder in place
    }
    // A newer setImage for this key (different src) supersedes this decode.
    if (this.entries.get(key) !== entry) return;
    entry.width = bitmap.width || 1;
    entry.height = bitmap.height || 1;
    const tex = this.resources.texture(
      `img:${src}`,
      { label: `image:${src}`, width: entry.width, height: entry.height, format: 'rgba8unorm', externalCopy: true },
      /* pinned */ true,
    );
    this.resources.writeTexture(tex, { type: 'bitmap', bitmap });
    entry.texture = tex;
    entry.bitmap = bitmap;
    entry.ready = true;
    this.onChange?.();
  }

  private placeholder(): ResolvedTexture {
    const texture = this.resources.texture(
      'texture:white',
      { label: 'white', width: 1, height: 1, format: 'rgba8unorm' },
      true,
    );
    if (!this.hasInitWhite) {
      const data = new Uint8Array([255, 255, 255, 255]);
      this.resources.writeTexture(texture, { type: 'buffer', data, width: 1, height: 1 });
      this.hasInitWhite = true;
    }
    return { texture, sampler: this.sampler(), ready: true };
  }

  private sampler(): SamplerHandle {
    return this.resources.sampler(
      'sampler:linear-clamp',
      { label: 'linear-clamp', min: 'linear', mag: 'linear', addressU: 'clamp', addressV: 'clamp' },
      true,
    );
  }

  get(key: string): ResolvedTexture | null {
    const mask = this.maskEntries.get(key);
    if (mask) {
      return { texture: mask.texture, sampler: this.sampler(), ready: true };
    }
    const path = this.pathEntries.get(key);
    if (path) {
      return { texture: path.texture, sampler: this.sampler(), ready: true };
    }
    const text = this.textEntries.get(key);
    if (text) {
      return { texture: text.texture, sampler: this.sampler(), ready: true };
    }
    const light = this.lightEntries.get(key);
    if (light) {
      return { texture: light.texture, sampler: this.sampler(), ready: true };
    }
    const gradient = this.gradientEntries.get(key);
    if (gradient) {
      return { texture: gradient.texture, sampler: this.sampler(), ready: true };
    }
    const lut = this.lutEntries.get(key);
    if (lut) {
      return { texture: lut.texture, sampler: this.sampler(), ready: true };
    }
    const frame = this.frameEntries.get(key);
    if (frame) {
      return { texture: frame.texture, sampler: this.sampler(), ready: true };
    }
    const particles = this.particleEntries.get(key);
    if (particles && particles.texture) {
      return { texture: particles.texture, sampler: this.sampler(), ready: true };
    }
    const video = this.videoEntries.get(key);
    if (video && video.texture) {
      return { texture: video.texture, sampler: this.sampler(), ready: true };
    }
    const entry = this.entries.get(key);
    if (entry && entry.ready && entry.texture) {
      return { texture: entry.texture, sampler: this.sampler(), ready: true };
    }
    // Not-yet-decoded image/video: show the placeholder box so the layer still
    // composites (parity with Canvas2D's loading placeholder).
    return this.placeholder();
  }

  setMask(key: string, layer: RenderLayer): void {
    if (!layer.mask || layer.mask.paths.length === 0) return;

    // The signature must cover EVERYTHING that changes matte pixels — the old
    // one omitted mode/feather/opacity/expansion, so editing any of them
    // couldn't even trigger a re-rasterize (on top of the paint ignoring them).
    const ptsSig = layer.mask.paths.map((path) =>
      path.points.map((p) => `${p.x},${p.y},${p.inX},${p.inY},${p.outX},${p.outY}`).join('|') +
      `|inv:${path.inverted}|m:${path.mode}|f:${path.feather}|o:${path.opacity ?? 1}|e:${path.expansion ?? 0}|c:${path.closed}`,
    ).join('||');
    const signature = `${layer.width}x${layer.height}|mask:${ptsSig}`;

    const existing = this.maskEntries.get(key);
    if (existing && existing.signature === signature) return;

    const result = this.rasterizer.rasterize({
      drawable: {
        ...layer,
        kind: 'mask',
        contentHash: signature,
      },
      resolutionScale: 1,
      padding: 0,
    });

    const texKey = `raster:${signature}@1~0`;
    const texture = this.resources.texture(texKey, {
      label: `raster:${signature}`,
      width: result.texture.width,
      height: result.texture.height,
      format: 'rgba8unorm',
    });
    this.maskEntries.set(key, { kind: 'mask', signature, texture });
  }


}

/** Rasterize a text layer to a canvas, mirroring Canvas2DBackend's text render
 *  path exactly — font family/weight/style, letter spacing, per-line alignment
 *  and multi-line layout — supersampled for crispness. The quad the renderer
 *  maps this onto is the layer's box, so text is laid out in a box-sized canvas
 *  with the same anchors Canvas2D uses (which draws centred at the box origin). */


/** Rasterize a 2D light to a square radial-gradient texture: `color` at the
 *  centre fading to transparent at the edge — the same gradient Canvas2DBackend
 *  paints in `drawLight`, baked once at a fixed size and stretched to the light's
 *  box by the renderable (intensity drives the renderable opacity, not the texel). */
function rasterizeLight(color: string): HTMLCanvasElement {
  const s = LIGHT_TEX_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = s;
  canvas.height = s;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const c = s / 2;
  const g = ctx.createRadialGradient(c, c, 0, c, c, c);
  g.addColorStop(0, color);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  return canvas;
}

/** Bake a linear/radial background gradient into a canvas the GPU can upload.
 *  Rasterized at the comp aspect ratio (longest edge capped) and filled from the
 *  centre so the gradient geometry matches the Canvas2D backend exactly. */
function rasterizeGradient(paint: LinearFill | RadialFill, w: number, h: number): HTMLCanvasElement {
  const scale = Math.min(1, GRADIENT_TEX_MAX / Math.max(w, h, 1));
  const tw = Math.max(2, Math.round(w * scale));
  const th = Math.max(2, Math.round(h * scale));
  const canvas = document.createElement('canvas');
  canvas.width = tw;
  canvas.height = th;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.fillStyle = makeCanvasGradient(ctx, paint, tw, th, tw / 2, th / 2);
  ctx.fillRect(0, 0, tw, th);
  return canvas;
}



