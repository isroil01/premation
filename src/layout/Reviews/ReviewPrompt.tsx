/**
 * "How are you finding it?" — asked once, answerable in one click.
 *
 * ## The shape of the ask
 *
 * The rating is the whole form until it has been given. Opening on a rating and
 * a textarea asks for an essay, and most people close an essay; opening on five
 * stars asks for one click, and the sentence comes after because they have
 * already started. The body only becomes required once they are writing one.
 *
 * ## Dismissing is a real answer
 *
 * "Not now" is a button, not a hidden X, and pressing it records a refusal on
 * the server so this account is never asked again on any machine. The scrim and
 * Escape close WITHOUT recording — closing something is not the same as
 * declining it, and treating it as a refusal means one stray Escape silently
 * spends the single chance we get to ask.
 *
 * ## What this screen does not decide
 *
 * Nothing is published here. Every review lands pending and an operator
 * approves it before it appears anywhere public — the copy says so, because a
 * form that implies your words go live immediately is a form people write
 * differently into.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { Modal } from '@components/Modal';
import { Button } from '@components/Button';
import { Icon } from '@components/Icon';
import { useReviewPromptStore } from '@stores/reviewPromptStore';
import styles from './ReviewPrompt.module.css';

/** The floor the server enforces, mirrored so the form can explain itself. */
const BODY_MIN = 40;
const BODY_MAX = 1200;

const RATING_LABEL: Record<number, string> = {
  1: 'Not for me',
  2: 'Needs work',
  3: 'It is fine',
  4: 'Really good',
  5: 'I love it',
};

export function ReviewPrompt(): JSX.Element | null {
  const open = useReviewPromptStore((s) => s.open);
  const submitting = useReviewPromptStore((s) => s.submitting);
  const error = useReviewPromptStore((s) => s.error);
  const status = useReviewPromptStore((s) => s.status);
  const dismiss = useReviewPromptStore((s) => s.dismiss);
  const close = useReviewPromptStore((s) => s.close);
  const submit = useReviewPromptStore((s) => s.submit);

  const existing = status?.review ?? null;
  const [rating, setRating] = useState(0);
  const [hovered, setHovered] = useState(0);
  const [body, setBody] = useState('');
  const [title, setTitle] = useState('');
  const [role, setRole] = useState('');

  // Seed from an existing draft when the dialog opens, so "edit my review"
  // starts on what they wrote rather than on a blank form.
  useEffect(() => {
    if (!open) return;
    setRating(existing?.rating ?? 0);
    setBody(existing?.body ?? '');
    setTitle(existing?.title ?? '');
    setHovered(0);
  }, [open, existing]);

  if (!open) return null;

  const trimmed = body.trim();
  const shown = hovered || rating;
  // The body is optional until they start one; once started it has to be long
  // enough for the server to accept it, and saying so here beats a round trip
  // that comes back with a validation error.
  const bodyReady = trimmed.length === 0 || trimmed.length >= BODY_MIN;
  const ready = rating > 0 && trimmed.length >= BODY_MIN && !submitting;

  const onSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!ready) return;
    await submit({
      rating,
      body: trimmed,
      ...(title.trim() ? { title: title.trim() } : {}),
      ...(role.trim() ? { authorRole: role.trim() } : {}),
    }).catch(() => undefined);
  };

  return (
    <Modal
      open={open}
      onClose={close}
      id="review-prompt"
      size="md"
      title={existing ? 'Edit your review' : 'How are you finding Premation?'}
      description={
        existing
          ? 'Your review is still waiting to be published, so you can still change it.'
          : 'You have made your first project — we would love to know how it went.'
      }
    >
      <form className={styles.form} onSubmit={(e) => void onSubmit(e)}>
        <fieldset className={styles.ratingField}>
          <legend className={styles.legend}>Your rating</legend>
          <div
            className={styles.stars}
            onMouseLeave={() => setHovered(0)}
            role="radiogroup"
            aria-label="Your rating out of five"
          >
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={rating === n}
                aria-label={`${n} ${n === 1 ? 'star' : 'stars'} — ${RATING_LABEL[n]}`}
                className={n <= shown ? `${styles.star} ${styles.starOn}` : styles.star}
                disabled={submitting}
                onMouseEnter={() => setHovered(n)}
                onFocus={() => setHovered(n)}
                onBlur={() => setHovered(0)}
                onClick={() => setRating(n)}
              >
                <Icon name="star" size="md" aria-hidden />
              </button>
            ))}
            {/* Reserved whether or not a rating is chosen, so picking one does
                not shove the form down by a line. */}
            <span className={styles.ratingLabel}>{shown ? RATING_LABEL[shown] : ' '}</span>
          </div>
        </fieldset>

        <label className={styles.field}>
          <span className={styles.label}>
            What did you make?
            <span className={styles.count} data-over={trimmed.length > BODY_MAX || undefined}>
              {trimmed.length}/{BODY_MAX}
            </span>
          </span>
          <textarea
            className={styles.textarea}
            rows={5}
            maxLength={BODY_MAX}
            placeholder="A sentence or two about what you built and how it went."
            value={body}
            disabled={submitting}
            onChange={(e) => setBody(e.target.value)}
          />
          {!bodyReady && (
            <span className={styles.hint}>
              A little more, please — at least {BODY_MIN} characters.
            </span>
          )}
        </label>

        <div className={styles.optionalRow}>
          <label className={styles.field}>
            <span className={styles.label}>Headline (optional)</span>
            <input
              className={styles.input}
              type="text"
              maxLength={80}
              placeholder="Replaced our whole titles workflow"
              value={title}
              disabled={submitting}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>What you do (optional)</span>
            <input
              className={styles.input}
              type="text"
              maxLength={80}
              placeholder="Motion designer"
              value={role}
              disabled={submitting}
              onChange={(e) => setRole(e.target.value)}
            />
          </label>
        </div>

        <p className={styles.notice}>
          <Icon name="info" size="sm" aria-hidden className={styles.noticeIcon} />
          <span>
            Nothing is published automatically. We read every review first, and only your
            name and what you write here would ever appear — never your email address.
          </span>
        </p>

        {error && (
          <div className={styles.error} role="alert">
            <Icon name="warning" size="sm" aria-hidden />
            <span>{error}</span>
          </div>
        )}

        <div className={styles.actions}>
          {/* Declining is a button, not a hidden X — and it is the one that
              records a refusal. Closing the dialog does not. */}
          <Button variant="ghost" size="md" onClick={() => void dismiss()} disabled={submitting}>
            {existing ? 'Leave it as it is' : 'Not now'}
          </Button>
          <Button type="submit" variant="primary" size="md" loading={submitting} disabled={!ready}>
            {existing ? 'Update review' : 'Send review'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export default ReviewPrompt;
