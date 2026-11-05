/**
 * JobTray — the running background jobs (render, cache pass, transcription,
 * model download), one compact chip each, in the status bar's right cluster.
 *
 * Reads `uiStore.jobs` directly: in the editor this is where a job's progress
 * is shown (NotificationHost draws no progress card while this bar is up). The
 * tray is the compact view (Premiere's Progress Dashboard): only
 * RUNNING jobs, at most `MAX_CHIPS` of them plus a `+N`. A click anywhere on
 * it opens (or brings forward) the Tasks panel, which has every job, the
 * history, the time left and the stop buttons.
 */

import { Progress } from '@components/Progress';
import { Badge } from '@components/Badge';
import { useUIStore } from '@stores/uiStore';
import { useLayoutStore } from '@stores/layoutStore';
import { t } from '@core/i18n';
import styles from './EditorStatusBar.module.css';

const MAX_CHIPS = 2;

/** The Tasks panel (layout/Tasks), opened or brought to the front. */
export function openTasksPanel(): void {
  useLayoutStore.getState().openPanel('tasks');
}

export function JobTray(): JSX.Element | null {
  const jobs = useUIStore((s) => s.jobs);
  const running = jobs.filter((j) => j.status === 'running');
  if (running.length === 0) return null;
  const shown = running.slice(0, MAX_CHIPS);
  const more = running.length - shown.length;
  return (
    <div className={styles.tray} role="group" aria-label={t('statusBar.jobs.ariaLabel', 'Background jobs')}>
      <button
        type="button"
        className={styles.trayChips}
        title={t('statusBar.jobs.openTasks', 'Show all tasks')}
        onClick={openTasksPanel}
      >
        {shown.map((job) => {
          const indeterminate = job.progress === 'indeterminate';
          const pct = indeterminate ? null : Math.round((job.progress as number) * 100);
          return (
            <span
              key={job.id}
              className={styles.job}
              title={pct === null ? job.label : t('statusBar.jobs.progress', '{label} — {pct}%', { label: job.label, pct })}
            >
              <span className={styles.jobLabel}>{job.label}</span>
              <Progress
                className={styles.jobBar}
                size="sm"
                value={indeterminate ? 0 : (job.progress as number)}
                indeterminate={indeterminate}
                aria-label={job.label}
              />
              {pct !== null ? <span className={styles.jobPct}>{pct}%</span> : null}
            </span>
          );
        })}
        {more > 0 ? <Badge size="sm" title={t('statusBar.jobs.more', '{n} more running', { n: more })}>+{more}</Badge> : null}
      </button>
      <span className={styles.dot} aria-hidden>·</span>
    </div>
  );
}
