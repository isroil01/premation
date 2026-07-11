/**
 * Named time ranges the timeline tracks alongside the playhead: the loop region
 * for playback, the preview/RAM-preview region, and the work area (After
 * Effects' in/out bar). All are frame ranges; the Timeline stores them and emits
 * `RangeChanged` when they move.
 */

import type { TimeRange } from '../utils/TimeRange';

export type RangeKind = 'loop' | 'preview' | 'workArea';

export interface TimelineRanges {
  loop: TimeRange | null;
  preview: TimeRange | null;
  workArea: TimeRange | null;
}

export function emptyRanges(): TimelineRanges {
  return { loop: null, preview: null, workArea: null };
}
