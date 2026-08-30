import { useState, useEffect, useRef } from 'react';
import { openModal } from '@stores/modalStore';
import { Button } from '@components/Button';
import { Input } from '@components/Input';
import { Icon } from '@components/Icon';

interface PromptDialogContentProps {
  message: string;
  defaultValue: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

function PromptDialogContent({
  message,
  defaultValue,
  placeholder,
  confirmLabel = 'OK',
  cancelLabel = 'Cancel',
  onSubmit,
  onCancel,
}: PromptDialogContentProps) {
  const [val, setVal] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)', margin: 0, lineHeight: 'var(--line-height-normal)' }}>
        {message}
      </p>
      <Input
        ref={inputRef}
        fullWidth
        value={val}
        onChange={(e) => setVal(e.target.value)}
        placeholder={placeholder}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            onSubmit(val);
          }
        }}
      />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px', marginTop: '4px' }}>
        <Button variant="ghost" onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button variant="primary" onClick={() => onSubmit(val)}>
          {confirmLabel}
        </Button>
      </div>
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

    openModal({
      title: (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Icon name={isDanger ? 'warning' : 'info'} size="sm" style={{ color: isDanger ? 'var(--color-danger)' : 'var(--color-primary)' }} />
          <span>{title}</span>
        </div>
      ),
      size: 'sm',
      persistent: true,
      onClose: () => {
        if (!resolved) {
          resolved = true;
          resolve(false);
        }
      },
      render: (close) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)', margin: 0, lineHeight: 'var(--line-height-normal)' }}>
            {message}
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px', marginTop: '4px' }}>
            <Button
              variant="ghost"
              onClick={() => {
                resolved = true;
                close();
                resolve(false);
              }}
            >
              {cancelLabel}
            </Button>
            <Button
              variant={isDanger ? 'danger' : 'primary'}
              onClick={() => {
                resolved = true;
                close();
                resolve(true);
              }}
            >
              {confirmLabel}
            </Button>
          </div>
        </div>
      ),
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
      title: (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Icon name={isDanger ? 'warning' : 'info'} size="sm" style={{ color: isDanger ? 'var(--color-danger)' : 'var(--color-primary)' }} />
          <span>{title}</span>
        </div>
      ),
      size: 'sm',
      persistent: true,
      onClose: done,
      render: (close) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)', margin: 0, lineHeight: 'var(--line-height-normal)', whiteSpace: 'pre-wrap' }}>
            {message}
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '4px' }}>
            <Button
              variant="primary"
              onClick={() => {
                done();
                close();
              }}
            >
              {confirmLabel}
            </Button>
          </div>
        </div>
      ),
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

    openModal({
      title: (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Icon name="pencil" size="sm" style={{ color: 'var(--color-primary)' }} />
          <span>{title}</span>
        </div>
      ),
      size: 'sm',
      persistent: true,
      onClose: () => {
        if (!resolved) {
          resolved = true;
          resolve(null);
        }
      },
      render: (close) => {
        const onSubmit = (val: string) => {
          resolved = true;
          close();
          resolve(val);
        };
        const onCancel = () => {
          resolved = true;
          close();
          resolve(null);
        };
        return (
          <PromptDialogContent
            message={message}
            defaultValue={defaultValue}
            placeholder={placeholder}
            confirmLabel={confirmLabel}
            cancelLabel={cancelLabel}
            onSubmit={onSubmit}
            onCancel={onCancel}
          />
        );
      },
    });
  });
}
