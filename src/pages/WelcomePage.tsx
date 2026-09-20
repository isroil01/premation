/**
 * One question, asked once: how did you hear about us?
 *
 * ## Why it is here and not on the signup form
 *
 * The registration form is the highest-stakes form on the platform and every
 * field added to it costs accounts. This question costs nothing here, because
 * the user has already paid the price of admission — they have an account and a
 * confirmed address, and the only thing between them and the app is one tap.
 *
 * It is also the first moment the answer is worth having. An unverified account
 * is not yet a person; collecting a channel from every throwaway address would
 * bias the whole report toward however throwaway accounts arrive.
 *
 * ## Why it cannot be skipped
 *
 * Asked for, and defensible: this is a closed set of eight options where one of
 * them is "something else", so there is no honest answer the form refuses. A
 * "skip" on a question that takes one tap mostly collects skips, and an
 * attribution report with a 30% response rate cannot be reasoned from — the
 * missing 70% is not random, it is whoever was in a hurry.
 *
 * The escape hatch is real rather than nominal: `other` accepts free text and
 * that text is what tells us which option the list is missing.
 *
 * ## What the server owns
 *
 * Whether to ask (`needsSignupSource`), whether the answer is well formed, and
 * that it can only be given once. This screen renders the question and reports
 * the answer; it decides nothing.
 */

import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { api, type SignupSource } from '@core/api/client';
import { useAuthStore } from '@stores/authStore';
import { Icon, type IconName } from '@components/Icon';
import styles from './AuthPage.module.css';
import welcome from './WelcomePage.module.css';

/**
 * The options, in the order they are offered.
 *
 * Ordered by expected frequency rather than alphabetically, because the list is
 * read top-down and the common answers should be reachable without reading all
 * of it. `other` is pinned last by construction — it is the escape hatch, and
 * an escape hatch offered early is the one everybody takes.
 */
const OPTIONS: ReadonlyArray<{ value: SignupSource; label: string; icon: IconName }> = [
  { value: 'google', label: 'Google or another search engine', icon: 'search' },
  { value: 'ai_assistant', label: 'ChatGPT, Claude or another AI assistant', icon: 'sparkles' },
  { value: 'youtube', label: 'YouTube', icon: 'play' },
  { value: 'social', label: 'Instagram, X, TikTok or LinkedIn', icon: 'share' },
  { value: 'friend', label: 'A friend or colleague', icon: 'user' },
  { value: 'article', label: 'A blog post, newsletter or review', icon: 'file' },
  { value: 'forum', label: 'Reddit, Discord or a forum', icon: 'group' },
  { value: 'other', label: 'Something else', icon: 'more-horizontal' },
];

/** The write-in limit the server enforces, mirrored so the field can show it. */
const OTHER_MAX = 120;

/** Pull the server's `{ code, message }` out of a failed request. */
function messageOf(err: unknown, fallback: string): string {
  const body = (err as { body?: { message?: string | { message?: string } } }).body;
  const msg = typeof body?.message === 'object' ? body.message.message : body?.message;
  return msg || (err instanceof Error ? err.message : fallback);
}

export function WelcomePage(): JSX.Element {
  const navigate = useNavigate();
  const status = useAuthStore((s) => s.status);
  const user = useAuthStore((s) => s.user);
  const markAnswered = useAuthStore((s) => s.markSignupSourceAnswered);

  const [choice, setChoice] = useState<SignupSource | null>(null);
  const [other, setOther] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // Hooks are all above these returns, so the order never changes between
  // renders — same arrangement as VerifyEmailPage, for the same reason.
  if (status !== 'authenticated') return <Navigate to="/login" replace />;
  if (!user?.emailVerified) return <Navigate to="/verify-email" replace />;
  // Answered already (or never owed) — this route is not a place to linger.
  if (!user.needsSignupSource) return <Navigate to="/dashboard" replace />;

  const needsText = choice === 'other';
  const trimmedOther = other.trim();
  const ready = choice !== null && (!needsText || trimmedOther.length >= 2);

  const onSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!ready || submitting) return;
    setError('');
    setSubmitting(true);
    try {
      // The write-in travels only with `other`. The server refuses it beside any
      // other variant, and sending it anyway would be asking to be rejected.
      await api.setSignupSource(choice, needsText ? trimmedOther : undefined);
      markAnswered();
      navigate('/dashboard', { replace: true });
    } catch (err) {
      setError(messageOf(err, 'Could not save that just now. Try again.'));
      setSubmitting(false);
    }
  };

  const firstName = user.name?.trim().split(/\s+/)[0];

  return (
    <div className={styles.container}>
      <div className={`${styles.card} ${welcome.card}`}>
        <div className={styles.headerText}>
          <h1 className={styles.title}>{firstName ? `Welcome, ${firstName}` : 'Welcome'}</h1>
          <p className={styles.subtitle}>
            Your email is confirmed. One question before you start — it is the only way we
            find out which of these is worth doing more of.
          </p>
        </div>

        <form className={styles.form} onSubmit={(e) => void onSubmit(e)}>
          <fieldset className={welcome.fieldset}>
            <legend className={welcome.legend}>How did you hear about Premation?</legend>

            <div className={welcome.options}>
              {OPTIONS.map((opt) => {
                const active = choice === opt.value;
                return (
                  <label
                    key={opt.value}
                    className={active ? `${welcome.option} ${welcome.optionActive}` : welcome.option}
                  >
                    <input
                      type="radio"
                      name="signupSource"
                      value={opt.value}
                      className={welcome.radio}
                      checked={active}
                      disabled={submitting}
                      onChange={() => {
                        setChoice(opt.value);
                        // Leaving stale prose behind would let it travel with a
                        // preset answer the moment the user changed their mind,
                        // which is exactly what the server refuses.
                        if (opt.value !== 'other') setOther('');
                      }}
                    />
                    <span className={welcome.optionMark} aria-hidden>
                      <span className={welcome.optionDot} />
                    </span>
                    <Icon name={opt.icon} size="sm" className={welcome.optionIcon} aria-hidden />
                    <span className={welcome.optionLabel}>{opt.label}</span>
                  </label>
                );
              })}
            </div>

            {needsText && (
              <div className={welcome.otherField}>
                <label className={styles.label} htmlFor="signup-source-other">
                  Where was that?
                </label>
                <input
                  id="signup-source-other"
                  type="text"
                  className={`${styles.input} ${styles.inputNoIcon}`}
                  placeholder="A podcast, a conference, a course…"
                  value={other}
                  maxLength={OTHER_MAX}
                  disabled={submitting}
                  // The field appears because the option was chosen, so the
                  // caret belongs in it — otherwise the next keystroke goes to
                  // the radio group and moves the selection the user just made.
                  autoFocus
                  onChange={(e) => setOther(e.target.value)}
                />
                <p className={welcome.otherHint}>
                  Free text. It is read by us to find the option this list is missing —
                  nothing here is ever shown publicly.
                </p>
              </div>
            )}
          </fieldset>

          {error && (
            <div className={styles.errorAlert} role="alert">
              <Icon name="warning" size="sm" aria-hidden />
              <span>{error}</span>
            </div>
          )}

          <button type="submit" className={styles.primaryBtn} disabled={!ready || submitting}>
            {submitting ? 'Saving…' : 'Continue'}
          </button>
        </form>
      </div>
    </div>
  );
}

export default WelcomePage;
