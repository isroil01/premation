/**
 * TimelineController — the app-side owner of the framework-independent
 * `@motion/timeline` engine. It makes the engine the single authority for the
 * time domain (playhead, duration, frame rate, playback, markers, ranges) and
 * mirrors that into the app's `workspaceStore` (seconds), which the rest of the
 * UI already reads. It also mirrors Scene Graph nodes into timeline **layers**
 * so the engine holds real structure (for markers, queries, serialization).
 *
 * Division of labor: this engine owns *time*; keyframes remain in the Animation
 * Engine. Nothing here samples or stores keyframes.
 *
 *   transport / clock ──▶ TimelineController ──▶ @motion/timeline
 *                                    │  engine events (CurrentTimeChanged, …)
 *                                    ▼
 *                            workspaceStore (seconds) ──▶ existing UI
 */

import {
  
  type ClipGeometry,
  
} from '@core/commands/snapshotSharing';

export interface TimelineMarkerView {
  id: string;
  /** Seconds (for the seconds-based timeline UI). */
  time: number;
  label: string;
  color: string | null;
  /**
   * The marker's note. Carried here rather than through a second, richer
   * accessor because `marker.key(n).comment` in an expression and the marker
   * chip on the ruler must not read markers by two different paths — the
   * layer-relative → comp conversion in `getLayerMarkers` is exactly the kind
   * of step that goes wrong once it exists twice. One reader, widened.
   */
  comment: string;
  /** Span length in SECONDS (0 = point marker); the model stores frames. */
  duration: number;
}

/** A clip bar's geometry in FRAMES — `Clip.toJSON()`, named for readers.
 *  Declared beside the snapshot that carries it; re-exported here for the
 *  transition commands that already import it from this module. */
export type { ClipGeometry } from '@core/commands/snapshotSharing';

/** One bar of one node, addressed the way `captureClipBars` documents. */
export interface ClipBarSnapshot {
  nodeId: string;
  /** Position in `getLayersForNode` order (sorted by start). */
  index: number;
  clip: ClipGeometry;
}
