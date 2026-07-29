/**
 * Re-render this component whenever a timeline CLIP BAR changes.
 *
 * Clip geometry (a bar's start, trim and splits) lives in the Timeline Engine,
 * not in a store, and its edits go through the engine's own history — they
 * never bump the scene revision. So any panel that reads clip geometry has to
 * subscribe to the engine's layer events or it keeps showing the numbers it
 * rendered with. `App` hand-rolled exactly this for the timeline tracks; this
 * is that pattern, once, so the audio bridge and inspector share it.
 */

import { useEffect, useReducer } from 'react';
import { getTimelineController } from '@core/timeline/TimelineController';

export function useClipRevision(): number {
  const [rev, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const c = getTimelineController();
    const subs = [
      c.timeline.events.on('LayerAdded', bump),
      c.timeline.events.on('LayerRemoved', bump),
      c.timeline.events.on('LayerUpdated', bump),
      c.timeline.events.on('LayerTrimmed', bump),
      c.timeline.events.on('LayerSplit', bump),
    ];
    return () => {
      for (const s of subs) s.dispose();
    };
  }, []);
  return rev;
}
