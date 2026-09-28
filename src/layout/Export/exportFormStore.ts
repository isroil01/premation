/**
 * The export form's state, shared by its two hosts.
 *
 * The same form renders in the Export dialog (top-bar button) and in the
 * docked Export panel (Window ▸ Export). They are one form, not two: pick MP4
 * at half resolution in the panel, open the dialog, and it says MP4 at half
 * resolution. That is why the choices live here rather than in component
 * state — and why a RUNNING export lives here too, so that closing the dialog
 * mid-render does not abort a render the panel is still showing.
 *
 * Session state, not a preference: it is reset by a reload, and it is not in
 * `src/stores` because nothing outside the Export directory reads it.
 */

import { create } from 'zustand';
import type { ExportFormat } from '@core/export/exportManager';
import type { ExportQuality, ProresProfile } from '@core/export/renderSpec';

export type RangeMode = 'full' | 'work';

export interface ExportFormChoices {
  format: ExportFormat;
  activeCategory: string;
  /** Index into the resolution presets (Full / Half / Quarter). */
  scaleIdx: number;
  quality: ExportQuality;
  proresProfile: ProresProfile;
  /** F1: bits per channel of a mov through the engine export path (8 elsewhere). */
  bitDepth: 8 | 16;
  transparent: boolean;
  chapters: boolean;
  rangeMode: RangeMode;
}

interface ExportFormState extends ExportFormChoices {
  /** Set once, the first time a host mounts, from the comp and the presets. */
  seeded: boolean;
  /** 0–1 while an export runs, null otherwise. Both hosts read it. */
  progress: number | null;
  abort: AbortController | null;
  patch: (values: Partial<ExportFormChoices>) => void;
  seed: (values: ExportFormChoices) => void;
  begin: (abort: AbortController) => void;
  setProgress: (p: number) => void;
  end: () => void;
}

export const useExportFormStore = create<ExportFormState>((set, get) => ({
  format: 'webm',
  activeCategory: 'video',
  scaleIdx: 0,
  quality: 'high',
  proresProfile: '4444',
  bitDepth: 8,
  transparent: false,
  chapters: false,
  rangeMode: 'full',
  seeded: false,
  progress: null,
  abort: null,

  patch: (values) => set(values),
  seed: (values) => {
    if (get().seeded) return;
    set({ ...values, seeded: true });
  },
  begin: (abort) => set({ abort, progress: 0 }),
  setProgress: (progress) => set({ progress }),
  end: () => set({ abort: null, progress: null }),
}));
