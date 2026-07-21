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

export function PromptDialogContent({
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
          <Icon name={isDanger ? 'warning' : 'info'} size={18} style={{ color: isDanger ? 'var(--color-danger)' : 'var(--color-primary)' }} />
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

export function customAlert(
  title: string,
  message: string,
  options?: { buttonLabel?: string }
): Promise<void> {
  const { buttonLabel = 'OK' } = options ?? {};
  return new Promise((resolve) => {
    let resolved = false;

    openModal({
      title: (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Icon name="info" size={18} style={{ color: 'var(--color-primary)' }} />
          <span>{title}</span>
        </div>
      ),
      size: 'sm',
      persistent: true,
      onClose: () => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      },
      render: (close) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)', margin: 0, lineHeight: 'var(--line-height-normal)' }}>
            {message}
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '4px' }}>
            <Button
              variant="primary"
              onClick={() => {
                resolved = true;
                close();
                resolve();
              }}
            >
              {buttonLabel}
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
          <Icon name="pencil" size={18} style={{ color: 'var(--color-primary)' }} />
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
