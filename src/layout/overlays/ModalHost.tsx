/**
 * ModalHost — renders the modal stack from modalStore using the Modal
 * component. Mounted once near the app root.
 */

import { Modal } from '@components/Modal';
import { useModalStore } from '@stores/modalStore';

export function ModalHost(): JSX.Element | null {
  const stack = useModalStore((s) => s.stack);
  const close = useModalStore((s) => s.close);

  if (stack.length === 0) return null;

  return (
    <>
      {stack.map((m) => {
        const doClose = (): void => close(m.id);
        return (
          <Modal
            key={m.id}
            open
            onClose={doClose}
            title={m.title}
            description={m.description}
            size={m.size}
            persistent={m.persistent}
            footer={m.footer ? m.footer(doClose) : undefined}
          >
            {m.render(doClose)}
          </Modal>
        );
      })}
    </>
  );
}
