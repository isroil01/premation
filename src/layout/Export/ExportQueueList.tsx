/**
 * The out-of-process export queue, under the Export form.
 *
 * One row per supervisor job with what the in-process progress row showed —
 * frame, rate, time left, Cancel — plus Retry and Remove for finished ones.
 * The rows come from `exportQueueStore`, a mirror of the queue main owns, so
 * this shows the same thing after the editor reloads mid-render.
 */

import { useEffect } from 'react';
import { cn } from '@utils/cn';
import { Button } from '@components/Button';
import { useExportQueueStore } from '@stores/exportQueueStore';
import { describeProgress, isFinishedStatus, type ExportJobRecord } from '@core/export/exportSupervisorClient';
import styles from './ExportDialog.module.css';

function Row({ job }: { job: ExportJobRecord }): JSX.Element {
  const cancel = useExportQueueStore((s) => s.cancel);
  const retry = useExportQueueStore((s) => s.retry);
  const remove = useExportQueueStore((s) => s.remove);
  const live = !isFinishedStatus(job.status);
  const pct = Math.round(job.progress.fraction * 100);
  return (
    <div className={cn(styles.queueRow, job.status === 'failed' && styles.queueRowFailed)} data-status={job.status}>
      <div className={styles.queueMeta}>
        <span className={styles.queueLabel} title={job.spec.outPath}>{job.spec.label}</span>
        <span className={styles.queueStatus}>{describeProgress(job)}</span>
      </div>
      {live ? (
        <div
          className={styles.progressWrap}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-label={`Export ${job.spec.label}`}
        >
          <div className={styles.progressBar} style={{ width: `${pct}%` }} />
          <span className={styles.progressText}>{job.status === 'queued' ? 'Waiting' : `${pct}%`}</span>
        </div>
      ) : null}
      {live ? (
        <Button variant="secondary" size="sm" onClick={() => void cancel(job.id)} title="Stop this export — nothing is written">
          Cancel
        </Button>
      ) : (
        <span className={styles.queueActions}>
          {job.status !== 'completed' ? (
            <Button variant="secondary" size="sm" onClick={() => void retry(job.id)} title="Render this export again">
              Retry
            </Button>
          ) : null}
          <Button variant="secondary" size="sm" onClick={() => void remove(job.id)} title="Remove from the list">
            Remove
          </Button>
        </span>
      )}
    </div>
  );
}

export function ExportQueueList(): JSX.Element | null {
  const jobs = useExportQueueStore((s) => s.jobs);
  const connect = useExportQueueStore((s) => s.connect);
  useEffect(() => { void connect(); }, [connect]);
  if (jobs.length === 0) return null;
  // Live jobs first, then the most recent finished ones — a long list of
  // yesterday's completed exports must not push today's render off the panel.
  const ordered = [...jobs].sort((a, b) => {
    const la = isFinishedStatus(a.status) ? 1 : 0;
    const lb = isFinishedStatus(b.status) ? 1 : 0;
    return la - lb || b.createdAt - a.createdAt;
  });
  return (
    <div className={styles.queueList} aria-label="Export queue">
      {ordered.map((job) => <Row key={job.id} job={job} />)}
    </div>
  );
}
