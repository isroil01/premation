/**
 * Live timeline for a popped-out window.
 *
 * The pop-out used to mount `<Timeline>` with a hardcoded empty model, so the
 * detached window always showed an empty panel even after document sync filled
 * the scene. This is the same track derivation the editor shell uses.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { clampPps } from '@layout/Timeline/zoomAnchor';
import { BottomTimeline } from './BottomTimeline';
import { TransportBar } from '@layout/Workspace/TransportBar';
import { useTimelinePixelsPerSecond, useTimelineRuler, useTimelineTracks } from '@layout/Timeline/useTimelineModel';
import type { TimelineModel, TimelineTrack } from '@layout/Timeline';
import { documentMirror } from '@stores/documentMirror';
import { getTime as getPlayheadTime } from '@stores/playbackClockStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useActiveCompId } from '@hooks/useMirror';
import { uiKindOf } from '@core/mirror/layerKinds';
import { installLegacyTimelineSync } from '@core/engine/timelineUpkeep';
import { playheadSeconds, seekPlayhead, setTimelinePixelsPerSecond, setTimelineScrollPixels } from '@core/timeline/timelineView';
import { edit } from '@core/engine/uiEdits';
import { labelIndexOf } from '@core/engine/model';
import { moveBars, setWorkArea } from '@layout/Timeline/timelineEdits';
import { useFocusContext } from '@layout/focus/useFocusContext';

export function PopoutTimeline(): JSX.Element {
  const activeCompId = useActiveCompId();
  const { activeSet } = useFocusContext();
  const selectedIds = useSelectionStore((s) => s.ids);

  const [expandedIds, setExpandedIds] = useState<ReadonlyArray<string>>([]);

  // Keep this window's Timeline Engine bars seeded for layers written around
  // the engine API (document sync). WRITE-side upkeep of the TS engine, the
  // same installer App.tsx uses (core/engine/timelineUpkeep); nothing here
  // drives a render — the rows below follow the document mirror.
  useEffect(() => installLegacyTimelineSync(), []);

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

  // Switch toggles read the layer's CURRENT switches from the mirror at click time.
  const toggleFlag = useCallback((trackId: string, field: 'visible' | 'locked' | 'solo'): void => {
    const sw = documentMirror().layer(trackId)?.switches;
    if (!sw) return;
    const labels = {
      visible: sw.visible ? 'Hide layer' : 'Show layer',
      locked: sw.locked ? 'Unlock layer' : 'Lock layer',
      solo: sw.solo ? 'Unsolo layer' : 'Solo layer',
    };
    const next = !sw[field];
    void edit(labels[field], { type: 'setLayerSwitches', layers: [trackId], patch: { [field]: next } });
  }, []);

  // The speaker switch: only a layer that can make a sound has one; which way
  // it goes is the layer's `audioEnabled` switch (the write is the engine's).
  const toggleAudioMute = useCallback((trackId: string): void => {
    const layer = documentMirror().layer(trackId);
    const kind = uiKindOf(layer);
    if (!layer || (kind !== 'audio' && kind !== 'video')) return;
    const muted = !layer.switches.audioEnabled;
    void edit(muted ? 'Unmute layer audio' : 'Mute layer audio', {
      type: 'setLayerSwitches', layers: [trackId], patch: { audioEnabled: muted },
    });
  }, []);

  const setLabelColor = useCallback((trackId: string, color: string | undefined): void => {
    const label = labelIndexOf(color);
    // A colour outside the palette is a custom label (B3z `labelColor`).
    const patch = color && label === 0 ? { labelColor: color } : { label };
    void edit('Label Color', { type: 'setLayerSwitches', layers: [trackId], patch });
  }, []);

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
      onScrub={(t) => seekPlayhead(t)}
      onWorkAreaChange={(start, end) => { void setWorkArea(start, end); }}
      onScroll={(px) => setTimelineScrollPixels(px)}
      onZoom={(next, anchorSeconds) => {
        setTimelinePixelsPerSecond(clampPps(next), anchorSeconds ?? playheadSeconds());
      }}
      onTrackSelect={(trackId, additive) => {
        if (additive) useSelectionStore.getState().add(trackId);
        else useSelectionStore.getState().set([trackId]);
      }}
      onTrackSelectMany={(trackIds) => useSelectionStore.getState().set([...trackIds])}
      onClipMoveMany={(moves, label) => { void moveBars(moves, label); }}
      onTrackToggleVisible={(id) => toggleFlag(id, 'visible')}
      onTrackToggleLock={(id) => toggleFlag(id, 'locked')}
      onTrackToggleSolo={(id) => toggleFlag(id, 'solo')}
      onClipMuteToggle={toggleAudioMute}
      selectedTrackIds={selectedIds}
      expandedTrackIds={expandedIds}
      onTrackToggleExpand={(id) => {
        setExpandedIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
      }}
      onTrackColorChange={setLabelColor}
    />
      </div>
    </div>
  );
}
