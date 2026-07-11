/**
 * TimelineState — a flat, serializable snapshot of the timeline's live state.
 * Panels/devtools read this; it is derived, never authoritative. Produced by
 * `Timeline.getState()`.
 */

import type { FrameRate } from '../time/FrameRate';
import type { SelectionSnapshot } from '../selection/TimelineSelection';
import type { TimelineRanges } from './ranges';
import type { TimelineViewState } from './navigation';

export interface TimelineState {
  id: string;
  name: string;
  frameRate: FrameRate;
  duration: number;
  currentFrame: number;
  currentSeconds: number;
  playing: boolean;
  trackCount: number;
  layerCount: number;
  markerCount: number;
  selection: SelectionSnapshot;
  ranges: TimelineRanges;
  view: TimelineViewState;
  canUndo: boolean;
  canRedo: boolean;
}
