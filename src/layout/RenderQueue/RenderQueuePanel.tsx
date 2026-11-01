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

import { useEffect, useMemo } from 'react';
import { Icon } from '@components/Icon';
import { Button } from '@components/Button';
import {
  canChooseOutputDir,
  useRenderQueueStore,
  type OutputFormat,
  type RenderJob,
} from '@stores/renderQueueStore';
import { canEncodeLocally } from '@core/export/renderSpec';
import { belongsToProject } from '@core/export/renderProject';
import { useCurrentProjectRef } from '@hooks/useCurrentProjectRef';
import { customConfirm } from '@components/Modal/Dialogs';
import { failureAction, useExportQueueStore } from '@stores/exportQueueStore';
import { describeProgress, isFinishedStatus, isLiveStatus, type ExportJobRecord } from '@core/export/exportSupervisorClient';
import { supervisorRestartNote, orderForDisplay } from '@layout/Export/ExportQueueList';
import { t } from '@core/i18n';
import styles from './RenderQueuePanel.module.css';

/** Called at render time: `t()` must not run at module scope. */
function formatLabel(format: OutputFormat): string | undefined {
  const labels: Record<OutputFormat, string> = {
    mp4: 'H.264 MP4',
    hdr10: 'HDR10 MP4 (PQ)',
    hlg: 'HLG MP4',
    webm: 'WebM VP9',
    mov: 'ProRes MOV',
    gif: t('renderQueue.format.gif', 'Animated GIF'),
    'png-sequence': t('renderQueue.format.pngSequence', 'PNG Sequence'),
    'jpg-sequence': t('renderQueue.format.jpgSequence', 'JPEG Sequence'),
    'exr-sequence': t('renderQueue.format.exrSequence', 'EXR Sequence'),
    'tiff-sequence': t('renderQueue.format.tiffSequence', 'TIFF Sequence'),
    'dpx-sequence': t('renderQueue.format.dpxSequence', 'DPX Sequence'),
  };
  return labels[format];
}

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
    case 'queued':    return t('renderQueue.status.queued', 'Queued');
    case 'rendering': return t('renderQueue.status.rendering', 'Rendering…');
    case 'paused':    return t('renderQueue.status.paused', 'Paused');
    case 'stopped':   return t('renderQueue.status.stopped', 'Stopped');
    case 'done':      return t('renderQueue.status.done', 'Done');
    case 'failed':    return t('renderQueue.status.failed', 'Failed');
    case 'skipped':   return t('renderQueue.status.skipped', 'Skipped');
  }
}

export function RenderQueuePanel(): JSX.Element {
  // Scoped selectors: subscribing to the WHOLE store (no selector) re-rendered
  // the entire panel on every per-frame progress tick. Actions are stable refs,
  // so selecting them never triggers a render; only `jobs`/`isRunning` do.
  const allPending = useRenderQueueStore((s) => s.jobs);
  const isRunning = useRenderQueueStore((s) => s.isRunning);
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
  const restoreFromLastSession = useRenderQueueStore((s) => s.restoreFromLastSession);
  // Jobs main is rendering in their own windows (desktop). Listed beside the
  // in-window jobs, not merged into them: they have different verbs (no
  // pause/resume — an interrupted one restarts) and a different owner.
  const allBackground = useExportQueueStore((s) => s.jobs);
  // Both lists are machine-wide; this panel is the open project's. The dashboard's
  // Renders page is where every project's renders are listed together.
  const project = useCurrentProjectRef();
  const jobs = useMemo(() => allPending.filter((j) => belongsToProject(j.projectKey, project)), [allPending, project]);
  const backgroundJobs = useMemo(() => allBackground.filter((j) => belongsToProject(j.spec.projectKey, project)), [allBackground, project]);

  /*
    Read back what the last session left, the first time anyone opens the queue.

    Frames staged by a render that was interrupted are still on disk — the whole
    point of encoding once at the end — and until this ran, nothing in a new
    process could name the directory holding them. The action is idempotent and
    the store remembers it has run, so mounting this panel twice (or in a second
    window) restores nothing twice.

    Here rather than at app boot deliberately: a user who never opens the Render
    Queue does not need their settings blob parsed and their staging root walked
    on every launch, and the answer is identical whenever it is asked.
  */
  useEffect(() => {
    void restoreFromLastSession();
  }, [restoreFromLastSession]);

  // Main's background renders: subscribe to its queue while the panel is open.
  const connectBackground = useExportQueueStore((s) => s.connect);
  useEffect(() => {
    void connectBackground();
  }, [connectBackground]);

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
          t('renderQueue.stop.title', 'Stop rendering?'),
          t('renderQueue.stop.body', '{format} renders cannot resume — this job restarts from the beginning next time. Other formats keep their progress.', { format: formatLabel(active.format) ?? active.format }),
          { confirmLabel: t('renderQueue.stop.confirm', 'Stop rendering'), isDanger: true },
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
        t('renderQueue.discard.title', 'Discard render progress?'),
        t('renderQueue.discard.body', 'The frames already rendered are deleted and these jobs start again from the beginning. This cannot be undone.'),
        { confirmLabel: t('renderQueue.discard.confirm', 'Discard progress'), isDanger: true },
      );
      if (!ok) return;
      discardAll();
    })();
  };

  // Both lists count: every export now renders on main's queue, so counting only the
  // in-window jobs said "0 done" beside a list of finished renders, and left Clear done
  // and Render disabled with nothing they would act on in the window's own list.
  const bgDone = backgroundJobs.filter((j) => j.status === 'completed').length;
  const bgFailed = backgroundJobs.filter((j) => j.status === 'failed');
  const doneCount = jobs.filter((j) => j.status === 'done').length + bgDone;
  const queuedCount = jobs.filter((j) => j.status === 'queued').length + backgroundJobs.filter((j) => j.status === 'queued').length;
  const failedCount = jobs.filter((j) => j.status === 'failed').length + bgFailed.length;
  const clearDone = (): void => {
    clearFinished();
    const bg = useExportQueueStore.getState();
    for (const j of backgroundJobs) if (j.status === 'completed') void bg.remove(j.id);
  };
  /** Render: the window's queue, and the background renders that failed (after a fix — the engine back, a folder made writable — they run again). */
  const renderAll = (): void => {
    startAll();
    const bg = useExportQueueStore.getState();
    for (const j of bgFailed) void bg.retry(j.id);
  };
  // Half-rendered jobs holding a staging dir. They change what the main button
  // means (Resume All, not Render All) and are what Discard would destroy.
  const resumableCount = jobs.filter((j) => j.status === 'paused' || j.status === 'stopped').length;
  const backgroundLive = backgroundJobs.filter((j) => !isFinishedStatus(j.status)).length;

  const bgRunning = backgroundJobs.some((j) => isLiveStatus(j.status));
  const anyRunning = isRunning || bgRunning;
  const total = jobs.length + backgroundJobs.length;
  // The item being rendered right now, for the progress line at the top.
  const activeBg = backgroundJobs.find((j) => j.status === 'rendering' || j.status === 'encoding' || j.status === 'preparing');
  const activeLocal = jobs.find((j) => j.status === 'rendering');
  const activeFraction = activeLocal ? activeLocal.progress : activeBg ? activeBg.progress.fraction : 0;
  const summary = total === 0
    ? t('renderQueue.summary.empty', 'Nothing queued')
    : [
        total === 1 ? t('renderQueue.summary.itemsOne', '{n} item', { n: total }) : t('renderQueue.summary.itemsOther', '{n} items', { n: total }),
        t('renderQueue.summary.queued', '{n} queued', { n: queuedCount }),
        resumableCount > 0 ? t('renderQueue.summary.paused', '{n} paused', { n: resumableCount }) : '',
        t('renderQueue.summary.done', '{n} done', { n: doneCount }),
        failedCount > 0 ? t('renderQueue.summary.failed', '{n} failed', { n: failedCount }) : '',
        backgroundJobs.length > 0 ? t('renderQueue.summary.background', '{n} in background', { n: backgroundLive }) : '',
      ].filter(Boolean).join(' · ');

  return (
    <div className={styles.root} data-render-queue="">
      {/* ── Top line: where the queue stands, and the verbs for all of it ── */}
      <div className={styles.top}>
        <span className={styles.summary}>
          {anyRunning ? <span className={styles.running}>{t('renderQueue.summary.rendering', 'Rendering · ')}</span> : null}
          {summary}
        </span>
        <div className={styles.topBar} aria-hidden>
          <div className={styles.topBarFill} style={{ transform: `scaleX(${anyRunning ? activeFraction : 0})` }} />
        </div>
        {canChooseOutputDir() && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void chooseOutputDir()}
            title={outputDir ? t('renderQueue.outputDir.title', 'Renders are written to {dir}', { dir: outputDir }) : t('renderQueue.outputDir.choose', 'Choose where renders are written')}
          >
            {outputDir ? (outputDir.split(/[\\/]/).pop() || outputDir) : t('renderQueue.outputDir.button', 'Output folder…')}
          </Button>
        )}
        {(isRunning || resumableCount > 0) && (
          <Button variant="secondary" size="sm" onClick={confirmDiscard} title={t('renderQueue.discard.buttonTitle', 'Throw away the frames already rendered — jobs restart from the beginning')}>
            {t('renderQueue.discard.button', 'Discard')}
          </Button>
        )}
        <Button variant="secondary" size="sm" onClick={clearDone} disabled={doneCount === 0} title={t('renderQueue.clearDone.title', 'Remove finished items from the list')}>
          {t('renderQueue.clearDone.button', 'Clear done')}
        </Button>
        {/*
          "Stop (keep progress)" — the label is the promise: stopping keeps the
          sink, so Render continues where it left off. Losing the work is
          Discard, and it asks.
        */}
        <Button
          variant="primary"
          size="sm"
          onClick={isRunning ? confirmStop : renderAll}
          disabled={jobs.length === 0 && bgFailed.length === 0}
          title={
            isRunning
              ? t('renderQueue.main.stopTitle', 'Stop rendering — the current job keeps its rendered frames and resumes here')
              : resumableCount > 0
                ? t('renderQueue.main.resumeTitle', 'Resume stopped jobs, then render the rest of the queue')
                : bgFailed.length > 0
                  ? t('renderQueue.main.renderRetryTitle', 'Render all queued, and run the failed renders again')
                  : t('renderQueue.main.renderTitle', 'Render all queued')
          }
        >
          {isRunning ? t('renderQueue.main.stop', 'Stop (keep progress)') : resumableCount > 0 ? t('renderQueue.main.resume', 'Resume') : t('renderQueue.main.render', 'Render')}
        </Button>
      </div>

      {/* ── The table: one row per item, as After Effects lists them ── */}
      <div className={styles.table} role="table" aria-label={t('renderQueue.table.label', 'Render queue')}>
        <div className={`${styles.row} ${styles.head}`} role="row">
          <span role="columnheader">#</span>
          <span role="columnheader">{t('renderQueue.table.composition', 'Composition')}</span>
          <span role="columnheader">{t('renderQueue.table.status', 'Status')}</span>
          <span role="columnheader">{t('renderQueue.table.outputModule', 'Output module')}</span>
          <span role="columnheader">{t('renderQueue.table.outputTo', 'Output to')}</span>
          <span role="columnheader">{t('renderQueue.table.renderTime', 'Render time')}</span>
          <span role="columnheader" aria-label={t('renderQueue.table.actions', 'Actions')} />
        </div>

        <div className={styles.rows}>
          {total === 0 && (
            <div className={styles.empty}>
              <b>{t('renderQueue.summary.empty', 'Nothing queued')}</b>
              <span>{t('renderQueue.empty.hint', 'Add a composition with Export ▸ Add to Render Queue. It renders here while you keep working.')}</span>
            </div>
          )}

          {/* Background renders first: main's queue is already running what it
              holds, while the in-window jobs below wait for Render. */}
          {backgroundJobs.length > 0 && <p className={styles.note}>{supervisorRestartNote()}</p>}
          {orderForDisplay(backgroundJobs).map((job, idx) => (
            <BackgroundRow key={job.id} job={job} index={idx + 1} />
          ))}

          {jobs.map((job, idx) => {
            const resumable = job.status === 'paused' || job.status === 'stopped';
            const seconds = job.rangeStartSec !== undefined && job.rangeEndSec !== undefined ? job.rangeEndSec - job.rangeStartSec : job.durationSec;
            const outputModule = [
              formatLabel(job.format) ?? job.format,
              `${job.width}×${job.height}`,
              `${job.fps} fps`,
              job.transparent ? t('renderQueue.row.alpha', 'alpha') : '',
              job.quality && job.quality !== 'high' ? job.quality : '',
            ].filter(Boolean).join(' · ');
            const showProgress = job.status === 'rendering' || (resumable && job.progress > 0);
            return (
              <div key={job.id} className={styles.item} data-status={job.status}>
                <div className={styles.row} role="row">
                  <span role="cell" className={styles.num}>{backgroundJobs.length + idx + 1}</span>
                  <span role="cell" className={styles.name} title={job.compositionName}>{job.compositionName}</span>
                  <span
                    role="cell"
                    className={`${styles.status} ${statusClass(job.status)}`}
                    title={job.resumeFrame != null && resumable ? t('renderQueue.row.resumeTitle', '{n} frames already rendered — resumes at frame {n}', { n: job.resumeFrame }) : undefined}
                  >
                    {statusLabel(job.status)}
                    {showProgress ? ` · ${Math.round(job.progress * 100)} %` : ''}
                    {job.resumeFrame != null && resumable ? t('renderQueue.row.frame', ' · frame {n}', { n: job.resumeFrame }) : ''}
                  </span>
                  <span role="cell" className={styles.setting} title={`${outputModule} · ${seconds.toFixed(2)} s`}>{outputModule}</span>
                  <span role="cell" className={styles.setting} title={job.outputPath}>{job.outputPath}</span>
                  <span role="cell" className={styles.time}>{job.elapsedMs != null ? `${(job.elapsedMs / 1000).toFixed(1)} s` : '—'}</span>
                  <span role="cell" className={styles.actions}>
                    {job.status === 'rendering' && (
                      <Button variant="ghost" size="sm" iconOnly icon={<Icon name="pause" size="sm" />} title={t('renderQueue.row.pauseTitle', 'Pause this render — keeps the frames already rendered')} onClick={() => pauseJob(job.id)}>{t('renderQueue.row.pause', 'Pause')}</Button>
                    )}
                    {resumable && (
                      <>
                        <Button variant="ghost" size="sm" iconOnly icon={<Icon name="play" size="sm" />} title={job.resumeFrame != null ? t('renderQueue.row.resumeAtTitle', 'Resume this render at frame {n}', { n: job.resumeFrame }) : t('renderQueue.row.resumeRenderTitle', 'Resume this render')} onClick={() => resumeJob(job.id)}>{t('renderQueue.main.resume', 'Resume')}</Button>
                        <Button variant="ghost" size="sm" iconOnly icon={<Icon name="trash" size="sm" />} title={t('renderQueue.row.discardTitle', "Discard this job's rendered frames — it restarts from the beginning")} onClick={() => discardJobProgress(job.id)}>{t('renderQueue.discard.confirm', 'Discard progress')}</Button>
                      </>
                    )}
                    <Button variant="ghost" size="sm" iconOnly icon={<Icon name="copy" size="sm" />} title={t('renderQueue.row.duplicateTitle', 'Duplicate this job')} onClick={() => duplicateJob(job.id)}>{t('renderQueue.row.duplicate', 'Duplicate')}</Button>
                    {(job.status === 'queued' || resumable) && (
                      <Button variant="ghost" size="sm" iconOnly icon={<Icon name="skip-forward" size="sm" />} title={t('renderQueue.row.skipTitle', "Skip this job — leave it in the list but don't render it")} onClick={() => skipJob(job.id)}>{t('renderQueue.row.skip', 'Skip')}</Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      icon={<Icon name="close" size="sm" />}
                      title={job.status === 'rendering' ? t('renderQueue.row.removeRenderingTitle', 'Stop the queue before removing a rendering job') : t('renderQueue.row.removeTitle', 'Remove job')}
                      disabled={job.status === 'rendering'}
                      onClick={() => removeJob(job.id)}
                    >
                      {t('renderQueue.row.remove', 'Remove')}
                    </Button>
                  </span>
                </div>
                {showProgress && (
                  <div className={styles.progress} aria-hidden>
                    <div className={resumable ? `${styles.progressFill} ${styles.progressFillPaused}` : styles.progressFill} style={{ transform: `scaleX(${job.progress})` }} />
                  </div>
                )}
                {/* Something to know before this job runs (a composition that is
                    not in the open project). A warning: the job is still queued. */}
                {job.attention && <div className={styles.attention} title={job.attention}><Icon name="warning" size="sm" /><span>{job.attention}</span></div>}
                {/* Why it failed, in the row — "Failed" alone is not actionable. */}
                {job.error && <div className={styles.error} title={job.error}><Icon name="warning" size="sm" /><span>{job.error}</span></div>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** One of main's background renders (the desktop's export supervisor), as a table row. */
function BackgroundRow({ job, index }: { job: ExportJobRecord; index: number }): JSX.Element {
  const cancel = useExportQueueStore((s) => s.cancel);
  const retry = useExportQueueStore((s) => s.retry);
  const remove = useExportQueueStore((s) => s.remove);
  const setPriority = useExportQueueStore((s) => s.setPriority);
  const live = !isFinishedStatus(job.status);
  const waiting = job.status === 'queued';
  const pct = Math.round(job.progress.fraction * 100);
  const file = job.spec.outPath.split(/[\\/]/).pop() || job.spec.outPath;
  const tone = job.status === 'failed' ? styles.statusFailed : job.status === 'completed' ? styles.statusDone : live && !waiting ? styles.statusRendering : '';
  return (
    <div className={styles.item} data-status={job.status}>
      <div className={styles.row} role="row">
        <span role="cell" className={styles.num}>{index}</span>
        <span role="cell" className={styles.name} title={job.spec.label}>{job.spec.label}</span>
        <span role="cell" className={`${styles.status} ${tone ?? ''}`} title={describeProgress(job)}>
          {describeProgress(job)}
          {job.priority !== 0 ? t('export.queue.priority', ' · priority {n}', { n: `${job.priority > 0 ? '+' : ''}${job.priority}` }) : ''}
        </span>
        <span role="cell" className={styles.setting}>{job.spec.format.toUpperCase()}</span>
        <span role="cell" className={styles.setting} title={job.spec.outPath}>{file}</span>
        <span role="cell" className={styles.time}>{live && !waiting ? `${pct} %` : '—'}</span>
        <span role="cell" className={styles.actions}>
          {live && waiting && (
            <>
              <Button variant="ghost" size="sm" iconOnly icon={<Icon name="chevron-up" size="sm" />} title={t('export.queue.raisePriorityTitle', 'Raise priority — runs before lower-priority waiting renders')} onClick={() => void setPriority(job.id, job.priority + 1)}>{t('export.queue.raisePriority', 'Raise priority')}</Button>
              <Button variant="ghost" size="sm" iconOnly icon={<Icon name="chevron-down" size="sm" />} title={t('export.queue.lowerPriorityTitle', 'Lower priority — runs after higher-priority waiting renders')} onClick={() => void setPriority(job.id, job.priority - 1)}>{t('export.queue.lowerPriority', 'Lower priority')}</Button>
            </>
          )}
          {live ? (
            <Button variant="ghost" size="sm" iconOnly icon={<Icon name="close" size="sm" />} title={t('export.queue.cancelTitle', 'Stop this export — nothing is written')} onClick={() => void cancel(job.id)}>{t('export.queue.cancel', 'Cancel')}</Button>
          ) : (
            <>
              {job.errorCode === 'ffmpeg-unavailable' && (
                <Button variant="secondary" size="sm" title={t('export.queue.fixTitle', 'Repair video export, then render this again')} onClick={() => failureAction(job).action?.onSelect()}>{t('export.queue.fix', 'Fix')}</Button>
              )}
              {job.status !== 'completed' && (
                <Button variant="ghost" size="sm" iconOnly icon={<Icon name="loop" size="sm" />} title={t('export.queue.retryTitle', 'Render this export again, from the first frame')} onClick={() => void retry(job.id)}>{t('export.queue.retry', 'Retry')}</Button>
              )}
              <Button variant="ghost" size="sm" iconOnly icon={<Icon name="close" size="sm" />} title={t('export.queue.removeTitle', 'Remove from the list')} onClick={() => void remove(job.id)}>{t('export.queue.remove', 'Remove')}</Button>
            </>
          )}
        </span>
      </div>
      {live && !waiting && (
        <div className={styles.progress} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={t('export.queue.progressLabel', 'Export {name}', { name: job.spec.label })}>
          <div className={styles.progressFill} style={{ transform: `scaleX(${job.progress.fraction})` }} />
        </div>
      )}
    </div>
  );
}
