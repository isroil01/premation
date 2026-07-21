/**
 * Modal manager (store-backed). Any code can open a modal imperatively:
 *
 *   const id = openModal({ title: 'Settings', render: (close) => <Settings onDone={close} /> });
 *
 * The <ModalHost> renders the stack using the Modal component. Modals stack,
 * so a dialog can spawn another; closing pops just that entry.
 */

import { create } from 'zustand';
import type { ReactNode } from 'react';
import type { ModalSize } from '@components/Modal/Modal';

export interface ModalRequest {
  id: string;
  title?: ReactNode;
  description?: ReactNode;
  size?: ModalSize;
  persistent?: boolean;
  hideCloseButton?: boolean;
  onClose?: () => void;
  render: (close: () => void) => ReactNode;
  footer?: (close: () => void) => ReactNode;
}

export type ModalOpenInput = Omit<ModalRequest, 'id'> & { id?: string };

interface ModalStore {
  stack: ReadonlyArray<ModalRequest>;
  open(req: ModalOpenInput): string;
  close(id: string): void;
  closeAll(): void;
}

let seq = 0;

export const useModalStore = create<ModalStore>((set) => ({
  stack: [],
  open: (req) => {
    const id = req.id ?? `modal_${(seq += 1)}`;
    const entry: ModalRequest = { ...req, id };
    set((s) => ({ stack: [...s.stack.filter((m) => m.id !== id), entry] }));
    return id;
  },
  close: (id) => set((s) => ({ stack: s.stack.filter((m) => m.id !== id) })),
  closeAll: () => set({ stack: [] }),
}));

/** Imperative API (no hook required). */
export const openModal = (req: ModalOpenInput): string => useModalStore.getState().open(req);
export const closeModal = (id: string): void => useModalStore.getState().close(id);
export const closeAllModals = (): void => useModalStore.getState().closeAll();
