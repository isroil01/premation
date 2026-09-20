/**
 * Claiming a publisher namespace.
 *
 * This is the one step in the whole shelf that cannot be undone: the namespace
 * becomes the permanent prefix of every plugin id published under it, and a
 * plugin id is what an installed copy checks an update against. So the screen
 * is built to make the user certain before they commit, rather than to get them
 * through quickly:
 *
 *  • The **rule is enforced while typing**, not on submit. The registry's id
 *    grammar is narrow (lower-case, digits, single hyphens, no leading or
 *    trailing hyphen) and a server-side rejection after a confident Submit is
 *    the worst place to learn it.
 *  • The **consequence is shown, not described**. `acme.easing-lab` updating
 *    live under the field says what "permanent prefix" means in a way a
 *    sentence does not.
 *  • The **display name is separately editable later**; the namespace is not.
 *    Saying which is which, next to the fields, is what stops someone typing
 *    their studio's full name into the permanent one.
 *
 * It is a page, not a dialog. A dialog would put an irreversible decision
 * behind a dismissable scrim, and the one thing this step should not feel like
 * is something to get past.
 */

import { useMemo, useState } from 'react';
import { Icon } from '@components/Icon';
import { Button } from '@components/Button';
import { registerPublisher } from '@core/plugins/registry';
import styles from './PublisherWorkspace.module.css';

/**
 * One segment of a plugin id, as the registry's own `REGISTRY_ID_RE` defines
 * it. Checked here as well so a bad namespace fails under the field instead of
 * after a round trip.
 */
const SEGMENT_RE = /^[a-z0-9][a-z0-9-]*$/;

const MAX_NAMESPACE = 32;

/** The rule that `value` breaks, or null when it is fine (or still empty). */
function namespaceProblem(value: string): string | null {
  if (value.length === 0) return null;
  if (value.length > MAX_NAMESPACE) return `Keep it to ${MAX_NAMESPACE} characters or fewer.`;
  // Case is not validated: the field lower-cases as you type, so an upper-case
  // key press is a correction rather than a mistake. Rejecting it here while
  // `submit` silently lower-cased it anyway was the contradiction this
  // replaces — the user was told off for something the form then fixed.
  if (/\s/.test(value)) return 'No spaces — use a hyphen.';
  if (value.startsWith('-') || value.endsWith('-')) return 'Cannot start or end with a hyphen.';
  if (value.includes('.')) return 'One segment only — the dot is added for you.';
  if (!SEGMENT_RE.test(value)) return 'Letters, digits and hyphens only.';
  return null;
}

export function ClaimNamespace({
  onClaimed,
  onError,
}: {
  onClaimed: () => void;
  onError: (message: string | null) => void;
}): JSX.Element {
  const [namespace, setNamespace] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  /** Errors stay hidden until the field has been left once. */
  const [touched, setTouched] = useState(false);

  const trimmed = namespace.trim();
  const problem = namespaceProblem(trimmed);
  const ready = trimmed.length > 0 && !problem && displayName.trim().length > 0;

  const preview = useMemo(() => trimmed || 'your-namespace', [trimmed]);

  const submit = async (): Promise<void> => {
    if (!ready || busy) return;
    setBusy(true);
    onError(null);
    try {
      await registerPublisher(trimmed, displayName.trim());
      onClaimed();
    } catch (err) {
      onError((err as Error).message || 'Could not claim that namespace.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className={styles.column}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className={styles.sectionHead}>
        <span className={styles.sectionTitle}>Claim a publisher namespace</span>
        <span className={styles.sectionHint}>
          Every plugin you publish is identified by your namespace followed by the plugin&rsquo;s own name. It is how an
          installed copy recognises that an update came from you, so it is permanent once claimed.
        </span>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="claim-namespace">
          Namespace <span className={styles.labelHint}>· permanent, cannot be changed later</span>
        </label>
        <input
          id="claim-namespace"
          className={touched && problem ? `${styles.input} ${styles.inputInvalid}` : styles.input}
          value={namespace}
          // Lower-cased in the field, not at submit: the namespace the preview
          // shows has to be the namespace that gets claimed, and a field that
          // accepts `Acme` then registers `acme` is lying about what it will do.
          onChange={(e) => setNamespace(e.target.value.toLowerCase())}
          onBlur={() => setTouched(true)}
          placeholder="acme"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          maxLength={MAX_NAMESPACE + 8}
          aria-label="Namespace"
          aria-invalid={touched && problem ? true : undefined}
          aria-describedby="claim-namespace-preview"
        />
        {touched && problem && (
          <span className={styles.fieldError}>
            <Icon name="warning" size="sm" />
            {problem}
          </span>
        )}
      </div>

      <div className={styles.field}>
        <span className={styles.label}>Your plugin ids will look like</span>
        <div className={styles.preview} id="claim-namespace-preview">
          <span className={styles.previewStrong}>{preview}</span>
          <span>.easing-lab</span>
        </div>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="claim-display-name">
          Display name <span className={styles.labelHint}>· shown on your listings, editable later</span>
        </label>
        <input
          id="claim-display-name"
          className={styles.input}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Acme Studio"
          autoComplete="organization"
          maxLength={64}
          aria-label="Display name"
        />
      </div>

      <div>
        <Button type="submit" variant="primary" size="md" loading={busy} disabled={!ready || busy}>
          {busy ? 'Claiming…' : `Claim ${trimmed ? `“${trimmed}”` : 'namespace'}`}
        </Button>
      </div>
    </form>
  );
}
