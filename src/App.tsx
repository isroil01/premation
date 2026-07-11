/**
 * App — the application root.
 *
 * Lifecycle:
 *   1. Providers boot the Application core and wire the built-in commands.
 *   2. We register the demo panels in the layout store.
 *   3. We render the editor: toolbar, layout, status bar.
 *
 * Engine integration points:
 *   - Register additional panels: `useLayoutStore.getState().registerPanel(...)`
 *   - Mount a rendering engine: call `useLayoutStore.setState` or use the
 *     layout-registered WorkspaceViewport selector `[data-workspace-viewport]`.
 *   - Push timeline data: pass a `model` prop to <BottomTimeline />.
 */

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Providers } from '@providers/Providers';
import { useLayoutStore } from '@stores/layoutStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useSceneRevision, bumpScene } from '@stores/sceneStore';
import { useActiveWorkspace } from '@stores/workspaceStore';
import { usePlaybackClock } from '@layout/Timeline/usePlaybackClock';
import { useTimelineKeys } from '@layout/Timeline/useTimelineKeys';
import { getTimelineController } from '@core/timeline/TimelineController';
import { Icon } from '@components/Icon';
import { EditorLayout } from '@layout/EditorLayout';
import { StatusBar } from '@layout/StatusBar';
import { BottomTimeline } from '@layout/BottomTimeline';
import { TopNav } from '@layout/TopNav';
import { getSidebarRenderers, getInspectorRenderers } from '@layout/EditorLayout/DemoPanels';
import type { TimelineModel, TimelineTrack, TimelinePropertyTrack, TimelineCacheRange, TimelineClip } from '@layout/Timeline';
import type { TrackId } from '@app-types/common';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation, makeKeyframeId, parseKeyframeId } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import { flattenScene, readNodeKind, KIND_COLOR, KIND_ICON, KIND_FILL } from '@core/scene/sceneDerive';
import renderCache from '@core/rendering/renderCache';
import { openPalette } from '@stores/commandPaletteStore';
import { FpsMeter } from '@layout/StatusBar/FpsMeter';
import { useFocusStore } from '@stores/focusStore';
import { useFocusContext } from '@layout/focus/useFocusContext';
import { openContextMenu } from '@stores/contextMenuStore';
import type { TimelineKeyframeRef } from '@layout/Timeline';
import type { KeyId, NodeId } from '@app-types/common';

const TIMELINE_DURATION = 10;
const TIMELINE_FPS = 60;

/** Format seconds as mm:ss:ff at the timeline frame rate. */
function formatClock(sec: number): string {
  const frames = Math.floor(sec * TIMELINE_FPS);
  const m = Math.floor(frames / (TIMELINE_FPS * 60));
  const s = Math.floor((frames / TIMELINE_FPS) % 60);
  const f = frames % TIMELINE_FPS;
  const p = (n: number): string => n.toString().padStart(2, '0');
  return `${p(m)}:${p(s)}:${p(f)}`;
}

function EditorShell(): JSX.Element {
  const registerPanel = useLayoutStore((s) => s.registerPanel);
  const selectionCount = useSelectionStore((s) => s.ids.length);
  const selectedIds = useSelectionStore((s) => s.ids);
  const setSelected = useSelectionStore((s) => s.set);
  const addSelected = useSelectionStore((s) => s.add);
  const sceneRev = useSceneRevision((s) => s.rev);
  const active = useActiveWorkspace();
  const focusEnter = useFocusStore((s) => s.enter);
  const focusIsolate = useFocusStore((s) => s.isolate);
  const { activeSet } = useFocusContext();

  // Register the default panels exactly once.
  useEffect(() => {
    registerPanel({ id: 'scene',      title: 'Scene',      icon: 'layers',  region: 'leftSidebar',    weight: 2, closable: true });
    registerPanel({ id: 'assets',     title: 'Assets',     icon: 'folder',  region: 'leftSidebar',    weight: 1, closable: true });
    registerPanel({ id: 'properties', title: 'Properties', icon: 'settings', region: 'rightInspector',  weight: 3, closable: true });
    registerPanel({ id: 'motion',     title: 'Motion',     icon: 'keyframe', region: 'rightInspector',  weight: 3, closable: true });
    registerPanel({ id: 'effects',    title: 'Effects',    icon: 'sparkles', region: 'rightInspector',  weight: 2, closable: true });
    registerPanel({ id: 'comments',   title: 'Comments',   icon: 'marker',   region: 'rightInspector',  weight: 1, closable: true });
    registerPanel({ id: 'history',    title: 'History',    icon: 'undo',     region: 'rightInspector',  weight: 0, closable: true });
  }, [registerPanel]);

  // Bumped when the engine's layers/clips change (add/remove/move/trim/split),
  // so the derived clip bars stay in sync.
  const [clipRev, setClipRev] = useState(0);

  // Timeline tracks derived from the scene graph — one track per node, in
  // layer order. Clip bars come from the Timeline Engine's layers for that node.
  const tracks = useMemo<TimelineTrack[]>(() => {
    void sceneRev;
    void clipRev;
    const controller = getTimelineController();
    return flattenScene(defaultSceneGraph).map((node) => {
      const kind = readNodeKind(node);
      // Per-property sub-tracks (revealed when the layer is expanded).
      const properties: TimelinePropertyTrack[] = defaultAnimation
        .tracksFor(node.id)
        .map((track) => ({
          prop: track.prop,
          label: track.prop,
          keyframes: track.keyframes.map((kf) => ({
            id: makeKeyframeId(node.id, track.prop, kf.t) as KeyId,
            nodeId: node.id as NodeId,
            time: kf.t,
          })),
        }));
      // Flat union of all keyframes (collapsed summary row).
      const keyframes: TimelineKeyframeRef[] = properties.flatMap((p) => p.keyframes);
      // Clip bars for this node = its Timeline Engine layers (seconds).
      const clips: TimelineClip[] = controller.getLayersForNode(node.id).map((l) => ({
        id: l.id,
        trackId: node.id as TrackId,
        nodeId: node.id as NodeId,
        start: l.start / TIMELINE_FPS,
        duration: l.duration / TIMELINE_FPS,
        label: node.name ?? node.id,
        color: KIND_FILL[kind],
      }));
      return {
        id: node.id as TrackId,
        name: node.name ?? node.id,
        kind,
        icon: KIND_ICON[kind],
        color: KIND_COLOR[kind],
        muted: node.visible === false,
        locked: node.locked === true,
        solo: node.solo === true,
        keyframes,
        properties,
        clips,
      };
    });
  }, [sceneRev, clipRev]);

  // Mirror the scene graph into the Timeline Engine's layers whenever the scene
  // changes (structural, non-undoable). The engine then owns the time domain.
  useEffect(() => {
    void sceneRev;
    getTimelineController().syncFromScene();
  }, [sceneRev]);

  // Re-read engine markers + work area when they change (add/remove, in/out).
  const [markerRev, setMarkerRev] = useState(0);
  // Bumped on timeline zoom changes (engine owns pixels-per-frame).
  const [viewRev, setViewRev] = useState(0);
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
  }, []);

  // Track visibility / lock toggles → scene node state.
  const toggleTrackVisible = (trackId: string): void => {
    const node = defaultSceneGraph.getNode(trackId);
    if (!node) return;
    node.visible = node.visible === false;
    bumpScene();
  };
  const toggleTrackLock = (trackId: string): void => {
    const node = defaultSceneGraph.getNode(trackId);
    if (!node) return;
    node.locked = !node.locked;
    bumpScene();
  };
  const toggleTrackSolo = (trackId: string): void => {
    const node = defaultSceneGraph.getNode(trackId);
    if (!node) return;
    node.solo = !node.solo;
    bumpScene();
  };

  // ── Timeline expansion (reveal animated properties) ──────────────
  // Calm by default: a layer is one row until its chevron — or the `U`
  // reveal shortcut on the selected layers — expands it (AE muscle memory).
  const [expandedIds, setExpandedIds] = useState<ReadonlyArray<string>>([]);
  // AE reveal filter: which properties the sub-rows show (null = all).
  const [revealFilter, setRevealFilter] = useState<ReadonlyArray<string> | null>(null);

  // Horizontal zoom — the Timeline Engine's view is the authority (pixels/frame);
  // pps = ppf × fps. Driven by the transport zoom buttons and Ctrl+Wheel.
  const pps = useMemo(() => {
    void viewRev;
    return getTimelineController().getPixelsPerSecond();
  }, [viewRev]);
  const handleZoom = useCallback((next: number): void => {
    const c = getTimelineController();
    c.setPixelsPerSecond(Math.min(800, Math.max(4, next)), c.currentSeconds);
  }, []);

  const toggleExpand = useCallback((id: string): void => {
    setExpandedIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }, []);

  useEffect(() => {
    // AE reveal shortcuts: U = all animated, P = position, S = scale,
    // R = rotation, T = opacity (transparency). Filters the revealed sub-rows.
    const REVEAL: Record<string, ReadonlyArray<string> | null> = {
      u: null,
      p: ['x', 'y'],
      s: ['scale', 'scaleX', 'scaleY'],
      r: ['rotation'],
      t: ['opacity'],
    };
    const onKey = (e: KeyboardEvent): void => {
      const filter = REVEAL[e.key.toLowerCase()];
      if (filter === undefined) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      const sel = useSelectionStore.getState().ids;
      if (sel.length === 0) return;
      e.preventDefault();
      // Reveal keys expand the selection and switch which props are shown.
      // (Collapse via the disclosure chevron or Esc.)
      setRevealFilter(filter);
      setExpandedIds((cur) => {
        const set = new Set(cur);
        for (const id of sel) set.add(id);
        return [...set];
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Mark tracks that fall outside the current Focus Mode context as ghosted.
  const focusTracks = useMemo<TimelineTrack[]>(() => {
    if (!activeSet) return tracks;
    return tracks.map((t) => ({ ...t, ghosted: !activeSet.has(t.id) }));
  }, [tracks, activeSet]);

  // Cache bar ranges — REAL rendered-frame cache. Grows as the user plays or
  // scrubs (each rendered frame is marked) and clears on any animation edit.
  // Recomputed on playhead move (marks follow renders) and on scene changes.
  const cachedRanges = useMemo<TimelineCacheRange[]>(
    () => renderCache.ranges(),
    [active?.time, sceneRev],
  );

  // User markers from the Timeline Engine (in seconds), plus Start/End bookends.
  const markers = useMemo(() => {
    void markerRev;
    return [
      { id: 'm_start', time: 0, label: 'Start' },
      { id: 'm_end', time: TIMELINE_DURATION, label: 'End' },
      ...getTimelineController().getMarkers().map((m) => ({ id: m.id, time: m.time, label: m.label })),
    ];
  }, [markerRev]);

  // Work area (in/out) from the engine, in seconds — re-read on RangeChanged.
  const workArea = useMemo(() => {
    void markerRev;
    return getTimelineController().getWorkArea() ?? undefined;
  }, [markerRev]);

  // Model object carries the live playhead (currentTime) without rebuilding tracks.
  const timelineModel = useMemo<TimelineModel>(() => ({
    duration: TIMELINE_DURATION,
    frameRate: TIMELINE_FPS,
    currentTime: active?.time ?? 0,
    pixelsPerSecond: pps,
    markers,
    tracks: focusTracks,
    cachedRanges,
    ...(workArea ? { workArea } : {}),
  }), [focusTracks, active?.time, cachedRanges, pps, markers, workArea]);

  // Real-time playback clock: pumps the Timeline Engine while `playing` is set.
  usePlaybackClock();
  // Frame-accurate transport shortcuts (Home/End, Page Up/Down, Shift = markers).
  useTimelineKeys();

  // Wire scrub → Timeline Engine (authority); it mirrors seconds into the store.
  const handleScrub = (t: number): void => {
    getTimelineController().seekSeconds(t);
  };

  // Clicking a timeline track selects its node (Shift/Cmd = additive).
  const handleTrackSelect = (trackId: string, additive: boolean): void => {
    if (additive) addSelected(trackId);
    else setSelected([trackId]);
  };

  // Double-clicking a track enters Focus Mode: a group/precomp is entered in
  // place (parent ghosts around it); a leaf layer is isolated.
  const handleTrackActivate = (trackId: string): void => {
    const node = defaultSceneGraph.getNode(trackId);
    if (!node) return;
    if (readNodeKind(node) === 'group') {
      focusEnter(trackId);
    } else {
      focusIsolate(trackId);
      setSelected([trackId]);
    }
  };

  // ── Keyframe editing (timeline reports intents; the engine does the work) ──
  const handleKeyframeSeek = (kfId: string): void => {
    const ref = parseKeyframeId(kfId);
    if (!ref) return;
    handleScrub(ref.t);
    setSelected([ref.nodeId]);
  };
  const handleKeyframeMove = (kfId: string, time: number): void => {
    const ref = parseKeyframeId(kfId);
    // The timeline commits once on release, so one move = one undoable command.
    if (ref) {
      runAnimEdit('Move keyframe', () =>
        defaultAnimation.moveKeyframe(ref.nodeId, ref.prop, ref.t, time),
      );
    }
  };
  const handleKeyframeContextMenu = (kfId: string, x: number, y: number): void => {
    const ref = parseKeyframeId(kfId);
    if (!ref) return;
    openContextMenu(x, y, [
      {
        id: 'delete',
        label: 'Delete keyframe',
        danger: true,
        onSelect: () =>
          runAnimEdit('Delete keyframe', () =>
            defaultAnimation.removeKeyframe(ref.nodeId, ref.prop, ref.t),
          ),
      },
    ]);
  };

  // ── Clip editing (Timeline Engine layers) ─────────────────────────
  const handleClipMove = (clipId: string, start: number): void => {
    getTimelineController().setClipStart(clipId, start);
  };
  const handleClipTrim = (clipId: string, edge: 'start' | 'end', time: number): void => {
    getTimelineController().trimClipTo(clipId, edge, time);
  };
  const handleClipContextMenu = (clipId: string, x: number, y: number): void => {
    const c = getTimelineController();
    openContextMenu(x, y, [
      { id: 'split', label: 'Split at playhead', onSelect: () => c.splitClip(clipId, c.currentSeconds) },
      { id: 'delete', label: 'Delete clip', danger: true, onSelect: () => c.deleteLayer(clipId) },
    ]);
  };

  return (
    <EditorLayout
      topNav={<TopNav />}
      statusBar={
        <StatusBar
          left={
            <>
              <span style={{ color: 'var(--color-success)' }}>●</span>
              <span>Ready</span>
              <span style={{ opacity: 0.4 }}>·</span>
              <span>{defaultSceneGraph.size} layers</span>
              {selectionCount > 0 ? (
                <>
                  <span style={{ opacity: 0.4 }}>·</span>
                  <span>{selectionCount} selected</span>
                </>
              ) : null}
            </>
          }
          center={
            <span style={{ fontFamily: 'var(--font-family-mono)', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              {active?.title ?? 'Untitled'}
              {active?.dirty ? (
                // Unsaved changes — small amber dot (VS Code convention).
                <span
                  aria-label="Unsaved changes"
                  title="Unsaved changes"
                  style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--color-modified)' }}
                />
              ) : null}
            </span>
          }
          right={
            <>
              <FpsMeter />
              <span style={{ opacity: 0.4 }}>·</span>
              <span style={{ fontFamily: 'var(--font-family-mono)', fontVariantNumeric: 'tabular-nums' }}>
                {formatClock(active?.time ?? 0)}
              </span>
              <span style={{ opacity: 0.4 }}>·</span>
              <button
                type="button"
                onClick={() => openPalette()}
                title="Search commands, layers, timecode…"
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '2px 8px', borderRadius: 'var(--radius-full)',
                  background: 'var(--color-surface-2)', border: '1px solid var(--color-border)',
                  color: 'var(--color-text-secondary)', cursor: 'pointer', font: 'inherit',
                }}
              >
                <Icon name="search" size={11} />
                Search
                <kbd style={{
                  fontFamily: 'var(--font-family-mono)', fontSize: 10,
                  padding: '0 4px', borderRadius: 3, background: 'var(--color-surface-3)',
                  color: 'var(--color-text-tertiary)',
                }}>⌘K</kbd>
              </button>
            </>
          }
        />
      }
      timeline={
        <BottomTimeline
          model={timelineModel}
          onScrub={handleScrub}
          onWorkAreaChange={(start, end) => getTimelineController().setWorkArea(start, end)}
          onClipMove={handleClipMove}
          onClipTrim={handleClipTrim}
          onClipContextMenu={handleClipContextMenu}
          onScroll={(px) => getTimelineController().setScrollPixels(px)}
          onZoom={handleZoom}
          onTrackSelect={handleTrackSelect}
          onTrackToggleVisible={toggleTrackVisible}
          onTrackToggleLock={toggleTrackLock}
          onTrackToggleSolo={toggleTrackSolo}
          onKeyframeSeek={handleKeyframeSeek}
          onKeyframeMove={handleKeyframeMove}
          onKeyframeContextMenu={handleKeyframeContextMenu}
          selectedTrackIds={selectedIds}
          expandedTrackIds={expandedIds}
          revealProps={revealFilter}
          onTrackToggleExpand={toggleExpand}
          onTrackActivate={handleTrackActivate}
        />
      }
      sidebarRenderers={getSidebarRenderers()}
      inspectorRenderers={getInspectorRenderers()}
    />
  );
}

export function App(): JSX.Element {
  return (
    <Providers>
      <EditorShell />
    </Providers>
  );
}
