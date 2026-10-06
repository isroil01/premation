/**
 * How much of the cloud allowance this account is using, and what that means.
 *
 * Shared by the Billing page and the Settings profile card so the two cannot
 * describe the same allowance in different words. Every number comes from the
 * server (`cloudProjects` on /billing/me, `projectCount` + `access` on
 * /auth/me); this only draws them. The one piece of arithmetic — how many
 * projects are past the cap — is a subtraction of two server numbers, never a
 * second opinion about which projects those are (the project list's per-row
 * `readOnly` says that).
 */

import { Icon } from '@components/Icon';
import styles from './CloudUsage.module.css';

export interface CloudUsageProps {
  /** Live cloud projects. */
  used: number;
  /** The cap in force; null = unlimited. */
  limit: number | null;
  /** Days of autosave history the plan keeps. */
  historyDays?: number;
  /**
   * The Free allowance starts applying at this moment (launch grace period).
   * While set, `limit` is the uncapped allowance and `freeLimit` is the one
   * that is coming.
   */
  limitsFrom?: string | null;
  /** The Free plan's cap, for the grace-period sentence. */
  freeLimit?: number | null;
  /** Rendered after the sentences — e.g. an Upgrade button. */
  action?: React.ReactNode;
}

type Level = 'ok' | 'near' | 'full' | 'over';

function levelOf(used: number, limit: number | null): Level {
  if (limit === null || limit <= 0) return 'ok';
  if (used > limit) return 'over';
  if (used === limit) return 'full';
  return used >= limit - 1 ? 'near' : 'ok';
}

function longDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function CloudUsage({
  used,
  limit,
  historyDays,
  limitsFrom,
  freeLimit,
  action,
}: CloudUsageProps): JSX.Element {
  const level = levelOf(used, limit);
  const capped = limit !== null && limit > 0;
  const fill = capped ? Math.min(100, (used / limit) * 100) : 0;
  const graceCap = limitsFrom && freeLimit != null ? freeLimit : null;

  let note: React.ReactNode = null;
  if (graceCap !== null && limitsFrom) {
    note =
      used > graceCap ? (
        <>
          Free plan limits start on <strong>{longDate(limitsFrom)}</strong>. From then on, your{' '}
          {graceCap} most recently edited projects stay editable and the other{' '}
          {plural(used - graceCap, 'project turns', 'projects turn')} read-only. Nothing is deleted.
        </>
      ) : (
        <>
          Free plan limits start on <strong>{longDate(limitsFrom)}</strong>: {graceCap} cloud
          projects and {historyDays ?? 7} days of history. You are within them.
        </>
      );
  } else if (level === 'over' && limit !== null) {
    note = (
      <>
        {plural(used - limit, 'project is', 'projects are')} past your plan and read-only. You can
        still open and export {used - limit === 1 ? 'it' : 'them'}; your {limit} most recently edited
        projects keep saving.
      </>
    );
  } else if (level === 'full') {
    note = <>You have used every cloud project on your plan. New projects can still be saved locally.</>;
  } else if (level === 'near' && limit !== null) {
    note = <>{plural(limit - used, 'cloud project', 'cloud projects')} left on your plan.</>;
  }

  const tone =
    graceCap !== null && used > graceCap ? 'warn' : level === 'over' || level === 'full' ? 'warn' : 'info';

  return (
    <div className={styles.usage}>
      <div className={styles.row}>
        <span className={styles.label}>Cloud projects</span>
        <span className={styles.value}>
          {capped ? (
            <>
              {used} <span className={styles.of}>of {limit}</span>
            </>
          ) : (
            <>
              {used} <span className={styles.of}>· unlimited</span>
            </>
          )}
        </span>
      </div>
      {capped ? (
        <div
          className={styles.track}
          role="progressbar"
          aria-label="Cloud projects used"
          aria-valuemin={0}
          aria-valuemax={limit}
          aria-valuenow={Math.min(used, limit)}
        >
          <div className={`${styles.fill} ${styles[level]}`} style={{ transform: `scaleX(${fill / 100})` }} />
        </div>
      ) : null}
      {historyDays ? (
        <div className={styles.row}>
          <span className={styles.label}>Version history</span>
          <span className={styles.value}>{plural(historyDays, 'day', 'days')}</span>
        </div>
      ) : null}
      {note || action ? (
        <div className={`${styles.note} ${tone === 'warn' ? styles.noteWarn : ''}`}>
          {note ? (
            <>
              <Icon name={tone === 'warn' ? 'warning' : 'info'} size="sm" className={styles.noteIcon} />
              <span className={styles.noteText}>{note}</span>
            </>
          ) : (
            <span className={styles.noteText} />
          )}
          {action ? <span className={styles.noteAction}>{action}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
