/**
 * AppTextureProvider — the app-side `TextureProvider` for the GPU @motion/renderer
 * path (S2 of the Canvas2D→GPU swap). It resolves a renderable's `textureKey`
 * (`asset:<id>` for image/video, `text:<id>` for text) to a real GPU texture.
 *
 * The renderer's passes call `get(key)` synchronously mid-frame, but image decode
 * is async, so the flow is:
 *   1. Each frame, MotionRendererBackend feeds current sources via `setImage`.
 *   2. `get` returns the decoded texture once ready, else a shared 1×1
 *      TRANSPARENT placeholder — an undecoded layer draws nothing rather than a
 *      box. It used to be opaque white, which made every layer whose clip starts
 *      partway into the timeline flash a white rectangle on its first frame
 *      (see `placeholder()`).
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
import { displayReferredUploadFormat } from '@motion/renderer';
import type { RenderLayer } from './RenderBackend';
import { makeCanvasGradient, type LinearFill, type RadialFill } from '@core/paint/fill';

/** A light layer's wash parameters — the shape `RenderLayer.light` carries. */
type LightWash = NonNullable<RenderLayer['light']>;
import { rasterPadding } from './raster/vectorDraw';
import { layerSubpaths } from './raster/subpaths';
import { resolutionTier, paddingClass, continuousResolutionTier, DEFAULT_MAX_RASTER_DIMENSION } from '@motion/renderer';
import { Canvas2DVectorRasterizer } from './raster/Canvas2DVectorRasterizer';
import { type RichRun } from '@core/text/textLayout';
import { effectsNeedCpuBake, applyEffectChain } from '@core/effects/effectBake';
import { scaleEffectLengths, type Effect } from '@core/effects/effects';
import { deinterlaceData, deinterlaceInto, type FieldOrder } from './deinterlace';
import { paintMaskMatte, type LayerMask } from '@core/effects/mask';
import { drawParticleField, particleFieldSignature } from '@core/particles/particleRender';
import type { ParticleConfig } from '@core/particles/particleSim';
import type { CubeLut } from '@core/effects/cubeLut';
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
export type ImageLoader = (src: string, fillColor?: string, premultipliedFile?: boolean) => Promise<ImageBitmap>;

const RASTER_MAX = 4096;

/**
 * How many decoded images to keep alive after they leave the visible set.
 *
 * The point is to survive a playhead crossing a layer's start/end — see
 * `retain`. Sized for "a composition's worth of images the user is scrubbing
 * around", not for a whole project: past this the oldest is freed, so a long
 * timeline full of stills still has a ceiling. Each parked entry holds one
 * decoded bitmap and one GPU texture, so the bound is what keeps this a cache
 * rather than a leak.
 */
const MAX_PARKED_IMAGES = 32;

/**
 * Decode options for EVERY bitmap that becomes a GPU texture.
 *
 * THE ALPHA INVARIANT (stated in full on `TextureSource`,
 * packages/renderer/src/gpu/types.ts): textures hold PREMULTIPLIED alpha. This is
 * where a footage bitmap is brought into it, and where the FILE's own alpha mode
 * is consumed — once per file, not once per draw.
 *
 *   straight file        'premultiply'  the browser multiplies at decode
 *   premultiplied file   'none'         raw bytes; they are already multiplied
 *
 * Either way the bitmap that comes out is premultiplied, which is why the upload
 * can then pass every bitmap through untouched.
 *
 * ## Why the conversion is here and not at the upload
 *
 * Measured, not assumed. `UNPACK_PREMULTIPLY_ALPHA_WEBGL` is IGNORED for
 * `ImageBitmap` sources — an ImageBitmap carries its own premultiply state from
 * creation and the unpack flag cannot override it. Setting the flag alone left
 * WebGL2 rendering a premultiplied-declared-straight file as if correct
 * (measured: linear rms 0.68 where the double multiply predicts 53.77) while
 * WebGPU, whose `copyExternalImageToTexture` does convert, disagreed. The decode
 * is the only boundary that governs on both backends.
 *
 * ## Why 'premultiply' is also right for our own canvas rasters
 *
 * The SVG and `<img>` fallback paths draw into a 2D canvas first, and a canvas
 * backing store is premultiplied. `'premultiply'` on a canvas source is a no-op
 * that PRESERVES that; `'none'` would un-premultiply it and put a straight
 * texture back in the sampler — the halo this invariant exists to remove.
 *
 * It has to be on every loader path, not most: one left at the default would
 * differ only for the formats that take that path (the `<img>` fallback handles
 * GIF/WebP/exotic types), leaving a fringe on those files alone.
 *
 * Proven by: packages/render-tests/scripts/verify-alpha.mjs
 * (`a straight source composites LINEARLY in alpha`, and the filtering-cost
 * measurement on `alpha-filter-hard-edge`).
 */
function decodeOptions(premultipliedFile?: boolean): ImageBitmapOptions {
  return { premultiplyAlpha: premultipliedFile ? 'none' : 'premultiply' };
}

/** Draw an already-decoded <img> to a canvas at w×h and hand back a bitmap. */
async function imageToBitmap(img: HTMLImageElement, w: number, h: number, premultipliedFile?: boolean): Promise<ImageBitmap> {
  const maxDim = RASTER_MAX;
  const scale = Math.max(w, h) > maxDim ? maxDim / Math.max(w, h) : 1;
  const targetW = Math.max(1, Math.round(w * scale));
  const targetH = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return createImageBitmap(img, decodeOptions(premultipliedFile));
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, targetW, targetH);
  return createImageBitmap(canvas, decodeOptions(premultipliedFile));
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

const defaultLoader: ImageLoader = async (src, fillColor, premultipliedFile) => {
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
        return await createImageBitmap(blob, decodeOptions(premultipliedFile));
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
    return await createImageBitmap(blob, decodeOptions(premultipliedFile));
  } catch {
    // GIF/WebP/exotic types createImageBitmap chokes on — fall back to <img>,
    // which decodes the first frame of any format the browser can display.
    return rasterizeViaImage(src);
  }
};

/**
 * What an image needs baked into its texture: the effect chain, plus the layer
 * box the chain's px parameters are expressed in (the bitmap is at its own
 * natural resolution, which is rarely the same thing).
 */
export interface ImageBakeSpec {
  effects: ReadonlyArray<Effect>;
  width: number;
  height: number;
  fillOpacity?: number;
  /** Baked BEFORE the chain, so interior styles shape themselves from the
   *  masked silhouette rather than the bitmap's rectangle. */
  mask?: LayerMask;
  /**
   * Device pixels per layer unit on screen THIS frame — the view's raster scale
   * times the layer's own scale. When present, the bake runs at
   * `min(native, layer box × targetScale)` instead of the source's native size.
   *
   * This is where the cost of effects on footage lives. A 1080p clip shown in
   * a 960 px viewport at Half preview covers 480 × 270 device pixels, yet every
   * CPU effect used to run over all 2,073,600 source pixels per frame, only for
   * the compositor to shrink the result 16×. Baking at the size that will be
   * shown makes a four-effect chain cost what it costs at that size — and the
   * export path, whose raster scale is 1:1 at comp resolution, still bakes at
   * native. Absent → native, the old behaviour.
   */
  targetScale?: number;
}

/**
 * The pixel size to bake at: the layer box scaled to the screen, clamped to
 * the source's native size, never below 1 px. Aspect follows the SOURCE (the
 * layer box may be letterboxed around it), so the chain's px parameters scale
 * by the same factor on both axes as before.
 */
export function bakeSize(nativeW: number, nativeH: number, bake: Pick<ImageBakeSpec, 'width' | 'height' | 'targetScale'>): { w: number; h: number } {
  const ts = bake.targetScale;
  if (!(ts !== undefined && ts > 0 && Number.isFinite(ts))) return { w: nativeW, h: nativeH };
  // Device pixels the layer box covers, per axis; the source is fitted into
  // that box, so the limiting axis decides the factor.
  const boxW = Math.max(1, bake.width) * ts;
  const boxH = Math.max(1, bake.height) * ts;
  const factor = Math.min(1, Math.max(boxW / nativeW, boxH / nativeH));
  return {
    w: Math.max(1, Math.round(nativeW * factor)),
    h: Math.max(1, Math.round(nativeH * factor)),
  };
}

interface ImageEntry {
  kind: 'image';
  src: string;
  /**
   * The DECODE identity — `src` without the bake suffix, so it carries the fill
   * colour, the alpha mode and the media time but not the effect chain.
   *
   * Kept separately because `unbaked` may only be reused across a change that
   * cannot alter the decoded pixels, and `src` cannot answer that: it has the
   * bake appended, so an exact compare rejects every legitimate re-bake, while
   * a prefix compare accepts `blob:x` against `blob:x#premul`. Recorded at
   * `setImage` time, so it is also immune to `premultipliedFile` being
   * rewritten once a bake lands.
   */
  fileId: string;
  /** Effect chain to bake into the bitmap (see imageNeedsCpuBake). */
  bake?: ImageBakeSpec;
  /** The FILE's alpha mode, carried to the upload. See the alpha invariant. */
  premultipliedFile?: boolean;
  texture: TextureHandle | null;
  bitmap: ImageBitmap | null;
  /**
   * Decoded FILE pixels, before any CPU bake. Kept so a bake-spec change
   * (tweaking Inner Glow, a layer style, …) can re-bake without re-decoding
   * and without throwing away the texture already on screen.
   */
  unbaked: ImageBitmap | null;
  width: number;
  height: number;
  ready: boolean;
  /** Linear float EXR (or similar) — sample without sRGB decode. */
  sampleLinear?: boolean;
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
  /** Variable-font width axis (wdth), typically 50–200. */
  fontWidth?: number;
  /** Variable-font slant axis (slnt), typically −15..0. */
  fontSlant?: number;
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

/** CSS font-variation-settings for variable axes (wght/wdth/slnt). */
export function textFontVariationSettings(
  spec: Pick<TextSpec, 'fontWeight' | 'fontWidth' | 'fontSlant'>,
): string | undefined {
  const parts: string[] = [];
  const w = spec.fontWeight !== undefined ? Number(spec.fontWeight) : NaN;
  if (Number.isFinite(w)) parts.push(`'wght' ${w}`);
  if (spec.fontWidth !== undefined && Number.isFinite(spec.fontWidth)) {
    parts.push(`'wdth' ${spec.fontWidth}`);
  }
  if (spec.fontSlant !== undefined && Number.isFinite(spec.fontSlant)) {
    parts.push(`'slnt' ${spec.fontSlant}`);
  }
  return parts.length ? parts.join(', ') : undefined;
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
  /** Previous source time during hardware playback — detects loop wraps. */
  lastPlaybackTime?: number;
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
  /** Shared scratch surface for field separation — sequential per-call use,
   *  resized by `deinterlaceInto`, so one canvas serves every video key. */
  private readonly fieldsWork: HTMLCanvasElement = document.createElement('canvas');
  /** Fired when an async decode finishes and a texture becomes ready. */
  onChange: (() => void) | null = null;

  private exactMediaTiming = false;
  /** Timeline is playing — setVideoPlayback keeps `<video>` running instead of per-frame seeks. */
  private playbackMode = false;
  private mediaWaits: Promise<void>[] = [];

  setExactMediaTiming(on: boolean): void {
    this.exactMediaTiming = on;
    if (!on) this.mediaWaits = [];
  }

  setPlaybackMode(on: boolean): void {
    if (this.playbackMode === on) return;
    this.playbackMode = on;
    if (!on) {
      for (const entry of this.videoEntries.values()) {
        entry.video.pause();
        entry.lastPlaybackTime = undefined;
      }
    }
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
  /** Reused scratch canvases for CPU effect bakes — allocating one per CSS
   *  flush inside a five-effect stack was a major source of main-thread freezes.
   *  Two slots so silhouette + flushCss never alias the same surface. */
  private bakeWork: HTMLCanvasElement | null = null;
  /** The baked-video upload surface, reused frame to frame (see setVideoBaked). */
  private videoBakeOut: HTMLCanvasElement | null = null;
  private bakeScratchA: HTMLCanvasElement | null = null;
  private bakeScratchB: HTMLCanvasElement | null = null;
  private bakeScratchToggle = 0;
  /** One-shot init for the transparent placeholder — see `placeholder()`. */
  private hasInitTransparent = false;
  /**
   * Decoded images that have fallen out of the visible set but are NOT yet
   * freed — see `retain`. Insertion-ordered, so the oldest is evicted first.
   */
  private readonly parkedImages = new Map<string, ImageEntry>();
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
   * What to hand the rasterizer as its draw scale: the TIER, always.
   *
   * The pixels drawn and the cache key have to be the same number. They used to
   * disagree on the CR-OFF path — drawn at the raw scale, keyed on the
   * quantized tier — which meant one texture served a whole tier and was
   * stretched to whatever size the layer had grown to since. During a scale
   * animation that reads as content going progressively soft and then snapping
   * sharp at each tier boundary, over and over; it also made the result
   * ORDER-DEPENDENT, since whichever scale rasterized first won the key.
   *
   * The tier rounds UP, so below the ceiling it is >= the requested scale and
   * the raster is never magnified — this is sharper than it was, not softer, as
   * well as stable. Above the ceiling the tier clamps and the texture is
   * magnified, which is the documented >4x limitation and exactly what
   * CONTINUOUS RASTERIZATION exists to lift: it extends the ladder so the tier
   * keeps up. Before, above 4x was sharp but arbitrary — the first scale
   * rasterized was reused for every other, so the same project could render
   * differently depending on which frame you visited first. Predictable and
   * bounded beats sharp and arbitrary.
   */
  private drawScaleFor(scale: number, continuous: boolean | undefined, tier: number): number {
    void scale; void continuous;
    return tier;
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
    this.maxRasterDimension = this.resources.maxTextureSize || DEFAULT_MAX_RASTER_DIMENSION;
    this.rasterizer = new Canvas2DVectorRasterizer(this.resources);
  }

  /**
   * Register/refresh the image source behind a renderable key. Idempotent: the
   * same (key, src, fillColor) never re-decodes. A changed src supersedes the old decode.
   */
  /**
   * @param premultipliedFile  The FILE's own alpha mode
   *   (`FootageInterpretation.alpha === 'premultiplied'`). It rides all the way
   *   to the upload call, where it decides whether the browser multiplies — see
   *   the alpha invariant on `TextureSource`. It is part of the cache key
   *   because it changes the TEXTURE, not just the draw: without that, toggling
   *   Interpret Footage would keep serving the bitmap uploaded under the old
   *   setting and the inspector would appear to do nothing.
   */
  setImage(key: string, src: string, fillColor?: string, premultipliedFile?: boolean, bake?: ImageBakeSpec, mediaTime?: number): void {
    // The bake belongs in the key: it changes the TEXTURE, so two layers on the
    // same file with different styles must not share one upload, and editing a
    // style has to invalidate what is already there.
    // The chosen bake RESOLUTION tier belongs in the key: zooming in must
    // re-bake sharper, and without this the first (possibly low-res) bake
    // would be served forever. Quantized so panning/zooming does not thrash.
    const bakeSig = bake ? `#bake=${JSON.stringify(bake)}#rq=${this.bakeResolutionTier()}` : '';
    // Live SVG scrubbing: quantize to centiseconds so adjacent frames share a
    // decode when the playhead barely moves, while still invalidating on scrub.
    const timeSig = mediaTime !== undefined && Number.isFinite(mediaTime)
      ? `#t=${Math.round(mediaTime * 100) / 100}`
      : '';
    const fileId = (fillColor ? `${src}#fill=${fillColor}` : src) + (premultipliedFile ? '#premul' : '') + timeSig;
    const fullKey = fileId + bakeSig;
    const existing = this.entries.get(key);
    if (existing && existing.src === fullKey) return; // already loading or loaded
    // Keep the last good texture on screen while the new bake/decode runs.
    // Dropping it for a 1×1 transparent placeholder is the "eye blink": every
    // Inner Glow / Stroke / Fill tweak replaced the entry with ready:false,
    // so get() drew nothing until the async bake landed.
    // Compared on the DECODE identity, not on `src`: the alpha mode is baked
    // into the decode (`decodeOptions` multiplies a straight file and passes a
    // premultiplied one through), so carrying `unbaked` across a flip would
    // serve pixels decoded under the old setting forever — Interpret Footage ▸
    // Alpha would appear to do nothing. A `startsWith(src)` test cannot see
    // that, and misses the premul→straight direction outright.
    const sameFile = !!existing && existing.fileId === fileId;
    const entry: ImageEntry = {
      kind: 'image',
      src: fullKey,
      fileId,
      bake,
      texture: existing?.texture ?? null,
      bitmap: existing?.bitmap ?? null,
      unbaked: sameFile && !timeSig ? existing?.unbaked ?? null : null,
      width: existing?.width ?? 1,
      height: existing?.height ?? 1,
      ready: !!(existing?.texture),
      premultipliedFile,
      sampleLinear: false,
    };
    this.entries.set(key, entry);
    const decoding = this.decode(key, src, fillColor, entry, mediaTime);
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
   * Upload a linear float RGBA image (EXR working media) as rgba32float.
   * Falls back to the 8-bit `setImage` path when the GPU lacks float textures.
   * RGB is premultiplied by A to honour the renderer alpha invariant.
   */
  setFloatImage(
    key: string,
    img: { width: number; height: number; rgba: Float32Array },
    opts?: { fallbackSrc?: string; fillColor?: string; premultipliedFile?: boolean },
  ): void {
    if (!this.resources.float32Textures) {
      if (opts?.fallbackSrc) {
        this.setImage(key, opts.fallbackSrc, opts.fillColor, opts.premultipliedFile);
      }
      return;
    }
    const sig = `float:${img.width}x${img.height}:${img.rgba.length}`;
    const existing = this.entries.get(key);
    if (existing && existing.src === sig && existing.ready && existing.sampleLinear) return;

    const n = img.width * img.height;
    const premul = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const a = img.rgba[i * 4 + 3] ?? 1;
      premul[i * 4] = (img.rgba[i * 4] ?? 0) * a;
      premul[i * 4 + 1] = (img.rgba[i * 4 + 1] ?? 0) * a;
      premul[i * 4 + 2] = (img.rgba[i * 4 + 2] ?? 0) * a;
      premul[i * 4 + 3] = a;
    }

    const texId = `img:${sig}`;
    const tex = this.resources.texture(
      texId,
      {
        label: `float:${key}`,
        width: img.width,
        height: img.height,
        format: 'rgba32float',
        displayReferred: false,
      },
      /* pinned */ true,
    );
    this.resources.writeTexture(tex, {
      type: 'buffer',
      data: premul,
      width: img.width,
      height: img.height,
      format: 'rgba32float',
    });

    this.entries.set(key, {
      kind: 'image',
      src: sig,
      fileId: sig,
      texture: tex,
      bitmap: null,
      unbaked: null,
      width: img.width,
      height: img.height,
      ready: true,
      sampleLinear: true,
    });
    this.onChange?.();
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
      `|wd${spec.fontWidth ?? ''}|sl${spec.fontSlant ?? ''}` +
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
      format: displayReferredUploadFormat(),
      displayReferred: true,
    });
    this.textEntries.set(key, { kind: 'text', signature, texture });
  }

  /**
   * Register/refresh a 2D light's wash texture behind a renderable key. The
   * gradient is scale-invariant; the renderable stretches it to the light's
   * 2·radius box and screen-blends it (see snapshotToFrameScene).
   *
   * The signature was `color` alone. That was not merely narrow, it COLLIDED:
   * two spots differing only in cone hashed to one cache entry, so the second
   * silently rendered with the first's gradient — a correct rasterizer would
   * still have drawn the wrong cone.
   *
   * Non-spot types keep the bare-colour key deliberately: their wash genuinely
   * depends on nothing else, so ambient/point/parallel of the same colour SHARE
   * one texture, as they always have. That is not a collision — it is the same
   * image.
   */
  setLight(key: string, light: LightWash): void {
    const signature = light.type === 'spot'
      ? `${light.color}|spot|${light.angle ?? 0}|${light.cone ?? 0}|${light.coneFeather ?? 'd'}`
      : light.color;
    const existing = this.lightEntries.get(key);
    if (existing && existing.signature === signature) return;
    if (existing) {
      this.resources.freeTexture(`light:${key}:${existing.signature}`);
    }
    const canvas = rasterizeLight(light);
    const tex = this.resources.texture(
      `light:${key}:${signature}`,
      { label: `light:${key}`, width: canvas.width, height: canvas.height, format: displayReferredUploadFormat(), displayReferred: true, externalCopy: true },
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
      { label: `gradient:${key}`, width: canvas.width, height: canvas.height, format: displayReferredUploadFormat(), displayReferred: true, externalCopy: true },
      /* pinned */ true,
    );
    this.resources.writeTexture(tex, { type: 'canvas', canvas });
    this.gradientEntries.set(key, { kind: 'gradient', signature, texture: tex });
  }

  /**
   * Register/refresh an Apply Color LUT `.cube` table as the STRIP texture the
   * `apply-color-lut` shader samples.
   *
   * ── Layout, which the shader depends on exactly ─────────────────────────
   *
   * A 3D cube of edge `n` is laid out as `n` slices side by side: the texture
   * is `n*n` wide and `n` tall, and slice `z` occupies columns `[z*n, (z+1)*n)`.
   * Within a slice, X is red and Y (the row) is green. So the texel at
   * `(z*n + r, g)` holds the entry for (r, g, z), which is what `sliceSample`
   * reads back as `u = (slice*n + xIn) / (n*n)`.
   *
   * A 1D LUT is one row, `size1d` wide, each channel looked up independently.
   *
   * The source ordering is the other half of this: `.cube` files vary RED
   * fastest, so the flat index is `r + g*size + b*size²` (cubeLut.ts says so at
   * the top, and getting it backwards transposes the grade silently rather than
   * failing).
   *
   * Signature-keyed like every other entry here, so an unchanged LUT does not
   * re-upload a 64³ table every frame.
   */
  setCubeLut(key: string, cube: CubeLut, signature: string): void {
    const existing = this.lutEntries.get(key);
    if (existing && existing.signature === signature) return;
    if (existing) {
      this.resources.freeTexture(`${key}:${existing.signature}`);
    }
    const is1d = cube.size1d > 0;
    const n = is1d ? cube.size1d : cube.size;
    if (n <= 0) return;
    const width = is1d ? n : n * n;
    const height = is1d ? 1 : n;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(width, height);
    // 0..1 floats to bytes. Clamped rather than wrapped: a LUT may legitimately
    // carry values outside the unit range, and an 8-bit strip cannot hold them.
    const b8 = (v: number): number => {
      const x = Math.round((Number.isFinite(v) ? v : 0) * 255);
      return x < 0 ? 0 : x > 255 ? 255 : x;
    };
    const put = (x: number, y: number, s: number): void => {
      const o = (y * width + x) * 4;
      img.data[o] = b8(cube.data[s] ?? 0);
      img.data[o + 1] = b8(cube.data[s + 1] ?? 0);
      img.data[o + 2] = b8(cube.data[s + 2] ?? 0);
      img.data[o + 3] = 255;
    };
    if (is1d) {
      for (let i = 0; i < n; i++) put(i, 0, i * 3);
    } else {
      for (let z = 0; z < n; z++) {
        for (let g = 0; g < n; g++) {
          for (let r = 0; r < n; r++) put(z * n + r, g, (r + g * n + z * n * n) * 3);
        }
      }
    }
    ctx.putImageData(img, 0, 0);

    const tex = this.resources.texture(
      `${key}:${signature}`,
      { label: key, width, height, format: 'rgba8unorm', externalCopy: true },
      /* pinned */ true,
    );
    this.resources.writeTexture(tex, { type: 'canvas', canvas });
    this.lutEntries.set(key, { kind: 'lut', signature, texture: tex });
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
    // Runs are joined by a separator that cannot appear inside a run, so two
    // different splits of the same points are two different signatures. Without
    // the boundary marker a path cut into 2+2 points and one cut into 1+3 sign
    // identically and the second silently reuses the first's texture.
    // Per-run PAINT signs too. Identical geometry with different run paint is a
    // different picture, and without this the second layer reuses the first's
    // texture — the same failure the run boundary above prevents, but with
    // matching geometry, so nothing else in the key would catch it.
    const ptsSig = layerSubpaths(layer)
      .map((s) => `${s.open ? 'o' : 'c'}:${s.paint ? JSON.stringify(s.paint) : ''}:${s.points.map(p => `${p.x},${p.y},${p.inX},${p.inY},${p.outX},${p.outY}`).join('|')}`)
      .join('//');
    const strokeSig = layer.stroke ? `${layer.stroke.width},${layer.stroke.color},${layer.stroke.align}` : 'no-stroke';
    const paintSig = layer.fillPaint && layer.fillPaint.type !== 'solid' ? JSON.stringify(layer.fillPaint) : 'solid';
    const fillSig = layer.fillOpacity !== undefined && layer.fillOpacity < 1 ? `|fo${layer.fillOpacity}` : '';
    const fxSig = effectsNeedCpuBake(layer.effects)
      ? `|fx:${JSON.stringify(layer.effects)}|mask:${layer.mask ? JSON.stringify(layer.mask.paths) : 0}`
      : '';
    const tier = this.tierFor(effectiveScale, layer.continuousRaster, layer.width ?? 1, layer.height ?? 1);
      const signature = `h:${layer.contentHash ?? ''}|${layer.width}x${layer.height}|${layer.primitive ?? 'path'}|r:${layer.cornerRadius ?? 0}|cr:${layer.cornerRadii ? layer.cornerRadii.join(',') : ''}|${ptsSig}|${layer.fill}|${paintSig}|${strokeSig}|${layer.pathOpen ? 'open' : 'closed'}${fxSig}${fillSig}|t${tier}`;

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
      format: displayReferredUploadFormat(),
      displayReferred: true,
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
  setVideo(key: string, src: string, timeSec: number, fields?: FieldOrder): void {
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
    this.uploadVideoTexture(entry, key, fields);
  }

  /**
   * Hardware playback path: keep the `<video>` element decoding forward and
   * sample its current frame. Seeks only on start, loop wrap, or large drift —
   * NOT every compositor frame (which cannot keep up on 1080p/4K footage).
   */
  setVideoPlayback(key: string, src: string, timeSec: number, fields?: FieldOrder, bucket = 1): void {
    let entry = this.videoEntries.get(key);
    if (!entry || entry.src !== src) {
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
      if (!entry.hasSeeked) {
        entry.hasSeeked = true;
        entry.requestedTime = timeSec;
        v.currentTime = timeSec;
      }
      return;
    }
    const prev = entry.lastPlaybackTime;
    entry.lastPlaybackTime = timeSec;
    const loopWrap = prev !== undefined && timeSec + 0.05 < prev;
    const largeJump = prev !== undefined && Math.abs(timeSec - prev) > 0.35;
    const drift = Math.abs(v.currentTime - timeSec);
    if (!entry.hasSeeked || loopWrap || largeJump || (drift > 0.25 && !v.seeking)) {
      entry.hasSeeked = true;
      entry.requestedTime = timeSec;
      v.currentTime = timeSec;
      void v.play().catch(() => undefined);
    } else if (v.paused && !v.seeking) {
      void v.play().catch(() => undefined);
    }
    this.uploadVideoTexture(entry, key, fields, bucket);
  }

  /** Create/resize the GPU texture and upload the element's current frame. */
  private uploadVideoTexture(entry: VideoEntry, key: string, fields?: FieldOrder, bucket = 1): void {
    const v = entry.video;
    const w = v.videoWidth || 1;
    const h = v.videoHeight || 1;
    let bw = bucket >= 1 || fields ? w : Math.max(1, Math.round(w * bucket));
    let bh = bucket >= 1 || fields ? h : Math.max(1, Math.round(h * bucket));
    const maxDim = this.maxRasterDimension;
    if ((bw > maxDim || bh > maxDim) && bw > 0 && bh > 0) {
      const scale = Math.min(maxDim / bw, maxDim / bh);
      bw = Math.max(1, Math.round(bw * scale));
      bh = Math.max(1, Math.round(bh * scale));
    }
    const poolKey = `vid:${key}:${bw}x${bh}`;
    if (entry.texture === null || entry.w !== bw || entry.h !== bh) {
      if (entry.texture && entry.poolKey) this.resources.freeTexture(entry.poolKey);
      entry.texture = this.resources.texture(
        poolKey,
        { label: `video:${key}`, width: bw, height: bh, format: displayReferredUploadFormat(), displayReferred: true, externalCopy: true },
        /* pinned */ true,
      );
      entry.w = bw;
      entry.h = bh;
      entry.poolKey = poolKey;
    }
    if (fields) {
      const clean = deinterlaceInto(this.fieldsWork, v, w, h, fields);
      if (clean) {
        this.resources.writeTexture(entry.texture, { type: 'canvas', canvas: clean });
        return;
      }
    }
    if (bw !== w || bh !== h) {
      const canvas = this.ensureCanvas('work', bw, bh);
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(v, 0, 0, bw, bh);
        this.resources.writeTexture(entry.texture, { type: 'canvas', canvas });
        return;
      }
    }
    this.resources.writeTexture(entry.texture, { type: 'video', video: v });
  }

  /**
   * Seek + upload a video frame WITH a Canvas2D-only effect chain baked in.
   *
   * Same seek contract as `setVideo`, then drawImage → applyEffectChain →
   * `setFrame`. Signature includes source time so paused scrubbing caches;
   * playback pays per unique frame only when styles need the bake.
   */
  setVideoBaked(key: string, src: string, timeSec: number, bake: ImageBakeSpec, fields?: FieldOrder): void {
    // Ensure the element is seeked via the normal path (creates entry, seeks).
    // Fields is NOT forwarded: the raw element upload is only the placeholder
    // this bake replaces, and the deinterlace happens below, before effects.
    this.setVideo(key, src, timeSec);
    const entry = this.videoEntries.get(key);
    if (!entry || entry.video.readyState < HAVE_CURRENT_DATA || !entry.hasSeeked) return;
    const v = entry.video;
    const nativeW = v.videoWidth || 0;
    const nativeH = v.videoHeight || 0;
    if (!(nativeW > 0) || !(nativeH > 0)) return;
    // Bake at the displayed size, never above native. See `ImageBakeSpec.targetScale`.
    const { w, h } = bakeSize(nativeW, nativeH, bake);
    try {
      const canvas = this.ensureCanvas('work', w, h);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.filter = 'none';
      ctx.clearRect(0, 0, w, h);
      // drawImage downsamples in one step; for a 2–4× reduction the browser's
      // bilinear filter is close enough for a preview bake.
      ctx.drawImage(v, 0, 0, w, h);
      if (fields) {
        // Before the effect chain: effects sampling a combed frame would smear
        // the comb teeth into their output.
        const image = ctx.getImageData(0, 0, w, h);
        deinterlaceData(image.data, w, h, fields);
        ctx.putImageData(image, 0, 0);
      }
      const k = bake.width > 0 ? w / bake.width : 1;
      if (bake.mask && bake.mask.paths.length > 0) {
        const matte = this.nextBakeScratch(w, h);
        const mc = matte.getContext('2d');
        if (mc) {
          const ky = bake.height > 0 ? h / bake.height : 1;
          mc.setTransform(1, 0, 0, 1, 0, 0);
          mc.globalCompositeOperation = 'source-over';
          mc.clearRect(0, 0, w, h);
          mc.setTransform(k, 0, 0, ky, w / 2, h / 2);
          paintMaskMatte(mc, bake.mask, bake.width, bake.height);
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.globalCompositeOperation = 'destination-in';
          ctx.drawImage(matte, 0, 0);
          ctx.globalCompositeOperation = 'source-over';
        }
      }
      applyEffectChain(
        ctx,
        w,
        h,
        scaleEffectLengths(bake.effects, k),
        (sw, sh) => this.nextBakeScratch(sw, sh),
        bake.fillOpacity ?? 1,
        bake.mask,
      );
      const fxSig = bake.effects.map((e) => `${e.type}:${e.enabled !== false ? 1 : 0}:${JSON.stringify(e.params ?? {})}`).join('|');
      const maskSig = bake.mask ? `:m${bake.mask.paths.length}` : '';
      // Frame entries win over video entries in get(), so the baked canvas is
      // what the compositor samples while the video element stays alive for the
      // next seek. Copy out of the pooled work surface before upload — into a
      // POOLED output canvas, not a fresh element per frame: at 30 fps that was
      // thirty 1080p canvas allocations a second, which is GC pressure the
      // frame budget cannot afford.
      const out = this.ensureCanvas('videoBakeOut', w, h);
      const oc = out.getContext('2d');
      if (!oc) return;
      oc.setTransform(1, 0, 0, 1, 0, 0);
      oc.globalCompositeOperation = 'copy';
      oc.drawImage(canvas, 0, 0);
      oc.globalCompositeOperation = 'source-over';
      this.setFrame(key, out, `vb:${timeSec.toFixed(4)}:${w}x${h}:${fxSig}${maskSig}:fo${bake.fillOpacity ?? 1}:f${fields ?? ''}`);
    } catch {
      /* leave the raw video upload from setVideo in place */
    }
  }

  /**
   * Upload an externally-rasterized canvas under `key` (decoded video frames
   * for Frame Mix). The signature dedupes uploads — pass the source time so a
   * new frame re-uploads and a repeat render doesn't.
   */
  setFrame(key: string, canvas: HTMLCanvasElement, signature: string, fields?: FieldOrder): void {
    if (canvas.width < 1 || canvas.height < 1) return;
    const existing = this.frameEntries.get(key);
    if (existing && existing.signature === signature) return;
    if (fields) {
      // Interpret Footage ▸ Fields: rebuild the discarded field before the
      // frame reaches the GPU. On failure (no 2d context) the raw frame
      // uploads — combing, not a missing layer. The caller's signature already
      // carries the field order, so toggling it re-uploads.
      const clean = deinterlaceInto(this.fieldsWork, canvas, canvas.width, canvas.height, fields);
      if (clean) canvas = clean;
    }
    const maxDim = this.maxRasterDimension;
    if ((canvas.width > maxDim || canvas.height > maxDim) && canvas.width > 0 && canvas.height > 0) {
      const scale = Math.min(maxDim / canvas.width, maxDim / canvas.height);
      const targetW = Math.max(1, Math.round(canvas.width * scale));
      const targetH = Math.max(1, Math.round(canvas.height * scale));
      const scaled = document.createElement('canvas');
      scaled.width = targetW;
      scaled.height = targetH;
      const ctx = scaled.getContext('2d');
      if (ctx) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(canvas, 0, 0, targetW, targetH);
        canvas = scaled;
      }
    }
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
        { label: `frame:${key}`, width: canvas.width, height: canvas.height, format: displayReferredUploadFormat(), displayReferred: true, externalCopy: true },
        /* pinned */ true,
      );
    }
    this.resources.writeTexture(tex, { type: 'canvas', canvas });
    this.frameEntries.set(key, { signature, texture: tex, poolKey });
  }

  /**
   * Free the frame entry under `key`, if any. Frame entries SHADOW video
   * entries in `getTexture` (they must — an exact decoded frame beats a
   * seeked element), so a caller that switches a key from `setFrame` back to
   * `setVideo` has to release the frame first or the stale exact frame keeps
   * winning the lookup forever.
   */
  releaseFrame(key: string): void {
    const existing = this.frameEntries.get(key);
    if (!existing) return;
    this.resources.freeTexture(existing.poolKey);
    this.frameEntries.delete(key);
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
    fps = 30,
  ): void {
    const w = Math.max(1, Math.round(fieldW));
    const h = Math.max(1, Math.round(fieldH));
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const requestedScale = dpr * Math.max(1, transformScale) * (this.rasterScale || 1);
    const scale = Math.max(0.5, Math.min(requestedScale, PARTICLE_TEX_MAX / Math.max(w, h)));
    const time = Math.max(0, timeSec);
    const signature = `${particleFieldSignature(cfg, time, w, h, scale)}|fps:${fps}`;
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
    drawParticleField(ctx, cfg, time, w, h, scale, { fps, cacheKey: key });

    if (entry.texture === null || entry.w !== pxW || entry.h !== pxH) {
      entry.texture = this.resources.texture(
        `particles:${key}:${pxW}x${pxH}`,
        { label: `particles:${key}`, width: pxW, height: pxH, format: displayReferredUploadFormat(), displayReferred: true, externalCopy: true },
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
  retain(
    activeKeys: ReadonlySet<string>,
    /** `releaseParked` frees the grace cache too — teardown only. See dispose. */
    opts: { releaseParked?: boolean } = {},
  ): void {
    // ── IMAGE entries get a grace period. Everything below does not. ─────────
    //
    // `activeKeys` is the set of layers visible on THIS FRAME, which is not the
    // same question as "still in the project" — and treating it as such is what
    // made a layer whose clip starts at, say, 2s re-decode its image every
    // single time the playhead crossed 2s. Off-time → evicted → back on-time →
    // decode from scratch → placeholder. The flash was not a one-off on first
    // load; it repeated on every pass and every scrub.
    //
    // A frame-accurate eviction is still wanted for genuinely removed layers
    // (the stranded texture/decoder/bitmap this method was written to fix), so
    // the answer is a bounded grace rather than keeping everything: an image
    // that falls out of the active set is parked, and only actually freed once
    // enough OTHER images have taken its place. Scrubbing over a start point
    // therefore costs nothing, while deleting layers still reclaims memory.
    //
    // Only images are parked. Video entries own a decoder pipeline and live
    // listeners, and text/mask/path/gradient entries are cheap to rebuild — for
    // those, prompt release remains the right trade.
    for (const [key, entry] of [...this.entries]) {
      if (activeKeys.has(key)) {
        this.parkedImages.delete(key);
        continue;
      }
      // Re-park (delete + set) so the insertion order is true LRU.
      this.parkedImages.delete(key);
      this.parkedImages.set(key, entry);
    }
    const ceiling = opts.releaseParked ? 0 : MAX_PARKED_IMAGES;
    while (this.parkedImages.size > ceiling) {
      const oldest = this.parkedImages.keys().next();
      if (oldest.done) break;
      const key = oldest.value;
      const entry = this.parkedImages.get(key)!;
      this.parkedImages.delete(key);
      // Only free if it has not come back into use since being parked.
      if (!activeKeys.has(key)) {
        this.resources.freeTexture(`img:${entry.src}`);
        entry.bitmap?.close();
        this.entries.delete(key);
      }
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

  /**
   * Release every retained GPU/media resource. Call before dropping the provider.
   *
   * `releaseParked` is what makes this a real teardown: `retain` deliberately
   * PARKS images rather than freeing them, so that a playhead crossing a layer's
   * start does not re-decode. On dispose there is no later frame to park for,
   * and skipping it would strand a bitmap and a texture per parked image —
   * reintroducing exactly the leak `retain`'s docstring was written about.
   */
  dispose(): void {
    this.retain(new Set(), { releaseParked: true });
  }

  /**
   * Run an effect chain over a decoded bitmap and hand back the baked result.
   *
   * The chain's px parameters are COMP px while the canvas is at the bitmap's
   * own resolution, so they are scaled by the ratio — the same correction the
   * vector rasterizer applies, and for the same reason: otherwise a 10px inner
   * shadow means something different on a 400px photo than on a 4000px one.
   *
   * Returns null if anything is unavailable, leaving the untouched bitmap in
   * place rather than dropping the layer.
   */
  private ensureCanvas(slot: 'work' | 'a' | 'b' | 'videoBakeOut', w: number, h: number): HTMLCanvasElement {
    const cur =
      slot === 'work' ? this.bakeWork
      : slot === 'a' ? this.bakeScratchA
      : slot === 'b' ? this.bakeScratchB
      : this.videoBakeOut;
    if (cur && cur.width === w && cur.height === h) return cur;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    if (slot === 'work') this.bakeWork = c;
    else if (slot === 'a') this.bakeScratchA = c;
    else if (slot === 'b') this.bakeScratchB = c;
    else this.videoBakeOut = c;
    return c;
  }

  /** Alternating scratch so consecutive acquire calls never share a canvas. */
  private nextBakeScratch(w: number, h: number): HTMLCanvasElement {
    const slot = (this.bakeScratchToggle++ & 1) === 0 ? 'a' : 'b';
    return this.ensureCanvas(slot, w, h);
  }

  /**
   * Device-px-per-comp-unit quantized to a small ladder. This decides how many
   * pixels an image BAKE is worth: the baked texture is only ever sampled at
   * the layer's on-screen size, so baking a 4K source shown at 400 px through
   * a 30-effect chain at native resolution was 8 M pixels × 30 passes of work
   * whose extra detail no one could see. Quantized so zoom/pan does not
   * re-bake every frame; keyed into the cache signature so crossing a tier
   * re-bakes at the new resolution.
   */
  private bakeResolutionTier(): number {
    const s = this.rasterScale || 1;
    if (s <= 0.28) return 0.25;
    if (s <= 0.55) return 0.5;
    if (s <= 1.05) return 1;
    if (s <= 1.55) return 1.5;
    if (s <= 2.1) return 2;
    if (s <= 3.1) return 3;
    return 4;
  }

  private async bakeImageBitmap(
    bitmap: ImageBitmap,
    bake: ImageBakeSpec,
    premultipliedFile: boolean | undefined,
  ): Promise<ImageBitmap | null> {
    const srcW = bitmap.width;
    const srcH = bitmap.height;
    if (!(srcW > 0) || !(srcH > 0)) return null;
    // Bake at the resolution the layer is DISPLAYED at (plus headroom for
    // resampling quality), never above the source. Effect pixel-lengths are
    // already normalised through `scaleEffectLengths(effects, k)`, so the
    // chain is resolution-independent by construction — only sharpness beyond
    // what the screen can show is given up, and zooming in re-bakes sharper
    // via the tier in the cache key.
    const BAKE_HEADROOM = 1.5;
    const needW = bake.width > 0 ? bake.width * this.bakeResolutionTier() * BAKE_HEADROOM : srcW;
    const factor = Math.min(1, Math.max(0.05, needW / srcW));
    let w = Math.max(1, Math.round(srcW * factor));
    let h = Math.max(1, Math.round(srcH * factor));
    const maxDim = this.maxRasterDimension;
    if (w > maxDim || h > maxDim) {
      const clampScale = Math.min(maxDim / w, maxDim / h);
      w = Math.max(1, Math.round(w * clampScale));
      h = Math.max(1, Math.round(h * clampScale));
    }
    try {
      const canvas = this.ensureCanvas('work', w, h);
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.filter = 'none';
      ctx.clearRect(0, 0, w, h);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, w, h);
      const k = bake.width > 0 ? w / bake.width : 1;
      // MASK FIRST, matching the vector path. An interior style is generated
      // from the layer's silhouette, and for a masked layer that silhouette is
      // the masked one — run the chain first and an inner shadow hangs off the
      // bitmap's rectangle instead of the mask's contour. The matte is drawn in
      // the layer's centred space scaled to the bitmap's resolution, since the
      // two are rarely the same size.
      if (bake.mask && bake.mask.paths.length > 0) {
        const matte = this.nextBakeScratch(w, h);
        const mc = matte.getContext('2d');
        if (mc) {
          const ky = bake.height > 0 ? h / bake.height : 1;
          mc.setTransform(1, 0, 0, 1, 0, 0);
          mc.globalCompositeOperation = 'source-over';
          mc.clearRect(0, 0, w, h);
          mc.setTransform(k, 0, 0, ky, w / 2, h / 2);
          paintMaskMatte(mc, bake.mask, bake.width, bake.height);
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.globalCompositeOperation = 'destination-in';
          ctx.drawImage(matte, 0, 0);
          ctx.globalCompositeOperation = 'source-over';
        }
      }
      applyEffectChain(
        ctx,
        w,
        h,
        scaleEffectLengths(bake.effects, k),
        (sw, sh) => this.nextBakeScratch(sw, sh),
        bake.fillOpacity ?? 1,
        bake.mask,
      );
      void premultipliedFile;
      // A canvas is straight alpha; 'premultiply' brings it into the invariant.
      // Copy into a dedicated canvas so the pooled work surface can be reused
      // without racing createImageBitmap's read of these pixels.
      const out = document.createElement('canvas');
      out.width = w;
      out.height = h;
      const oc = out.getContext('2d');
      if (!oc) return null;
      oc.drawImage(canvas, 0, 0);
      return await createImageBitmap(out, decodeOptions(false));
    } catch {
      return null;
    }
  }

  private async decode(
    key: string,
    src: string,
    fillColor: string | undefined,
    entry: ImageEntry,
    mediaTime?: number,
  ): Promise<void> {
    let bitmap: ImageBitmap;
    if (entry.unbaked) {
      bitmap = entry.unbaked;
    } else {
      try {
        if (
          mediaTime !== undefined
          && Number.isFinite(mediaTime)
          && (/^data:image\/svg\+xml/i.test(src) || /\.svg(\?|#|$)/i.test(src))
        ) {
          const { rasterizeSvgAtTime } = await import('../svg/liveSvgRaster');
          // Interactive playback rasters at 1024 px and caches frames; exact
          // media timing (export / harness) pays for the full 2048 px raster.
          bitmap = await rasterizeSvgAtTime(src, mediaTime, { exportQuality: this.exactMediaTiming });
        } else {
          bitmap = await this.loader(src, fillColor, entry.premultipliedFile);
        }
      } catch {
        return; // broken source — leave the placeholder in place
      }
      // A newer setImage for this key (different src) supersedes this decode.
      if (this.entries.get(key) !== entry) return;
      // Live SVG frames must NOT park as unbaked — each time needs a fresh draw.
      if (mediaTime === undefined) entry.unbaked = bitmap;
    }
    // A newer setImage for this key (different src) supersedes this decode.
    if (this.entries.get(key) !== entry) return;

    // Canvas2D-only effects (Inner Shadow / Glow, Satin, Bevel, Stroke, Fill…)
    // have no GPU form, so they are baked into the bitmap here — the same
    // round-trip the vector rasterizer does, and the only way they render on a
    // photo at all. Gated by imageNeedsCpuBake; see there for what is excluded.
    if (entry.bake) {
      const baked = await this.bakeImageBitmap(bitmap, entry.bake, entry.premultipliedFile);
      if (this.entries.get(key) !== entry) return; // superseded while baking
      if (baked) {
        bitmap = baked;
        // The bake produced its bitmap from a CANVAS, whose pixels are straight
        // alpha, decoded with 'premultiply'. So whatever the FILE was, what we
        // now hold is a premultiplied-labelled bitmap — the "straight file" row
        // of the table below — and the upload flag has to say so or the browser
        // un-premultiplies it and the halo comes back.
        entry.premultipliedFile = false;
      }
    }

    // Downscale oversized bitmaps that exceed the GPU's maximum texture dimension
    // (e.g. giant screenshots such as 3072x24608 exceeding 8192/16384).
    // WebGPU and WebGL reject textures above maxTextureDimension2D, which otherwise
    // invalidates the texture and prevents any content from rendering.
    const maxDim = this.maxRasterDimension;
    if ((bitmap.width > maxDim || bitmap.height > maxDim) && bitmap.width > 0 && bitmap.height > 0) {
      const scale = Math.min(maxDim / bitmap.width, maxDim / bitmap.height);
      const targetW = Math.max(1, Math.round(bitmap.width * scale));
      const targetH = Math.max(1, Math.round(bitmap.height * scale));
      let downscaled: ImageBitmap | null = null;
      if (typeof OffscreenCanvas !== 'undefined') {
        try {
          const off = new OffscreenCanvas(targetW, targetH);
          const ctx = off.getContext('2d');
          if (ctx) {
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(bitmap, 0, 0, targetW, targetH);
            downscaled = typeof createImageBitmap === 'function'
              ? await createImageBitmap(off, decodeOptions(false))
              : ({ width: targetW, height: targetH, close() {} } as unknown as ImageBitmap);
          }
        } catch {
          downscaled = null;
        }
      }
      if (!downscaled && typeof document !== 'undefined') {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = targetW;
          canvas.height = targetH;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(bitmap, 0, 0, targetW, targetH);
            downscaled = typeof createImageBitmap === 'function'
              ? await createImageBitmap(canvas, decodeOptions(false))
              : ({ width: targetW, height: targetH, close() {} } as unknown as ImageBitmap);
          }
        } catch {
          downscaled = null;
        }
      }
      if (downscaled) {
        if (bitmap !== entry.unbaked) {
          try { bitmap.close(); } catch { /* */ }
        }
        bitmap = downscaled;
        entry.premultipliedFile = false;
      }
    }

    entry.width = bitmap.width || 1;
    entry.height = bitmap.height || 1;
    // The texture id carries the alpha mode: two layers can point at the same
    // file with different Interpret Footage settings, and they must not share one
    // uploaded texture — the mode is baked in by the upload, not applied per draw.
    const texId = `img:${entry.src}`;
    const tex = this.resources.texture(
      texId,
      { label: `image:${src}`, width: entry.width, height: entry.height, format: displayReferredUploadFormat(), displayReferred: true, externalCopy: true },
      /* pinned */ true,
    );
    // `decodeOptions` has already brought the bytes into the invariant, so the
    // upload must do NOTHING — and "do nothing" is expressed by matching the
    // bitmap's own premultiply LABEL, which is what this flag ends up meaning
    // for bitmaps:
    //
    //   straight file      decoded 'premultiply' → labelled premultiplied
    //                      → flag false → dest premultipliedAlpha true → no-op
    //   premultiplied file decoded 'none' → labelled straight (the label is a
    //                      lie; the bytes are already multiplied)
    //                      → flag true → dest premultipliedAlpha false → no-op
    //
    // Passing `true` unconditionally looks right and is not: it tells WebGPU the
    // destination is non-premultiplied, so the browser UN-premultiplies what the
    // decode just multiplied and the halo comes straight back. Measured that way
    // round, the premultiplied-declared-straight ramp read linear rms 0.70 where
    // the double multiply predicts 53.77.
    this.resources.writeTexture(tex, { type: 'bitmap', bitmap, alreadyPremultiplied: entry.premultipliedFile });
    entry.texture = tex;
    entry.bitmap = bitmap;
    entry.ready = true;
    this.onChange?.();
  }

  /**
   * What a not-yet-decoded image or video draws: NOTHING.
   *
   * ── This used to be `texture:white`, and that WAS the bug ──────────────────
   *
   * A layer whose clip starts partway into the timeline is not in the snapshot
   * until it becomes visible, so its source is registered — and its decode
   * begins — on the very frame it appears. Handing back an opaque white 1×1 in
   * the meantime meant every such layer flashed a white rectangle before its
   * picture arrived. Most visible on icons and logos: small, light, and usually
   * sitting on a dark composition.
   *
   * The old rationale was "so a box still shows while loading, and no textured
   * layer ever silently vanishes". That is a developer-facing convenience with a
   * user-facing artifact — showing the WRONG pixels is worse than showing none,
   * and for the frame or two it lasts a white box is indistinguishable from a
   * real white layer.
   *
   * ── Why `texture:white` could not simply be recoloured ─────────────────────
   *
   * It has a second, legitimate consumer: `CompositionPass` binds it as the
   * identity texture for SOLID layers, where the solid's colour is multiplied
   * against it (`isSolid && !tex`). Turning that transparent would multiply
   * every solid layer to nothing. Two unrelated roles had been collapsed onto
   * one texture — the same shape as the bake-vs-GPU predicate pair — so they get
   * one texture each.
   *
   * Transparent BLACK, not transparent white: this pipeline is premultiplied, so
   * zero coverage means all four channels zero.
   */
  private placeholder(): ResolvedTexture {
    const texture = this.resources.texture(
      'texture:transparent',
      { label: 'transparent', width: 1, height: 1, format: 'rgba8unorm' },
      true,
    );
    if (!this.hasInitTransparent) {
      const data = new Uint8Array([0, 0, 0, 0]);
      this.resources.writeTexture(texture, { type: 'buffer', data, width: 1, height: 1 });
      this.hasInitTransparent = true;
    }
    // `ready: false` is the honest answer and costs nothing — no renderer pass
    // reads this field today. Reporting `true` would make the flag a lie the
    // moment something starts to.
    return { texture, sampler: this.sampler(), ready: false };
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
    // A stale texture (rebake in flight) still draws — `ready` says whether
    // THIS bake has landed, but flashing transparent while it hasn't is worse
    // than showing last frame's pixels for a tick.
    if (entry && entry.texture) {
      return { texture: entry.texture, sampler: this.sampler(), ready: entry.ready, sampleLinear: entry.sampleLinear };
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
      // `p.feather` is the per-vertex width override — variable feather redraws
      // the whole matte, so it must invalidate like any coordinate.
      path.points.map((p) => `${p.x},${p.y},${p.inX},${p.inY},${p.outX},${p.outY},${p.feather ?? ''}`).join('|') +
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
      format: displayReferredUploadFormat(),
      displayReferred: true,
    });
    this.maskEntries.set(key, { kind: 'mask', signature, texture });
  }


}

/** Rasterize a text layer to a canvas, mirroring Canvas2DBackend's text render
 *  path exactly — font family/weight/style, letter spacing, per-line alignment
 *  and multi-line layout — supersampled for crispness. The quad the renderer
 *  maps this onto is the layer's box, so text is laid out in a box-sized canvas
 *  with the same anchors Canvas2D uses (which draws centred at the box origin). */


/**
 * Rasterize a 2D light's wash: `color` at the centre fading to transparent at
 * the edge, baked once at a fixed size and stretched to the light's box by the
 * renderable (intensity drives the renderable opacity, not the texel).
 *
 * A SPOT is then masked down to its cone. Before this, every type rasterized to
 * the same isotropic circle and the texture was cached on colour alone, so a
 * spot light was pixel-identical to a point light: cone angle, cone feather and
 * light angle were three shipped inspector controls with no visual effect
 * whatsoever on a 2D layer.
 *
 * The cone MASKS the radial gradient rather than replacing it, so a pixel
 * inside the cone is bit-identical to what a point light would have drawn, and
 * only the shaping is new. Non-spot types take the original path untouched.
 */
function rasterizeLight(light: LightWash): HTMLCanvasElement {
  const s = LIGHT_TEX_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = s;
  canvas.height = s;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const c = s / 2;
  const g = ctx.createRadialGradient(c, c, 0, c, c, c);
  g.addColorStop(0, light.color);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  if (light.type !== 'spot') return canvas;

  // Same cone rule as `shadeLayer` and the per-fragment shader: hard cut at the
  // half-cone, linear ramp across a feather expressed as a PERCENT of it.
  // `angle` is 0 = →, 90 = ↓, which is exactly atan2's convention with y down.
  const aim = ((light.angle ?? 0) * Math.PI) / 180;
  const half = Math.max(1e-3, (((light.cone ?? 0) / 2) * Math.PI) / 180);
  const feather = half * (light.coneFeather === undefined ? 0.2 : Math.max(0, light.coneFeather) / 100);

  const img = ctx.getImageData(0, 0, s, s);
  const d = img.data;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      // getImageData is straight (un-premultiplied) alpha per spec, so scaling
      // coverage means scaling A alone — touching RGB here would darken the
      // cone edge toward black instead of fading it out.
      const a = (y * s + x) * 4 + 3;
      d[a] = d[a]! * spotConeFactor(x + 0.5 - c, y + 0.5 - c, aim, half, feather);
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/**
 * A spot cone's coverage at an offset from the light centre, 0..1.
 *
 * Exported and pure because the rasterizer above needs a real 2D canvas, which
 * jsdom does not provide — the cone maths would otherwise be verifiable only
 * through the GPU harness. Mirrors the cone rule in `shadeLayer` and in the
 * per-fragment shader: hard cut at the half-cone, linear ramp across a feather
 * given in absolute radians.
 */
export function spotConeFactor(
  dx: number,
  dy: number,
  aimRad: number,
  halfConeRad: number,
  featherRad: number,
): number {
  // Dead centre has no direction; the light is on top of the pixel.
  if (dx === 0 && dy === 0) return 1;
  let delta = Math.abs(Math.atan2(dy, dx) - aimRad);
  // Angles wrap. Without this a cone aimed near ±180° reads as ~2π away from
  // half its own pixels and is cut in two.
  if (delta > Math.PI) delta = 2 * Math.PI - delta;
  if (delta > halfConeRad) return 0;
  if (featherRad > 1e-6 && delta > halfConeRad - featherRad) {
    return (halfConeRad - delta) / featherRad;
  }
  return 1;
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



