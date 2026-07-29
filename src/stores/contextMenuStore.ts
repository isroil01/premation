/**
 * Context-menu manager (store-backed). Open a menu at a point from anywhere:
 *
 *   onContextMenu={(e) => { e.preventDefault;
 *     openContextMenu(e.clientX, e.clientY, [
 *       { id: 'rename', label: 'Rename', onSelect: rename },
 *       { id: 'sep', separator: true },
 *       { id: 'delete', label: 'Delete', danger: true, onSelect: remove },
 *     ]);
 *   }}
 *
 * The <ContextMenuHost> renders it with the Menu component.
 */

import { create } from 'zustand';
import type { ReactNode } from 'react';
import type { IconName } from '@components/Icon';

export interface ContextMenuItem {
  id: string;
  label?: ReactNode;
  icon?: IconName;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  /** Render a divider instead of an action. */
  separator?: boolean;
  onSelect?: () => void;
  /** Nested items — renders this entry as a submenu (opens to the right). */
  children?: ContextMenuItem[];
}

interface ContextMenuState {
  open: boolean;
  x: number;
  y: number;
  items: ReadonlyArray<ContextMenuItem>;
  openMenu(x: number, y: number, items: ContextMenuItem[]): void;
  close(): void;
}

export const useContextMenuStore = create<ContextMenuState>((set) => ({
  open: false,
  x: 0,
  y: 0,
  items: [],
  openMenu: (x, y, items) => set({ open: true, x, y, items }),
  close: () => set({ open: false, items: [] }),
}));

export const openContextMenu = (x: number, y: number, items: ContextMenuItem[]): void =>
  useContextMenuStore.getState().openMenu(x, y, items);
export const closeContextMenu = (): void => useContextMenuStore.getState().close();
