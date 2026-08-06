/**
 * Modal — dialog built on Radix Dialog (robust focus-trap, scroll-lock,
 * Escape, and accessible labelling). The public API is unchanged, so the
 * ModalHost and every `openModal(...)` caller keep working:
 *
 *   <Modal open onClose={...} title="Settings" size="md" footer={...}>
 *...content...
 *   </Modal>
 */

import { type CSSProperties, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { cn } from '@utils/cn';
import { IconButton } from '@components/IconButton';
import { Icon } from '@components/Icon';
import styles from './Modal.module.css';

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | 'fullscreen';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  size?: ModalSize;
  /** Hide the header (used for fully custom layouts). */
  hideHeader?: boolean;
  hideCloseButton?: boolean;
  /** Disable Escape-to-close. */
  persistent?: boolean;
  /** Disable scrim click. */
  persistentScrim?: boolean;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}

const SR_ONLY: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

export function Modal({
  open,
  onClose,
  title,
  description,
  size = 'md',
  hideHeader = false,
  hideCloseButton = false,
  persistent = false,
  persistentScrim = false,
  footer,
  children,
  className,
}: ModalProps): JSX.Element {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={styles.scrim}>
          <Dialog.Content
            className={cn(styles.dialog, styles[size], className)}
            onEscapeKeyDown={(e) => persistent && e.preventDefault()}
            onPointerDownOutside={(e) => persistentScrim && e.preventDefault()}
            onInteractOutside={(e) => persistentScrim && e.preventDefault()}
            aria-describedby={undefined}
          >
            {/* Radix requires a Title for a11y; hide it visually when unused. */}
            {hideHeader || !title ? (
              <Dialog.Title style={SR_ONLY}>{title ?? 'Dialog'}</Dialog.Title>
            ) : null}

            {!hideHeader ? (
              <header className={styles.header}>
                <div className={styles.headerText}>
                  {title ? <Dialog.Title className={styles.title}>{title}</Dialog.Title> : null}
                  {description ? (
                    <Dialog.Description className={styles.description}>{description}</Dialog.Description>
                  ) : null}
                </div>
                {!hideCloseButton ? (
                  <Dialog.Close asChild>
                    <IconButton aria-label="Close" size="sm">
                      <Icon name="close" size="md" />
                    </IconButton>
                  </Dialog.Close>
                ) : null}
              </header>
            ) : null}

            <div className={styles.body}>{children}</div>
            {footer ? <footer className={styles.footer}>{footer}</footer> : null}
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
