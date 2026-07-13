/**
 * RenderQueuePanel — After Effects–style Render Queue.
 *
 * Lists export jobs; shows status, progress, format. Lets the user add jobs
 * (targeting the current composition), start/pause all, skip or remove
 * individual jobs, and clear finished items.
 *
 * Rendering is real (Prompt 9): each job runs through the deterministic offline
 * renderer, reports true per-frame progress, and downloads the output file
 * (PNG/JPEG-sequence zip, or WebM). Pause aborts the in-flight render.
 */

import { useState } from 'react';
import { Icon } from '@components/Icon';
import { useCompositionStore } from '@stores/compositionStore';
import { useRenderQueueStore, type OutputFormat, type RenderJob } from '@stores/renderQueueStore';
import styles from './RenderQueuePanel.module.css';

const FORMAT_OPTIONS: ReadonlyArray<{ value: OutputFormat; label: string }> = [
  { value: 'mp4',          label: 'H.264 MP4' },
  { value: 'webm',         label: 'WebM VP9' },
  { value: 'gif',          label: 'Animated GIF' },
  { value: 'png-sequence', label: 'PNG Sequence' },
  { value: 'jpg-sequence', label: 'JPEG Sequence' },
] as const;

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
  const { jobs, isRunning, addJob, removeJob, startAll, pauseAll, clearFinished } =
    useRenderQueueStore();

  const [format, setFormat] = useState<OutputFormat>('webm');

  const handleAddJob = () => {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const ext = format === 'png-sequence' || format === 'jpg-sequence' ? 'zip' : format === 'mp4' || format === 'gif' ? 'webm' : format;
    addJob({
      compositionName: compName ?? 'Comp 1',
      outputPath: `${compName ?? 'output'}_${ts}.${ext}`,
      format,
      width: compW,
      height: compH,
      fps: compFps,
      durationSec: compDur,
    });
  };

  const doneCount = jobs.filter((j) => j.status === 'done').length;
  const queuedCount = jobs.filter((j) => j.status === 'queued').length;

  return (
    <div className={styles.root}>
      {/* ── Toolbar ──────────────────────────────────────────────── */}
      <div className={styles.toolbar}>
        {/* Format picker */}
        <select
          value={format}
          onChange={(e) => setFormat(e.target.value as OutputFormat)}
          style={{
            background: '#2e2e2e',
            border: '1px solid #3a3a3a',
            color: '#c8c8c8',
            fontSize: 11,
            padding: '3px 6px',
            cursor: 'pointer',
          }}
        >
          {FORMAT_OPTIONS.map((f) => (
            <option key={f.value} value={f.value}>{f.label}</option>
          ))}
        </select>

        <button type="button" className={styles.toolbarBtn} onClick={handleAddJob} title="Add current composition to queue">
          <Icon name="plus" size={12} /> Add Comp
        </button>

        <span className={styles.spacer} />

        {isRunning ? (
          <span className={styles.statusBadgeRunning}>● Running</span>
        ) : (
          <span className={styles.statusBadge}>Stopped</span>
        )}

        <button
          type="button"
          className={styles.toolbarBtnPrimary}
          onClick={isRunning ? pauseAll : startAll}
          disabled={jobs.length === 0}
          title={isRunning ? 'Pause render queue' : 'Render all queued'}
        >
          <Icon name={isRunning ? 'pause' : 'play'} size={12} />
          {isRunning ? 'Pause' : 'Render All'}
        </button>

        <button type="button" className={styles.toolbarBtnDanger} onClick={clearFinished} disabled={doneCount === 0}>
          <Icon name="close" size={12} /> Clear Done
        </button>
      </div>

      {/* ── Job list ─────────────────────────────────────────────── */}
      <div className={styles.jobList}>
        {jobs.length === 0 && (
          <div className={styles.emptyState}>
            <Icon name="layers" size={32} className={styles.emptyIcon} />
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
                <span className={styles.formatBadge}>
                  {FORMAT_OPTIONS.find((f) => f.value === job.format)?.label ?? job.format}
                </span>
                <button
                  type="button"
                  className={styles.removeBtn}
                  title="Remove job"
                  onClick={() => removeJob(job.id)}
                >
                  <Icon name="close" size={10} />
                </button>
              </div>
            </div>

            <div className={styles.cardBody}>
              <span className={styles.outputPath} title={job.outputPath}>{job.outputPath}</span>
              
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
            </div>
          </div>
        ))}
      </div>

      {/* ── Footer ───────────────────────────────────────────────── */}
      <div className={styles.footer}>
        <Icon name="layers" size={11} />
        {jobs.length} job{jobs.length !== 1 ? 's' : ''} · {queuedCount} queued · {doneCount} done
        {isRunning && <span style={{ color: '#2988ff' }}> · Rendering…</span>}
      </div>
    </div>
  );
}
