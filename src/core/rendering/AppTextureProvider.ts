/**
 * AppTextureProvider — the app-side `TextureProvider` for the GPU @motion/renderer
 * path (S2 of the Canvas2D→GPU swap). It resolves a renderable's `textureKey`
 * (`asset:<id>` for image/video, `text:<id>` for text) to a real GPU texture.
 *
 * The renderer's passes call `get(key)` synchronously mid-frame, but image decode
 * is async, so the flow is:
 *   1. Each frame, MotionRendererBackend feeds current sources via `setImage()`.
 *   2. `get()` returns the decoded texture once ready, else a shared 1×1 white
 *      placeholder (so a box still shows while loading — matching Canvas2D — and
 *      no textured layer ever silently vanishes).
 *   3. When a decode completes we flip the entry to ready and fire `onChange`,
 *      which the app turns into a re-render so the real pixels appear next frame.
 *
 * Text and video still resolve to the placeholder for now (documented S2b gap):
 * text needs glyph rasterization parity and video needs per-frame element
 * management — both require browser verification we can't do headlessly yet.
 */

import type {
  ResourceManager,
  ResolvedTexture,
  TextureProvider,
  TextureHandle,
  SamplerHandle,
} from '@motion/renderer';
import type { RenderLayer } from './RenderBackend';
import { maskSegments } from '@core/effects/mask';

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
export type ImageLoader = (src: string) => Promise<ImageBitmap>;

const defaultLoader: ImageLoader = async (src) => {
  const res = await fetch(src);
  const blob = await res.blob();
  return createImageBitmap(blob);
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

/** What a text layer needs rasterized: string + font + colour + box size. */
export interface TextSpec {
  text: string;
  fontSize: number;
  color: string;
  width: number;
  height: number;
}

interface TextEntry {
  kind: 'text';
  signature: string;
  texture: TextureHandle;
}

/** Creates the HTMLVideoElement backing a video layer. Injectable for tests. */
export type VideoFactory = (src: string) => HTMLVideoElement;

const defaultVideoFactory: VideoFactory = (src) => {
  const v = document.createElement('video');
  v.muted = true;
  v.autoplay = false;
  v.loop = true;
  v.crossOrigin = 'anonymous';
  v.src = src;
  return v;
};

interface VideoEntry {
  kind: 'video';
  src: string;
  video: HTMLVideoElement;
  texture: TextureHandle | null;
  w: number;
  h: number;
}

/** Supersample factor for the text raster so it stays crisp when zoomed in. */
const TEXT_SUPERSAMPLE = 2;
/** HTMLMediaElement.HAVE_CURRENT_DATA — enough decoded to sample a frame. */
const HAVE_CURRENT_DATA = 2;
/** Only re-seek a video when the playhead drifts past this (seconds). */
const SEEK_EPSILON = 0.05;

export class AppTextureProvider implements TextureProvider {
  /** Fired when an async decode finishes and a texture becomes ready. */
  onChange: (() => void) | null = null;

  private readonly entries = new Map<string, ImageEntry>();
  private readonly textEntries = new Map<string, TextEntry>();
  private readonly videoEntries = new Map<string, VideoEntry>();
  private readonly pathEntries = new Map<string, PathEntry>();
  private readonly maskEntries = new Map<string, MaskEntry>();
  private readonly loader: ImageLoader;
  private readonly videoFactory: VideoFactory;
  private hasInitWhite = false;

  constructor(
    private readonly resources: ResourceManager,
    opts: {
      loader?: ImageLoader;
      videoFactory?: VideoFactory;
    } = {},
  ) {
    this.loader = opts.loader ?? defaultLoader;
    this.videoFactory = opts.videoFactory ?? defaultVideoFactory;
  }

  /**
   * Register/refresh the image source behind a renderable key. Idempotent: the
   * same (key, src) never re-decodes. A changed src supersedes the old decode.
   */
  setImage(key: string, src: string): void {
    const existing = this.entries.get(key);
    if (existing && existing.src === src) return; // already loading or loaded
    const entry: ImageEntry = { kind: 'image', src, texture: null, bitmap: null, width: 1, height: 1, ready: false };
    this.entries.set(key, entry);
    void this.decode(key, src, entry);
  }

  /**
   * Register/refresh the text behind a renderable key. Rasterizes synchronously
   * (so it's ready the same frame) and re-rasterizes only when the string, font,
   * colour, or box size changes (signature-keyed).
   */
  setText(key: string, spec: TextSpec): void {
    const signature = `${spec.text}|${spec.fontSize}|${spec.color}|${Math.round(spec.width)}x${Math.round(spec.height)}`;
    const existing = this.textEntries.get(key);
    if (existing && existing.signature === signature) return;
    const canvas = rasterizeText(spec);
    const tex = this.resources.texture(
      `text:${key}:${signature}`,
      { label: `text:${key}`, width: canvas.width, height: canvas.height, format: 'rgba8unorm' },
      /* pinned */ true,
    );
    this.resources.writeTexture(tex, { type: 'canvas', canvas });
    this.textEntries.set(key, { kind: 'text', signature, texture: tex });
  }

  /**
   * Register/refresh the custom vector path behind a renderable key.
   * Rasterizes synchronously and uploads the generated path texture to the GPU.
   */
  setPath(key: string, layer: RenderLayer): void {
    const ptsSig = layer.pathPoints ? layer.pathPoints.map(p => `${p.x},${p.y},${p.inX},${p.inY},${p.outX},${p.outY}`).join('|') : '';
    const strokeSig = layer.stroke ? `${layer.stroke.width},${layer.stroke.color},${layer.stroke.align}` : 'no-stroke';
    const signature = `${layer.width}x${layer.height}|${ptsSig}|${layer.fill}|${strokeSig}`;
    
    const existing = this.pathEntries.get(key);
    if (existing && existing.signature === signature) return;

    const canvas = rasterizePath(layer);
    const tex = this.resources.texture(
      `path:${key}:${signature}`,
      { label: `path:${key}`, width: canvas.width, height: canvas.height, format: 'rgba8unorm' },
      /* pinned */ true,
    );
    this.resources.writeTexture(tex, { type: 'canvas', canvas });
    this.pathEntries.set(key, { kind: 'path', signature, texture: tex });
  }

  /**
   * Register/refresh the video behind a renderable key and upload the frame at
   * `timeSec`. Reuses one HTMLVideoElement per source, seeks it toward the
   * playhead, and re-uploads the current frame each call (video content changes
   * every frame, so there is no signature cache). Returns the placeholder via
   * get() until the element has decoded a frame.
   */
  setVideo(key: string, src: string, timeSec: number): void {
    let entry = this.videoEntries.get(key);
    if (!entry || entry.src !== src) {
      entry = { kind: 'video', src, video: this.videoFactory(src), texture: null, w: 1, h: 1 };
      this.videoEntries.set(key, entry);
    }
    const v = entry.video;
    if (v.readyState < HAVE_CURRENT_DATA) return; // not decoded yet → placeholder
    if (Math.abs(v.currentTime - timeSec) > SEEK_EPSILON) v.currentTime = timeSec;
    const w = v.videoWidth || 1;
    const h = v.videoHeight || 1;
    if (entry.texture === null || entry.w !== w || entry.h !== h) {
      entry.texture = this.resources.texture(
        `vid:${key}:${w}x${h}`,
        { label: `video:${key}`, width: w, height: h, format: 'rgba8unorm' },
        /* pinned */ true,
      );
      entry.w = w;
      entry.h = h;
    }
    this.resources.writeTexture(entry.texture, { type: 'video', video: v });
  }

  /** Forget keys no longer present in the scene (frees the GPU textures via GC). */
  retain(activeKeys: ReadonlySet<string>): void {
    for (const key of this.entries.keys()) {
      if (!activeKeys.has(key)) this.entries.delete(key);
    }
    for (const key of this.textEntries.keys()) {
      if (!activeKeys.has(key)) this.textEntries.delete(key);
    }
    for (const key of this.videoEntries.keys()) {
      if (!activeKeys.has(key)) this.videoEntries.delete(key);
    }
    for (const key of this.pathEntries.keys()) {
      if (!activeKeys.has(key)) this.pathEntries.delete(key);
    }
    for (const key of this.maskEntries.keys()) {
      if (!activeKeys.has(key)) this.maskEntries.delete(key);
    }
  }

  private async decode(key: string, src: string, entry: ImageEntry): Promise<void> {
    let bitmap: ImageBitmap;
    try {
      bitmap = await this.loader(src);
    } catch {
      return; // broken source — leave the placeholder in place
    }
    // A newer setImage() for this key (different src) supersedes this decode.
    if (this.entries.get(key) !== entry) return;
    entry.width = bitmap.width || 1;
    entry.height = bitmap.height || 1;
    const tex = this.resources.texture(
      `img:${src}`,
      { label: `image:${src}`, width: entry.width, height: entry.height, format: 'rgba8unorm' },
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
    
    const ptsSig = layer.mask.paths.map(path => 
      path.points.map(p => `${p.x},${p.y},${p.inX},${p.inY},${p.outX},${p.outY}`).join('|') + `|inv:${path.inverted}`
    ).join('||');
    const signature = `${layer.width}x${layer.height}|mask:${ptsSig}`;

    const existing = this.maskEntries.get(key);
    if (existing && existing.signature === signature) return;

    const w = Math.max(1, Math.round(layer.width * TEXT_SUPERSAMPLE));
    const h = Math.max(1, Math.round(layer.height * TEXT_SUPERSAMPLE));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.scale(TEXT_SUPERSAMPLE, TEXT_SUPERSAMPLE);
    ctx.translate(layer.width / 2, layer.height / 2);

    ctx.fillStyle = 'white';
    const p = new Path2D();
    const inverted = layer.mask.paths.some((m) => m.inverted);
    if (inverted) p.rect(-layer.width / 2, -layer.height / 2, layer.width, layer.height);

    for (const path of layer.mask.paths) {
      const segs = maskSegments(path);
      if (segs.length === 0) continue;
      p.moveTo(segs[0]!.x0, segs[0]!.y0);
      for (const s of segs) p.bezierCurveTo(s.cx1, s.cy1, s.cx2, s.cy2, s.x1, s.y1);
      p.closePath();
    }
    ctx.fill(p, 'evenodd');

    const tex = this.resources.texture(
      `mask:${key}:${signature}`,
      { label: `mask:${key}`, width: canvas.width, height: canvas.height, format: 'rgba8unorm' },
      /* pinned */ true,
    );
    this.resources.writeTexture(tex, { type: 'canvas', canvas });
    this.maskEntries.set(key, { kind: 'mask', signature, texture: tex });
  }


}

/** Rasterize a text layer to a canvas matching Canvas2DBackend's text rendering
 *  (600-weight Inter, centred, middle baseline), supersampled for crispness. The
 *  quad the renderer maps this onto is the layer's box, so text is drawn centred
 *  in a box-sized canvas. */
function rasterizeText(spec: TextSpec): HTMLCanvasElement {
  const w = Math.max(1, Math.round(spec.width * TEXT_SUPERSAMPLE));
  const h = Math.max(1, Math.round(spec.height * TEXT_SUPERSAMPLE));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.scale(TEXT_SUPERSAMPLE, TEXT_SUPERSAMPLE);
  ctx.font = `600 ${spec.fontSize}px Inter, system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillStyle = spec.color;
  ctx.fillText(spec.text || 'Text', spec.width / 2, spec.height / 2);
  return canvas;
}

/** Rasterize a custom vector path shape layer onto a supersampled canvas. */
function rasterizePath(layer: RenderLayer): HTMLCanvasElement {
  const w = Math.max(1, Math.round(layer.width * TEXT_SUPERSAMPLE));
  const h = Math.max(1, Math.round(layer.height * TEXT_SUPERSAMPLE));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  ctx.scale(TEXT_SUPERSAMPLE, TEXT_SUPERSAMPLE);
  // Center coordinates inside canvas bounds
  ctx.translate(layer.width / 2, layer.height / 2);

  ctx.beginPath();
  const pts = layer.pathPoints || [];
  if (pts.length > 0) {
    ctx.moveTo(pts[0]!.x, pts[0]!.y);
    for (let i = 0; i < pts.length; i++) {
      const curr = pts[i]!;
      const next = pts[(i + 1) % pts.length]!;
      ctx.bezierCurveTo(
        curr.outX, curr.outY,
        next.inX, next.inY,
        next.x, next.y
      );
    }
    ctx.closePath();
  }

  // Draw fill
  ctx.fillStyle = layer.fill;
  ctx.fill();

  // Draw stroke if specified
  if (layer.stroke && layer.stroke.width > 0) {
    ctx.lineWidth = layer.stroke.width;
    ctx.strokeStyle = layer.stroke.color;
    ctx.lineCap = layer.stroke.cap || 'butt';
    ctx.lineJoin = layer.stroke.join || 'miter';
    if (layer.stroke.dash && layer.stroke.dash.length > 0) {
      ctx.setLineDash(layer.stroke.dash);
    }

    if (layer.stroke.align === 'inside') {
      ctx.save();
      ctx.clip();
      ctx.lineWidth = layer.stroke.width * 2;
      ctx.stroke();
      ctx.restore();
    } else if (layer.stroke.align === 'outside') {
      ctx.save();
      const outClip = new Path2D();
      outClip.rect(-layer.width, -layer.height, layer.width * 2, layer.height * 2);
      if (pts.length > 0) {
        outClip.moveTo(pts[0]!.x, pts[0]!.y);
        for (let i = 0; i < pts.length; i++) {
          const curr = pts[i]!;
          const next = pts[(i + 1) % pts.length]!;
          outClip.bezierCurveTo(
            curr.outX, curr.outY,
            next.inX, next.inY,
            next.x, next.y
          );
        }
        outClip.closePath();
      }
      ctx.clip(outClip, 'evenodd');
      ctx.lineWidth = layer.stroke.width * 2;
      ctx.stroke();
      ctx.restore();
    } else {
      ctx.stroke();
    }
  }

  return canvas;
}

