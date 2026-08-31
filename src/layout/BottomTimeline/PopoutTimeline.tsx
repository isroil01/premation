/**
 * Live timeline for a popped-out window.
 *
 * The pop-out used to mount `<Timeline>` with a hardcoded empty model, so the
 * detached window always showed an empty panel even after document sync filled
 * the scene. This is the same track derivation the editor shell uses.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { BottomTimeline } from './BottomTimeline';
import { deriveTimelineTracks } from '@layout/Timeline/deriveTimelineTracks';
import type { TimelineModel, TimelineTrack } from '@layout/Timeline';
import { useCompositionStore } from '@stores/compositionStore';
import { useProjectStore } from '@stores/projectStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useSceneRevision, bumpScene } from '@stores/sceneStore';
import { getEventBus } from '@core/events/EventBus';
import { isMediaDecodeRepaint } from '@core/rendering/mediaRepaint';
import { getTimelineController } from '@core/timeline/TimelineController';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { runDocumentEdit } from '@core/commands/documentEdit';
import { useFocusContext } from '@layout/focus/useFocusContext';
import { setNodeLabelColor } from '@core/scene/labelColor';

export function PopoutTimeline(): JSX.Element {
  const sceneRev = useSceneRevision((s) => s.rev);
  const activeCompId = useProjectStore((s) => (s.activeTabId ? s.tabs[s.activeTabId]?.compositionId : undefined));
  const compFps = useCompositionStore((s) => s.fps);
  const compDuration = useCompositionStore((s) => s.durationSeconds);
  const compStartFrame = useCompositionStore((s) => s.startFrame);
  const { activeSet } = useFocusContext();
  const selectedIds = useSelectionStore((s) => s.ids);

  const [expandedIds, setExpandedIds] = useState<ReadonlyArray<string>>([]);
  const [graphRev, setGraphRev] = useState(0);
  const [animRev, setAnimRev] = useState(0);
  const [clipRev, setClipRev] = useState(0);
  const [markerRev, setMarkerRev] = useState(0);
  const [viewRev, setViewRev] = useState(0);

  useEffect(() => {
    const bus = getEventBus();
    const graphSub = bus.on('SceneGraphChanged', () => {
      getTimelineController().syncFromScene();
      setGraphRev((v) => v + 1);
    });
    const animSub = bus.on('AnimationChanged', (payload) => {
      if (!isMediaDecodeRepaint(payload)) setAnimRev((v) => v + 1);
    });
    return () => {
      graphSub.dispose();
      animSub.dispose();
    };
  }, []);

  useEffect(() => {
    const c = getTimelineController();
    const bumpMarker = (): void => setMarkerRev((v) => v + 1);
    const bumpClip = (): void => setClipRev((v) => v + 1);
    const subs = [
      c.timeline.events.on('MarkerAdded', bumpMarker),
      c.timeline.events.on('MarkerRemoved', bumpMarker),
      c.timeline.events.on('RangeChanged', bumpMarker),
      c.timeline.events.on('LayerAdded', bumpClip),
      c.timeline.events.on('LayerRemoved', bumpClip),
      c.timeline.events.on('LayerUpdated', bumpClip),
      c.timeline.events.on('LayerTrimmed', bumpClip),
      c.timeline.events.on('LayerSplit', bumpClip),
      c.timeline.events.on('TimelineZoomChanged', () => setViewRev((v) => v + 1)),
    ];
    return () => {
      for (const s of subs) s.dispose();
    };
  }, [activeCompId]);

  const valueRev = expandedIds.length > 0 ? sceneRev : 0;
  const tracks = useMemo<TimelineTrack[]>(() => {
    void graphRev;
    void animRev;
    void clipRev;
    void markerRev;
    void valueRev;
    void sceneRev;
    return deriveTimelineTracks({ activeCompId, compFps, expandedIds });
  }, [graphRev, animRev, clipRev, markerRev, valueRev, sceneRev, compFps, expandedIds, activeCompId]);

  const focusTracks = useMemo<TimelineTrack[]>(() => {
    if (!activeSet) return tracks;
    return tracks.map((t) => ({ ...t, ghosted: !activeSet.has(t.id) }));
  }, [tracks, activeSet]);

  const pps = useMemo(() => {
    void viewRev;
    return getTimelineController().getPixelsPerSecond();
  }, [viewRev]);

  const markers = useMemo(() => {
    void markerRev;
    return getTimelineController().getMarkers().map((m) => ({ id: m.id, time: m.time, label: m.label }));
  }, [markerRev]);

  const workArea = useMemo(() => {
    void markerRev;
    return getTimelineController().getWorkArea() ?? undefined;
  }, [markerRev]);

  const model = useMemo<TimelineModel>(() => {
    const s = useProjectStore.getState();
    return {
      duration: compDuration,
      frameRate: compFps,
      startFrame: compStartFrame,
      currentTime: s.activeTabId ? (s.tabs[s.activeTabId]?.time ?? 0) : 0,
      pixelsPerSecond: pps,
      markers,
      tracks: focusTracks,
      ...(workArea ? { workArea } : {}),
    };
  }, [focusTracks, pps, markers, workArea, compDuration, compFps, compStartFrame]);

  const toggleFlag = useCallback((trackId: string, field: 'visible' | 'locked' | 'solo'): void => {
    const node = defaultSceneGraph.getNode(trackId);
    if (!node) return;
    const labels = {
      visible: node.visible === false ? 'Show layer' : 'Hide layer',
      locked: node.locked ? 'Unlock layer' : 'Lock layer',
      solo: node.solo ? 'Unsolo layer' : 'Solo layer',
    };
    runDocumentEdit(labels[field], () => {
      if (field === 'visible') node.visible = node.visible === false;
      else if (field === 'locked') node.locked = !node.locked;
      else node.solo = !node.solo;
      bumpScene();
    });
  }, []);

  return (
    <BottomTimeline
      model={model}
      onScrub={(t) => getTimelineController().seekSeconds(t)}
      onWorkAreaChange={(start, end) => getTimelineController().setWorkArea(start, end)}
      onScroll={(px) => getTimelineController().setScrollPixels(px)}
      onZoom={(next) => {
        const c = getTimelineController();
        c.setPixelsPerSecond(Math.min(800, Math.max(4, next)), c.currentSeconds);
      }}
      onTrackSelect={(trackId, additive) => {
        if (additive) useSelectionStore.getState().add(trackId);
        else useSelectionStore.getState().set([trackId]);
      }}
      onTrackToggleVisible={(id) => toggleFlag(id, 'visible')}
      onTrackToggleLock={(id) => toggleFlag(id, 'locked')}
      onTrackToggleSolo={(id) => toggleFlag(id, 'solo')}
      selectedTrackIds={selectedIds}
      expandedTrackIds={expandedIds}
      onTrackToggleExpand={(id) => {
        setExpandedIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
      }}
      onTrackColorChange={(trackId, color) => setNodeLabelColor(trackId, color)}
    />
  );
}
