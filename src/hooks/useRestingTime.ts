/**
 * The playhead for a viewport overlay that only works on a RESTING frame (the
 * Object Matte and Roto Brush tools: a hover preview, a stroke, a found-object
 * search mean nothing on a frame that is already gone).
 *
 *   paused    exact: every seek, scrub and keyframe jump re-renders the
 *             overlay, as `useCurrentTime` would
 *   playing   frozen at the frame playback started on — the overlay is not
 *             subscribed to the per-frame clock at all (nor to the project
 *             store's 4 Hz playback mirror), so a played frame re-renders
 *             nothing of it (CLAUDE.md: no React render per played frame);
 *             the play / stop flag is what it listens to instead
 *   stop      re-syncs to the frame the transport parked on
 *
 * `playing` tells the overlay to stay out of the way (no hover, no search)
 * while the picture moves.
 */

import { useRef } from 'react';
import { usePlaybackClockStore } from '@stores/playbackClockStore';
import { useProjectStore } from '@stores/projectStore';

export function useRestingTime(): { time: number; playing: boolean } {
  const tab = useProjectStore((s) => s.activeTabId ?? '');
  const playing = useProjectStore((s) => (s.activeTabId ? s.tabs[s.activeTabId]?.playing === true : false));
  // While playing both selectors answer constants, so neither the clock's
  // writes nor the project store's playback mirror reach this component.
  const live = usePlaybackClockStore((s) => (playing ? undefined : s.clocks[tab]?.time));
  const fallback = useProjectStore((s) => (playing || live !== undefined ? 0 : s.tabs[tab]?.time ?? 0));
  const held = useRef(0);
  if (!playing) held.current = live ?? fallback;
  return { time: held.current, playing };
}
