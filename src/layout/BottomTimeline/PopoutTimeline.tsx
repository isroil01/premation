/**
 * Live timeline for a popped-out window.
 *
 * The pop-out used to mount `<Timeline>` with a hardcoded empty model, so the
 * detached window always showed an empty panel even after document sync filled
 * the scene. This is the same track derivation the editor shell uses.
 */

import { useMemo, useRef, useState } from 'react';
import { clampPps } from '@layout/Timeline/zoomAnchor';
import { BottomTimeline } from './BottomTimeline';
import { TransportBar } from '@layout/Workspace/TransportBar';
import { useTimelinePixelsPerSecond, useTimelineRuler, useTimelineTracks } from '@layout/Timeline/useTimelineModel';
import type { TimelineModel, TimelineTrack } from '@layout/Timeline';
import { getTime as getPlayheadTime } from '@stores/playbackClockStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useActiveCompId } from '@hooks/useMirror';
import { playheadSeconds, setTimelinePixelsPerSecond, setTimelineScrollPixels } from '@core/timeline/timelineView';
import { setWorkArea } from '@layout/Timeline/timelineEdits';
import { useFocusContext } from '@layout/focus/useFocusContext';
import { timelineHandlerProps, useTimelineHandlers } from '@layout/Timeline/useTimelineHandlers';

export function PopoutTimeline(): JSX.Element {
  const activeCompId = useActiveCompId();
  const { activeSet } = useFocusContext();
  const selectedIds = useSelectionStore((s) => s.ids);

  const [expandedIds, setExpandedIds] = useState<ReadonlyArray<string>>([]);

  // The same model the editor shell builds (Timeline/useTimelineModel).
  const tracks = useTimelineTracks(activeCompId, expandedIds);
  const ruler = useTimelineRuler(activeCompId);
  const pps = useTimelinePixelsPerSecond(activeCompId);

  const focusTracks = useMemo<TimelineTrack[]>(() => {
    if (!activeSet) return tracks;
    return tracks.map((t) => ({ ...t, ghosted: !activeSet.has(t.id) }));
  }, [tracks, activeSet]);

  const model = useMemo<TimelineModel>(() => {
    return {
      duration: ruler.duration,
      frameRate: ruler.frameRate,
      startFrame: ruler.startFrame,
      // A snapshot; the live playhead reaches <Timeline> as `playheadTime`.
      currentTime: getPlayheadTime(),
      pixelsPerSecond: pps,
      markers: ruler.markers,
      tracks: focusTracks,
      ...(ruler.workArea ? { workArea: ruler.workArea } : {}),
    };
  }, [focusTracks, pps, ruler]);

  // Every row, bar, keyframe and property handler — the docked timeline's own
  // (useTimelineHandlers), so the switches, Mode / TrkMat / Parent menus,
  // rename, trims and keyframe edits work here too.
  const tracksRef = useRef<ReadonlyArray<TimelineTrack>>(tracks);
  tracksRef.current = tracks;
  const handlers = useTimelineHandlers(tracksRef);

  return (
    /*
      The transport rides along in this window.

      In the docked editor it lives under the stage — the panel you are watching
      while it plays. This window has no stage, and a timeline you cannot start
      playing is a strange thing to pop out, so it gets its own copy. Both read
      the same controller, so the two stay in step.
    */
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <TransportBar />
      <div style={{ flex: 1, minHeight: 0 }}>
    <BottomTimeline
      model={model}
      {...timelineHandlerProps(handlers)}
      onWorkAreaChange={(start, end) => { void setWorkArea(start, end); }}
      onScroll={(px) => setTimelineScrollPixels(px)}
      onZoom={(next, anchorSeconds) => {
        setTimelinePixelsPerSecond(clampPps(next), anchorSeconds ?? playheadSeconds());
      }}
      selectedTrackIds={selectedIds}
      expandedTrackIds={expandedIds}
      onTrackToggleExpand={(id) => {
        setExpandedIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
      }}
    />
      </div>
    </div>
  );
}
