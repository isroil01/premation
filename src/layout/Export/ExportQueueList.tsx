/**
 * The out-of-process export queue, under the Export form and in the Render
 * Queue panel.
 *
 * One row per supervisor job with what the in-process progress row showed —
 * frame, rate, time left, Cancel — plus Retry and Remove for finished ones and,
 * where the host asks for it (the Render Queue panel), priority up/down for
 * jobs still waiting. The rows come from `exportQueueStore`, a mirror of the
 * queue main owns, so this shows the same thing after the editor reloads
 * mid-render.
 */

import { useEffect } from 'react';
import { cn } from '@utils/cn';
import { Button } from '@components/Button';
import { Icon } from '@components/Icon';
import { useExportQueueStore } from '@stores/exportQueueStore';
import { describeProgress, isFinishedStatus, type ExportJobRecord } from '@core/export/exportSupervisorClient';
import styles from './ExportDialog.module.css';

/**
 * What the supervisor path promises about interruption, said where its jobs
 * are listed. A streamed encode has nothing on disk to pick up again, so a job
 * the app was killed during comes back failed and Retry renders it from the
 * first frame — unlike the in-window queue's desktop renders, which resume.
 */
export const SUPERVISOR_RESTART_NOTE =
  'Renders in the background, in its own window. An interrupted render starts again from the first frame.';

/**
 * Display order: live jobs first — the running one(s), then the waiting ones in
 * the order main will run them (priority, then first-come; the rule in
 * electron/exportProcess.ts) — then finished ones newest first, so yesterday's
 * completed exports never push today's render off the list.
 */
export function orderForDisplay(jobs: ReadonlyArray<ExportJobRecord>): ExportJobRecord[] {
  const rank = (j: ExportJobRecord): number => (isFinishedStatus(j.status) ? 2 : j.status === 'queued' ? 1 : 0);
  return [...jobs].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    if (rank(a) === 2) return b.createdAt - a.createdAt;
    return b.priority - a.priority || a.createdAt - b.createdAt || a.id.localeCompare(b.id);
  });
}

export interface ExportQueueRowProps {
  job: ExportJobRecord;
  /** Show raise/lower priority on waiting jobs. */
  priorityControls?: boolean;
}

export function ExportQueueRow({ job, priorityControls = false }: ExportQueueRowProps): JSX.Element {
  const cancel = useExportQueueStore((s) => s.cancel);
  const retry = useExportQueueStore((s) => s.retry);
  const remove = useExportQueueStore((s) => s.remove);
  const setPriority = useExportQueueStore((s) => s.setPriority);
  const live = !isFinishedStatus(job.status);
  const pct = Math.round(job.progress.fraction * 100);
  const waiting = job.status === 'queued';
  return (
    <div className={cn(styles.queueRow, job.status === 'failed' && styles.queueRowFailed)} data-status={job.status}>
      <div className={styles.queueMeta}>
        <span className={styles.queueLabel} title={job.spec.outPath}>{job.spec.label}</span>
        <span className={styles.queueStatus}>
          {describeProgress(job)}
          {priorityControls && job.priority !== 0 ? ` · priority ${job.priority > 0 ? '+' : ''}${job.priority}` : ''}
        </span>
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
          <span className={styles.progressText}>{waiting ? 'Waiting' : `${pct}%`}</span>
        </div>
      ) : null}
      {live ? (
        <span className={styles.queueActions}>
          {priorityControls && waiting ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon={<Icon name="chevron-up" size="sm" />}
                title="Raise priority — runs before lower-priority waiting renders"
                onClick={() => void setPriority(job.id, job.priority + 1)}
              >
                Raise priority
              </Button>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon={<Icon name="chevron-down" size="sm" />}
                title="Lower priority — runs after higher-priority waiting renders"
                onClick={() => void setPriority(job.id, job.priority - 1)}
              >
                Lower priority
              </Button>
            </>
          ) : null}
          <Button variant="secondary" size="sm" onClick={() => void cancel(job.id)} title="Stop this export — nothing is written">
            Cancel
          </Button>
        </span>
      ) : (
        <span className={styles.queueActions}>
          {job.status !== 'completed' ? (
            <Button variant="secondary" size="sm" onClick={() => void retry(job.id)} title="Render this export again, from the first frame">
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

export interface ExportQueueListProps {
  /** Show raise/lower priority on waiting jobs (the Render Queue panel does). */
  priorityControls?: boolean;
}

export function ExportQueueList({ priorityControls = false }: ExportQueueListProps = {}): JSX.Element | null {
  const jobs = useExportQueueStore((s) => s.jobs);
  const connect = useExportQueueStore((s) => s.connect);
  useEffect(() => { void connect(); }, [connect]);
  if (jobs.length === 0) return null;
  return (
    <div className={styles.queueList} aria-label="Export queue">
      <p className={styles.fieldNote}>{SUPERVISOR_RESTART_NOTE}</p>
      {orderForDisplay(jobs).map((job) => <ExportQueueRow key={job.id} job={job} priorityControls={priorityControls} />)}
    </div>
  );
}
