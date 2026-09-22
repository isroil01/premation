/**
 * The three stock dialogs — `customConfirm`, `customAlert`, `customPrompt` —
 * as promises over `openModal`.
 *
 * Their footers are the modal's own footer slot, built from `DialogFooter`
 * (secondary left, destructive left in red, primary right), and Enter is the
 * modal's Enter-to-confirm — nothing here hand-rolls button order or a key
 * handler. The prompt registers its confirm with `useDialogPrimaryAction`
 * because the value lives in its body.
 */

import { useState, useEffect, useRef } from 'react';
import { openModal } from '@stores/modalStore';
import { Button } from '@components/Button';
import { Input } from '@components/Input';
import { Icon, type IconName } from '@components/Icon';
import { cn } from '@utils/cn';
import { useDialogPrimaryAction } from './Modal';
// TODO(ds): DialogFooter is being added by the design-system pass; this file
// consumes it with the `secondary` / `destructive` / `primary` slot API.
import { DialogFooter } from './DialogFooter';
import styles from './Dialogs.module.css';

function DialogTitle({ icon, danger, children }: { icon: IconName; danger?: boolean; children: string }): JSX.Element {
  return (
    <div className={styles.titleRow}>
      <Icon name={icon} size="sm" className={cn(styles.titleIcon, danger && styles.titleIconDanger)} />
      <span>{children}</span>
    </div>
  );
}

interface PromptDialogContentProps {
  message: string;
  defaultValue: string;
  placeholder?: string;
  onSubmit: (value: string) => void;
}

function PromptDialogContent({ message, defaultValue, placeholder, onSubmit }: PromptDialogContentProps): JSX.Element {
  const [val, setVal] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, []);

  // Enter in the field submits the CURRENT value — the modal's Enter handler
  // reaches this through the registration rather than a keydown of its own.
  useDialogPrimaryAction(() => onSubmit(val));

  return (
    <div className={styles.stack}>
      <p className={styles.message}>{message}</p>
      <Input
        ref={inputRef}
        fullWidth
        value={val}
        onChange={(e) => setVal(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}

export function customConfirm(
  title: string,
  message: string,
  options?: { confirmLabel?: string; cancelLabel?: string; isDanger?: boolean }
): Promise<boolean> {
  const { confirmLabel = 'Confirm', cancelLabel = 'Cancel', isDanger = false } = options ?? {};
  return new Promise((resolve) => {
    let resolved = false;
    const settle = (value: boolean, close: () => void): void => {
      resolved = true;
      close();
      resolve(value);
    };

    openModal({
      title: <DialogTitle icon={isDanger ? 'warning' : 'info'} danger={isDanger}>{title}</DialogTitle>,
      size: 'sm',
      persistent: true,
      onClose: () => {
        if (!resolved) {
          resolved = true;
          resolve(false);
        }
      },
      render: () => (
        <div className={styles.stack}>
          <p className={styles.message}>{message}</p>
        </div>
      ),
      footer: (close) => (
        <DialogFooter
          secondary={
            <Button variant="ghost" onClick={() => settle(false, close)}>
              {cancelLabel}
            </Button>
          }
          {...(isDanger
            ? {
                destructive: (
                  <Button variant="danger" onClick={() => settle(true, close)}>
                    {confirmLabel}
                  </Button>
                ),
              }
            : {
                primary: (
                  <Button variant="primary" onClick={() => settle(true, close)}>
                    {confirmLabel}
                  </Button>
                ),
              })}
        />
      ),
      primaryAction: (close) => settle(true, close),
    });
  });
}

/** What the user chose in a `customSaveChoice`. Dismissal (Esc, ×) is `cancel`. */
export type SaveChoice = 'save' | 'discard' | 'cancel';

/**
 * The three-way unsaved-changes dialog: Save / Don't Save / Cancel.
 *
 * `customConfirm` can only ask yes-or-no, so the unsaved-changes prompt built
 * on it offered Cancel and "Discard and continue" — the one thing a person
 * closing a dirty project most often wants, keeping the work, was not on the
 * dialog at all. The footer slots already say where each answer goes: the way
 * out on the left, the destructive verb beside it in red, and Save alone on
 * the right where Enter finds it — so Enter can never discard.
 */
export function customSaveChoice(
  title: string,
  message: string,
  options?: { saveLabel?: string; discardLabel?: string; cancelLabel?: string },
): Promise<SaveChoice> {
  const { saveLabel = 'Save', discardLabel = 'Don’t Save', cancelLabel = 'Cancel' } = options ?? {};
  return new Promise((resolve) => {
    let resolved = false;
    const settle = (value: SaveChoice, close: () => void): void => {
      resolved = true;
      close();
      resolve(value);
    };

    openModal({
      title: <DialogTitle icon="warning" danger>{title}</DialogTitle>,
      size: 'sm',
      persistent: true,
      onClose: () => {
        if (!resolved) {
          resolved = true;
          resolve('cancel');
        }
      },
      render: () => (
        <div className={styles.stack}>
          <p className={cn(styles.message, styles.preWrap)}>{message}</p>
        </div>
      ),
      footer: (close) => (
        <DialogFooter
          secondary={
            <Button variant="ghost" onClick={() => settle('cancel', close)}>
              {cancelLabel}
            </Button>
          }
          destructive={
            <Button variant="danger" onClick={() => settle('discard', close)}>
              {discardLabel}
            </Button>
          }
          primary={
            <Button variant="primary" onClick={() => settle('save', close)}>
              {saveLabel}
            </Button>
          }
        />
      ),
      primaryAction: (close) => settle('save', close),
    });
  });
}

/**
 * In-app replacement for `window.alert`.
 *
 * Returns a promise so a caller can await dismissal, but most callers just fire
 * it — the point is that the message lands in the app's own modal chrome rather
 * than an OS dialog that blocks the renderer thread.
 *
 * `message` is rendered with `white-space: pre-wrap` because the plugin
 * installer's errors arrive as `errors.join('\n')`, and a native alert honoured
 * those newlines. Losing them would turn a readable validation list into one
 * run-on line.
 */
export function customAlert(
  title: string,
  message: string,
  options?: { isDanger?: boolean; confirmLabel?: string },
): Promise<void> {
  const { isDanger = false, confirmLabel = 'OK' } = options ?? {};
  return new Promise((resolve) => {
    let resolved = false;
    const done = (): void => {
      if (!resolved) {
        resolved = true;
        resolve();
      }
    };

    openModal({
      title: <DialogTitle icon={isDanger ? 'warning' : 'info'} danger={isDanger}>{title}</DialogTitle>,
      size: 'sm',
      persistent: true,
      onClose: done,
      render: () => (
        <div className={styles.stack}>
          <p className={cn(styles.message, styles.preWrap)}>{message}</p>
        </div>
      ),
      footer: (close) => (
        <DialogFooter
          primary={
            <Button
              variant="primary"
              onClick={() => {
                done();
                close();
              }}
            >
              {confirmLabel}
            </Button>
          }
        />
      ),
      primaryAction: (close) => {
        done();
        close();
      },
    });
  });
}

export function customPrompt(
  title: string,
  message: string,
  defaultValue = '',
  options?: { placeholder?: string; confirmLabel?: string; cancelLabel?: string }
): Promise<string | null> {
  const { placeholder = '', confirmLabel = 'OK', cancelLabel = 'Cancel' } = options ?? {};
  return new Promise((resolve) => {
    let resolved = false;
    // The body owns the value, so the footer's OK reaches it through this
    // latch rather than through props: the body registers its submit here.
    let submit: (() => void) | null = null;

    openModal({
      title: <DialogTitle icon="pencil">{title}</DialogTitle>,
      size: 'sm',
      persistent: true,
      onClose: () => {
        if (!resolved) {
          resolved = true;
          resolve(null);
        }
      },
      render: (close) => {
        const onSubmit = (val: string): void => {
          resolved = true;
          close();
          resolve(val);
        };
        return (
          <PromptDialogContent
            message={message}
            defaultValue={defaultValue}
            placeholder={placeholder}
            onSubmit={(v) => {
              submit = () => onSubmit(v);
              onSubmit(v);
            }}
          />
        );
      },
      footer: (close) => (
        <DialogFooter
          secondary={
            <Button
              variant="ghost"
              onClick={() => {
                resolved = true;
                close();
                resolve(null);
              }}
            >
              {cancelLabel}
            </Button>
          }
          primary={
            <Button variant="primary" onClick={() => submit?.() ?? clickBodySubmit()}>
              {confirmLabel}
            </Button>
          }
        />
      ),
    });
  });
}

/**
 * The prompt's OK button when nothing has been submitted yet: the body holds
 * the value, so OK is the same as Enter — dispatch Enter to the focused field
 * and let the modal's Enter-to-confirm route it to the registered action.
 */
function clickBodySubmit(): void {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return;
  active.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
}
