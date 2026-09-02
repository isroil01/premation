/**
 * One composition → one output file, as a plain function.
 *
 * This is the render the Render Queue performs, lifted out of the queue's
 * zustand store so it can be performed by something that is not a queue. The
 * headless CLI (`electron/cliRender.ts` → `@core/cli/headlessRender`) renders
 * the same jobs from a terminal, and the whole point of the local edition
 * having a CLI is that a rendered file is the SAME file either way — same
 * deterministic frame loop, same sink, same comp→frame fit.
 *
 * Keeping this in the store would have meant a second implementation of "how a
 * job becomes options", which is exactly the drift that made a queued job
 * render the active comp on a hardcoded background (see `RenderJobSpec.compWidth`
 * and `.background` for what each of those cost). One home for it, and both
 * callers are stuck with whatever is true here.
 *
 * The store still owns everything a QUEUE owns — status, progress coalescing,
 * pause/resume bookkeeping, the serial loop. This module owns only the render.
 */

import {
  exportAudioEntries,
  renderSequenceZip,
  renderExrSequenceZip,
  renderVideo,
  renderGifBlob,
  createResumableVideoRender,
  type ExportOptions,
  type ResumableVideoRender,
} from '@core/export/exportManager';
import { canEncodeLocally, type VideoFormat } from '@core/export/videoSink';
import type { ExportChapter } from '@core/export/chapters';
import { DEFAULT_COMPOSITION } from '@stores/compositionStore';
import { compSizeOf } from '@core/composition/compSizes';

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
    // HDR presets encode into an MP4 container — falling through advertised a
    // ".hdr10" file that never exists (the delivered file was always .mp4).
    case 'hdr10':
    case 'hlg':
      return 'mp4';
    default:
      // A plugin format's "extension" would otherwise be "plugin:id.exporter"
      // — a colon in a filename. Fall back to a neutral extension; the sink
      // renames by its real extension on delivery.
      return format.startsWith('plugin:') ? 'bin' : format;
  }
}

/**
 * The exporter options a job renders with.
 *
 * `persistForResume` is the queue's flag and nobody else's: it adds the
 * `resumeSpec` that makes the staging dir describe itself on disk, so a
 * relaunched app can find these frames and rebuild the job that was producing
 * them. The headless CLI and the batch renderer leave it off — an invocation
 * that has exited is not something a later editor session should offer to
 * finish, and its staging dir would then be a directory nothing ever collects.
 */
export function jobExportOptions(job: RenderJobSpec, persistForResume = false): ExportOptions {
  return {
    format: job.format,
    ...(persistForResume ? { resumeSpec: job } : {}),
    width: job.width,
    height: job.height,
    fps: job.fps,
    duration: job.durationSec,
    time: 0,
    quality: job.quality ?? 'high',
    ...(job.proresProfile ? { proresProfile: job.proresProfile } : {}),
    ...(job.chapters?.length ? { chapters: job.chapters } : {}),
    // The captured range, never the LIVE work area: a queued job must render
    // what was queued, regardless of what the user does to any timeline
    // between queueing and running.
    ...(job.rangeStartSec !== undefined && job.rangeEndSec !== undefined
      ? { range: { startSec: job.rangeStartSec, endSec: job.rangeEndSec } }
      : { useWorkArea: false }),
    baseName: job.outputPath.replace(/\.[a-z0-9]+$/i, ''),
    comp: {
      // The COMPOSITION's size, so the comp→frame fit is right at any output
      // scale. See RenderJobSpec.compWidth for what using the output size did.
      width: job.compWidth ?? job.width,
      height: job.compHeight ?? job.height,
      transparent: job.transparent,
      // The job's own comp and background — this rendered the ACTIVE comp on a
      // hardcoded '#101014' regardless of what was queued.
      background: job.background ?? DEFAULT_COMPOSITION.background,
      ...(job.compositionId ? { rootId: job.compositionId } : {}),
      compSizeOf,
    },
  };
}

/** What a finished job produced, and how to hand it to the user. */
export type JobOutput =
  | { kind: 'blob'; blob: Blob; ext: string }
  | {
      kind: 'file';
      ext: string;
      frames: number;
      save(name: string): Promise<string | null>;
      saveTo(dir: string, name: string, overwrite?: boolean): Promise<string>;
      discard(): Promise<void>;
    };

/** A paused render's live state — an open sink plus where to resume from. */
export interface JobResume {
  render: ResumableVideoRender;
  nextOffset: number;
}

/**
 * Whether an interrupted render of this format can be picked up by a LATER RUN
 * of the app.
 *
 * The question is only ever "does this format stage frames as files": mp4, mov
 * (ProRes) and the rest of the ffmpeg formats write one file per frame and
 * encode once at the end, so the interrupted state is real, inspectable and
 * still there tomorrow. Sequence exports build a single zip in memory, a plugin
 * exporter's intermediate state lives inside the plugin, and the browser's
 * streaming sinks have consumed each frame by the time the next arrives — for
 * all of those an interruption really is a restart, and the queue must say so
 * rather than offer a Resume that silently re-renders from zero.
 */
export function isResumableAcrossRestart(format: OutputFormat): boolean {
  if (format.endsWith('-sequence') || format.startsWith('plugin:')) return false;
  return canEncodeLocally();
}

/**
 * What identifies "the same job" to a session that has forgotten everything.
 *
 * A restored queue and a staging dir on disk are two independent records of the
 * same render, and the id that linked them (`stagingJobId`) is only written
 * once a pause has been recorded — an app that CRASHED mid-render never got to
 * write it. Without a second way to match, that job comes back twice: once as
 * the queued spec it was persisted as, once as an orphan rebuilt from the
 * manifest. So jobs are also matched on what they PRODUCE, which is the part a
 * user would call the same job.
 *
 * Deliberately not the whole spec: a comp edited between sessions must still
 * match the render that was in flight, or the match fails exactly when the
 * frames on disk matter most.
 */
export function specSignature(spec: RenderJobSpec): string {
  return [
    spec.compositionId ?? spec.compositionName,
    spec.outputPath,
    spec.format,
    spec.width,
    spec.height,
    spec.fps,
  ].join('|');
}

/**
 * Rebuild a live render around a staging dir a previous session left behind.
 *
 * `adopted` comes from `render:adoptJob`, which has already re-registered the
 * directory in the main process under its original id and counted the frames
 * that are really there. Everything from here is the ordinary resumable path:
 * the same sink, the same staging dir, the same `finish()` — the only
 * difference is that the frames before `nextFrame` were rendered by a process
 * that no longer exists.
 *
 * Null when the format cannot be resumed at all, which the caller must treat as
 * "this job starts over" rather than silently continuing.
 */
export async function adoptRenderJob(
  job: RenderJobSpec,
  adopted: { jobId: string; stagedFrames: number; nextFrame: number },
): Promise<JobResume | null> {
  if (!isResumableAcrossRestart(job.format)) return null;
  const render = await createResumableVideoRender(
    jobExportOptions(job, true),
    job.format as VideoFormat,
    { jobId: adopted.jobId, stagedFrames: adopted.stagedFrames },
  );
  if (!render) return null;
  return { render, nextOffset: adopted.nextFrame };
}

/**
 * Render one job to a file — or pause partway, keeping its staged frames.
 *
 * `persistForResume` asks for the staging dir to describe itself on disk so the
 * render survives a restart of the app, not just a pause. Off by default,
 * because the two callers that are NOT the queue (the headless CLI, the batch
 * template renderer) render for a process that exits when it is done: a
 * manifest there would advertise a resumable job to an editor session that has
 * no queue entry for it and no reason to finish it.
 */
export async function renderJobOutput(
  job: RenderJobSpec,
  onProgress: (f: number) => void,
  signal: AbortSignal,
  resume?: JobResume,
  persistForResume = false,
): Promise<JobOutput | { kind: 'paused'; resume: JobResume }> {
  const opts = jobExportOptions(job, persistForResume);

  if (job.format === 'png-sequence' || job.format === 'jpg-sequence') {
    const ext = job.format === 'png-sequence' ? 'png' : 'jpg';
    const audio = await exportAudioEntries(opts);
    return { kind: 'blob', blob: await renderSequenceZip(opts, ext, onProgress, signal, audio), ext: 'zip' };
  }

  if (job.format === 'exr-sequence') {
    return { kind: 'blob', blob: await renderExrSequenceZip(opts, onProgress, signal), ext: 'zip' };
  }

  // GIF has no browser encoder path through the sink, so it keeps its own.
  if (job.format === 'gif' && !canEncodeLocally()) {
    return { kind: 'blob', blob: await renderGifBlob(opts, onProgress, signal), ext: 'gif' };
  }

  // ── The resumable path (desktop) ──
  // A paused job keeps its open sink — frames already staged on disk stay
  // there — and comes back at the exact frame the loop stopped on. Pausing
  // used to abort the render outright: the sink was disposed, the staging dir
  // deleted, and Resume meant re-rendering from frame 0.
  const render = resume?.render ?? await createResumableVideoRender(opts, job.format);
  if (render) {
    const from = resume?.nextOffset ?? 0;
    try {
      const res = await render.run(from, onProgress, signal);
      if (!res.done) return { kind: 'paused', resume: { render, nextOffset: res.nextOffset } };
      const result = await render.finish();
      return result.kind === 'blob'
        ? { kind: 'blob', blob: result.blob, ext: result.ext }
        : { kind: 'file', ext: result.ext, frames: result.frames, save: result.save, saveTo: result.saveTo, discard: result.discard };
    } catch (e) {
      // run() disposed on real errors; finish() failures still hold the sink.
      // Either way the job is FAILED now, so nothing may keep a resume handle.
      await render.dispose().catch(() => undefined);
      throw e;
    }
  }

  // Browser fallback: streaming sinks can't pause, so the one-shot path stays.
  const result = await renderVideo(opts, job.format, onProgress, signal);
  return result.kind === 'blob'
    ? { kind: 'blob', blob: result.blob, ext: result.ext }
    : {
        kind: 'file',
        ext: result.ext,
        frames: result.frames,
        save: result.save,
        saveTo: result.saveTo,
        discard: result.discard,
      };
}
