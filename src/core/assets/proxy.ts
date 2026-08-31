/**
 * Proxies — a low-resolution stand-in decoded during editing, never during
 * output.
 *
 * ## Why, with numbers
 *
 * Scrubbing 4K footage costs one `<video>` seek per playhead position, and that
 * seek is essentially the whole cost. Measured on this machine (Chromium,
 * H.264 yuv420p, GOP 60, 30 samples per cell, median ms):
 *
 * |                       |    4K |  1080p |   540p |
 * |-----------------------|------:|-------:|-------:|
 * | seek, random          | 171.8 |   36.6 |   17.4 |
 * | seek, 1-frame step    | 148.0 |   40.9 |   16.3 |
 * | GPU upload (WebGPU)   |   4.3 |    4.4 |    3.8 |
 * | GPU upload (WebGL2)   |   0.1 |    0.1 |    0.1 |
 *
 * Two things follow, and they are the whole design rationale:
 *
 *  1. **Seek is 97.6% of the cost at 4K** and is the only term that scales with
 *     resolution — 4K seeks 4.7× slower than 1080p. Upload is FLAT across a 16×
 *     payload range (31.6 → 2.0 MB/frame), so it is per-call overhead, not
 *     bytes; re-uploading the full-res frame every render (AppTextureProvider
 *     .setVideo) is not what makes 4K slow.
 *  2. Seek cost is decode-from-keyframe cost. So a proxy wins on resolution AND
 *     on **GOP length** — hence `-g 12` below, far shorter than the 60 the
 *     measurement used. Resolution alone predicts 3.6×; the short GOP is on top.
 *
 * ## The invariant that matters most
 *
 * Export and any offline render use the ORIGINAL, always, whatever the toggle
 * says. That is enforced by POLARITY rather than by vigilance: `useProxies` is
 * absent/false by default and only the interactive viewport ever sets it true.
 * Export, the offline renderer and the render-test harness never pass it, so
 * they cannot opt in by forgetting something. Proven end-to-end against encoded
 * output in `proxyExport.test.ts`.
 *
 * ## Two proxies, because they answer different questions
 *
 * The VIEWPORT proxy above exists so a human can scrub. An ANALYSIS proxy
 * exists so a machine can measure, and the two want different encodes.
 *
 * Tracking, scene-edit detection, roto and stabilisation all walk footage
 * frame by frame reading LUMA, and none of them needs 4K to do it — a feature
 * matcher works on a downsampled pyramid, and this app's own auto-reframe has
 * analysed at 160px wide since it was written. What they are paying for is the
 * seek, and the table above says seek is 97.6% of the cost at 4K and the only
 * term that scales with resolution. So the analysis proxy goes further down
 * than the viewport one (960px long edge rather than 1920) and further again on
 * GOP (`-g 6` rather than `-g 12`), because an analysis walk is seek-heavy in a
 * way that scrubbing is not: a reverse walk restarts at a keyframe per chunk.
 *
 * It is never seen. That is what lets it be ugly — and what makes it safe: the
 * tier is requested explicitly by name, no render path can name it, and the
 * `ProxyTier` guard in `proxyExport.test.ts` fails if an output path so much as
 * mentions the type.
 *
 * ## Time alignment is by construction, not by synchronisation
 *
 * A proxy substitutes PIXELS ONLY. Every timing and geometry fact —
 * `conformFps`, duration, PAR, alpha interpretation, loop count, trim, slip,
 * stretch, time remap — keeps reading the ORIGINAL asset's `metadata` and
 * `interpret` through `sourceOf`, which this module does not touch. There is no
 * second record to keep in step, so a proxy cannot drift out of alignment with
 * its source; the only way to break alignment would be to encode a proxy at a
 * different duration, which `proxyEncodeArgs` cannot do (no `-t`, no `-r`, no
 * `-ss`: the whole stream is transcoded 1:1).
 */

/**
 * Which decode a caller wants.
 *
 * An ENUM rather than a wider boolean, and defaulting to `'original'`, so the
 * export invariant is still enforced by polarity: a caller that says nothing
 * gets full resolution. Adding a tier therefore cannot weaken the guarantee —
 * there is no value of this type that an output path reaches by omission.
 */
export type ProxyTier =
  /** Full resolution. Every output path, by saying nothing. */
  | 'original'
  /** The scrubbing stand-in. Only the interactive viewport opts in. */
  | 'viewport'
  /** The measuring stand-in. Only the analysis walks opt in; never displayed. */
  | 'analysis';

/** Where a proxy is in its lifecycle. */
export type ProxyStatus =
  /** An ffmpeg job is running. The asset renders at FULL resolution meanwhile. */
  | 'generating'
  /** Usable: `src` points at a decodable low-res stand-in. */
  | 'ready'
  /** Generation ran and failed, or the file went missing. `error` says why.
   *  Renders fall back to full resolution — never an error, never a black frame. */
  | 'failed';

export interface ProxyRecord {
  status: ProxyStatus;
  /** Object URL / path for the stand-in. Present only when `status` is 'ready'. */
  src?: string;
  /** Stored size of the stand-in, for the UI to show what you are editing at. */
  width?: number;
  height?: number;
  /** True when the user attached this file themselves rather than generating it.
   *  Detaching a user proxy must not delete their file — see `assetStore`. */
  userSupplied?: boolean;
  /** Why generation failed, shown in the Assets panel. */
  error?: string;
}

/**
 * Long edge at or below which a proxy stops being worth the disk and the wait.
 * Below this the source already seeks in ~17ms (measured), which is inside a
 * 30fps frame budget.
 */
export const PROXY_MIN_SOURCE_LONG_EDGE = 1280;

/** Long edge a proxy is reduced to at or below. */
export const PROXY_TARGET_LONG_EDGE = 1920;

/** Shortest edge a proxy is allowed to have, so a very wide source stays legible. */
export const PROXY_MIN_LONG_EDGE = 640;

/**
 * The proxy size for a source, or null when a proxy is not worth making.
 *
 * THE RULE, stated because the brief requires it be derived rather than
 * hardcoded: halve the source, then keep halving while the long edge is still
 * above `PROXY_TARGET_LONG_EDGE`. Dimensions are rounded to even numbers
 * because H.264 yuv420p and VP9 yuva420p both require even dimensions and
 * ffmpeg fails outright on odd ones. Sources whose long edge is already at or
 * below `PROXY_MIN_SOURCE_LONG_EDGE` get no proxy — halving them would land
 * under `PROXY_MIN_LONG_EDGE` and buy a few ms.
 *
 * Halving specifically (rather than scaling to a fixed target) keeps the
 * scaler on clean power-of-two ratios, which is both faster and visibly
 * cleaner than an arbitrary resample.
 *
 *   3840×2160 → 1920×1080     7680×4320 → 1920×1080
 *   1920×1080 →  960× 540     2048×858  → 1024×430  (odd 429 → 430)
 *   1280×720  → null          640×360   → null
 */
export function proxyResolution(
  width: number,
  height: number,
): { width: number; height: number } | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return halveTo(width, height, PROXY_TARGET_LONG_EDGE, PROXY_MIN_SOURCE_LONG_EDGE);
}

/** The halving rule itself, shared by both tiers so they cannot drift apart on
 *  rounding. See `proxyResolution` for the reasoning. */
function halveTo(
  width: number,
  height: number,
  targetLongEdge: number,
  minSourceLongEdge: number,
): { width: number; height: number } | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  if (Math.max(width, height) <= minSourceLongEdge) return null;

  let w = width;
  let h = height;
  do {
    w /= 2;
    h /= 2;
  } while (Math.max(w, h) > targetLongEdge);

  // Even, and never smaller than 2px on either axis (an extreme aspect ratio
  // like 4096×2 would otherwise round a dimension to 0 and ffmpeg would fail).
  const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);
  return { width: even(w), height: even(h) };
}

/**
 * Long edge an ANALYSIS proxy is reduced to at or below.
 *
 * 960 is 540p on a 16:9 source. The repo's measurement puts a 540p random seek
 * at 17.4ms against 171.8ms at 4K — an order of magnitude, which is the figure
 * an analysis walk actually lives or dies on.
 */
export const ANALYSIS_TARGET_LONG_EDGE = 960;

/**
 * Long edge at or below which an analysis proxy stops being worth making.
 *
 * Lower than the viewport's 1280 because the analysis target is lower: a 1000px
 * source would get no viewport proxy and still halve usefully for analysis.
 */
export const ANALYSIS_MIN_SOURCE_LONG_EDGE = 960;

/**
 * The analysis-proxy size for a source, or null when one is not worth making.
 *
 * Same rule as `proxyResolution` — halve, keep halving while the long edge is
 * above the target, round to even because both encoders require it — with the
 * analysis target. Sharing the RULE and differing only in the constant is
 * deliberate: two independently written downscale rules would eventually
 * disagree about rounding, and a track measured on a grid half a pixel off from
 * the one the UI reports is the hardest kind of wrong to see.
 *
 *   3840x2160 -> 960x540      1920x1080 -> 960x540
 *   1280x720  -> 640x360      960x540   -> null
 */
export function analysisResolution(
  width: number,
  height: number,
): { width: number; height: number } | null {
  return halveTo(width, height, ANALYSIS_TARGET_LONG_EDGE, ANALYSIS_MIN_SOURCE_LONG_EDGE);
}

/**
 * ffmpeg arguments for an analysis proxy.
 *
 * Same no-`-ss`/no-`-t`/no-`-r` discipline as the viewport encode, for the same
 * reason: frame N of the proxy must BE frame N of the source, or every measured
 * sample lands on the wrong comp frame. That property is what lets the tracker
 * treat a proxy as a resolution change and nothing else.
 *
 * `-g 6` rather than 12: an analysis walk seeks far more than scrubbing does —
 * `createReverseFrameWalk` restarts at a keyframe for every backward chunk —
 * and seek cost is decode-from-keyframe cost.
 *
 * ALWAYS H.264 yuv420p, even for an alpha source. Two reasons, and the first is
 * not "alpha does not matter": it is that every consumer of this tier reads the
 * Y PLANE (see `lumaExtract`), so keeping a planar YUV format is what preserves
 * the zero-copy luma path that makes analysis fast in the first place. Alpha is
 * then genuinely irrelevant — a matte flattened against black changes the luma
 * of transparent regions, which were never being tracked.
 */
export function analysisEncodeArgs(
  input: string,
  output: string,
  size: { width: number; height: number },
): string[] {
  return [
    '-y', '-loglevel', 'error', '-i', input,
    '-vf', `scale=${size.width}:${size.height}`,
    '-an',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26',
    '-pix_fmt', 'yuv420p', '-g', '6', '-keyint_min', '6', '-sc_threshold', '0',
    output,
  ];
}

/**
 * Container and codec for a proxy of this source.
 *
 * Alpha is the reason this is a decision and not a constant. H.264 yuv420p has
 * no alpha channel, so encoding an alpha source to it would silently flatten
 * the matte — the footage would keep compositing in the viewport but against
 * black, which reads as a rendering bug rather than a proxy artefact. Alpha
 * sources therefore go to VP9 `yuva420p` in WebM, which Chromium decodes with
 * its alpha intact.
 */
export function proxyCodec(hasAlpha: boolean): { ext: 'mp4' | 'webm'; mime: string } {
  return hasAlpha ? { ext: 'webm', mime: 'video/webm' } : { ext: 'mp4', mime: 'video/mp4' };
}

/**
 * ffmpeg arguments to transcode `input` into a proxy at `output`.
 *
 * Deliberately carries NO timing flags. There is no `-ss`, no `-t`, no `-r`:
 * the stream is transcoded 1:1, so the proxy has the same duration, the same
 * frame count and the same presentation timestamps as the source. That is what
 * makes "proxy and source stay time-aligned" a property of the encode rather
 * than something the app has to keep checking.
 *
 * `-g 12` is the deliberate divergence from a normal delivery encode: proxies
 * exist to be SEEKED, and seek cost is decode-from-keyframe cost, so a short
 * GOP is worth the extra bitrate. `-an` drops audio because the AudioEngine
 * always reads the original (see `resolveMediaSrc` — audio is never proxied).
 */
export function proxyEncodeArgs(
  input: string,
  output: string,
  size: { width: number; height: number },
  hasAlpha: boolean,
): string[] {
  const common = ['-y', '-loglevel', 'error', '-i', input, '-vf', `scale=${size.width}:${size.height}`, '-an'];
  return hasAlpha
    ? [...common, '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-crf', '34', '-b:v', '0', '-g', '12', '-deadline', 'realtime', '-cpu-used', '5', output]
    : [...common, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '25', '-pix_fmt', 'yuv420p', '-g', '12', output];
}

/** The minimum an asset must expose for a caller to pick a pixel source. */
export interface ProxyResolvable {
  src?: string;
  /** The scrubbing stand-in. */
  proxy?: ProxyRecord;
  /** The measuring stand-in. A separate record, not a variant of `proxy`,
   *  because the two have independent lifecycles: attaching, detaching or
   *  failing one must say nothing about the other. */
  analysisProxy?: ProxyRecord;
}

/** A ready record with a usable src, or undefined. */
function usable(p: ProxyRecord | undefined): string | undefined {
  return p?.status === 'ready' && p.src ? p.src : undefined;
}

/**
 * Which URL a caller should decode for this asset.
 *
 * The ONE place the substitution happens. Every failure mode — no proxy, still
 * generating, failed, ready-but-src-missing, and above all a caller that never
 * asked — resolves to full resolution rather than to an error or a black frame.
 *
 * The `analysis` tier FALLS THROUGH to the viewport proxy before the original,
 * which the other two never do. That is not a shortcut: an analysis walk cares
 * about decode cost and nothing else, so a 1920px stand-in is strictly better
 * for it than a 3840px one when no 960px stand-in exists. A viewport request
 * must NOT fall the other way — the analysis proxy is 540p and displaying it
 * would look like the quality bug the proxy badge exists to prevent.
 */
export function resolveMediaSrc(asset: ProxyResolvable, tier: ProxyTier = 'original'): string | undefined {
  if (tier === 'viewport') return usable(asset.proxy) ?? asset.src;
  if (tier === 'analysis') return usable(asset.analysisProxy) ?? usable(asset.proxy) ?? asset.src;
  return asset.src;
}

/** Which tier `resolveMediaSrc` would actually serve for this request. Callers
 *  that must know the decoded RESOLUTION (every analysis walk does — it scales
 *  its measurements back through it) ask this rather than comparing URLs. */
export function servedProxy(asset: ProxyResolvable, tier: ProxyTier): ProxyRecord | undefined {
  if (tier === 'viewport') return usable(asset.proxy) ? asset.proxy : undefined;
  if (tier === 'analysis') {
    if (usable(asset.analysisProxy)) return asset.analysisProxy;
    if (usable(asset.proxy)) return asset.proxy;
  }
  return undefined;
}

/** True when this asset is currently being decoded from a proxy — what the UI
 *  badges, because a proxy in use silently looks like a quality bug. */
export function isProxyInUse(asset: ProxyResolvable, tier: ProxyTier | boolean): boolean {
  // The boolean overload is the viewport toggle, which is what every UI call
  // site holds; spelling it as a tier at each of them would say less.
  const t: ProxyTier = typeof tier === 'boolean' ? (tier ? 'viewport' : 'original') : tier;
  return !!servedProxy(asset, t);
}

/**
 * Whether a proxy record can be PERSISTED and restored across a reload.
 *
 * Both generated and user-attached proxies point `src` at a `blob:` URL from
 * `URL.createObjectURL`, and those URLs are document-scoped — they die the
 * instant the page reloads. A persisted 'ready' record pointing at one restores
 * as a DEAD url, and `resolveMediaSrc` would then hand that dead url to the
 * decoder (a black frame) instead of falling back to full resolution. So a
 * 'ready' record is persistable only when its `src` is durable (e.g. a backend
 * URL in cloud mode), never a blob:/data: URL.
 *
 * 'generating' is never persistable — its ffmpeg child dies with the app, so a
 * restored job would spin forever with nothing to cancel (the pre-existing rule
 * this generalises). 'failed' carries only an error and is safe to keep.
 *
 * Pure and DOM-free so it can gate both the save and the load side and be tested
 * directly.
 */
export function isPersistableProxy(p: ProxyRecord | undefined | null): boolean {
  if (!p) return false;
  if (p.status === 'generating') return false;
  if (p.status === 'ready') {
    return !!p.src && !p.src.startsWith('blob:') && !p.src.startsWith('data:');
  }
  return true; // 'failed'
}
