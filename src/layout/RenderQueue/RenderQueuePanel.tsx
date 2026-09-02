/**
 * RenderQueuePanel — After Effects–style Render Queue.
 *
 * Lists export jobs; shows status, progress, elapsed time and, when something
 * goes wrong, the actual reason. Jobs run serially through the same deterministic
 * pipeline the Export dialog uses, so a queued render is not a second
 * implementation of exporting.
 *
 * Rendering does not take the app away from you: frames are rasterised between
 * yields to the main thread and, on the desktop, encoded by ffmpeg in a separate
 * process.
 *
 * Stopping does not take the render away from you either. Pause and Stop halt
 * the frame loop and KEEP the sink — the staged frames stay on disk and the job
 * resumes at the frame it stopped on. Throwing that away is a separate control
 * (Discard) with its own confirmation, because it is a separate decision.
 */

import { useState } from 'react';
import { Icon } from '@components/Icon';
import { EmptyState } from '@components/EmptyState';
import { useCompositionStore } from '@stores/compositionStore';
import {
  canChooseOutputDir,
  useRenderQueueStore,
  outputExtFor,
  type OutputFormat,
  type RenderJob,
} from '@stores/renderQueueStore';
import { canEncodeLocally } from '@core/export/videoSink';
import { OutputModuleDialog, type OutputSettings } from './OutputModuleDialog';
import { getTimelineController } from '@core/timeline/TimelineController';
import { customConfirm } from '@components/Modal/Dialogs';
import styles from './RenderQueuePanel.module.css';

const FORMAT_LABEL: Record<OutputFormat, string> = {
  mp4: 'H.264 MP4',
  webm: 'WebM VP9',
  mov: 'ProRes MOV',
  gif: 'Animated GIF',
  hdr10: 'HDR10 MP4',
  hlg: 'HLG MP4',
  'png-sequence': 'PNG Sequence',
  'jpg-sequence': 'JPEG Sequence',
  'exr-sequence': 'EXR Sequence',
};

function statusClass(s: RenderJob['status']): string {
  switch (s) {
    case 'queued':    return styles.statusQueued ?? '';
    case 'rendering': return styles.statusRendering ?? '';
    case 'paused':    return styles.statusPaused ?? '';
    case 'stopped':   return styles.statusPaused ?? '';
    case 'done':      return styles.statusDone ?? '';
    case 'failed':    return styles.statusFailed ?? '';
    case 'skipped':   return styles.statusSkipped ?? '';
    default:          return '';
  }
}

function statusLabel(s: RenderJob['status']): string {
  switch (s) {
    case 'queued':    return 'Queued';
    case 'rendering': return 'Rendering…';
    case 'paused':    return 'Paused';
    case 'stopped':   return 'Stopped';
    case 'done':      return 'Done';
    case 'failed':    return 'Failed';
    case 'skipped':   return 'Skipped';
  }
}

export function RenderQueuePanel(): JSX.Element {
  const compName = useCompositionStore((s) => s.name);
  const compW = useCompositionStore((s) => s.width);
  const compH = useCompositionStore((s) => s.height);
  const compFps = useCompositionStore((s) => s.fps);
  const compDur = useCompositionStore((s) => s.durationSeconds);
  // Scoped selectors: subscribing to the WHOLE store (no selector) re-rendered
  // the entire panel on every per-frame progress tick. Actions are stable refs,
  // so selecting them never triggers a render; only `jobs`/`isRunning` do.
  const jobs = useRenderQueueStore((s) => s.jobs);
  const isRunning = useRenderQueueStore((s) => s.isRunning);
  const addJob = useRenderQueueStore((s) => s.addJob);
  const removeJob = useRenderQueueStore((s) => s.removeJob);
  const duplicateJob = useRenderQueueStore((s) => s.duplicateJob);
  const skipJob = useRenderQueueStore((s) => s.skipJob);
  const startAll = useRenderQueueStore((s) => s.startAll);
  const stopAll = useRenderQueueStore((s) => s.stopAll);
  const discardAll = useRenderQueueStore((s) => s.discardAll);
  const pauseJob = useRenderQueueStore((s) => s.pauseJob);
  const resumeJob = useRenderQueueStore((s) => s.resumeJob);
  const discardJobProgress = useRenderQueueStore((s) => s.discardJobProgress);
  const clearFinished = useRenderQueueStore((s) => s.clearFinished);
  const outputDir = useRenderQueueStore((s) => s.outputDir);
  const chooseOutputDir = useRenderQueueStore((s) => s.chooseOutputDir);

  const [showDialog, setShowDialog] = useState(false);

  /**
   * Whether a stopped render can come back at all.
   *
   * Only the desktop's staging sink can: it writes every frame to a temp dir
   * and encodes once at the end, so "stopped" is just "the loop is not feeding
   * it right now". Browser sinks stream their encode as frames arrive — there
   * is nothing to reopen — and sequence exports build one zip in memory.
   */
  const canResumeFormat = canEncodeLocally();

  /**
   * Stopping keeps the work, so it no longer needs a warning — the only thing
   * worth saying is which formats CAN'T come back, and that is worth saying
   * before the click rather than after.
   *
   * Sequence exports and the browser's streaming sinks have no staging dir to
   * resume from, so for those a stop really is a restart. Ask only there.
   */
  const confirmStop = (): void => {
    void (async () => {
      const active = jobs.find((j) => j.status === 'rendering');
      const nonResumable =
        !!active && (active.format.endsWith('-sequence') || !canResumeFormat);
      if (nonResumable) {
        const ok = await customConfirm(
          'Stop rendering?',
          `${FORMAT_LABEL[active.format] ?? active.format} renders cannot resume — this job restarts from the beginning next time. Other formats keep their progress.`,
          { confirmLabel: 'Stop rendering', isDanger: true },
        );
        if (!ok) return;
      }
      stopAll();
    })();
  };

  /**
   * The destructive one, which is why it asks and Stop does not.
   *
   * Discard disposes the sink: ffmpeg is killed and its staging directory
   * removed, so a 40-minute render really is gone and starts again at frame 0.
   */
  const confirmDiscard = (): void => {
    void (async () => {
      const ok = await customConfirm(
        'Discard render progress?',
        'The frames already rendered are deleted and these jobs start again from the beginning. This cannot be undone.',
        { confirmLabel: 'Discard progress', isDanger: true },
      );
      if (!ok) return;
      discardAll();
    })();
  };

  const handleAddJob = (settings: OutputSettings) => {
    setShowDialog(false);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const ext = outputExtFor(settings.format);
    // Read the active comp lazily (avoids subscribing the panel to a fresh
    // object every store tick).
    const comp = useCompositionStore.getState().comp();

    // Sanitized like the Export dialog's fileStem: a comp named "Hero / v2"
    // otherwise put a path separator into the output filename, which
    // path.join then treated as a directory.
    const stem = (compName ?? 'output').trim().replace(/[<>:"/\\|?*]+/g, '-') || 'output';
    // Capture the range at queue time — same contract as the Export dialog:
    // a queued job renders what was queued, not the live global work area.
    const wa = getTimelineController().getWorkArea();
    const range = wa ?? { start: 0, end: settings.durationSec };
    addJob({
      compositionName: compName ?? 'Comp 1',
      // Bind the job to the comp it was queued FROM (see RenderJob.compositionId).
      compositionId: comp.id,
      background: comp.background,
      outputPath: `${stem}_${ts}.${ext}`,
      format: settings.format,
      width: settings.width,
      height: settings.height,
      // The composition's real size — the output size above is what the user
      // typed and may be smaller or larger than the comp.
      compWidth: comp.width,
      compHeight: comp.height,
      fps: settings.fps,
      durationSec: settings.durationSec,
      rangeStartSec: range.start,
      rangeEndSec: range.end,
      transparent: settings.transparent,
      quality: settings.quality,
      ...(settings.proresProfile ? { proresProfile: settings.proresProfile } : {}),
    });
  };

  const doneCount = jobs.filter((j) => j.status === 'done').length;
  const queuedCount = jobs.filter((j) => j.status === 'queued').length;
  // Half-rendered jobs holding a staging dir. They change what the main button
  // means (Resume All, not Render All) and are what Discard would destroy.
  const resumableCount = jobs.filter((j) => j.status === 'paused' || j.status === 'stopped').length;

  return (
    <div className={styles.root}>
      {showDialog && (
        <OutputModuleDialog 
          initialWidth={compW}
          initialHeight={compH}
          initialFps={compFps}
          initialDuration={compDur}
          onConfirm={handleAddJob}
          onCancel={() => setShowDialog(false)}
        />
      )}
      {/* ── Toolbar ──────────────────────────────────────────────── */}
      <div className={styles.toolbar}>
        <button type="button" className={styles.toolbarBtn} onClick={() => setShowDialog(true)} title="Add current composition to queue" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <Icon name="plus" size="sm" />
          <span>Add Comp</span>
        </button>

        {canChooseOutputDir() && (
          <button
            type="button"
            className={styles.toolbarBtn}
            onClick={() => void chooseOutputDir()}
            title={outputDir ? `Renders are written to ${outputDir}` : 'Choose where renders are written'}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
          >
            <Icon name="folder" size="sm" style={{ color: '#f5b041' }} />
            <span>{outputDir ? (outputDir.split(/[\\/]/).pop() || outputDir) : 'Output folder…'}</span>
          </button>
        )}

        <span className={styles.spacer} />

        {isRunning ? (
          <span className={styles.statusBadgeRunning}>● Running</span>
        ) : (
          <span className={styles.statusBadge}>Stopped</span>
        )}

        {/*
          "Stop (keep progress)" — the label is the promise.

          This used to be a plain "Stop" that disposed the sink: ffmpeg killed,
          staging dir deleted, every job back at frame 0. It now stops feeding
          frames and leaves the sink open, so Render All continues where it
          left off. Losing the work is the button next to it, and it asks.
        */}
        <button
          type="button"
          className={styles.toolbarBtnPrimary}
          onClick={isRunning ? confirmStop : startAll}
          disabled={jobs.length === 0}
          title={
            isRunning
              ? 'Stop rendering — the current job keeps its rendered frames and resumes here'
              : resumableCount > 0
                ? 'Resume stopped jobs, then render the rest of the queue'
                : 'Render all queued'
          }
        >
          <Icon name={isRunning ? 'stop' : 'play'} size="sm" />
          {isRunning ? 'Stop (keep progress)' : resumableCount > 0 ? 'Resume All' : 'Render All'}
        </button>

        {(isRunning || resumableCount > 0) && (
          <button
            type="button"
            className={styles.toolbarBtnDanger}
            onClick={confirmDiscard}
            title="Throw away the frames already rendered — jobs restart from the beginning"
          >
            <Icon name="trash" size="sm" /> Discard
          </button>
        )}

        <button type="button" className={styles.toolbarBtnDanger} onClick={clearFinished} disabled={doneCount === 0}>
          <Icon name="close" size="sm" /> Clear Done
        </button>
      </div>

      {/* ── Job list ─────────────────────────────────────────────── */}
      <div className={styles.jobList}>
        {jobs.length === 0 && (
          <EmptyState
            icon="queue"
            title="Nothing queued"
            message="Queue a composition and it renders here — the queue keeps going while you keep working."
            action={{ label: 'Add the current composition', onClick: () => setShowDialog(true) }}
          />
        )}

        {jobs.map((job, idx) => (
          <div
            key={job.id}
            className={job.status === 'rendering' ? styles.jobCardRendering : styles.jobCard}
          >
            <div className={styles.cardHeader}>
              <div className={styles.cardHeaderLeft}>
                <span className={styles.jobIndex}>#{idx + 1}</span>
                <span className={styles.compName}>{job.compositionName}</span>
              </div>
              <div className={styles.cardHeaderRight}>
                <span className={styles.formatBadge}>{FORMAT_LABEL[job.format] ?? job.format}</span>
                {/* Pause / Resume, per job — the control the queue never had.
                    Pausing keeps this job's staged frames and its encoder; the
                    Resume next to it feeds the SAME sink from that frame. */}
                {job.status === 'rendering' && (
                  <button
                    type="button"
                    className={styles.removeBtn}
                    title="Pause this render — keeps the frames already rendered"
                    onClick={() => pauseJob(job.id)}
                  >
                    <Icon name="pause" size="sm" />
                  </button>
                )}
                {(job.status === 'paused' || job.status === 'stopped') && (
                  <>
                    <button
                      type="button"
                      className={styles.removeBtn}
                      title={`Resume this render${job.resumeFrame != null ? ` at frame ${job.resumeFrame}` : ''}`}
                      onClick={() => resumeJob(job.id)}
                    >
                      <Icon name="play" size="sm" />
                    </button>
                    <button
                      type="button"
                      className={styles.removeBtn}
                      title="Discard this job's rendered frames — it restarts from the beginning"
                      onClick={() => discardJobProgress(job.id)}
                    >
                      <Icon name="trash" size="sm" />
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className={styles.removeBtn}
                  title="Duplicate this job"
                  onClick={() => duplicateJob(job.id)}
                >
                  <Icon name="copy" size="sm" />
                </button>
                {(job.status === 'queued' || job.status === 'paused' || job.status === 'stopped') && (
                  <button
                    type="button"
                    className={styles.removeBtn}
                    title="Skip this job — leave it in the list but don't render it"
                    onClick={() => skipJob(job.id)}
                  >
                    <Icon name="skip-forward" size="sm" />
                  </button>
                )}
                <button
                  type="button"
                  className={styles.removeBtn}
                  title={job.status === 'rendering' ? 'Stop the queue before removing a rendering job' : 'Remove job'}
                  disabled={job.status === 'rendering'}
                  onClick={() => removeJob(job.id)}
                >
                  <Icon name="close" size="sm" />
                </button>
              </div>
            </div>

            <div className={styles.cardBody}>
              <span className={styles.outputPath} title={job.outputPath}>{job.outputPath}</span>
              <span className={styles.jobSpec}>
                {job.width}×{job.height}
                {job.compWidth && job.compWidth !== job.width ? ` (comp ${job.compWidth}×${job.compHeight})` : ''}
                {' · '}{job.fps} fps
                {' · '}
                {(job.rangeStartSec !== undefined && job.rangeEndSec !== undefined
                  ? job.rangeEndSec - job.rangeStartSec
                  : job.durationSec
                ).toFixed(2)}s
                {job.transparent ? ' · alpha' : ''}
                {job.quality && job.quality !== 'high' ? ` · ${job.quality}` : ''}
              </span>

              <div className={styles.statusProgressRow}>
                <span
                  className={`${styles.statusChip} ${statusClass(job.status)}`}
                  title={
                    job.resumeFrame != null && (job.status === 'paused' || job.status === 'stopped')
                      ? `${job.resumeFrame} frames already rendered — resumes at frame ${job.resumeFrame}`
                      : undefined
                  }
                >
                  {statusLabel(job.status)}
                  {job.resumeFrame != null && (job.status === 'paused' || job.status === 'stopped')
                    ? ` · frame ${job.resumeFrame}`
                    : ''}
                </span>
                
                <div className={styles.progressCell}>
                  <div className={styles.progressHeader}>
                    <span className={styles.progressLabel}>{Math.round(job.progress * 100)}%</span>
                    <span className={styles.elapsedLabel}>
                      {job.elapsedMs != null ? `${(job.elapsedMs / 1000).toFixed(1)}s` : '—'}
                    </span>
                  </div>
                  <div className={styles.progressBar}>
                    <div
                      className={
                        job.status === 'paused' || job.status === 'stopped'
                          ? `${styles.progressFill} ${styles.progressFillPaused}`
                          : styles.progressFill
                      }
                      style={{ width: `${job.progress * 100}%` }}
                    />
                  </div>
                </div>
              </div>

              {/* A failed job used to show the word "Failed" and nothing else —
                  the reason was captured on the job and never rendered, so every
                  failure looked identical and none of them were actionable. */}
              {job.error && (
                <div className={styles.jobError} title={job.error}>
                  <Icon name="warning" size="sm" />
                  <span>{job.error}</span>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* ── Footer ───────────────────────────────────────────────── */}
      <div className={styles.footer}>
        <Icon name="queue" size="sm" />
        {jobs.length} job{jobs.length !== 1 ? 's' : ''} · {queuedCount} queued
        {resumableCount > 0 ? ` · ${resumableCount} paused` : ''} · {doneCount} done
        {isRunning && <span style={{ color: 'var(--color-primary)' }}> · Rendering…</span>}
      </div>
    </div>
  );
}
