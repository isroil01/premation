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
 * process. Pause aborts the in-flight render and kills its encoder.
 */

import { useState } from 'react';
import { Icon } from '@components/Icon';
import { useCompositionStore } from '@stores/compositionStore';
import {
  canChooseOutputDir,
  useRenderQueueStore,
  outputExtFor,
  type OutputFormat,
  type RenderJob,
} from '@stores/renderQueueStore';
import { OutputModuleDialog, type OutputSettings } from './OutputModuleDialog';
import { customConfirm } from '@components/Modal/Dialogs';
import styles from './RenderQueuePanel.module.css';

const FORMAT_LABEL: Record<OutputFormat, string> = {
  mp4: 'H.264 MP4',
  webm: 'WebM VP9',
  mov: 'ProRes 4444',
  gif: 'Animated GIF',
  hdr10: 'HDR10 MP4',
  hlg: 'HLG MP4',
  'png-sequence': 'PNG Sequence',
  'jpg-sequence': 'JPEG Sequence',
};

function statusClass(s: RenderJob['status']): string {
  switch (s) {
    case 'queued':    return styles.statusQueued ?? '';
    case 'rendering': return styles.statusRendering ?? '';
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
  const pauseAll = useRenderQueueStore((s) => s.pauseAll);
  const clearFinished = useRenderQueueStore((s) => s.clearFinished);
  const outputDir = useRenderQueueStore((s) => s.outputDir);
  const chooseOutputDir = useRenderQueueStore((s) => s.chooseOutputDir);

  const [showDialog, setShowDialog] = useState(false);

  /**
   * Confirm before aborting. `pauseAll` disposes the sink, which kills ffmpeg
   * and removes the staging directory — a 40-minute render is gone and restarts
   * from frame 0. Only asks when a job is actually mid-flight; stopping an
   * idle-but-running queue has nothing to lose.
   */
  const confirmStop = (): void => {
    void (async () => {
      const active = jobs.some((j) => j.status === 'rendering');
      if (active) {
        const ok = await customConfirm(
          'Stop rendering?',
          'The job in progress will be discarded and restarts from the beginning next time — there is no resume.',
          { confirmLabel: 'Stop rendering', isDanger: true },
        );
        if (!ok) return;
      }
      pauseAll();
    })();
  };

  const handleAddJob = (settings: OutputSettings) => {
    setShowDialog(false);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const ext = outputExtFor(settings.format);
    // Read the active comp lazily (avoids subscribing the panel to a fresh
    // object every store tick).
    const comp = useCompositionStore.getState().comp();

    addJob({
      compositionName: compName ?? 'Comp 1',
      // Bind the job to the comp it was queued FROM (see RenderJob.compositionId).
      compositionId: comp.id,
      background: comp.background,
      outputPath: `${compName ?? 'output'}_${ts}.${ext}`,
      format: settings.format,
      width: settings.width,
      height: settings.height,
      // The composition's real size — the output size above is what the user
      // typed and may be smaller or larger than the comp.
      compWidth: comp.width,
      compHeight: comp.height,
      fps: settings.fps,
      durationSec: settings.durationSec,
      transparent: settings.transparent,
      quality: settings.quality,
    });
  };

  const doneCount = jobs.filter((j) => j.status === 'done').length;
  const queuedCount = jobs.filter((j) => j.status === 'queued').length;

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
        <button type="button" className={styles.toolbarBtn} onClick={() => setShowDialog(true)} title="Add current composition to queue">
          <Icon name="plus" size="sm" /> Add Comp
        </button>

        {canChooseOutputDir() && (
          <button
            type="button"
            className={styles.toolbarBtn}
            onClick={() => void chooseOutputDir()}
            title={outputDir ? `Renders are written to ${outputDir}` : 'Choose where renders are written'}
          >
            <Icon name="folder" size="sm" />
            {outputDir ? (outputDir.split(/[\\/]/).pop() || outputDir) : 'Output folder…'}
          </button>
        )}

        <span className={styles.spacer} />

        {isRunning ? (
          <span className={styles.statusBadgeRunning}>● Running</span>
        ) : (
          <span className={styles.statusBadge}>Stopped</span>
        )}

        {/*
          "Stop", not "Pause".

          `pauseAll` aborts: it kills the running ffmpeg child and deletes its
          staging directory. There is no resume — pressing Render All afterwards
          restarts every job from frame 0. The button said "Pause", so a user
          freeing the CPU for ten minutes lost the render instead, and only
          found out later. Real pause/resume is a separate piece of work; until
          it exists the control must say what it does.
        */}
        <button
          type="button"
          className={styles.toolbarBtnPrimary}
          onClick={isRunning ? confirmStop : startAll}
          disabled={jobs.length === 0}
          title={isRunning ? 'Stop rendering — discards progress on the current job' : 'Render all queued'}
        >
          <Icon name={isRunning ? 'stop' : 'play'} size="sm" />
          {isRunning ? 'Stop' : 'Render All'}
        </button>

        <button type="button" className={styles.toolbarBtnDanger} onClick={clearFinished} disabled={doneCount === 0}>
          <Icon name="close" size="sm" /> Clear Done
        </button>
      </div>

      {/* ── Job list ─────────────────────────────────────────────── */}
      <div className={styles.jobList}>
        {jobs.length === 0 && (
          <div className={styles.emptyState}>
            <Icon name="queue" size="lg" className={styles.emptyIcon} />
            <span>No render jobs. Click "Add Comp" to queue a composition.</span>
          </div>
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
                <button
                  type="button"
                  className={styles.removeBtn}
                  title="Duplicate this job"
                  onClick={() => duplicateJob(job.id)}
                >
                  <Icon name="copy" size="sm" />
                </button>
                {job.status === 'queued' && (
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
                  title="Remove job"
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
                {' · '}{job.fps} fps · {job.durationSec.toFixed(2)}s
                {job.transparent ? ' · alpha' : ''}
                {job.quality && job.quality !== 'high' ? ` · ${job.quality}` : ''}
              </span>

              <div className={styles.statusProgressRow}>
                <span className={`${styles.statusChip} ${statusClass(job.status)}`}>
                  {statusLabel(job.status)}
                </span>
                
                <div className={styles.progressCell}>
                  <div className={styles.progressHeader}>
                    <span className={styles.progressLabel}>{Math.round(job.progress * 100)}%</span>
                    <span className={styles.elapsedLabel}>
                      {job.elapsedMs != null ? `${(job.elapsedMs / 1000).toFixed(1)}s` : '—'}
                    </span>
                  </div>
                  <div className={styles.progressBar}>
                    <div className={styles.progressFill} style={{ width: `${job.progress * 100}%` }} />
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
        {jobs.length} job{jobs.length !== 1 ? 's' : ''} · {queuedCount} queued · {doneCount} done
        {isRunning && <span style={{ color: 'var(--color-primary)' }}> · Rendering…</span>}
      </div>
    </div>
  );
}
