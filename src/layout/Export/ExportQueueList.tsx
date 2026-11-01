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

import { useEffect, useMemo } from 'react';
import { cn } from '@utils/cn';
import { Button } from '@components/Button';
import { Icon } from '@components/Icon';
import { useCurrentProjectRef } from '@hooks/useCurrentProjectRef';
import { belongsToProject } from '@core/export/renderProject';
import { failureAction, useExportQueueStore } from '@stores/exportQueueStore';
import { describeProgress, isFinishedStatus, type ExportJobRecord } from '@core/export/exportSupervisorClient';
import { t } from '@core/i18n';
import styles from './ExportDialog.module.css';

/**
 * What the supervisor path promises about interruption, said where its jobs
 * are listed. A streamed encode has nothing on disk to pick up again, so a job
 * the app was killed during comes back failed and Retry renders it from the
 * first frame — unlike the in-window queue's desktop renders, which resume.
 */
export const SUPERVISOR_RESTART_NOTE =
  'Renders in the background, in its own window. An interrupted render starts again from the first frame.';

/** `SUPERVISOR_RESTART_NOTE`, translated — call at render time. */
export function supervisorRestartNote(): string {
  return t('export.queue.restartNote', 'Renders in the background, in its own window. An interrupted render starts again from the first frame.');
}

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
          {priorityControls && job.priority !== 0 ? t('export.queue.priority', ' · priority {n}', { n: `${job.priority > 0 ? '+' : ''}${job.priority}` }) : ''}
        </span>
      </div>
      {live ? (
        <div
          className={styles.progressWrap}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-label={t('export.queue.progressLabel', 'Export {name}', { name: job.spec.label })}
        >
          <div className={styles.progressBar} style={{ width: `${pct}%` }} />
          <span className={styles.progressText}>{waiting ? t('export.queue.waiting', 'Waiting') : `${pct}%`}</span>
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
                title={t('export.queue.raisePriorityTitle', 'Raise priority — runs before lower-priority waiting renders')}
                onClick={() => void setPriority(job.id, job.priority + 1)}
              >
                {t('export.queue.raisePriority', 'Raise priority')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon={<Icon name="chevron-down" size="sm" />}
                title={t('export.queue.lowerPriorityTitle', 'Lower priority — runs after higher-priority waiting renders')}
                onClick={() => void setPriority(job.id, job.priority - 1)}
              >
                {t('export.queue.lowerPriority', 'Lower priority')}
              </Button>
            </>
          ) : null}
          <Button variant="secondary" size="sm" onClick={() => void cancel(job.id)} title={t('export.queue.cancelTitle', 'Stop this export — nothing is written')}>
            {t('export.queue.cancel', 'Cancel')}
          </Button>
        </span>
      ) : (
        <span className={styles.queueActions}>
          {job.errorCode === 'ffmpeg-unavailable' ? (
            <Button variant="primary" size="sm" onClick={() => failureAction(job).action?.onSelect()} title={t('export.queue.fixTitle', 'Repair video export, then render this again')}>
              {t('export.queue.fix', 'Fix')}
            </Button>
          ) : null}
          {job.status !== 'completed' ? (
            <Button variant="secondary" size="sm" onClick={() => void retry(job.id)} title={t('export.queue.retryTitle', 'Render this export again, from the first frame')}>
              {t('export.queue.retry', 'Retry')}
            </Button>
          ) : null}
          <Button variant="secondary" size="sm" onClick={() => void remove(job.id)} title={t('export.queue.removeTitle', 'Remove from the list')}>
            {t('export.queue.remove', 'Remove')}
          </Button>
        </span>
      )}
      {/* What the frames were drawn without (the engine's preflight warnings): the file is complete. */}
      {job.status === 'completed' && job.warnings && job.warnings.length > 0 ? (
        <ul className={styles.queueStatus} title={job.warnings.join('\n')} aria-label={t('export.queue.warnings', 'Export warnings')}>
          {job.warnings.slice(0, 3).map((w) => <li key={w}>{w}</li>)}
          {job.warnings.length > 3 ? <li>{t('export.queue.moreWarnings', 'and {n} more', { n: job.warnings.length - 3 })}</li> : null}
        </ul>
      ) : null}
    </div>
  );
}

export interface ExportQueueListProps {
  /** Show raise/lower priority on waiting jobs (the Render Queue panel does). */
  priorityControls?: boolean;
}

export function ExportQueueList({ priorityControls = false }: ExportQueueListProps = {}): JSX.Element | null {
  const allJobs = useExportQueueStore((s) => s.jobs);
  const project = useCurrentProjectRef();
  // This project's renders; the dashboard's Renders page lists every project's.
  const jobs = useMemo(() => allJobs.filter((j) => belongsToProject(j.spec.projectKey, project)), [allJobs, project]);
  const connect = useExportQueueStore((s) => s.connect);
  useEffect(() => { void connect(); }, [connect]);
  if (jobs.length === 0) return null;
  return (
    <div className={styles.queueList} aria-label={t('export.queue.label', 'Export queue')}>
      <p className={styles.fieldNote}>{supervisorRestartNote()}</p>
      {orderForDisplay(jobs).map((job) => <ExportQueueRow key={job.id} job={job} priorityControls={priorityControls} />)}
    </div>
  );
}
