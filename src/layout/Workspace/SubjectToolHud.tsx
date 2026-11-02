/**
 * What the subject tools (Object Matte, Quick Selection, Selection Brush,
 * Refine Edge) tell the user: the overlay's message ("Segmenting…", "Click to
 * select…") and, while a subject is followed in the background, its progress
 * with a Stop. Shown in the editor's status bar — never as chips over the
 * viewer, where they covered the very subject being selected (the tool, size
 * and hardness are in the tool options bar).
 *
 * Reads the store with selectors only: it re-renders on a message change or a
 * tracking tick, never on a pointer move or a played frame.
 */

import { useEffect } from 'react';
import { useRotoBrushStore } from '@stores/rotoBrushStore';
import { layerSubjects } from '@core/workspace/subjects';
import { cancelSubjectWalk, subjectWalkRunning } from './subjectActions';
import { t } from '@core/i18n';
import styles from './SubjectToolHud.module.css';

/** The overlay hands its message to the status bar (cleared when the tool goes away). */
export function usePublishSubjectNotice(text: string | null, busy: boolean): void {
  useEffect(() => {
    useRotoBrushStore.getState().setNotice(text ? { text, busy } : null);
  }, [text, busy]);
  useEffect(() => () => useRotoBrushStore.getState().setNotice(null), []);
}

/** Stop every walk of the layer's subjects (the chip does not know which one is running). */
function stopTracking(nodeId: string | null): void {
  if (!nodeId) return;
  for (const s of layerSubjects(nodeId)) if (subjectWalkRunning(nodeId, s.id)) cancelSubjectWalk(nodeId, s.id);
}

/** The status bar's notice: the tool's message, then the background walk's progress and Stop. */
export function SubjectToolNotice(): JSX.Element | null {
  const notice = useRotoBrushStore((s) => s.notice);
  const tracking = useRotoBrushStore((s) => s.tracking);
  const pct = useRotoBrushStore((s) => Math.round(s.trackingProgress * 100));
  const nodeId = useRotoBrushStore((s) => s.nodeId);
  if (!notice && !tracking) return null;
  return (
    <span className={styles.notice}>
      {notice && (
        <span className={styles.message} role="status" title={notice.text} data-subject-notice="">
          {notice.busy && <span className={styles.spinner} aria-hidden="true" />}
          {notice.text}
        </span>
      )}
      {tracking && (
        <span className={styles.tracking} role="status" data-tracking-chip="">
          <span className={styles.spinner} aria-hidden="true" />
          <span>{t('workspace.subjects.trackingPct', 'Tracking {pct} %', { pct })}</span>
          <button type="button" className={styles.stop} onClick={() => stopTracking(nodeId)} title={t('workspace.subjects.trackingStopTitle', 'Stop following the subject (what is tracked so far stays)')}>
            {t('workspace.subjects.trackingStop', 'Stop')}
          </button>
        </span>
      )}
    </span>
  );
}
