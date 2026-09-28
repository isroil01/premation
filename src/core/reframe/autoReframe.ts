/**
 * Auto-reframe — retarget a composition to another aspect ratio: the target
 * shapes and sizes the UI offers. The analysis (where the eye goes, the pan
 * that follows it) and the new composition are the ENGINE's `autoReframe` job
 * (native/engine/src/jobs/kind_auto_reframe.cpp); the page analysis that ran
 * on the TypeScript renderer is gone (docs/TS_ENGINE_REMOVAL.md phase 4).
 */

/** A target shape, as offered in the UI. */
export interface AspectPreset {
  id: string;
  label: string;
  /** Width : height. */
  ratio: number;
  hint: string;
}

export const ASPECT_PRESETS: readonly AspectPreset[] = [
  { id: '9:16', label: '9:16 Vertical', ratio: 9 / 16, hint: 'Reels, Shorts, TikTok, Stories' },
  { id: '1:1', label: '1:1 Square', ratio: 1, hint: 'Feed posts' },
  { id: '4:5', label: '4:5 Portrait', ratio: 4 / 5, hint: 'Instagram feed — the tallest a feed post may be' },
  { id: '16:9', label: '16:9 Widescreen', ratio: 16 / 9, hint: 'YouTube, broadcast' },
  { id: '4:3', label: '4:3 Classic', ratio: 4 / 3, hint: 'Archive and broadcast masters' },
];

/**
 * The target frame size for an aspect, sized off the source.
 *
 * The SHORTER of the source's edges is preserved, so retargeting never invents
 * resolution: a 1920×1080 master becomes 1080×1920 vertical, not 2160×3840
 * upscaled from pixels that were never there.
 */
export function targetSizeFor(
  source: { width: number; height: number },
  ratio: number,
): { width: number; height: number } {
  const shortEdge = Math.min(source.width, source.height);
  const [w, h] = ratio >= 1
    ? [Math.round(shortEdge * ratio), shortEdge]
    : [shortEdge, Math.round(shortEdge / ratio)];
  // Even dimensions: every h.264/HEVC encoder wants them, and an odd edge here
  // becomes an ffmpeg scale filter at export or a refused encode.
  return { width: w - (w % 2), height: h - (h % 2) };
}

/** A reframe that could not be made (the job's own message). */
export class AutoReframeError extends Error {}
