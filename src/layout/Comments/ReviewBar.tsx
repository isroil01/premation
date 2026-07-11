/**
 * ReviewBar — the approval flow + shareable review link (spec §Collaboration
 * V1). Set the document's status and copy a self-contained review link that
 * carries the project and its comments.
 */

import { Icon } from '@components/Icon';
import { cn } from '@utils/cn';
import { useReviewStore, REVIEW_LABEL, type ReviewStatus } from '@stores/reviewStore';
import { useCommentsStore } from '@stores/commentsStore';
import { useUIStore } from '@stores/uiStore';
import { buildReviewLink } from '@core/collab/review';
import styles from './ReviewBar.module.css';

const ORDER: ReviewStatus[] = ['draft', 'in-review', 'approved'];

export function ReviewBar(): JSX.Element {
  const status = useReviewStore((s) => s.status);
  const setStatus = useReviewStore((s) => s.setStatus);
  const comments = useCommentsStore((s) => s.comments);
  const notify = useUIStore((s) => s.notify);

  const share = async (): Promise<void> => {
    const link = buildReviewLink(comments, status, Date.now());
    try {
      await navigator.clipboard.writeText(link);
      notify({ level: 'success', message: 'Review link copied to clipboard', durationMs: 2600 });
    } catch {
      notify({ level: 'info', message: 'Review link ready (clipboard blocked)', durationMs: 2600 });
    }
  };

  return (
    <div className={styles.bar}>
      <div className={styles.statuses} role="radiogroup" aria-label="Review status">
        {ORDER.map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={status === s}
            className={cn(styles.chip, status === s && styles.chipOn, status === s && s === 'approved' && styles.chipApproved)}
            onClick={() => setStatus(s)}
          >
            {s === 'approved' && status === s ? <Icon name="check" size={11} /> : null}
            {REVIEW_LABEL[s]}
          </button>
        ))}
      </div>
      <button type="button" className={styles.share} onClick={share} title="Copy a shareable review link">
        <Icon name="arrow-up" size={12} /> Share
      </button>
    </div>
  );
}

export default ReviewBar;
