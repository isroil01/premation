/**
 * History store (spec §Trust Infrastructure — Photoshop-style visual history).
 *
 * Holds an ordered list of fully non-destructive snapshots of the editable
 * state (scene graph + animation). Jumping to an entry restores that state;
 * it never mutates source data. Entries can be renamed ("Client v1 look").
 *
 * Recording is driven from Providers: an initial "Open" entry, then a debounced
 * capture after edits. The `restoring` guard stops a jump from recording itself.
 */

import { create } from 'zustand';
import { sceneProjectIO } from '@core/scene/sceneProjectIO';
import { defaultAnimation, type AnimSnapshot } from '@motion/animation';
import type { ProjectFile } from '@core/types';
import { bumpScene } from './sceneStore';

export interface HistoryEntry {
  id: string;
  label: string;
  /** True when the user explicitly named/snapshotted this state. */
  named: boolean;
  at: number;
  scene: ProjectFile;
  anim: AnimSnapshot;
}

interface HistoryStore {
  entries: ReadonlyArray<HistoryEntry>;
  /** Index of the state the document currently reflects. */
  index: number;
  /** True while a jump is restoring state (suppresses auto-record). */
  restoring: boolean;

  record: (label?: string, named?: boolean) => void;
  jumpTo: (index: number) => void;
  rename: (index: number, label: string) => void;
  reset: () => void;
}

const CAP = 100;
let seq = 0;
let idSeq = 0;

/** Deep-clone the current editable state into a snapshot. */
function captureState(): { scene: ProjectFile; anim: AnimSnapshot } {
  return {
    scene: structuredClone(sceneProjectIO.capture()),
    anim: defaultAnimation.snapshot(),
  };
}

export const useHistoryStore = create<HistoryStore>((set, get) => ({
  entries: [],
  index: -1,
  restoring: false,

  record: (label, named = false) => {
    if (get().restoring) return;
    const state = captureState();
    const entry: HistoryEntry = {
      id: `h_${(idSeq += 1)}`,
      label: label ?? `Edit ${(seq += 1)}`,
      named,
      at: Date.now(),
      ...state,
    };
    set((s) => {
      // A new edit after jumping back truncates the redoable future (Photoshop).
      const kept = s.entries.slice(0, s.index + 1);
      let entries = [...kept, entry];
      if (entries.length > CAP) entries = entries.slice(entries.length - CAP);
      return { entries, index: entries.length - 1 };
    });
  },

  jumpTo: (index) => {
    const entry = get().entries[index];
    if (!entry) return;
    set({ restoring: true });
    try {
      // Restore is non-destructive: swap state, never touch source assets.
      sceneProjectIO.restore(structuredClone(entry.scene));
      defaultAnimation.restore(entry.anim);
      bumpScene();
    } finally {
      set({ index, restoring: false });
    }
  },

  rename: (index, label) =>
    set((s) => ({
      entries: s.entries.map((e, i) => (i === index ? { ...e, label, named: true } : e)),
    })),

  reset: () => set({ entries: [], index: -1, restoring: false }),
}));
