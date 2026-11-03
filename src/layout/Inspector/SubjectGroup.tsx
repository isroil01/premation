/**
 * One foldable group of Properties ▸ Subject (Edge, Tracking, Create, Styles):
 * a twirl, its title, and a one-line summary on the right that still reports
 * the group's state while it is folded. Folded groups are the user's
 * preference (subjectPanelPrefsStore), never the document's.
 */

import type { ReactNode } from 'react';
import { Icon } from '@components/Icon';
import { useSubjectPanelPrefsStore } from '@stores/subjectPanelPrefsStore';
import styles from './SubjectSection.module.css';

export function SubjectGroup({ id, title, summary, extra, children }: {
  id: string;
  title: string;
  summary?: ReactNode;
  /** A control beside the title (outside the twirl button). */
  extra?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  const open = !useSubjectPanelPrefsStore((s) => s.closed.includes(id));
  const bodyId = `subject-group-${id}`;
  return (
    <div className={styles.group}>
      <div className={styles.groupHead}>
        <button
          type="button"
          className={styles.groupToggle}
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => useSubjectPanelPrefsStore.getState().toggle(id)}
        >
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size="sm" className={styles.groupTwirl} />
          <span className={styles.groupTitle}>{title}</span>
          {summary !== undefined && <span className={styles.groupSummary}>{summary}</span>}
        </button>
        {extra}
      </div>
      {open && <div id={bodyId} className={styles.groupBody}>{children}</div>}
    </div>
  );
}
