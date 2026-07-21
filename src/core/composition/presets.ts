/**
 * The single source of truth for composition setup: sizes, frame rates and
 * durations.
 *
 * This used to be three copies — one hardcoded in the dashboard's setup modal,
 * one in NewCompositionDialog, one in CompositionSettingsDialog — which drifted
 * (the dashboard's duration was a dropdown that stopped at 60 seconds, so a
 * two-minute video was literally unauthorable). One catalog, three consumers.
 *
 * Presets are grouped by where the video is GOING, because that is how anyone
 * actually picks: "this is an Instagram reel", not "this is 1080×1920".
 */

export interface SizePreset {
  id: string;
  /** What it is, in the user's terms. */
  label: string;
  /** Where it's going — the group heading. */
  group: SizeGroup;
  width: number;
  height: number;
  /** Shown as a secondary line: aspect + typical use. */
  note?: string;
}

export type SizeGroup = 'Social' | 'YouTube' | 'Big screen' | 'Web & other';

/**
 * Hard limits. 16px floor keeps the renderer sane; 7680 is 8K, past which the
 * canvas/WebGL path is unreliable on most GPUs.
 */
export const MIN_DIMENSION = 16;
export const MAX_DIMENSION = 7680;

/** 0.1s is the shortest thing worth animating; 2 hours is a generous ceiling. */
export const MIN_DURATION = 0.1;
export const MAX_DURATION = 7200;

export const MIN_FPS = 1;
export const MAX_FPS = 240;

export const SIZE_PRESETS: readonly SizePreset[] = [
  // ── Social ──────────────────────────────────────────────────────────
  { id: 'ig_reel', label: 'Instagram Reel / Story', group: 'Social', width: 1080, height: 1920, note: '9:16 · also TikTok, YouTube Shorts' },
  { id: 'ig_post', label: 'Instagram Post', group: 'Social', width: 1080, height: 1080, note: '1:1 square feed' },
  { id: 'ig_portrait', label: 'Instagram Portrait', group: 'Social', width: 1080, height: 1350, note: '4:5 · takes the most feed height' },
  { id: 'tiktok', label: 'TikTok', group: 'Social', width: 1080, height: 1920, note: '9:16 full screen' },
  { id: 'x_post', label: 'X / Twitter Post', group: 'Social', width: 1600, height: 900, note: '16:9 timeline video' },
  { id: 'li_post', label: 'LinkedIn Post', group: 'Social', width: 1200, height: 1200, note: '1:1 · safe for feed crops' },

  // ── YouTube ─────────────────────────────────────────────────────────
  { id: 'yt_1080', label: 'YouTube 1080p', group: 'YouTube', width: 1920, height: 1080, note: '16:9 · the standard upload' },
  { id: 'yt_1440', label: 'YouTube 1440p', group: 'YouTube', width: 2560, height: 1440, note: '16:9 · better bitrate than 1080p' },
  { id: 'yt_4k', label: 'YouTube 4K', group: 'YouTube', width: 3840, height: 2160, note: '16:9 · best quality tier' },
  { id: 'yt_shorts', label: 'YouTube Shorts', group: 'YouTube', width: 1080, height: 1920, note: '9:16 vertical' },

  // ── Big screen ──────────────────────────────────────────────────────
  { id: 'uhd_4k', label: '4K UHD', group: 'Big screen', width: 3840, height: 2160, note: '16:9 · TVs, displays, digital signage' },
  { id: 'uhd_8k', label: '8K UHD', group: 'Big screen', width: 7680, height: 4320, note: '16:9 · heavy; only if you need it' },
  { id: 'dci_2k', label: 'DCI 2K (Cinema)', group: 'Big screen', width: 2048, height: 1080, note: '256:135 · digital cinema' },
  { id: 'dci_4k', label: 'DCI 4K (Cinema)', group: 'Big screen', width: 4096, height: 2160, note: '256:135 · digital cinema' },
  { id: 'ultrawide', label: 'Ultrawide / Cinematic', group: 'Big screen', width: 2560, height: 1080, note: '21:9 · banners, LED walls' },

  // ── Web & other ─────────────────────────────────────────────────────
  { id: 'hd_720', label: 'HD 720p', group: 'Web & other', width: 1280, height: 720, note: '16:9 · light web embeds' },
  { id: 'web_banner', label: 'Web Banner', group: 'Web & other', width: 1456, height: 816, note: '16:9 · hero / landing loops' },
  { id: 'classic_43', label: 'Classic 4:3', group: 'Web & other', width: 1440, height: 1080, note: '4:3 · retro / archival' },
  { id: 'presentation', label: 'Presentation', group: 'Web & other', width: 1920, height: 1080, note: '16:9 · slides, keynotes' },
];

export const SIZE_GROUPS: readonly SizeGroup[] = ['Social', 'YouTube', 'Big screen', 'Web & other'];

/** Reduced W:H, e.g. 1920x1080 -> "16:9". Shared with `describeSize`. */
export function aspectRatioLabel(width: number, height: number): string {
  const g = gcd(Math.round(width), Math.round(height)) || 1;
  return `${Math.round(width / g)}:${Math.round(height / g)}`;
}

export interface FpsPreset {
  value: number;
  label: string;
}

/**
 * Includes the broadcast fractional rates — 23.976 and 29.97 are what actual
 * delivery specs ask for, and rounding them to 24/30 is a real sync bug.
 */
export const FPS_PRESETS: readonly FpsPreset[] = [
  { value: 23.976, label: '23.976 — film (NTSC pulldown)' },
  { value: 24, label: '24 — film / cinematic' },
  { value: 25, label: '25 — PAL broadcast' },
  { value: 29.97, label: '29.97 — NTSC broadcast' },
  { value: 30, label: '30 — standard digital / social' },
  { value: 50, label: '50 — PAL high frame rate' },
  { value: 60, label: '60 — smooth motion, gaming' },
  { value: 120, label: '120 — slow-motion source' },
];

export interface DurationPreset {
  seconds: number;
  label: string;
}

/** Quick chips. The field itself accepts any value up to MAX_DURATION. */
export const DURATION_PRESETS: readonly DurationPreset[] = [
  { seconds: 5, label: '5s' },
  { seconds: 10, label: '10s' },
  { seconds: 15, label: '15s' },
  { seconds: 30, label: '30s' },
  { seconds: 60, label: '1m' },
  { seconds: 180, label: '3m' },
  { seconds: 600, label: '10m' },
];

export const clampDimension = (n: number): number =>
  Math.round(Math.min(MAX_DIMENSION, Math.max(MIN_DIMENSION, Number.isFinite(n) ? n : MIN_DIMENSION)));

export const clampFps = (n: number): number =>
  Math.min(MAX_FPS, Math.max(MIN_FPS, Number.isFinite(n) ? n : 30));

export const clampDuration = (n: number): number =>
  Math.min(MAX_DURATION, Math.max(MIN_DURATION, Number.isFinite(n) ? n : 1));

export function findSizePreset(width: number, height: number): SizePreset | undefined {
  return SIZE_PRESETS.find((p) => p.width === width && p.height === height);
}

/** "1080×1920 · 9:16" — the reassurance line under a custom size. */
export function describeSize(width: number, height: number): string {
  return `${width}×${height} · ${aspectRatioLabel(width, height)}`;
}

/** Seconds → "1m 30s" / "45s" / "2h 5m". Timeline lengths read badly in raw seconds. */
export function describeDuration(seconds: number): string {
  if (seconds < 60) return `${Number(seconds.toFixed(2))}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  const parts = [h ? `${h}h` : '', m ? `${m}m` : '', s ? `${s}s` : ''].filter(Boolean);
  return parts.join(' ');
}

function gcd(a: number, b: number): number {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y) [x, y] = [y, x % y];
  return x;
}
