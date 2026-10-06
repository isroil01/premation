/**
 * The Content-Aware Fill panel's settings (AE parity 3.7). Editor state: the
 * choices for the next fill and the reference plates the user added, kept per
 * layer for the session. Never part of the document — the fill's RESULT is
 * (setContentAwareFill, one undo entry).
 */

import { create } from 'zustand';
import type { ContentAwareFillMode, ContentAwareLighting, ContentAwareReference } from '@core/tracking/contentAwareFill';

export type FillRange = 'workArea' | 'entire' | 'layer';

interface ContentAwareFillState {
  mode: ContentAwareFillMode;
  lighting: ContentAwareLighting;
  expansion: number;
  range: FillRange;
  /** layer id → its reference plates. */
  references: Record<string, ContentAwareReference[]>;
  running: boolean;
  progress: number;
  status: string;
  /** Set while a job runs: cancels it. */
  cancel: (() => void) | null;

  setMode(mode: ContentAwareFillMode): void;
  setLighting(lighting: ContentAwareLighting): void;
  setExpansion(px: number): void;
  setRange(range: FillRange): void;
  addReference(layer: string, ref: ContentAwareReference): void;
  removeReference(layer: string, time: number): void;
  begin(cancel: () => void): void;
  setProgress(fraction: number, status: string): void;
  finish(status: string): void;
}

export const useContentAwareFillStore = create<ContentAwareFillState>((set) => ({
  mode: 'object',
  lighting: 'off',
  expansion: 0,
  range: 'workArea',
  references: {},
  running: false,
  progress: 0,
  status: '',
  cancel: null,

  setMode: (mode) => set({ mode }),
  setLighting: (lighting) => set({ lighting }),
  setExpansion: (px) => set({ expansion: Number.isFinite(px) ? Math.max(-100, Math.min(100, px)) : 0 }),
  setRange: (range) => set({ range }),
  addReference: (layer, ref) =>
    set((s) => {
      // One plate per frame: a new one for the same frame replaces it.
      const list = (s.references[layer] ?? []).filter((r) => Math.abs(r.time - ref.time) > 1e-6);
      list.push(ref);
      list.sort((a, b) => a.time - b.time);
      return { references: { ...s.references, [layer]: list } };
    }),
  removeReference: (layer, time) =>
    set((s) => ({
      references: { ...s.references, [layer]: (s.references[layer] ?? []).filter((r) => Math.abs(r.time - time) > 1e-6) },
    })),
  begin: (cancel) => set({ running: true, progress: 0, status: 'Starting…', cancel }),
  setProgress: (progress, status) => set({ progress, status }),
  finish: (status) => set({ running: false, progress: 0, status, cancel: null }),
}));
