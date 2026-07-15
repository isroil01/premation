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

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Providers } from '@providers/Providers';
import { useLayoutStore } from '@stores/layoutStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import { useKeyframeSelectionStore } from '@stores/keyframeSelectionStore';
import { applyEasingToKeyframes, type EasingPreset } from '@core/animation/keyframeAssistants';
import { useSceneRevision, bumpScene } from '@stores/sceneStore';
import { useActiveWorkspace, useProjectStore } from '@stores/projectStore';
import { usePlaybackClock } from '@layout/Timeline/usePlaybackClock';
import { useTimelineKeys } from '@layout/Timeline/useTimelineKeys';
import { getTimelineController } from '@core/timeline/TimelineController';
import { Icon } from '@components/Icon';
import { EditorLayout } from '@layout/EditorLayout';

import { StatusBar } from '@layout/StatusBar';
import { getEventBus } from '@core/events/EventBus';
import { BottomTimeline } from '@layout/BottomTimeline';
import { TopNav } from '@layout/TopNav';
import { getAllPanelRenderers } from '@layout/EditorLayout/DemoPanels';
import type { TimelineModel, TimelineTrack, TimelinePropertyTrack, TimelineCacheRange, TimelineClip } from '@layout/Timeline';
import type { TrackId } from '@app-types/common';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation, makeKeyframeId, parseKeyframeId } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import { useCompositionStore } from '@stores/compositionStore';
import { readNodeKind, KIND_COLOR, KIND_ICON, KIND_FILL } from '@core/scene/sceneDerive';
import { getNodeBlend, setNodeBlend } from '@core/effects/blendMode';
import { reparentNode, reorderNode } from '@core/scene/parenting';
import { is3DEnabled, set3DEnabled } from '@core/scene/threeD';
import renderCache from '@core/rendering/renderCache';
import { openPalette } from '@stores/commandPaletteStore';
import { AccountButton } from '@layout/Auth/AccountButton';
import { FpsMeter } from '@layout/StatusBar/FpsMeter';
import { useFocusStore } from '@stores/focusStore';
import { useFocusContext } from '@layout/focus/useFocusContext';
import { openContextMenu } from '@stores/contextMenuStore';
import { useResponsiveLayout } from '@hooks/useResponsiveLayout';
import type { TimelineKeyframeRef } from '@layout/Timeline';
import type { KeyId, NodeId } from '@app-types/common';

/** Format seconds as mm:ss:ff at the timeline frame rate (AE-style timecode —
 *  the last field is FRAMES at the comp fps, not milliseconds). Frames pad to
 *  the fps digit width so e.g. 120 fps shows a stable 3-digit field. */
function formatClock(sec: number, fps: number = 60): string {
  const frames = Math.floor(sec * fps);
  const m = Math.floor(frames / (fps * 60));
  const s = Math.floor((frames / fps) % 60);
  const f = frames % fps;
  const fw = Math.max(2, String(Math.max(1, Math.ceil(fps)) - 1).length);
  const p = (n: number): string => n.toString().padStart(2, '0');
  return `${p(m)}:${p(s)}:${f.toString().padStart(fw, '0')}`;
}

function getNodeColor(node: any): string | undefined {
  return node.color ?? KIND_COLOR[readNodeKind(node)];
}

function setNodeColor(nodeId: string, color: string): void {
  const node = defaultSceneGraph.getNode(nodeId as any);
  if (!node) return;
  (node as any).color = color;
  bumpScene();
}

export function EditorShell(): JSX.Element {
  const registerPanel = useLayoutStore((s) => s.registerPanel);
  const selectionCount = useSelectionStore((s) => s.ids.length);
  const selectedIds = useSelectionStore((s) => s.ids);
  const setSelected = useSelectionStore((s) => s.set);
  const addSelected = useSelectionStore((s) => s.add);
  const sceneRev = useSceneRevision((s) => s.rev);
  const active = useActiveWorkspace();
  
  const compFps = useCompositionStore((s) => s.fps);
  const compDuration = useCompositionStore((s) => s.durationSeconds);

  const focusIsolate = useFocusStore((s) => s.isolate);
  const { activeSet } = useFocusContext();
  
  // Enable responsive UI auto-collapsing behaviors
  useResponsiveLayout();

  // Register the default panels exactly once.
  useEffect(() => {
    registerPanel({ id: 'scene',       title: 'Scene',        icon: 'layers',    region: 'leftSidebar',   weight: 2, closable: true });
    registerPanel({ id: 'assets',      title: 'Assets',       icon: 'folder',    region: 'leftSidebar',   weight: 1, closable: true });
    registerPanel({ id: 'libraries',   title: 'Libraries',    icon: 'shape',     region: 'leftSidebar',   weight: 1, closable: false });
    registerPanel({ id: 'properties',  title: 'Properties',   icon: 'settings',  region: 'rightInspector', weight: 3, closable: true });
    registerPanel({ id: 'motion',      title: 'Motion',       icon: 'keyframe',  region: 'rightInspector', weight: 3, closable: true });
    registerPanel({ id: 'effects',     title: 'Effects',      icon: 'sparkles',  region: 'rightInspector', weight: 2, closable: true });
    registerPanel({ id: 'motionTools', title: 'Motion Tools', icon: 'move', region: 'rightInspector', weight: 1, closable: true });
    registerPanel({ id: 'comments',    title: 'Comments',     icon: 'marker',    region: 'rightInspector', weight: 1, closable: true });
    registerPanel({ id: 'history',     title: 'History',      icon: 'undo',      region: 'rightInspector', weight: 0, closable: true });
    registerPanel({ id: 'renderQueue', title: 'Render Queue', icon: 'video',    region: 'rightInspector', weight: 0, closable: true });
  }, [registerPanel]);

  // Bumped when the engine's layers/clips change (add/remove/move/trim/split),
  // so the derived clip bars stay in sync.
  const [clipRev, setClipRev] = useState(0);

  const [expandedIds, setExpandedIds] = useState<ReadonlyArray<string>>([]);

  // Timeline tracks derived from the scene graph — one track per node, in
  // layer order. Clip bars come from the Timeline Engine's layers for that node.
  const tracks = useMemo<TimelineTrack[]>(() => {
    void sceneRev;
    void clipRev;
    const controller = getTimelineController();
    const compId = active?.compositionId || 'comp_root';

    const result: TimelineTrack[] = [];

    const traverse = (parentId: string, depth: number) => {
      const nodes = defaultSceneGraph.getChildren(parentId);
      for (const node of nodes) {
        const kind = readNodeKind(node);
        // Per-property sub-tracks (revealed when the layer is expanded).
      let properties: TimelinePropertyTrack[] = defaultAnimation
        .tracksFor(node.id)
        .map((track) => ({
          prop: track.prop,
          label:
            track.prop === 'x'
              ? 'Position X'
              : track.prop === 'y'
                ? 'Position Y'
                : track.prop === 'z'
                  ? 'Position Z'
                  : track.prop === 'fillAngle'
                    ? 'Fill Angle'
                    : track.prop === 'fillCenterX'
                      ? 'Fill Center X'
                      : track.prop === 'fillCenterY'
                        ? 'Fill Center Y'
                        : track.prop === 'fillRadius'
                          ? 'Fill Radius'
                          : track.prop,
          keyframes: track.keyframes.map((kf) => ({
            id: makeKeyframeId(node.id, track.prop, kf.t) as KeyId,
            nodeId: node.id as NodeId,
            time: controller.toAbsoluteTime(node.id, kf.t),
            roving: kf.roving,
            isHold: kf.easing === 'hold',
          })),
        }));
        
      const separated = node.components.find((c) => c.type === 'Transform')?.props.separateDimensions === true;
      if (!separated) {
        const posProps = properties.filter(p => p.prop === 'x' || p.prop === 'y' || p.prop === 'z');
        if (posProps.length > 0) {
          properties = properties.filter(p => p.prop !== 'x' && p.prop !== 'y' && p.prop !== 'z');
          const mergedKfs = new Map<number, TimelineKeyframeRef>();
          for (const pt of posProps) {
            for (const kf of pt.keyframes) {
              if (!mergedKfs.has(kf.time)) {
                mergedKfs.set(kf.time, { ...kf, id: makeKeyframeId(node.id, 'Position', kf.time) as KeyId });
              }
            }
          }
          properties.unshift({
            prop: 'Position', // Special pseudo-property
            label: 'Position',
            keyframes: Array.from(mergedKfs.values()).sort((a, b) => a.time - b.time),
          });
        }
      }
      // Flat union of all keyframes (collapsed summary row).
      const keyframes: TimelineKeyframeRef[] = properties.flatMap((p) => p.keyframes);
      // Clip bars for this node = its Timeline Engine layers (seconds).
      const clips: TimelineClip[] = controller.getLayersForNode(node.id).map((l) => ({
        id: l.id,
        trackId: node.id as TrackId,
        nodeId: node.id as NodeId,
        start: l.start / compFps,
        duration: l.duration / compFps,
        label: node.name ?? node.id,
        color: (node as any).color ?? KIND_FILL[kind],
      }));
      const track: TimelineTrack = {
        id: node.id as TrackId,
        name: node.name ?? node.id,
        kind,
        icon: KIND_ICON[kind],
        color: (node as any).color ?? KIND_COLOR[kind],
        muted: node.visible === false,
        locked: node.locked === true,
        solo: node.solo === true,
        blendMode: getNodeBlend(node.id),
        parent: node.parent ?? null,
        nodeColor: getNodeColor(node),
        threeD: is3DEnabled(node),
        motionBlur: (node as any).motionBlur === true,
        fxEnabled: (node as any).fxEnabled !== false,
        adjustment: (node as any).adjustment === true,
        shy: (node as any).shy === true,
        keyframes,
        properties,
        clips,
        depth,
        isGroup: kind === 'group',
        expanded: expandedIds.includes(node.id),
      };
      
      result.push(track);
      
      if (kind === 'group' && expandedIds.includes(node.id)) {
        traverse(node.id, depth + 1);
      }
    }
    };
    
    traverse(compId, 0);
    return result;
  }, [sceneRev, clipRev, compFps, expandedIds, active?.compositionId]);

  // Mirror the scene graph into the Timeline Engine's layers whenever the scene
  // changes (structural, non-undoable). The engine then owns the time domain.
  useEffect(() => {
    void sceneRev;
    getTimelineController().syncFromScene();
  }, [sceneRev]);

  // Session hydration is owned by AppRouter (before any route renders), so the
  // editor must NOT re-hydrate here — doing so flips auth status to 'loading'
  // mid-session and bounces RequireAuth back to /login.

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
  }, [active?.compositionId]);

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

  // Latest tracks, read by the reveal shortcuts without re-binding the listener.
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;

  useEffect(() => {
    // AE reveal shortcuts, filtering which property sub-rows show:
    //   U   → toggle *animated* properties on the selected layers
    //   UU  → toggle *animated* properties across ALL layers (reveal/hide all)
    //   P/S/R/T → position / scale / rotation / opacity on the selection
    // (True AE `UU` = "all modified incl. non-keyframed" awaits a modified-prop
    //  source; today the model surfaces animated props only.)
    const REVEAL: Record<string, ReadonlyArray<string>> = {
      p: ['x', 'y'],
      s: ['scale', 'scaleX', 'scaleY'],
      r: ['rotation'],
      t: ['opacity'],
      m: ['mask'],
      a: ['anchorX', 'anchorY'],
      l: ['audio'],
    };

    const onKey = (e: KeyboardEvent): void => {
      const key = e.key.toLowerCase();
      // 'u' is handled by CommandSystem/EventBus RevealAnimatedProps
      if (REVEAL[key] === undefined) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;

      // Expand the selection and switch which props are shown.
      const sel = useSelectionStore.getState().ids;
      if (sel.length === 0) return;
      e.preventDefault();
      setRevealFilter(REVEAL[key]!);
      setExpandedIds((cur) => {
        const set = new Set(cur);
        for (const id of sel) set.add(id);
        return [...set];
      });
    };
    window.addEventListener('keydown', onKey);

    const sub = getEventBus().on('RevealAnimatedProps', (evt: { nodeIds: string[], mode: 'animated' | 'modified' }) => {
      const { nodeIds, mode } = evt;
      const targetIds = nodeIds.length > 0 ? nodeIds : tracksRef.current.map(t => t.id);
      
      setRevealFilter(null);
      
      if (mode === 'animated' || mode === 'modified') {
        const animatedInTarget = targetIds.filter(id => 
          (tracksRef.current.find(t => t.id === id)?.properties?.length ?? 0) > 0
        );
        
        setExpandedIds((cur) => {
          const revealed = targetIds.every((id: string) => cur.includes(id));
          const set = new Set(cur);
          if (revealed) {
            for (const id of targetIds) set.delete(id);
          } else {
            for (const id of animatedInTarget) set.add(id);
          }
          return [...set];
        });
      }
    });

    return () => {
      window.removeEventListener('keydown', onKey);
      sub.dispose();
    };
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
      { id: 'm_end', time: compDuration, label: 'End' },
      ...getTimelineController().getMarkers().map((m) => ({ id: m.id, time: m.time, label: m.label })),
    ];
  }, [markerRev, compDuration]);

  // Work area (in/out) from the engine, in seconds — re-read on RangeChanged.
  const workArea = useMemo(() => {
    void markerRev;
    return getTimelineController().getWorkArea() ?? undefined;
  }, [markerRev]);

  // Model object carries the live playhead (currentTime) without rebuilding tracks.
  const timelineModel = useMemo<TimelineModel>(() => ({
    duration: compDuration,
    frameRate: compFps,
    currentTime: active?.time ?? 0,
    pixelsPerSecond: pps,
    markers,
    tracks: focusTracks,
    cachedRanges,
    ...(workArea ? { workArea } : {}),
  }), [focusTracks, active?.time, cachedRanges, pps, markers, workArea, compDuration, compFps]);

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

  // Rename a scene node — committed when user confirms via Enter or blur.
  const handleTrackRename = (trackId: string, newName: string): void => {
    const node = defaultSceneGraph.getNode(trackId);
    if (!node) return;
    node.name = newName;
    bumpScene();
  };

  const handleTrackActivate = (trackId: string): void => {
    const node = defaultSceneGraph.getNode(trackId);
    if (!node) return;
    if (readNodeKind(node) === 'group') {
      const ws = useProjectStore.getState();
      ws.actions.openTab(trackId, undefined, node.name ?? trackId);
    } else {
      focusIsolate(trackId);
      setSelected([trackId]);
    }
  };

  // Drag a track row to a new position (AE-style layer reorder).
  const handleTrackReorder = useCallback((fromId: string, toIndex: number): void => {
    reorderNode(fromId, toIndex);
    bumpScene();
  }, []);

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
      const props = ref.prop === 'Position' ? ['x', 'y', 'z'] : [ref.prop];
      if (time < 0) {
        runAnimEdit('Delete keyframe', () => {
          for (const p of props) defaultAnimation.removeKeyframe(ref.nodeId, p, ref.t);
        });
      } else {
        const c = getTimelineController();
        runAnimEdit('Move keyframe', () => {
          for (const p of props) defaultAnimation.moveKeyframe(ref.nodeId, p, ref.t, c.toLayerTime(ref.nodeId, time));
        });
      }
    }
  };
  // Timeline easing pills (Linear/Ease/EaseIn/EaseOut/Hold). Apply to the
  // currently selected keyframes; if none are selected, fall back to every
  // keyframe on the selected layers so the pill always has a visible effect.
  const handleSetEasing = (preset: EasingPreset): void => {
    let kfIds = [...useKeyframeSelectionStore.getState().ids];
    if (kfIds.length === 0) {
      kfIds = selectedIds.flatMap((nodeId) =>
        defaultAnimation
          .tracksFor(nodeId)
          .flatMap((track) => track.keyframes.map((kf) => makeKeyframeId(nodeId, track.prop, kf.t))),
      );
    }
    if (kfIds.length === 0) {
      useUIStore.getState().notify({
        level: 'info',
        message: 'Select a layer (or keyframes) first, then choose an easing.',
        durationMs: 3000,
      });
      return;
    }
    applyEasingToKeyframes(kfIds, preset);
  };
  const handleKeyframeContextMenu = (kfId: string, x: number, y: number): void => {
    const ref = parseKeyframeId(kfId);
    if (!ref) return;

    // Check if current keyframe has hold or roving
    // If it's a grouped 'Position' property, we check 'x' as the representative.
    const checkProp = ref.prop === 'Position' ? 'x' : ref.prop;
    const kfs = defaultAnimation.getTrackKeyframes(ref.nodeId, checkProp);
    const currentKf = kfs?.find((k) => Math.abs(k.t - ref.t) < 0.001);
    const isHold = currentKf?.easing === 'hold';
    const isRoving = currentKf?.roving === true;

    const props = ref.prop === 'Position' ? ['x', 'y', 'z'] : [ref.prop];

    openContextMenu(x, y, [
      {
        id: 'toggle-hold',
        label: isHold ? 'Disable Hold (Stepped)' : 'Enable Hold (Stepped)',
        onSelect: () => {
          runAnimEdit(isHold ? 'Disable hold keyframe' : 'Enable hold keyframe', () => {
            for (const p of props) {
              if (defaultAnimation.isAnimated(ref.nodeId, p)) {
                defaultAnimation.updateKeyframe(ref.nodeId, p, ref.t, { easing: isHold ? 'linear' : 'hold' });
              }
            }
          });
        }
      },
      {
        id: 'toggle-roving',
        label: isRoving ? 'Disable Roving' : 'Enable Roving (Rove Across Time)',
        onSelect: () => {
          runAnimEdit(isRoving ? 'Disable roving keyframe' : 'Enable roving keyframe', () => {
            for (const p of props) {
              if (defaultAnimation.isAnimated(ref.nodeId, p)) {
                defaultAnimation.setRoving(ref.nodeId, p, ref.t, !isRoving);
              }
            }
          });
        }
      },
      {
        id: 'delete',
        label: 'Delete keyframe',
        danger: true,
        onSelect: () =>
          runAnimEdit('Delete keyframe', () => {
            for (const p of props) defaultAnimation.removeKeyframe(ref.nodeId, p, ref.t);
          }),
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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100vw', overflow: 'hidden' }}>

      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <EditorLayout
          topNav={<TopNav />}
          statusBar={
            <StatusBar
              left={
                <>
                  {/* Real state, not a hardcoded "Ready": amber while unsaved. */}
                  <span style={{ color: active?.dirty ? 'var(--color-modified)' : 'var(--color-success)' }}>●</span>
                  <span>{active?.dirty ? 'Unsaved changes' : 'Ready'}</span>
                  <span style={{ opacity: 0.4 }}>·</span>
                  <span>{tracks.length} layers</span>
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
                    {formatClock(active?.time ?? 0, compFps)}
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
                  <span style={{ opacity: 0.4 }}>·</span>
                  <AccountButton />
                </>
              }
            />
          }
          timeline={
            <BottomTimeline
              model={timelineModel}
              onScrub={handleScrub}
              onSetEasing={handleSetEasing}
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
              onTrackBlendModeChange={(trackId, mode) => {
                setNodeBlend(trackId, mode);
                bumpScene();
              }}
              onTrackParentChange={(trackId, parentId) => {
                reparentNode(trackId, parentId);
                bumpScene();
              }}
              onTrackToggleFlag={(trackId, flag) => {
                const n = defaultSceneGraph.getNode(trackId);
                if (!n) return;
                if (flag === 'threeD') {
                  // Unified with the inspector's 3D Layer switch — one source of
                  // truth (the layer's z/rotationX/rotationY props).
                  set3DEnabled(trackId, !is3DEnabled(n));
                } else if (flag === 'fxEnabled') {
                  (n as any).fxEnabled = (n as any).fxEnabled === false ? true : false;
                } else {
                  (n as any)[flag] = !(n as any)[flag];
                }
                bumpScene();
              }}
              onKeyframeSeek={handleKeyframeSeek}
              onKeyframeMove={handleKeyframeMove}
              onKeyframeContextMenu={handleKeyframeContextMenu}
              selectedTrackIds={selectedIds}
              expandedTrackIds={expandedIds}
              revealProps={revealFilter}
              onTrackToggleExpand={toggleExpand}
              onTrackActivate={handleTrackActivate}
              onTrackRename={handleTrackRename}
              onTrackReorder={handleTrackReorder}
              onTrackColorChange={(trackId, color) => setNodeColor(trackId, color)}
            />
          }
          sidebarRenderers={getAllPanelRenderers()}
          inspectorRenderers={getAllPanelRenderers()}
        />
      </div>
    </div>
  );
}

export function App(): JSX.Element {
  return (
    <Providers>
      <EditorShell />
    </Providers>
  );
}
