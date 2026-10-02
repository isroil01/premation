/**
 * The timeline ruler's VIEW state per composition — zoom, horizontal scroll —
 * and the Loop preview toggle (block 3, docs/TS_ENGINE_REMOVAL.md: this used
 * to live on the page replica's TimelineController).
 *
 * Editor state, never the document (CLAUDE.md): undo does not touch it and a
 * save does not write it. `core/project/editorView.ts` remembers it per
 * project file on this machine.
 *
 * Zoom is stored in PIXELS PER FRAME (what a remembered view carries, and
 * what does not change meaning when the rate is read later); `undefined`
 * means the default 80 px per second at the composition's rate.
 */

import { create } from 'zustand';

export interface CompTimelineView {
  /** Pixels per frame; undefined = the default zoom (80 px/s). */
  readonly pixelsPerFrame?: number;
  /** Horizontal scroll, frames. */
  readonly scrollX: number;
  readonly scrollY: number;
  /** Loop playback (AE's loop toggle; the range follows the work area). Default on. */
  readonly looping: boolean;
}

export interface TimelineViewState {
  readonly views: Readonly<Record<string, CompTimelineView>>;
}

/** The ruler's default zoom, pixels per second. */
export const DEFAULT_TIMELINE_PPS = 80;
/** packages/timeline navigation.ts bounds, pixels per frame. */
export const MIN_PIXELS_PER_FRAME = 0.05;
export const MAX_PIXELS_PER_FRAME = 400;

const EMPTY: CompTimelineView = Object.freeze({ scrollX: 0, scrollY: 0, looping: true });

export const useTimelineViewStore = create<TimelineViewState>()(() => ({ views: {} }));

export function timelineViewOf(comp: string): CompTimelineView {
  return useTimelineViewStore.getState().views[comp] ?? EMPTY;
}

export function patchTimelineView(comp: string, patch: Partial<CompTimelineView>): void {
  if (!comp) return;
  const { views } = useTimelineViewStore.getState();
  const prev = views[comp] ?? EMPTY;
  const next = { ...prev, ...patch };
  if (next.pixelsPerFrame === prev.pixelsPerFrame && next.scrollX === prev.scrollX && next.scrollY === prev.scrollY && next.looping === prev.looping) return;
  useTimelineViewStore.setState({ views: { ...views, [comp]: next } });
}

export function clampPixelsPerFrame(ppf: number): number {
  return Math.min(MAX_PIXELS_PER_FRAME, Math.max(MIN_PIXELS_PER_FRAME, ppf));
}

/** Forget every composition's view (a new / opened document). */
export function resetTimelineViews(): void {
  useTimelineViewStore.setState({ views: {} });
}
