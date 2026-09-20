/**
 * Withdrawing a listing.
 *
 * The one genuinely irreversible action a publisher has, and the only place in
 * this redesign that IS a dialog — because a dialog is right here for the
 * reason it is wrong elsewhere: it stops everything and refuses to be answered
 * by accident.
 *
 * Three guards, each earning its place:
 *
 *  • **Type the name.** Not a second "are you sure" button, which people learn
 *    to click through. Typing `easing-lab` requires reading which listing this
 *    is, and the classic disaster is withdrawing the wrong one.
 *  • **The reversible option is an action, not advice.** "Make it private
 *    instead" is what most people arriving here actually want — they want to
 *    stop new installs, not erase the listing — so it is a button that does
 *    that, not a sentence suggesting they go and find it.
 *  • **What survives is stated.** Installed copies keep working. Withdrawing
 *    does not reach into anyone's machine, and a publisher deciding this is
 *    entitled to know that before they decide, not after.
 */

import { useEffect, useRef, useState } from 'react';
import { Icon } from '@components/Icon';
import { Modal } from '@components/Modal';
import { Button } from '@components/Button';
import { deletePublishedPlugin, updateListing, type MyRegistryPlugin } from '@core/plugins/registry';
import styles from './PublisherWorkspace.module.css';

/** The part of the id the user types to confirm — the name, not the namespace. */
const confirmPhrase = (plugin: MyRegistryPlugin): string => plugin.id.split('.').slice(1).join('.') || plugin.id;

export function WithdrawDialog({
  plugin,
  open,
  onClose,
  onDone,
  onError,
}: {
  plugin: MyRegistryPlugin;
  open: boolean;
  onClose: () => void;
  /** The listing is gone, or is now private — either way the shelf must reload. */
  onDone: () => void;
  onError: (message: string | null) => void;
}): JSX.Element {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState<'withdraw' | 'private' | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const phrase = confirmPhrase(plugin);
  const matches = typed.trim() === phrase;

  // Re-opening on another listing must not inherit the last one's typing —
  // which would otherwise leave the button armed for the wrong plugin.
  useEffect(() => {
    if (!open) return;
    setTyped('');
    setBusy(null);
    // The confirm field is the only thing to do here, so it takes focus once
    // the dialog has settled its own. Deferred a frame because `Modal` moves
    // focus to itself on open and would otherwise take it straight back.
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open, plugin.id]);

  const withdraw = async (): Promise<void> => {
    if (!matches || busy) return;
    setBusy('withdraw');
    onError(null);
    try {
      await deletePublishedPlugin(plugin.id);
      onDone();
      onClose();
    } catch (err) {
      onError((err as Error).message || 'Could not withdraw the plugin.');
      setBusy(null);
    }
  };

  const makePrivate = async (): Promise<void> => {
    if (busy) return;
    setBusy('private');
    onError(null);
    try {
      await updateListing(plugin.id, { visibility: 'private' });
      onDone();
      onClose();
    } catch (err) {
      onError((err as Error).message || 'Could not change visibility.');
      setBusy(null);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Withdraw ${plugin.name}?`}
      description="This removes the listing and every published version from the registry."
      size="sm"
    >
      <div className={styles.dialogBody}>
        <div className={`${styles.notice} ${styles.noticeWarn}`}>
          <Icon name="warning" size="sm" className={styles.noticeIcon} />
          <div className={styles.noticeBody}>
            <span className={styles.noticeTitle}>This cannot be undone.</span>
            <span>
              All {plugin.installs.toLocaleString()} existing installs keep working — withdrawing does not remove
              anything already on someone&rsquo;s machine. What goes is the listing, its history, and the ability to
              publish under this id again.
            </span>
          </div>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="withdraw-confirm">
            Type <span className={styles.confirmName}>{phrase}</span> to confirm
          </label>
          <input
            id="withdraw-confirm"
            ref={inputRef}
            className={styles.input}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && matches) void withdraw();
            }}
            placeholder={phrase}
            autoComplete="off"
            spellCheck={false}
            aria-label={`Type ${phrase} to confirm`}
          />
        </div>

        <div className={styles.dialogActions}>
          <span className={styles.dialogAlt}>
            <Button
              variant="secondary"
              size="sm"
              loading={busy === 'private'}
              disabled={busy !== null || plugin.visibility === 'private'}
              onClick={() => void makePrivate()}
              title={
                plugin.visibility === 'private'
                  ? 'This listing is already private.'
                  : 'Stop new installs without deleting anything.'
              }
            >
              {busy === 'private' ? 'Making private…' : 'Make private instead'}
            </Button>
          </span>

          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy !== null}>
            Cancel
          </Button>

          <Button
            variant="danger"
            size="sm"
            loading={busy === 'withdraw'}
            disabled={!matches || busy !== null}
            onClick={() => void withdraw()}
          >
            {busy === 'withdraw' ? 'Withdrawing…' : 'Withdraw permanently'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
