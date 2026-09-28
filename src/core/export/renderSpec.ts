/**
 * The vocabulary of a render: what a Render Queue job, an Export and a CLI
 * render ask the ENGINE for (electron/engineExport.ts runs it as
 * `premation-engine --export`). There is no page renderer any more
 * (docs/TS_ENGINE_REMOVAL.md phase 4): the in-window sinks, the WebM muxer,
 * the GIF encoder and the raw pipe are gone, and so is renderJob.ts — this is
 * what was left of them that the UI still speaks.
 */

import type { ExportChapter } from '@core/export/chapters';

/** The moving-picture formats the engine export writes. */
export type VideoFormat = 'mp4' | 'webm' | 'gif' | 'mov';

export type ExportQuality = 'high' | 'medium' | 'draft';

/**
 * ProRes flavour for `.mov` — the same family AE's output modules offer.
 * 4444 is the only one that carries alpha; the 422 tiers trade quality for
 * file size (HQ ≈ mastering, 422 ≈ edit, LT/Proxy ≈ offline).
 */
export type ProresProfile = 'proxy' | 'lt' | '422' | 'hq' | '4444';

export const PRORES_PROFILE_LABELS: Record<ProresProfile, string> = {
  '4444': 'ProRes 4444 (alpha)',
  hq: 'ProRes 422 HQ',
  '422': 'ProRes 422',
  lt: 'ProRes 422 LT',
  proxy: 'ProRes 422 Proxy',
};

/** The mp4 encoder main's ffmpeg command line uses (Settings ▸ Export ▸ Video encoder). */
export type VideoEncoderId = 'libx264' | 'h264_nvenc' | 'hevc_nvenc' | 'h264_qsv' | 'h264_videotoolbox';

export const VIDEO_ENCODER_LABELS: Record<VideoEncoderId, string> = {
  libx264: 'Software (libx264)',
  h264_nvenc: 'NVIDIA NVENC (H.264)',
  hevc_nvenc: 'NVIDIA NVENC (HEVC)',
  h264_qsv: 'Intel Quick Sync (H.264)',
  h264_videotoolbox: 'Apple VideoToolbox (H.264)',
};

export function isVideoEncoderId(v: unknown): v is VideoEncoderId {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(VIDEO_ENCODER_LABELS, v);
}

/**
 * Whether this build can render files at all: the desktop shell's export
 * supervisor (the engine export). A browser build has no engine.
 */
export function canEncodeLocally(): boolean {
  return typeof window !== 'undefined' && !!window.motionEditor?.exportSupervisor?.enqueue;
}

export type OutputFormat = VideoFormat | 'png-sequence' | 'jpg-sequence' | 'exr-sequence';

/**
 * Everything a render needs to know, and nothing about who asked for it.
 *
 * A queued job is this plus its queue state (id, status, progress, a paused
 * sink); a CLI invocation is this and nothing else.
 */
export interface RenderJobSpec {
  compositionName: string;
  /**
   * WHICH composition to render.
   *
   * Only `compositionName` existed — a label — so every job rendered whatever
   * comp happened to be active. Queue three comps, get three copies of one,
   * each correctly named.
   */
  compositionId?: string;
  outputPath: string;
  format: OutputFormat;
  /** Output frame size. May differ from the composition's own size (half-res
   *  previews, oversized deliverables). */
  width: number;
  height: number;
  /**
   * The COMPOSITION's own size, which is not the same thing as the output size.
   *
   * These were conflated: the comp was described to the renderer as being
   * `width × height` — the output size — so a job rendered at anything other than
   * full resolution described a comp that did not exist. Every layer positioned
   * beyond the shrunken bounds fell outside the frame, and a half-resolution
   * render came out empty. Optional so jobs queued before this existed still run,
   * falling back to the output size.
   */
  compWidth?: number;
  compHeight?: number;
  fps: number;
  durationSec: number;
  /**
   * The export RANGE, in seconds (end exclusive), captured at QUEUE time.
   *
   * Without these the job read `getWorkArea()` at RENDER time — a live,
   * GLOBAL value belonging to whichever comp is focused — so "Entire
   * composition" still rendered only the current work area, and queueing
   * comp A then editing comp B's in/out rendered A's picture over B's range.
   * Absent (legacy jobs), the whole comp renders.
   */
  rangeStartSec?: number;
  rangeEndSec?: number;
  transparent: boolean;
  /** The comp's own background. Was hardcoded '#101014' at render time. */
  background?: string;
  /** Encoder quality tier. Draft renders fast and looks it. */
  quality?: 'high' | 'medium' | 'draft';
  /** mov only — ProRes flavour, captured from the dialog at queue time. */
  proresProfile?: 'proxy' | 'lt' | '422' | 'hq' | '4444';
  /** mov only — 16 bits per channel (the engine's half-float surface, rgba64le). */
  bitDepth?: 8 | 16;
  /**
   * mp4 only — the H.264/HEVC encoder, captured from Settings at queue time
   * for the same reason the range is: a preference changed while the job
   * waits must not change what the job was queued to produce.
   */
  videoEncoder?: 'libx264' | 'h264_nvenc' | 'hevc_nvenc' | 'h264_qsv' | 'h264_videotoolbox';
  /**
   * Chapter marks, resolved from the composition's markers at QUEUE time.
   *
   * Captured rather than re-derived at render time for the same reason the
   * range is (see `rangeStartSec`): the marker list is live editor state, so a
   * job that read it when it finally ran would deliver chapters nobody chose.
   * Absent means no chapters — which is what the headless CLI leaves it as,
   * deliberately: a terminal render has no dialog to have ticked the box in,
   * and inventing chapters for it would change what `premation render` writes
   * based on editor state the invocation never mentioned.
   */
  chapters?: ReadonlyArray<ExportChapter>;
}

/**
 * The file extension a queued format produces.
 *
 * One home for this: the Export dialog hardcoded `.webm` for everything that
 * wasn't a sequence, so a GIF job was *named*.webm — matching the queue's old
 * behaviour of actually shipping a WebM under that name.
 */
export function outputExtFor(format: OutputFormat): string {
  switch (format) {
    case 'png-sequence':
    case 'jpg-sequence':
    case 'exr-sequence':
      return 'zip';
    default:
      return format;
  }
}
