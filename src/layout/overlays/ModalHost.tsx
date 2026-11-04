/**
 * ModalHost — renders the modal stack from modalStore using the Modal
 * component. Mounted once near the app root.
 *
 * Only the TOP of the stack is interactive. Every lower dialog is rendered
 * (so its state survives the one above it) but `inert`: no focus, no clicks,
 * no Enter-to-confirm firing in a dialog you cannot see. Radix stacks its own
 * focus scopes so the newest traps focus; `inert` is what stops a pointer from
 * reaching the one underneath through a gap in the scrim.
 *
 * A FLOATING dialog is never "under" a blocking one in the interaction sense
 * — it is a tool window beside the work — so it is only made inert while a
 * blocking dialog is open above it.
 */

import { useCatalogueRevision } from '@hooks/useLocale';
import { useEffect } from 'react';
import { Modal } from '@components/Modal';
import { useModalStore } from '@stores/modalStore';
import { installOverlayCommands } from './installCommands';

export function ModalHost(): JSX.Element | null {
  const stack = useModalStore((s) => s.stack);
  const close = useModalStore((s) => s.close);
  // A stored modal's body element is rebuilt by `render`, so it needs this redraw.
  useCatalogueRevision();

  // The dialog-adjacent commands (What's New, help docs, the Export panel,
  // the power tour) register from here because this is the one component
  // that is always mounted exactly once in the editor window. Idempotent.
  useEffect(() => installOverlayCommands(), []);

  if (stack.length === 0) return null;

  const topIndex = stack.length - 1;
  // A floating dialog below a blocking one is inert; below another floating
  // one it is not (two tool windows can both be live).
  const blockingAbove = (i: number): boolean =>
    stack.slice(i + 1).some((m) => (m.variant ?? 'blocking') === 'blocking');

  return (
    <>
      {stack.map((m, i) => {
        const doClose = (): void => {
          m.onClose?.();
          close(m.id);
        };
        const primary = m.primaryAction;
        const isTop = i === topIndex;
        const inert = !isTop && ((m.variant ?? 'blocking') === 'blocking' || blockingAbove(i));
        return (
          <Modal
            key={m.id}
            id={m.id}
            open
            onClose={doClose}
            title={m.title}
            description={m.description}
            size={m.size}
            variant={m.variant}
            resizable={m.resizable}
            persistent={m.persistent}
            hideCloseButton={m.hideCloseButton}
            footer={m.footer ? m.footer(doClose) : undefined}
            primaryAction={primary ? () => primary(doClose) : undefined}
            inert={inert}
            className={m.className}
          >
            {m.render(doClose)}
          </Modal>
        );
      })}
    </>
  );
}
