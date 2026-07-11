/**
 * Selection store.
 *
 * Right now this is a thin id-list. The future Scene Graph engine will plug
 * its selection model into this store (or expose a richer service behind it).
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { getEventBus } from '@core/events/EventBus';

export interface SelectionState {
  ids: ReadonlyArray<string>;
  primary: string | null;
}

interface SelectionActions {
  set(ids: ReadonlyArray<string>): void;
  add(id: string): void;
  remove(id: string): void;
  toggle(id: string): void;
  clear(): void;
  isSelected(id: string): boolean;
  count(): number;
}

export const useSelectionStore = create<SelectionState & SelectionActions>()(
  immer((set, get) => ({
    ids: [],
    primary: null,

    set: (ids) => {
      const next = Array.from(new Set(ids));
      set((s) => {
        s.ids = next;
        s.primary = next[0] ?? null;
      });
      getEventBus().emit('SelectionChanged', { ids: next });
    },

    add: (id) => {
      if (get().ids.includes(id)) return;
      const next = [...get().ids, id];
      set((s) => {
        s.ids = next;
        s.primary = id;
      });
      getEventBus().emit('SelectionChanged', { ids: next });
    },

    remove: (id) => {
      const next = get().ids.filter((x) => x !== id);
      set((s) => {
        s.ids = next;
        s.primary = s.primary === id ? (next[0] ?? null) : s.primary;
      });
      getEventBus().emit('SelectionChanged', { ids: next });
    },

    toggle: (id) => {
      if (get().ids.includes(id)) get().remove(id);
      else get().add(id);
    },

    clear: () => {
      set((s) => {
        s.ids = [];
        s.primary = null;
      });
      getEventBus().emit('SelectionChanged', { ids: [] });
    },

    isSelected: (id) => get().ids.includes(id),
    count: () => get().ids.length,
  })),
);
