/**
 * Command Palette store.
 *
 * Holds only open/closed state + an optional prefill so any surface can open
 * the palette in a specific mode (e.g. openPalette('>') for commands, '@' for
 * layers). The <CommandPalette> host reads this and owns all query logic.
 */

import { create } from 'zustand';

interface CommandPaletteStore {
  open: boolean;
  /** Seed query when opening (e.g. '>' commands, '@' layers, '#' comps, ':' time). */
  initialQuery: string;
  openPalette: (prefill?: string) => void;
  closePalette: () => void;
  toggle: (prefill?: string) => void;
}

export const useCommandPaletteStore = create<CommandPaletteStore>((set, get) => ({
  open: false,
  initialQuery: '',
  openPalette: (prefill = '') => set({ open: true, initialQuery: prefill }),
  closePalette: () => set({ open: false }),
  toggle: (prefill = '') =>
    get().open ? set({ open: false }) : set({ open: true, initialQuery: prefill }),
}));

export const openPalette = (prefill?: string): void =>
  useCommandPaletteStore.getState().openPalette(prefill);
export const closePalette = (): void => useCommandPaletteStore.getState().closePalette();
