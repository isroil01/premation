/**
 * "The publisher's signing key changed."
 *
 * The one screen that stands between an authorised key rotation and an account
 * takeover, because from here they look identical — and that is not a flaw in
 * this dialog, it is the honest situation. The registry has already required
 * the publisher's password to authorise the new key and a package signed with
 * it to rotate. This is the third gate, and it is the only one the person
 * whose machine it is gets to hold.
 *
 * ── What that means for the writing ──────────────────────────────────────────
 *
 * **Keeping the current version is a real option, presented as one.** It is not
 * a "cancel". The installed plugin keeps working, nothing is lost, and choosing
 * it costs the user nothing today — which is exactly why it can afford to be
 * the calm choice rather than the scary one.
 *
 * **No key fingerprints as the headline.** Two base64 blobs tell a user nothing
 * they can act on, and a screen full of cryptographic detail reads as "this is
 * for someone else" — which produces a reflexive Accept. The fingerprints are
 * available, below, for the small number of people who will check them against
 * something the publisher announced.
 *
 * **No default action, and no auto-focus on accept.** A prompt that can be
 * dismissed with a stray Enter is not a prompt.
 */

import { useState } from 'react';
import { Modal } from '@components/Modal';
import type { KeyChangeRequest } from './installFromRegistry';
import styles from './KeyChangeSheet.module.css';

/** First and last few characters — enough to compare, short enough to read. */
function fingerprint(key: string): string {
  if (key.length <= 24) return key;
  return `${key.slice(0, 12)}…${key.slice(-12)}`;
}

export function KeyChangeSheet({
  request,
  onDecide,
}: {
  request: KeyChangeRequest;
  onDecide: (accepted: boolean) => void;
}): JSX.Element {
  const [showKeys, setShowKeys] = useState(false);

  return (
    <Modal
      open
      // Closing by scrim or Escape is a DECLINE, never an accept. The safe
      // outcome has to be the one that happens when someone stops paying
      // attention.
      onClose={() => onDecide(false)}
      title={`${request.pluginName} is signed with a new key`}
      size="sm"
    >
      <div className={styles.body}>
        <p className={styles.lede}>
          Updates to this plugin used to be signed with one key. Version {request.version} is
          signed with a different one.
        </p>

        <p className={styles.note}>
          Publishers do change signing keys — usually because the old one was lost. But this is
          also what it would look like if someone else had taken over the publisher’s account, and
          from here the two are indistinguishable. Only accept if you were expecting it, or if the
          publisher has announced it somewhere you trust.
        </p>

        <p className={styles.note}>
          Keeping your current version is safe. It goes on working exactly as it does now, and you
          can update later.
        </p>

        <button
          type="button"
          className={styles.disclosure}
          onClick={() => setShowKeys((v) => !v)}
          aria-expanded={showKeys}
        >
          {showKeys ? 'Hide key details' : 'Show key details'}
        </button>

        {showKeys ? (
          <dl className={styles.keys}>
            <dt>Key you trusted</dt>
            <dd>{fingerprint(request.pinnedKey)}</dd>
            <dt>New key</dt>
            <dd>{fingerprint(request.newKey)}</dd>
          </dl>
        ) : null}
      </div>

      <div className={styles.actions}>
        {/*
          Order and emphasis are deliberate. Keeping the current version is the
          low-risk choice and sits where the eye lands; accepting is available,
          unhighlighted, and requires a deliberate click.
        */}
        <button type="button" className={styles.primary} onClick={() => onDecide(false)}>
          Keep version I have
        </button>
        <button type="button" className={styles.secondary} onClick={() => onDecide(true)}>
          Trust the new key and update
        </button>
      </div>
    </Modal>
  );
}
