/**
 * Reporting a plugin.
 *
 * The one place a user can say "this is wrong" about something they installed
 * in good faith. Signing proves who published a package and permissions bound
 * what it can reach; neither can tell whether the author meant well. A person
 * who noticed is the only detector for that, and this is the path they take —
 * so it has to be short enough that they finish it while still annoyed enough
 * to have started.
 *
 * ── Three deliberate choices ─────────────────────────────────────────────────
 *
 *  • **A category is required, a message is not.** Free text alone cannot be
 *    triaged — "it is stealing my project" and "it broke last update" need
 *    different urgency — and demanding an essay produces an empty queue.
 *  • **No sign-in wall.** The endpoint takes an identity when the caller has
 *    one and refuses nobody. The moment worth reporting is often BEFORE
 *    installing, and a dialog that asked for an account first would lose it.
 *  • **A failure is shown, never swallowed.** A reporter thanked for a report
 *    that never arrived has been actively misled, and will not try again.
 */

import { useState } from 'react';
import { Modal } from '@components/Modal';
import { reportPlugin } from '@core/plugins/registry';
import {
  REPORT_CATEGORIES,
  REPORT_CATEGORY_TEXT,
  MAX_REPORT_MESSAGE,
  type ReportCategory,
} from '@core/plugins/reportCategories';
import styles from './ReportPluginDialog.module.css';

export function ReportPluginDialog({
  pluginId,
  pluginName,
  version,
  open,
  onClose,
}: {
  pluginId: string;
  pluginName: string;
  /** The version they have, when they have one. Absent from a browse listing. */
  version?: string;
  open: boolean;
  onClose: () => void;
}): JSX.Element {
  const [category, setCategory] = useState<ReportCategory | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const close = (): void => {
    // Reset on the way out, not on the way in: a dialog that reopened holding
    // the last report would let a mis-click file it a second time.
    setCategory(null);
    setMessage('');
    setError(null);
    setSent(false);
    setBusy(false);
    onClose();
  };

  const submit = async (): Promise<void> => {
    if (!category) return;
    setBusy(true);
    setError(null);
    try {
      await reportPlugin(pluginId, {
        category,
        ...(version ? { version } : {}),
        ...(message.trim() ? { message: message.trim() } : {}),
      });
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The report could not be sent.');
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <Modal open={open} onClose={close} title="Report sent" size="sm">
        <div className={styles.body}>
          <p className={styles.lede}>Thank you — a reviewer will look at this.</p>
          {/*
            No case id, no queue position, no "we will email you". Every one of
            those is a promise about a human process, and a promise the
            marketplace cannot keep is worse than saying nothing.
          */}
          <p className={styles.note}>
            Reports about the same version are grouped together, so you do not need to send
            another if someone else has already reported it.
          </p>
        </div>
        <div className={styles.actions}>
          <button type="button" className={styles.primary} onClick={close}>Done</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title={`Report “${pluginName}”`}
      description="Tell us what is wrong. This goes to the registry, not to the publisher."
      size="sm"
    >
      <div className={styles.body}>
        <fieldset className={styles.categories}>
          <legend className={styles.legend}>What is the problem?</legend>
          {REPORT_CATEGORIES.map((key) => (
            <label key={key} className={styles.category} data-selected={category === key || undefined}>
              <input
                type="radio"
                name="report-category"
                value={key}
                checked={category === key}
                onChange={() => setCategory(key)}
              />
              <span className={styles.categoryText}>
                <span className={styles.categoryLabel}>{REPORT_CATEGORY_TEXT[key].label}</span>
                <span className={styles.categoryHint}>{REPORT_CATEGORY_TEXT[key].hint}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>Anything else? (optional)</span>
          <textarea
            className={styles.textarea}
            rows={4}
            maxLength={MAX_REPORT_MESSAGE}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="What happened, and what you were doing at the time."
          />
        </label>

        {/*
          Said plainly, because a reporter's first worry is whether the author
          will find out it was them.
        */}
        <p className={styles.note}>
          The publisher is not told who reported them.
          {version ? ` This is about version ${version}.` : ''}
        </p>

        {error ? <p className={styles.error} role="alert">{error}</p> : null}
      </div>

      <div className={styles.actions}>
        <button type="button" className={styles.secondary} onClick={close} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className={styles.primary}
          disabled={!category || busy}
          onClick={() => void submit()}
        >
          {busy ? 'Sending…' : 'Send report'}
        </button>
      </div>
    </Modal>
  );
}
