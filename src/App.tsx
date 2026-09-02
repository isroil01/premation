/**
 * App — the application root.
 *
 * Lifecycle:
 *   1. Providers boot the Application core and wire the built-in commands.
 *   2. We register the demo panels in the layout store.
 *   3. We render the editor: toolbar, layout, status bar.
 *
 * Engine integration points:
 *   - Register additional panels: `useLayoutStore.getState.registerPanel(...)`
 *   - Mount a rendering engine: call `useLayoutStore.setState` or use the
 *     layout-registered WorkspaceViewport selector `[data-workspace-viewport]`.
 *   - Push timeline data: pass a `model` prop to <BottomTimeline />.
 */

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Providers } from '@providers/Providers';
import { useLayoutStore } from '@stores/layoutStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import { framesToTimecode } from '@core/time/timecode';
import { videoDiag, VIDEO_DIAG_LIVE_MS, DropRateWindow } from '@core/rendering/videoPlaybackDiag';
import { type EasingPreset } from '@core/animation/keyframeAssistants';
import { applyEasingToKeyframes } from '@core/animation/keyframeAssistants';
import { copyKeyframes, pasteKeyframes } from '@core/animation/keyframeClipboard';
import { viewportFrameCache } from '@core/rendering/frameCache';
import { createViewportDiskCache } from '@core/rendering/frameDiskCache';
import { useKeyframeSelectionStore } from '@stores/keyframeSelectionStore';
import { useSceneRevision, bumpScene } from '@stores/sceneStore';
import { isMediaDecodeRepaint } from '@core/rendering/mediaRepaint';
import { VIDEO_AUDIO_MUTED_PROP } from '@core/audio/audioScene';
import { useProjectStore } from '@stores/projectStore';
import { usePlaybackClock } from '@layout/Timeline/usePlaybackClock';
import { useTimelineKeys } from '@layout/Timeline/useTimelineKeys';
import { useSpaceTransport } from '@hooks/useSpaceTransport';
import { getTimelineController, getRemappedTime, compToKeyframeTime, keyframeToCompTime } from '@core/timeline/TimelineController';
import { staticOrDefaultValue, writeStaticPropertyValue } from '@core/inspector/propertyValue';
import { MASK_ANIM_PROP } from '@core/timeline/propertyTree';
import { deriveTimelineTracks } from '@layout/Timeline/deriveTimelineTracks';
import { runSceneEditDetection } from '@core/tracking/sceneEditCommand';
import { bindAdaptiveResolution } from '@stores/renderQualityStore';
import { installModelHydration } from '@core/scene/modelHydrate';
import { usePropertySelectionStore, propertyKey, distributeScrub } from '@stores/propertySelectionStore';
import {
  keyframeMask,
  clearMaskAnim,
  moveMaskKeyframe,
  removeMaskKeyframe,
  readNodeMaskAnim,
} from '@core/effects/mask';
import { Icon } from '@components/Icon';
import { EditorLayout } from '@layout/EditorLayout';

import { StatusBar } from '@layout/StatusBar';
import { getEventBus } from '@core/events/EventBus';
import { BottomTimeline } from '@layout/BottomTimeline';
import { TopNav } from '@layout/TopNav';
import { AiChatProvider } from '@layout/AiChat/AiChatContext';
import { getAllPanelRenderers } from '@layout/EditorLayout/DemoPanels';
import { PluginConsentHost } from '@layout/Plugins/PluginConsentHost';
import { PluginDeepLink } from '@layout/Plugins/PluginDeepLink';
import { setNodeLabelColor } from '@core/scene/labelColor';
import { usePluginPanelRegistration } from '@layout/Plugins/usePluginPanels';
import { availablePanelDefs } from '@layout/EditorLayout/panelDefs';
import type { TimelineModel, TimelineTrack } from '@layout/Timeline';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import {
  defaultAnimation,
  parseKeyframeId,
  expandKeyframeProp,
  POSITION_PSEUDO_PROP,
  type EasingKind,
} from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import { openKeyframeVelocityDialog } from '@layout/Timeline/KeyframeVelocityDialog';
import {
  addTransition,
  removeTransition,
  transitionAtCut,
  compIdForTransition,
  DEFAULT_TRANSITION_FRAMES,
  TRANSITION_KINDS,
  TRANSITION_LABEL,
} from '@core/timeline/transitions';
import {
  TIMELINE_EDIT_MODES,
  setTimelineEditMode,
  getTimelineEditMode,
} from '@layout/Timeline/timelineEditMode';
import { useCompositionStore } from '@stores/compositionStore';
import { readNodeKind } from '@core/scene/sceneDerive';
import { readCompRef } from '@core/scene/compInstance';
import { setNodeBlend } from '@core/effects/blendMode';
import { setNodeMatte } from '@core/effects/matte';
import { readNodeFxEnabled, setNodeFxEnabled } from '@core/effects/effects';
import { readNodeMotionBlur, setNodeMotionBlur } from '@core/effects/motionBlur';
import { readNodeAdjustment, setNodeAdjustment } from '@core/effects/adjustment';
import { toggleGuideLayer, isGuideLayer } from '@core/scene/guideLayer';
import { readNodePreserveTransparency, setNodePreserveTransparency } from '@core/effects/preserveTransparency';
import {
  enableLayerMotionBlurWithFeedback,
  disableLayerMotionBlur,
  setAdjustmentWithFeedback,
  notifyGuideLayerChange,
} from '@core/effects/layerSwitchFeedback';
import { reparentNode, moveNodeAdjacent } from '@core/scene/parenting';
import { renameLayer } from '@core/scene/renameLayer';
import { is3DEnabled, set3DEnabled, canBe3D } from '@core/scene/threeD';
import { notifyCameraTipIfMissing } from '@core/workspace/cameraNav';
import { openPalette } from '@stores/commandPaletteStore';
import { AccountButton } from '@layout/Auth/AccountButton';
import { openCompositionSettings } from '@layout/Composition/CompositionSettingsDialog';
import { FpsMeter } from '@layout/StatusBar/FpsMeter';
import { InfoReadout } from '@layout/StatusBar/InfoReadout';
import { VUMeter } from '@layout/StatusBar/VUMeter';
import { TimelineZoom } from '@layout/StatusBar/TimelineZoom';
import { useFocusStore } from '@stores/focusStore';
import { useFocusContext } from '@layout/focus/useFocusContext';
import { openContextMenu } from '@stores/contextMenuStore';
import { useResponsiveLayout } from '@hooks/useResponsiveLayout';
import { usePreferenceStore } from '@stores/preferenceStore';
import { openInterpretFootage } from '@layout/Assets/InterpretFootageModal';
import { getNodeLayerTime, updateNodeLayerTime } from '@core/scene/layerTime';
import { useAssetStore } from '@stores/assetStore';
import { customPrompt, customAlert } from '@components/Modal';
import { runDocumentEdit } from '@core/commands/documentEdit';

/**
 * The value a property HAS at `layerT`: the sampled keyframe when the property
 * is animated, else its static component prop, else the type's default.
 *
 * One definition on purpose. The stopwatch, the add-keyframe command and the
 * timeline's value fields all need this answer, and three copies of the rule is
 * three chances to key a different number than the one on screen — which is
 * exactly how "Enable animation" on Position once wrote y:= x.
 *
 * `layerT` must be the LAYER's time (`getRemappedTime`), not raw comp time.
 */
function propertyValueAt(nodeId: string, prop: string, layerT: number): number {
  const sampled = defaultAnimation.sample(nodeId, prop, layerT);
  if (sampled !== undefined) return sampled;
  // The static value, through the one reader that understands STRUCTURED paths
  // as well as flat component props. The timeline's tree keys effect params,
  // path operators and text animators now; a component scan answers 0 for all
  // three, so a stopwatch on a 40px Glow radius used to key it to 0.
  return staticOrDefaultValue(nodeId, prop);
}

/** Times within this many seconds of each other are the same keyframe. */
const KEYFRAME_EPSILON = 1e-4;

function setNodeColor(nodeId: string, color: string): void {
  setNodeLabelColor(nodeId, color);
}

/** The editor UI wrapped in the AI chat provider — chat state must sit above
 *  the dock tree so switching sidebar tabs never cancels a run or rolls back a
 *  pending preview. Routing renders EditorShell directly (EditorPage), so the
 *  provider lives here, not in <App>. */
export function EditorShell(): JSX.Element {
  return (
    <AiChatProvider>
      <EditorShellInner />
    </AiChatProvider>
  );
}

/** The playhead time RIGHT NOW, read non-reactively. For event handlers: they
 *  fire at event time, so a render-captured value buys them nothing — while a
 *  reactive subscription in the shell re-rendered the whole editor tree every
 *  playback frame just to keep that captured value fresh. */
function playheadNow(): number {
  const s = useProjectStore.getState();
  return s.activeTabId ? (s.tabs[s.activeTabId]?.time ?? 0) : 0;
}

/** Self-subscribing status-bar timecode — the ONE render-time consumer of the
 *  playhead in the shell. Isolated (same pattern as FpsMeter/VUMeter beside
 *  it) so only this span re-renders per comp frame, not EditorShellInner. */
/** How far back the drop readout looks. Long enough that sustained pressure
 *  cannot hide between ticks, short enough that the badge clears within a
 *  breath of playback recovering. */
const DROP_WINDOW_MS = 4000;
/** Drops inside the window that turn the badge red — about a quarter-second of
 *  30fps footage lost while the window is only four seconds long. */
const DROP_BAD_COUNT = 30;

function StatusBarTimecode({ fps, startFrame }: { fps: number; startFrame: number }): JSX.Element {
  const time = useProjectStore((s) => (s.activeTabId ? s.tabs[s.activeTabId]?.time ?? 0 : 0));
  return (
    <span style={{ fontFamily: 'var(--font-family-mono)', fontVariantNumeric: 'tabular-nums' }}>
      {framesToTimecode(time, fps, startFrame)}
    </span>
  );
}

/**
 * Live video decoder health in the status bar. Two jobs: show dropped-frame
 * pressure during playback (decode overload reads as "broken video" with no
 * other symptom), and — the important one — say OUT LOUD when the browser's
 * media pipeline has wedged (every new <video> stalls at readyState 0 with no
 * error; only a full app/browser restart clears it). That failure mode used
 * to be indistinguishable from editor bugs.
 */
function VideoHealth(): JSX.Element | null {
  const [state, setState] = useState<{ label: string; bad: boolean } | null>(null);
  const warnedRef = useRef(false);
  // Recent drops, not lifetime drops — the counters are cumulative and the
  // elements are reused across loops, so raw totals kept the badge red forever
  // after one rough pass. The arithmetic and its reasoning live in
  // `DropRateWindow`.
  const dropsRef = useRef(new DropRateWindow(DROP_WINDOW_MS));
  useEffect(() => {
    const id = setInterval(() => {
      if (videoDiag.stalledSources.size > 0) {
        setState({ label: 'video decoder not responding — restart the app', bad: true });
        if (!warnedRef.current) {
          warnedRef.current = true;
          useUIStore.getState().notify({
            level: 'error',
            message:
              'Video decoding is not responding (the system media pipeline appears wedged). '
              + 'Fully restart the app — or your browser — to restore video playback.',
            durationMs: 12000,
          });
        }
        return;
      }
      const now = performance.now();
      let live = 0;
      let seeking = false;
      let worstLagMs = 0;
      const counts = new Map<string, number>();
      for (const s of videoDiag.samples.values()) {
        if (now - s.updatedAt > VIDEO_DIAG_LIVE_MS) continue;
        live += 1;
        counts.set(s.key, s.droppedFrames);
        seeking = seeking || s.seeking;
        if (s.driftMs < worstLagMs) worstLagMs = s.driftMs;
      }
      const recentDrops = dropsRef.current.sample(now, counts);
      if (live === 0) {
        setState(null);
        return;
      }
      // "behind" = the decoder cannot sustain realtime on this machine; the
      // timeline is pacing down to meet it. The cure is a preview proxy
      // (Media Settings ▸ Proxy), not a code path.
      const lag = worstLagMs < -150 ? ` · behind ${(-worstLagMs / 1000).toFixed(1)}s` : '';
      setState({
        label: `video ×${live} · drop ${recentDrops}${seeking ? ' · seeking' : ''}${lag}`,
        // ~1/4 of a second's frames lost inside the window = real pressure now;
        // a couple of drops around a seek is normal and stays quiet.
        bad: recentDrops > DROP_BAD_COUNT || worstLagMs < -400,
      });
    }, 500);
    return () => clearInterval(id);
  }, []);
  if (!state) return null;
  return (
    <>
      <span style={{ opacity: 0.4 }}>·</span>
      <span
        style={{
          fontVariantNumeric: 'tabular-nums',
          ...(state.bad ? { color: 'var(--color-danger, #e06055)', fontWeight: 600 } : {}),
        }}
        title={`Video decoder health: live elements, frames dropped in the last ${DROP_WINDOW_MS / 1000}s`}
      >
        {state.label}
      </span>
    </>
  );
}

function EditorShellInner(): JSX.Element {
  const registerPanel = useLayoutStore((s) => s.registerPanel);
  const selectionCount = useSelectionStore((s) => s.ids.length);
  const selectedIds = useSelectionStore((s) => s.ids);
  const setSelected = useSelectionStore((s) => s.set);
  // Property-row selection (ordered) — what proportional scrubbing acts on.
  const propertyEntries = usePropertySelectionStore((s) => s.entries);
  const selectedPropertyKeys = useMemo(() => propertyEntries.map(propertyKey), [propertyEntries]);
  const handlePropertySelect = (trackId: string, prop: string, mode: 'replace' | 'toggle'): void => {
    const store = usePropertySelectionStore.getState();
    if (mode === 'replace') store.select({ nodeId: trackId, prop });
    else store.toggle({ nodeId: trackId, prop });
  };
  const addSelected = useSelectionStore((s) => s.add);
  const sceneRev = useSceneRevision((s) => s.rev);
  // Scalar selectors, NOT `useActiveWorkspace`.
  //
  // `useActiveWorkspace` returns the whole tab OBJECT, which immer replaces on
  // every `setTime` — 60×/s during playback. That subscription sat right next to
  // a comment claiming it had been removed for exactly this reason, so this
  // ~1200-line component (which hosts the entire editor tree, and whose children
  // are almost all unmemoized) re-rendered every playback frame. Only three
  // fields were ever read off it, and none of them change per frame.
  const activeCompId = useProjectStore((s) => (s.activeTabId ? s.tabs[s.activeTabId]?.compositionId : undefined));
  const activeDirty = useProjectStore((s) => (s.activeTabId ? s.tabs[s.activeTabId]?.dirty ?? false : false));
  const activeTitle = useProjectStore((s) => (s.activeTabId ? s.tabs[s.activeTabId]?.title : undefined));
  // NO reactive playhead subscription here. `time` changes once per comp frame
  // during playback, and a subscription re-rendered this ~1355-line shell (and
  // reconciled its entire unmemoized return tree — TopNav, dock, timeline) on
  // every single frame, starving the main thread the renderer and the <video>
  // pipeline needed. The only render-time reader was the status-bar timecode
  // (now the self-subscribing <StatusBarTimecode/>); everything else that
  // needs the playhead is an EVENT HANDLER, which reads `playheadNow()` at
  // event time — non-reactive and always current.

  const compFps = useCompositionStore((s) => s.fps);
  const compWidth = useCompositionStore((s) => s.width);
  const compHeight = useCompositionStore((s) => s.height);
  const compStartFrame = useCompositionStore((s) => s.startFrame);
  const compDuration = useCompositionStore((s) => s.durationSeconds);

  const focusIsolate = useFocusStore((s) => s.isolate);
  const { activeSet } = useFocusContext();

  // Enable responsive UI auto-collapsing behaviors
  useResponsiveLayout();

  /*
   * There is deliberately no auto-switching of the inspector tab on selection.
   *
   * There used to be: selecting a camera, light or particle layer force-opened
   * the Settings tab, because those layers' controls lived there and the tab
   * you were on would otherwise show you nothing. Before that it was worse —
   * it switched between Transform and Style on every selection change, so
   * reading a transform and clicking a text layer yanked you to Style.
   *
   * Both were workarounds for one thing: the selected layer's properties were
   * split across three tabs. They are one panel now, so every layer kind's
   * controls are already on screen and there is nothing to switch to.
   */

  // Adaptive Resolution: the viewport degrades while ANY drag is in flight.
  // The UI store's drag flag is already set by every gizmo, scrub and value
  // field, so one subscription covers them all.
  useEffect(
    () => bindAdaptiveResolution((cb) => useUIStore.subscribe((s, prev) => {
      if (s.isDragging !== prev.isDragging) cb(s.isDragging);
    })),
    [],
  );

  // Imported 3D models: re-parse stored .glb sources into the session mesh
  // registry after a project opens (and repoint dead texture object URLs).
  useEffect(() => installModelHydration(), []);

  // Register the default panels exactly once.
  useEffect(() => {
    // Registrations come from the SHARED registry (panelDefs.ts) so a pop-out
    // window can resolve the same titles/icons — it renders PopoutRoute, never
    // EditorShell, so it never runs this effect and used to show a raw id.
    // On-demand panels are registered (so menus/shortcuts can open them) then
    // closed unless a persisted layout already had them open.
    // `availablePanelDefs()`, not PANEL_DEFS: a panel its edition does not offer
    // must never be registered. That is the gate, not a cosmetic filter — the
    // dock renders `panelOrder.map(id => panels[id]).filter(Boolean)`, so an id
    // left over in a PERSISTED layout (or written by a workspace preset) draws
    // nothing at all once it is absent from the registry.
    const openBefore = new Set(Object.values(useLayoutStore.getState().panelOrder).flat());
    for (const p of availablePanelDefs()) {
      registerPanel({ id: p.id, title: p.title, icon: p.icon, region: p.region, weight: p.weight, closable: p.closable });
      if (p.onDemand && !openBefore.has(p.id)) useLayoutStore.getState().closePanel(p.id);
    }
  }, [registerPanel]);

  // The panels that are NOT known at build time: one per plugin panel that asked
  // for a tab of its own and got one. Registered by their own hook because the
  // set changes while the app is running — install, uninstall, enable, disable —
  // and the effect above deliberately runs once.
  usePluginPanelRegistration();


  // Bumped when the engine's layers/clips change (add/remove/move/trim/split),
  // so the derived clip bars stay in sync.
  const [clipRev, setClipRev] = useState(0);

  const [expandedIds, setExpandedIds] = useState<ReadonlyArray<string>>([]);

  // Re-read engine markers + work area when they change (add/remove, in/out).
  // Declared here rather than beside its effect because the track model reads
  // layer markers, so it has to re-derive when one is added or removed.
  const [markerRev, setMarkerRev] = useState(0);

  // Structural vs value-only: `sceneRev` ticks on inspector slider drags
  // (`bumpSceneRevision`), which used to rebuild every timeline row 30–60×/s.
  // Structure (add/remove/reparent) is `SceneGraphChanged`; keyframe diamonds
  // are `AnimationChanged`. Expanded property *values* still need sceneRev.
  const [graphRev, setGraphRev] = useState(0);
  const [animRev, setAnimRev] = useState(0);

  // Timeline tracks derived from the scene graph — one track per node, in
  // layer order. Clip bars come from the Timeline Engine's layers for that node.
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

  // Mirror the scene graph into the Timeline Engine's layers on STRUCTURAL
  // changes only (add/remove/reparent). Pure keyframe or property edits do not
  // change layer geometry, so there is no need to walk the whole scene for them.
  // Previously this was keyed on sceneRev, which fired on every drag tick and
  // caused a full syncFromScene walk 30-60 times/second during a slider drag.
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

  // Session hydration is owned by AppRouter (before any route renders), so the
  // editor must NOT re-hydrate here — doing so flips auth status to 'loading'
  // mid-session and bounces RequireAuth back to /login.

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
  }, [activeCompId]);

  // Track visibility / lock toggles → scene node state.
  const toggleTrackVisible = (trackId: string): void => {
    const node = defaultSceneGraph.getNode(trackId);
    if (!node) return;
    runDocumentEdit(node.visible === false ? 'Show layer' : 'Hide layer', () => {
      node.visible = node.visible === false;
      bumpScene();
    });
  };
  const toggleTrackLock = (trackId: string): void => {
    const node = defaultSceneGraph.getNode(trackId);
    if (!node) return;
    runDocumentEdit(node.locked ? 'Unlock layer' : 'Lock layer', () => {
      node.locked = !node.locked;
      bumpScene();
    });
  };
  const toggleTrackSolo = (trackId: string): void => {
    const node = defaultSceneGraph.getNode(trackId);
    if (!node) return;
    runDocumentEdit(node.solo ? 'Unsolo layer' : 'Solo layer', () => {
      node.solo = !node.solo;
      bumpScene();
    });
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
    // A manual chevron twirl always shows the FULL property tree — clear any
    // lingering U/P/S/R/T reveal filter so rows don't silently stay hidden.
    setRevealFilter(null);
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
    // Each list names every row id that property can appear as: the raw engine
    // props, the merged 'Position' pseudo-row, and the static '__static:*'
    // placeholder shown before any keyframes exist.
    const REVEAL: Record<string, ReadonlyArray<string>> = {
      p: ['x', 'y', 'z', POSITION_PSEUDO_PROP, '__static:position'],
      s: ['scale', 'scaleX', 'scaleY', '__static:scale'],
      r: ['rotation', 'rotationX', 'rotationY', '__static:rotation'],
      t: ['opacity', '__static:opacity'],
      m: ['mask'],
      a: ['anchorX', 'anchorY', '__static:anchor'],
      l: ['audio'],
    };

    // AE's Alt+Shift+<prop> — add a keyframe for that property on every
    // selected layer at the playhead, enabling animation if needed. The engine
    // props each chord keys (not the reveal row ids above).
    const ADD_KEY_PROPS: Record<string, ReadonlyArray<string>> = {
      p: ['x', 'y'],
      s: ['scaleX', 'scaleY'],
      r: ['rotation'],
      t: ['opacity'],
      a: ['anchorX', 'anchorY'],
    };

    const addKeyframesFor = (sel: readonly string[], props: ReadonlyArray<string>): void => {
      const rawTime = useProjectStore.getState().tabs[useProjectStore.getState().activeTabId ?? '']?.time ?? 0;
      runAnimEdit('Add keyframe', () => {
        for (const id of sel) {
          const node = defaultSceneGraph.getNode(id);
          if (!node || node.locked) continue;
          // getRemappedTime is already layer-local; toLayerTime on top would
          // subtract the clip start twice (the ghost-drag bug's root cause).
          const layerT = getRemappedTime(id, rawTime);
          for (const p of props) {
            // Hold the value the user sees — same rule as the stopwatch and the
            // timeline's value fields, so all three key the same number.
            defaultAnimation.setKeyframe(id, p, layerT, propertyValueAt(id, p, layerT));
          }
        }
      });
    };

    const onKey = (e: KeyboardEvent): void => {
      const key = e.key.toLowerCase();
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;

      // Alt+Shift+<prop> → add keyframe (checked before the reveal early-outs
      // because reveal ignores modified chords entirely).
      if (e.altKey && e.shiftKey && !e.metaKey && !e.ctrlKey && ADD_KEY_PROPS[key]) {
        const sel = useSelectionStore.getState().ids;
        if (sel.length === 0) return;
        e.preventDefault();
        addKeyframesFor(sel, ADD_KEY_PROPS[key]!);
        // Reveal what was just keyed so the new diamond is visible.
        setRevealFilter(null);
        setExpandedIds((cur) => {
          const set = new Set(cur);
          for (const id of sel) set.add(id);
          return [...set];
        });
        return;
      }

      // 'u' is handled by CommandSystem/EventBus RevealAnimatedProps
      if (REVEAL[key] === undefined) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

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

    const sub = getEventBus().on('RevealAnimatedProps', (evt: { nodeIds: string[], mode: 'animated' | 'modified', force?: boolean }) => {
      const { nodeIds, mode, force } = evt;
      const targetIds = nodeIds.length > 0 ? nodeIds : tracksRef.current.map(t => t.id);

      // Static placeholder rows (animated:false) are part of the always-there
      // property tree, not animation — U must ignore them, or it would expand
      // every layer and reveal the full tree instead of keyframed props only.
      const animatedProps = (id: string) =>
        (tracksRef.current.find((t) => t.id === id)?.properties ?? []).filter(
          (p) => p.animated !== false,
        );

      // A generator asking to be seen (force) reads the ENGINE, not the model:
      // it emits in the same tick as its write, and `tracksRef` still holds the
      // model from before those keyframes existed. Reading the stale model here
      // would find no animated props and expand nothing — the exact "I clicked
      // it and the timeline is unchanged" this flag is for.
      if (force) {
        const rows = new Set<string>();
        const withRows: string[] = [];
        for (const id of targetIds) {
          const props = defaultAnimation.animatedProps(id);
          if (!props.length) continue;
          withRows.push(id);
          const node = defaultSceneGraph.getNode(id);
          const separated = node?.components.find((c) => c.type === 'Transform')?.props.separateDimensions === true;
          for (const p of props) {
            // x/y/z are drawn as one merged Position row unless the layer has
            // separated dimensions; naming the raw prop would filter that row out.
            if (!separated && (p === 'x' || p === 'y' || p === 'z')) rows.add(POSITION_PSEUDO_PROP);
            else rows.add(p);
          }
        }
        if (!withRows.length) return;
        setRevealFilter([...rows]);
        setExpandedIds((cur) => [...new Set([...cur, ...withRows])]);
        return;
      }

      if (mode === 'animated' || mode === 'modified') {
        const animatedInTarget = targetIds.filter((id) => animatedProps(id).length > 0);
        // Filter the revealed rows to the animated ones (AE's U shows only
        // keyframed properties; the chevron twirl shows the whole tree).
        const filter = new Set<string>();
        for (const id of animatedInTarget) for (const p of animatedProps(id)) filter.add(p.prop);
        setRevealFilter(filter.size > 0 ? [...filter] : null);

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

  // User markers from the Timeline Engine (in seconds).
  const markers = useMemo(() => {
    void markerRev;
    return getTimelineController().getMarkers().map((m) => ({ id: m.id, time: m.time, label: m.label }));
  }, [markerRev]);

  // Work area (in/out) from the engine, in seconds — re-read on RangeChanged.
  const workArea = useMemo(() => {
    void markerRev;
    return getTimelineController().getWorkArea() ?? undefined;
  }, [markerRev]);

  // The disk tier under the RAM cache, so a looped work area longer than ~2s
  // stops re-rendering from scratch on every pass.
  //
  // OPEN BEFORE ATTACH. `open()` purges what the previous session left (its
  // frames are keyed by revision counters that have since reset — see
  // frameDiskCache.ts). Attaching first would let the render loop write frames
  // that the purge then deletes, so the cache would silently drop everything
  // from its first few hundred milliseconds.
  useEffect(() => {
    const disk = createViewportDiskCache();
    if (!disk) return;
    let cancelled = false;
    void disk.open().then(() => {
      if (!cancelled) viewportFrameCache.attachDisk(disk);
    });
    return () => {
      cancelled = true;
      viewportFrameCache.attachDisk(null);
      // End of session: commit whatever manifest changes are still sitting in
      // the debounce. Without this the last frames written before the editor
      // closed would be on disk but absent from the manifest, and the next
      // launch's reconcile would delete them as orphans.
      disk.flushManifest();
    };
  }, []);

  // NOTE: preview-coverage (the green RAM lane and blue disk lane under the
  // ruler) is deliberately NOT state here any more. It changes on every
  // rendered frame — 60×/s through a first playback pass, and again through
  // every idle pre-render pass while paused — so holding it in the shell
  // re-rendered the entire application tree at frame rate and replaced the
  // `timelineModel` object below, defeating the memoization the comment on that
  // model exists to protect. The lanes now subscribe themselves; see
  // `layout/Timeline/CacheBars.tsx`.

  // Model object for the timeline — deliberately does NOT include the live
  // playhead time (activeTime). BottomTimeline reads ws?.time directly and
  // passes it to <Timeline> as a separate `playheadTime` prop, so the model
  // object stays referentially stable across playback frames. Without this,
  // timelineModel was a new object 60×/s and forced the entire row tree to
  // re-evaluate on every frame tick.
  const timelineModel = useMemo<TimelineModel>(() => ({
    duration: compDuration,
    frameRate: compFps,
    startFrame: compStartFrame,
    // A SNAPSHOT, deliberately not reactive: every live consumer reads the
    // separate playheadTime path (BottomTimeline/Timeline/GraphEditor), so
    // this field only serves the no-active-tab fallback. Making it reactive
    // rebuilt this model object every playback frame — exactly what the
    // header comment above forbids.
    currentTime: playheadNow(),
    pixelsPerSecond: pps,
    markers,
    tracks: focusTracks,
    ...(workArea ? { workArea } : {}),
  }), [focusTracks, pps, markers, workArea, compDuration, compFps, compStartFrame]);

  // Real-time playback clock: pumps the Timeline Engine while `playing` is set.
  usePlaybackClock();

  // Background "optimized media": once the editor settles, generate proxies
  // for video assets that predate import-time auto-generation. Sequential and
  // cancellable via the Use Proxies toggle; a no-op on builds without ffmpeg.
  useEffect(() => {
    const t = setTimeout(() => {
      void import('@core/assets/proxyManager').then((m) => m.backfillMissingProxies()).catch(() => {});
    }, 5000);
    return () => clearTimeout(t);
  }, []);
  // Frame-accurate transport shortcuts (Home/End, Page Up/Down, Shift = markers).
  useTimelineKeys();
  // Space: tap to play/pause, hold + drag to pan (After Effects).
  useSpaceTransport();

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
    const result = renameLayer(trackId, newName);
    if (!result.ok) return;
    if (result.repaired.length > 0) {
      const n = result.repaired.length;
      useUIStore.getState().notify({
        level: 'info',
        message: `${n} expression${n === 1 ? '' : 's'} updated to follow the new name.`,
        durationMs: 4000,
      });
    }
    if (result.captured.length > 0) {
      const n = result.captured.length;
      useUIStore.getState().notify({
        level: 'warning',
        message: `${n} expression${n === 1 ? '' : 's'} naming “${newName.trim()}” now read this layer instead of the previous layer.`,
        durationMs: 10000,
      });
    } else if (result.nameAlreadyInUse) {
      useUIStore.getState().notify({
        level: 'warning',
        message: `Another layer is already called “${newName.trim()}”; expressions can reach only one of them by name.`,
        durationMs: 6000,
      });
    }
  };

  /**
   * Toggle a layer's AUDIO mute from the speaker glyph on its clip bar.
   *
   * Deliberately separate from the track's visibility eye: hiding a layer
   * silences it too, but muting the sound must not blank the picture. Writes
   * the same prop the inspector's Mute switch does — the glyph is a second view
   * of one piece of state, not a second piece of state.
   */
  const handleClipMuteToggle = (nodeId: string): void => {
    const node = defaultSceneGraph.getNode(nodeId);
    if (!node) return;
    const kind = readNodeKind(node);
    const componentType = kind === 'audio' ? 'Audio' : 'Transform';
    const prop = kind === 'audio' ? '__muted' : VIDEO_AUDIO_MUTED_PROP;
    const comp = node.components.find((c) => c.type === componentType);
    if (!comp) return;
    const muted = (comp.props as Record<string, unknown>)?.[prop] === true;
    runDocumentEdit(muted ? 'Unmute layer audio' : 'Mute layer audio', () => {
      defaultSceneGraph.writeProp(nodeId, comp.id, prop, muted ? undefined : true);
      bumpScene();
    });
  };

  const handleTrackActivate = (trackId: string): void => {
    const node = defaultSceneGraph.getNode(trackId);
    if (!node) return;
    const kind = readNodeKind(node);
    // Double-clicking a comp INSTANCE opens the source composition for editing
    // (AE behaviour) — its own subtree is empty; the content lives in the ref.
    if (kind === 'comp') {
      const ref = readCompRef(node);
      const refNode = ref ? defaultSceneGraph.getNode(ref) : null;
      if (ref && refNode) {
        useProjectStore.getState().actions.openTab(ref, undefined, refNode.name ?? ref);
      }
      return;
    }
    if (kind === 'group') {
      const ws = useProjectStore.getState();
      ws.actions.openTab(trackId, undefined, node.name ?? trackId);
    } else {
      focusIsolate(trackId);
      setSelected([trackId]);
    }
  };

  // Drag a track row to a new position (AE-style layer reorder).
  //
  // `toIndex` is a DISPLAY track index (rows listed top = front). The old code
  // fed it straight to `reorderNode` as a sibling index, which was wrong twice
  // over: display order is reversed child order, and with any group expanded
  // the flat row index stopped matching sibling positions at all. Anchoring to
  // the nearest visible SIBLING row is immune to both.
  const handleTrackReorder = useCallback((fromId: string, toIndex: number): void => {
    const list = tracksRef.current;
    const node = defaultSceneGraph.getNode(fromId);
    if (!node) return;
    const parentId = node.parent;
    const siblingRow = (t: { id: string } | undefined): boolean =>
      !!t && t.id !== fromId && defaultSceneGraph.getNode(t.id)?.parent === parentId;

    // Prefer the first sibling at/after the drop slot → place display-BEFORE it;
    // otherwise the last sibling before the slot → place display-AFTER it.
    let anchorId: string | null = null;
    let displayPos: 'before' | 'after' = 'before';
    for (let i = Math.max(0, toIndex); i < list.length; i++) {
      if (siblingRow(list[i])) { anchorId = list[i]!.id; displayPos = 'before'; break; }
    }
    if (!anchorId) {
      for (let i = Math.min(toIndex, list.length) - 1; i >= 0; i--) {
        if (siblingRow(list[i])) { anchorId = list[i]!.id; displayPos = 'after'; break; }
      }
    }
    if (!anchorId) return;
    // Display order is reversed child order: display-before ⇒ child-after.
    moveNodeAdjacent(fromId, anchorId, displayPos === 'before' ? 'after' : 'before');
  }, []);

  // ── Keyframe editing (timeline reports intents; the engine does the work) ──
  const handleKeyframeSeek = (kfId: string): void => {
    const ref = parseKeyframeId(kfId);
    if (!ref) return;
    // `ref.t` is the STORED keyframe time — seek to the comp time where the
    // renderer applies it (identical only for an untrimmed clip at 0).
    handleScrub(keyframeToCompTime(ref.nodeId, ref.t, ref.prop));
    setSelected([ref.nodeId]);
  };
  const handleKeyframeMove = (kfId: string, time: number): void => {
    const ref = parseKeyframeId(kfId);
    // The timeline commits once on release, so one move = one undoable command.
    if (ref) {
      // Mask keyframes live on the scene graph as whole-shape snapshots, so
      // they retime through the mask store. Same gesture, different owner.
      if (ref.prop === MASK_ANIM_PROP) {
        if (time < 0) {
          runAnimEdit('Delete mask keyframe', () => removeMaskKeyframe(ref.nodeId, ref.t));
        } else {
          runAnimEdit('Move mask keyframe', () =>
            moveMaskKeyframe(ref.nodeId, ref.t, compToKeyframeTime(ref.nodeId, time, ref.prop)),
          );
        }
        return;
      }
      // Non-scalar (data) tracks — Source Text / gradient stops — have their
      // own keyframe store; route by which store actually holds the prop.
      if (defaultAnimation.isDataAnimated(ref.nodeId, ref.prop)) {
        if (time < 0) {
          runAnimEdit('Delete keyframe', () => defaultAnimation.removeDataKeyframe(ref.nodeId, ref.prop, ref.t));
        } else {
          runAnimEdit('Move keyframe', () => defaultAnimation.moveDataKeyframe(ref.nodeId, ref.prop, ref.t, compToKeyframeTime(ref.nodeId, time, ref.prop)));
        }
        return;
      }
      const props = expandKeyframeProp(ref.prop);
      if (time < 0) {
        runAnimEdit('Delete keyframe', () => {
          for (const p of props) defaultAnimation.removeKeyframe(ref.nodeId, p, ref.t);
        });
      } else {
        // `time` is the drop's comp time — store the keyframe on the canonical
        // axis so the diamond re-draws exactly where it was dropped.
        runAnimEdit('Move keyframe', () => {
          const layerT = compToKeyframeTime(ref.nodeId, time, ref.prop);
          for (const p of props) defaultAnimation.moveKeyframe(ref.nodeId, p, ref.t, layerT);
        });
      }
    }
  };
  const handleKeyframesDelete = (keyframeIds: ReadonlyArray<string>): void => {
    const refs = keyframeIds
      .map((id) => parseKeyframeId(id))
      .filter((ref): ref is NonNullable<ReturnType<typeof parseKeyframeId>> => ref !== null);
    if (refs.length === 0) return;
    runAnimEdit(refs.length === 1 ? 'Delete keyframe' : 'Delete keyframes', () => {
      for (const ref of refs) {
        if (ref.prop === MASK_ANIM_PROP) {
          removeMaskKeyframe(ref.nodeId, ref.t);
        } else if (defaultAnimation.isDataAnimated(ref.nodeId, ref.prop)) {
          defaultAnimation.removeDataKeyframe(ref.nodeId, ref.prop, ref.t);
        } else {
          for (const prop of expandKeyframeProp(ref.prop)) {
            defaultAnimation.removeKeyframe(ref.nodeId, prop, ref.t);
          }
        }
      }
    });
  };
  /**
   * The keyframe navigator's diamond — the only affordance that creates a
   * keyframe WITHOUT changing the value. Anchoring ("hold here, then move
   * away") is impossible otherwise: the stopwatch writes only the *first*
   * keyframe, so every later one would need a value change to exist.
   */
  const handlePropertyKeyframeToggle = (trackId: string, prop: string): void => {
    // Read the playhead at event time — same store field the navigator draws
    // from, so what it shows and what this writes can't disagree.
    const layerT = getRemappedTime(trackId, playheadNow());
    const at = (p: string) =>
      (defaultAnimation.getTrackKeyframes(trackId, p) ?? []).find(
        (k) => Math.abs(k.t - layerT) < KEYFRAME_EPSILON,
      );
    // 'Position' is a pseudo-property merging x/y/z; z only exists on 3D layers.
    const props = expandKeyframeProp(prop).filter((p) =>
      defaultAnimation.getTrackKeyframes(trackId, p),
    );
    if (props.length === 0) return;

    const existing = props.filter((p) => at(p));
    if (existing.length > 0) {
      runAnimEdit('Remove keyframe', () => {
        for (const p of existing) {
          const kf = at(p);
          if (kf) defaultAnimation.removeKeyframe(trackId, p, kf.t);
        }
      });
      return;
    }
    // Hold whatever the property currently evaluates to at the playhead.
    const values = defaultAnimation.evaluateNode(trackId, layerT);
    runAnimEdit('Add keyframe', () => {
      for (const p of props) {
        const v = values.get(p);
        if (v !== undefined) defaultAnimation.setKeyframe(trackId, p, layerT, v);
      }
    });
  };
  /**
   * A static property row's stopwatch (the AE gesture): create the first
   * keyframe(s) at the playhead holding the property's CURRENT static value,
   * turning the placeholder into a live animated row.
   */
  const handlePropertyStopwatch = (trackId: string, props: ReadonlyArray<string>): void => {
    const node = defaultSceneGraph.getNode(trackId);
    if (!node || node.locked) return;
    // The mask row is not a numeric track: its keyframes are whole-mask
    // snapshots kept on the scene graph, so its stopwatch routes to the mask
    // store instead of the animation engine.
    if (props[0] === MASK_ANIM_PROP) {
      const animated = readNodeMaskAnim(node).length > 0;
      runAnimEdit(animated ? 'Disable mask animation' : 'Enable mask animation', () => {
        if (animated) clearMaskAnim(trackId);
        else keyframeMask(trackId, getRemappedTime(trackId, playheadNow()));
      });
      return;
    }
    // The stopwatch is lit when animated, so clicking it means "turn this off" —
    // the same control both ways, as in AE. It used to only ever create, so the
    // timeline could start an animation but never end one.
    if (props.some((p) => defaultAnimation.isAnimated(trackId, p))) {
      runAnimEdit('Disable animation', () => {
        for (const p of props) defaultAnimation.removeTrack(trackId, p);
      });
      return;
    }
    const layerT = getRemappedTime(trackId, playheadNow());
    runAnimEdit('Enable animation', () => {
      for (const p of props) defaultAnimation.setKeyframe(trackId, p, layerT, propertyValueAt(trackId, p, layerT));
    });
  };

  /**
   * The timeline's value fields — AE shows a live, scrubbable value beside every
   * property, so an animation can be built without crossing to the inspector.
   *
   * Reads on the layer's axis (`getRemappedTime`) because that is what the
   * renderer samples and what every write below uses. Reading one axis and
   * writing another is what made a value set at 5s appear to overwrite the
   * keyframe at 1s.
   */
  const handlePropertyValue = (trackId: string, prop: string): number =>
    propertyValueAt(trackId, prop, getRemappedTime(trackId, playheadNow()));

  /**
   * Proportional Scrubbing (AE 26.2).
   *
   * While a value field is being dragged and its property is one of SEVERAL
   * selected, the drag's delta is spread across the whole selection — 0 % at
   * the first-selected, 100 % at the last — so one drag cascades ten layers.
   * The snapshot is taken at scrub START (see `ValueField.onScrubStart`): a
   * scrub is relative to where things were, and reading the live values
   * mid-drag would compound the ramp on every pointer move.
   */
  const scrubRef = useRef<null | {
    trackId: string;
    prop: string;
    entries: ReadonlyArray<{ nodeId: string; prop: string }>;
    starts: Map<string, number>;
  }>(null);
  const handlePropertyScrubStart = (trackId: string, prop: string): void => {
    const sel = usePropertySelectionStore.getState();
    const inSelection = sel.has({ nodeId: trackId, prop });
    if (!inSelection || sel.entries.length < 2) {
      scrubRef.current = null;
      return;
    }
    const layerT = (id: string) => getRemappedTime(id, playheadNow());
    const starts = new Map<string, number>();
    for (const e of sel.entries) starts.set(propertyKey(e), propertyValueAt(e.nodeId, e.prop, layerT(e.nodeId)));
    scrubRef.current = { trackId, prop, entries: sel.entries, starts };
  };
  const handlePropertyScrubEnd = (): void => {
    scrubRef.current = null;
  };

  /** One property's write, shared by the single and the distributed paths. */
  const writePropertyValue = (trackId: string, prop: string, value: number): void => {
    const node = defaultSceneGraph.getNode(trackId);
    if (!node || node.locked) return;
    const layerT = getRemappedTime(trackId, playheadNow());
    // Same contract as the inspector: an animated property keyframes at the
    // playhead; an un-animated one edits its static base.
    if (defaultAnimation.isAnimated(trackId, prop) || usePreferenceStore.getState().timelineAutoKeyframe) {
      runAnimEdit(
        `Set ${prop}`,
        () => defaultAnimation.setKeyframe(trackId, prop, layerT, value),
        // Merge key carries the CANONICAL written time, so scrubs at one comp
        // time coalesce iff they land on the same keyframe.
        `set:${trackId}:${prop}:${layerT}`,
      );
      return;
    }
    // One writer, which knows where a structured path stores its value — an
    // effect param, a path operator, a text animator — not just flat component
    // props. Rows whose base cannot be written carry no value field at all
    // (see `placeholderRow`), so a false here is a stale row, not a swallowed
    // edit.
    writeStaticPropertyValue(trackId, prop, value);
  };

  const handlePropertyValueChange = (trackId: string, prop: string, value: number): void => {
    const scrub = scrubRef.current;
    if (scrub && scrub.trackId === trackId && scrub.prop === prop) {
      const start = scrub.starts.get(propertyKey({ nodeId: trackId, prop }));
      if (start !== undefined) {
        const proportional = usePropertySelectionStore.getState().proportional;
        for (const { ref, value: v } of distributeScrub(scrub.entries, scrub.starts, value - start, proportional)) {
          writePropertyValue(ref.nodeId, ref.prop, v);
        }
        return;
      }
    }
    writePropertyValue(trackId, prop, value);
  };

  const handleKeyframeContextMenu = (kfId: string, x: number, y: number): void => {
    const ref = parseKeyframeId(kfId);
    if (!ref) return;

    // Check if current keyframe has hold or roving
    // If it's a grouped 'Position' property, we check 'x' as the representative.
    const checkProp = expandKeyframeProp(ref.prop)[0]!;
    const kfs = defaultAnimation.getTrackKeyframes(ref.nodeId, checkProp);
    const currentKf = kfs?.find((k) => Math.abs(k.t - ref.t) < 0.001);
    const isHold = currentKf?.easing === 'hold';
    const isRoving = currentKf?.roving === true;

    const props = expandKeyframeProp(ref.prop);

    // Easing entries act on the whole keyframe selection when the clicked
    // keyframe is part of it (AE behavior), else on just this keyframe.
    const selectedKfIds = useKeyframeSelectionStore.getState().ids;
    const easeTargets: string[] = selectedKfIds.has(kfId) ? [...selectedKfIds] : [kfId];
    const ease = (preset: EasingPreset) => () => applyEasingToKeyframes(easeTargets, preset);

    /**
     * Set one interpolation KIND on every expanded track of this keyframe.
     *
     * Not `applyEasingToKeyframes`: that maps AE's five preset NAMES onto
     * bezier handles, and Auto Bezier / Continuous Bezier are neither presets
     * nor handle shapes — they are engine easing kinds that the sampler
     * derives tangents for (`setEasing` seeds their default handles). Routing
     * them through the preset path would silently write a plain bezier and the
     * keyframe would stop auto-adjusting to its neighbours.
     */
    const setInterp = (kind: EasingKind, label: string) => () => {
      runAnimEdit(label, () => {
        for (const p of props) {
          if (defaultAnimation.isAnimated(ref.nodeId, p)) {
            defaultAnimation.setEasing(ref.nodeId, p, ref.t, kind);
          }
        }
      });
    };

    openContextMenu(x, y, [
      { id: 'easy-ease', label: 'Easy Ease', shortcut: 'F9', onSelect: ease('Ease') },
      { id: 'ease-in', label: 'Easy Ease In', shortcut: 'Shift+F9', onSelect: ease('EaseIn') },
      { id: 'ease-out', label: 'Easy Ease Out', shortcut: 'Ctrl+Shift+F9', onSelect: ease('EaseOut') },
      { id: 'linear', label: 'Linear Interpolation', onSelect: ease('Linear') },
      {
        /**
         * AE's Keyframe Interpolation submenu. The inspector row menu has had
         * an interpolation submenu since it shipped; the timeline diamond —
         * the surface people actually right-click — offered four flat easing
         * entries and a hold toggle, and no way to reach Auto or Continuous
         * Bezier at all despite both being live in the sampler.
         *
         * The flat "Enable/Disable Hold" and "Enable/Disable Roving" entries
         * moved IN here rather than being duplicated: both are interpolation
         * choices (roving decides whether the keyframe's time is authored or
         * solved for constant speed), and two doors to one toggle in one menu
         * is how a user ends up thinking they are two different things.
         */
        id: 'interpolation',
        label: 'Keyframe Interpolation',
        children: [
          { id: 'interp-linear', label: 'Linear', onSelect: setInterp('linear', 'Linear interpolation') },
          { id: 'interp-bezier', label: 'Bezier', onSelect: setInterp('bezier', 'Bezier interpolation') },
          { id: 'interp-auto', label: 'Auto Bezier', onSelect: setInterp('autoBezier', 'Auto bezier interpolation') },
          {
            id: 'interp-continuous',
            label: 'Continuous Bezier',
            onSelect: setInterp('continuousBezier', 'Continuous bezier interpolation'),
          },
          {
            // Toggles, because that is what the flat entry it replaces did:
            // choosing Hold on a keyframe that already holds is how you get
            // back to interpolating.
            id: 'interp-hold',
            label: isHold ? 'Hold ✓' : 'Hold',
            onSelect: isHold
              ? setInterp('linear', 'Disable hold keyframe')
              : setInterp('hold', 'Enable hold keyframe'),
          },
          { id: 'interp-sep', separator: true },
          {
            id: 'interp-roving',
            label: isRoving ? 'Rove Across Time ✓' : 'Rove Across Time',
            onSelect: () => {
              runAnimEdit(isRoving ? 'Disable roving keyframe' : 'Enable roving keyframe', () => {
                for (const p of props) {
                  if (defaultAnimation.isAnimated(ref.nodeId, p)) {
                    defaultAnimation.setRoving(ref.nodeId, p, ref.t, !isRoving);
                  }
                }
              });
            },
          },
        ],
      },
      {
        // The speed-graph maths was drag-only. A number you can type is the
        // whole reason AE ships this dialog — see KeyframeVelocityDialog.
        id: 'velocity',
        label: 'Keyframe Velocity…',
        onSelect: () => {
          if (!openKeyframeVelocityDialog(ref.nodeId, ref.prop, ref.t)) {
            useUIStore.getState().notify({
              level: 'info',
              message: 'A lone keyframe has no segment to shape.',
              durationMs: 2600,
            });
          }
        },
      },
      { id: 'sep-ease', separator: true },
      {
        // Navigation from the menu that is already open on a keyframe: the J/K
        // chords do this, but nothing said so anywhere a pointer can reach.
        id: 'goto-prev-kf',
        label: 'Go to Previous Keyframe',
        shortcut: 'J',
        onSelect: () => getTimelineController().goToPrevKeyframe(),
      },
      {
        id: 'goto-next-kf',
        label: 'Go to Next Keyframe',
        shortcut: 'K',
        onSelect: () => getTimelineController().goToNextKeyframe(),
      },
      { id: 'sep-nav', separator: true },
      {
        id: 'copy',
        label: `Copy Keyframe${easeTargets.length > 1 ? 's' : ''}`,
        shortcut: 'Ctrl+C',
        onSelect: () => copyKeyframes(new Set(easeTargets)),
      },
      {
        id: 'paste',
        label: 'Paste at Playhead',
        shortcut: 'Ctrl+V',
        onSelect: () => {
          const targets = useSelectionStore.getState().ids;
          if (targets.length > 0) pasteKeyframes(targets, getTimelineController().currentSeconds);
        },
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
  const handleClipTrim = (clipId: string, edge: 'start' | 'end', time: number, opts?: { ripple?: boolean }): void => {
    const c = getTimelineController();
    if (opts?.ripple && edge === 'end') c.rippleTrimClipEnd(clipId, time);
    else if (opts?.ripple && edge === 'start') c.rippleTrimClipStart(clipId, time);
    else c.trimClipTo(clipId, edge, time);
  };
  const handleClipSlip = (clipId: string, sourceInSec: number): void => {
    const c = getTimelineController();
    const layer = c.timeline.getLayer(clipId);
    if (!layer) return;
    const fps = c.timeline.getFrameRate().fps;
    const currentIn = layer.clip.sourceIn / fps;
    c.slipClip(clipId, sourceInSec - currentIn);
  };
  const handleClipSlide = (clipId: string, startSec: number): void => {
    const c = getTimelineController();
    const layer = c.timeline.getLayer(clipId);
    if (!layer) return;
    const fps = c.timeline.getFrameRate().fps;
    const currentStart = layer.clip.start / fps;
    c.slideClip(clipId, startSec - currentStart);
  };
  /**
   * Is there a clip after this one on the same track?
   *
   * "Close the gap" only means something if something can move into it — with
   * nothing later on the track it is an identical delete wearing a longer name,
   * which is half of what made two delete entries confusing.
   */
  const hasLaterClipOnTrack = (clipId: string): boolean => {
    const c = getTimelineController();
    const layer = c.timeline.getLayer(clipId);
    if (!layer) return false;
    const track = c.timeline.getTrack(layer.trackId);
    return !!track?.layers.some((l) => l.id !== clipId && l.start >= layer.end);
  };

  const handleClipContextMenu = (clipId: string, x: number, y: number): void => {
    const c = getTimelineController();
    const layer = c.timeline.getLayer(clipId);
    const nodeId = layer?.sourceId;
    const node = nodeId ? defaultSceneGraph.getNode(nodeId) : null;
    const tComp = node?.components.find((comp) => comp.type === 'Transform');
    const assetId = (tComp?.props?.assetId as string | undefined) ?? (tComp?.props?.__assetId as string | undefined);
    const asset = assetId ? useAssetStore.getState().assets.find((a) => a.id === assetId) : null;
    const time = nodeId ? getNodeLayerTime(nodeId) : null;

    /*
     * The cut this clip takes part in, if any.
     *
     * Addressed by SCENE NODE and searched across the whole comp, not along one
     * track, for the reason `clipCuts` documents at length: splitting clones the
     * node, so the two halves of a cut land on two ADJACENT ROWS rather than on
     * one, and a same-track search finds nothing at exactly the moment the user
     * has just made the cut they want to soften.
     *
     * The clip's OUT-point wins when it has neighbours on both sides. That is
     * the cut a right-click on a bar most often means — you reach for a
     * dissolve while thinking about where this shot ends — and offering both
     * would need two submenus that are indistinguishable in the menu.
     */
    const compBars = layer ? c.layersOfComp() : [];
    const others = compBars.filter((l) => l.sourceId && l.sourceId !== nodeId && l.id !== layer?.id);
    /*
     * "Abuts" is not enough on its own: once a cross dissolve is applied the two
     * bars OVERLAP by the transition's length, so a search for a seam finds
     * nothing at exactly the cut the user is right-clicking to remove one from.
     * A neighbour is therefore any bar that starts inside this one and carries
     * on past its end (or, before it, ends inside this one having started
     * earlier) — which covers the touching case and the overlapped one with the
     * same test. The nearest to the out-point (or in-point) wins.
     */
    const nearest = <T,>(list: T[], distance: (item: T) => number): T | undefined =>
      list.slice().sort((a, b) => distance(a) - distance(b))[0];
    const neighbourAfter = layer
      ? nearest(
          others.filter((l) => l.start > layer.start && l.start <= layer.end && l.end > layer.end),
          (l) => Math.abs(l.start - layer.end),
        )
      : undefined;
    const neighbourBefore = layer
      ? nearest(
          others.filter((l) => l.end < layer.end && l.end >= layer.start && l.start < layer.start),
          (l) => Math.abs(l.end - layer.start),
        )
      : undefined;
    const cut =
      nodeId && neighbourAfter?.sourceId
        ? { leftNodeId: nodeId, rightNodeId: neighbourAfter.sourceId }
        : nodeId && neighbourBefore?.sourceId
          ? { leftNodeId: neighbourBefore.sourceId, rightNodeId: nodeId }
          : null;
    const existingTransition = cut
      ? transitionAtCut(compIdForTransition(cut), cut.leftNodeId, cut.rightNodeId)
      : undefined;

    openContextMenu(x, y, [
      {
        id: 'split',
        label: 'Split Layer at Playhead (Ctrl+Shift+D)',
        onSelect: () => {
          c.splitClip(clipId, c.currentSeconds);
          bumpScene();
        },
      },
      {
        id: 'trim-in',
        label: 'Trim In to Playhead (Alt+[)',
        onSelect: () => {
          if (nodeId) c.trimSelectedStartToPlayhead([nodeId]);
          else c.trimClipTo(clipId, 'start', c.currentSeconds);
          bumpScene();
        },
      },
      {
        id: 'trim-out',
        label: 'Trim Out to Playhead (Alt+])',
        onSelect: () => {
          if (nodeId) c.trimSelectedEndToPlayhead([nodeId]);
          else c.trimClipTo(clipId, 'end', c.currentSeconds);
          bumpScene();
        },
      },
      {
        id: 'ripple-trim-out',
        label: 'Ripple Trim Out to Playhead',
        onSelect: () => {
          c.rippleTrimClipEnd(clipId, c.currentSeconds);
          bumpScene();
        },
      },
      {
        id: 'ripple-trim-in',
        label: 'Ripple Trim In to Playhead',
        onSelect: () => {
          c.rippleTrimClipStart(clipId, c.currentSeconds);
          bumpScene();
        },
      },
      {
        id: 'ripple-insert',
        label: 'Ripple Insert 1s Gap at Playhead',
        onSelect: () => {
          c.rippleInsertGapAt(clipId, c.currentSeconds, 1);
          bumpScene();
        },
      },
      { id: 'sep-time', separator: true },
      {
        id: 'time-stretch',
        label: 'Time Stretch…',
        disabled: !nodeId,
        onSelect: async () => {
          if (!nodeId || !time) return;
          const raw = await customPrompt('Time Stretch', 'Enter new stretch percentage (100% = original speed):', String(time.stretch));
          if (raw !== null) {
            const parsed = parseFloat(raw);
            if (!isNaN(parsed) && parsed >= 1 && parsed <= 1000) {
              updateNodeLayerTime(nodeId, { stretch: parsed });
              bumpScene();
            }
          }
        },
      },
      {
        id: 'time-reverse',
        label: time?.reverse ? 'Restore Forward Playback' : 'Time-Reverse Layer',
        disabled: !nodeId,
        onSelect: () => {
          if (!nodeId || !time) return;
          updateNodeLayerTime(nodeId, { reverse: !time.reverse });
          bumpScene();
        },
      },
      {
        id: 'freeze-frame',
        label: time?.freeze ? 'Unfreeze Frame' : 'Freeze Frame at Playhead',
        disabled: !nodeId,
        onSelect: () => {
          if (!nodeId || !time) return;
          if (time.freeze) {
            updateNodeLayerTime(nodeId, { freeze: false });
          } else {
            const fps = c.timeline.getFrameRate().fps;
            const clipStartSec = layer ? layer.start / fps : 0;
            const freezeAt = Math.max(0, c.currentSeconds - clipStartSec);
            updateNodeLayerTime(nodeId, { freeze: true, freezeTime: freezeAt });
          }
          bumpScene();
        },
      },
      ...(asset
        ? [
            { id: 'sep-footage', separator: true },
            {
              id: 'interpret-footage',
              label: 'Interpret Footage… (Ctrl+Alt+G)',
              onSelect: () => openInterpretFootage(asset),
            },
            // AE's Layer ▸ Scene Edit Detection. Video only: a still has no cuts.
            ...(asset.type === 'video' && nodeId
              ? [
                  {
                    id: 'scene-edit-markers',
                    label: 'Scene Edit Detection → Markers',
                    onSelect: () => void runSceneEditDetection(nodeId, 'markers'),
                  },
                  {
                    id: 'scene-edit-split',
                    label: 'Scene Edit Detection → Split Clips',
                    onSelect: () => void runSceneEditDetection(nodeId, 'split'),
                  },
                ]
              : []),
          ]
        : []),
      { id: 'sep-transition', separator: true },
      /*
       * Transitions.
       *
       * A submenu rather than four flat rows: the four kinds are variants of one
       * act, and flattening them would push five unrelated items apart in a menu
       * that is already long. Present-but-DISABLED when the clip has no
       * neighbour, rather than hidden — "why is there no transition command
       * here" is a question the greyed row answers and an absent one does not.
       */
      {
        id: 'add-transition',
        label: 'Add Transition',
        disabled: !cut,
        children: TRANSITION_KINDS.map((kind) => ({
          id: `add-transition-${kind}`,
          label: TRANSITION_LABEL[kind],
          onSelect: () => {
            if (!cut) return;
            void addTransition(
              cut.leftNodeId,
              cut.rightNodeId,
              kind,
              DEFAULT_TRANSITION_FRAMES,
              'centred',
            ).then((res) => {
              if (!res.ok) void customAlert('Transition', res.reason);
            });
          },
        })),
      },
      ...(existingTransition && cut
        ? [
            {
              id: 'remove-transition',
              label: `Remove ${TRANSITION_LABEL[existingTransition.kind]}`,
              onSelect: () => {
                void removeTransition(compIdForTransition(cut), existingTransition.id);
              },
            },
          ]
        : []),
      /*
       * The five timeline edit tools, reachable from the menu too.
       *
       * They already have a lit tool row and a Shift+letter chord each, and
       * both of those still leave the same gap the row was built to close: you
       * have to already know the family exists to look for it. A right-click on
       * the very bar these gestures act on is where someone asks "can I move
       * just the cut?", so the answer belongs there as well. `TIMELINE_EDIT_MODES`
       * is the one source for the labels and chords, so a mode cannot exist in
       * the row and not here.
       */
      {
        id: 'edit-mode',
        label: 'Timeline Tool',
        children: TIMELINE_EDIT_MODES.map((def) => ({
          id: `edit-mode-${def.mode}`,
          label: `${def.label}${getTimelineEditMode() === def.mode ? '  ✓' : ''}`,
          shortcut: def.chord,
          onSelect: () => setTimelineEditMode(def.mode),
        })),
      },
      { id: 'sep-del', separator: true },
      /*
       * Two deletes, and they have to read as genuinely different things.
       *
       * They used to be "Delete Clip (Del)" and "Ripple Delete Clip", which is
       * one word apart and looks like the same command twice — and NEITHER of
       * them deleted the layer. Both removed only the clip BAR, leaving the
       * scene node behind, so the timeline row stayed with nothing on it and
       * the next `syncFromScene` seeded it a fresh full-length bar. The layer
       * came back, which is why deleting from the Scene tree "worked" and
       * deleting from the timeline did not.
       *
       * Now both remove the layer for real. The only difference is what
       * happens to the TIME the layer occupied, which is what the labels say.
       */
      {
        id: 'delete',
        label: 'Delete Layer (Del)',
        danger: true,
        onSelect: () => c.deleteLayerForClip(clipId, { ripple: false }),
      },
      {
        id: 'ripple-delete',
        label: 'Delete Layer and Close Gap',
        danger: true,
        // Only meaningful when something later on the track can move left into
        // the space. Otherwise it is the entry above under a longer name.
        disabled: !hasLaterClipOnTrack(clipId),
        onSelect: () => c.deleteLayerForClip(clipId, { ripple: true }),
      },
    ]);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%', overflow: 'hidden' }}>

      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <EditorLayout
          topNav={<TopNav />}
          statusBar={
            <StatusBar
              left={
                <>
                  {/* Real state, not a hardcoded "Ready": amber while unsaved. */}
                  <span style={{ color: activeDirty ? 'var(--color-modified)' : 'var(--color-success)' }}>●</span>
                  <span>{activeDirty ? 'Unsaved changes' : 'Ready'}</span>
                  <span style={{ opacity: 0.4 }}>·</span>
                  <span>{tracks.length} layers</span>
                  {selectionCount > 0 ? (
                    <>
                      <span style={{ opacity: 0.4 }}>·</span>
                      <span>{selectionCount} selected</span>
                    </>
                  ) : null}
                  <span style={{ opacity: 0.4 }}>·</span>
                  <InfoReadout />
                </>
              }
              center={
                <button
                  type="button"
                  title="Composition settings"
                  onClick={() => openCompositionSettings()}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '2px 8px',
                    borderRadius: '4px',
                    backgroundColor: 'var(--color-surface-hover, rgba(255, 255, 255, 0.05))',
                    border: '1px solid var(--color-border)',
                    cursor: 'pointer',
                    font: 'inherit',
                    fontSize: '11px',
                    color: 'var(--color-text-primary)',
                    transition: 'border-color 0.1s, background-color 0.1s',
                  }}
                  onMouseOver={(e) => {
                    e.currentTarget.style.borderColor = 'var(--color-border-strong)';
                    e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.08)';
                  }}
                  onMouseOut={(e) => {
                    e.currentTarget.style.borderColor = 'var(--color-border)';
                    e.currentTarget.style.backgroundColor = 'var(--color-surface-hover, rgba(255, 255, 255, 0.05))';
                  }}
                >
                  <Icon name="layers" size="sm" style={{ color: 'var(--color-text-tertiary)' }} />
                  <span style={{ fontWeight: 500 }}>{activeTitle ?? 'Untitled'}</span>
                  <span style={{ fontFamily: 'var(--font-family-mono)', fontSize: '10px', color: 'var(--color-text-secondary)' }}>
                    {compWidth}×{compHeight} · {compFps}fps
                  </span>
                  {activeDirty ? (
                    <span
                      aria-label="Unsaved changes"
                      title="Unsaved changes"
                      style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--color-modified)' }}
                    />
                  ) : null}
                </button>
              }
              right={
                <>
                  <VUMeter />
                  {/* Timeline zoom. It had a 22px footer row to itself at the
                      bottom of the timeline panel, empty across its whole left
                      half; the status bar is already the strip for readouts you
                      glance at and occasionally poke. */}
                  <TimelineZoom />
                  <span style={{ opacity: 0.4 }}>·</span>
                  <FpsMeter />
                  <span style={{ opacity: 0.4 }}>·</span>
                  <StatusBarTimecode fps={compFps} startFrame={compStartFrame} />
                  <VideoHealth />
                  <span style={{ opacity: 0.4 }}>·</span>
                  <button
                    type="button"
                    onClick={() => openPalette()}
                    title="Search commands, layers, effects, presets…"
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                      padding: '2px 8px', borderRadius: 'var(--radius-full)',
                      background: 'var(--color-surface-2)', border: '1px solid var(--color-border)',
                      color: 'var(--color-text-secondary)', cursor: 'pointer', font: 'inherit',
                    }}
                  >
                    <Icon name="search" size="sm" />
                    Search
                    <kbd style={{
                      fontFamily: 'var(--font-family-mono)', fontSize: 'var(--font-size-micro)',
                      padding: '0 4px', borderRadius: 4, background: 'var(--color-surface-3)',
                      color: 'var(--color-text-secondary)',
                    }}>⌘⇧P</kbd>
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
              onWorkAreaChange={(start, end) => getTimelineController().setWorkArea(start, end)}
              onClipMove={handleClipMove}
              onClipTrim={handleClipTrim}
              onClipSlip={handleClipSlip}
              onClipSlide={handleClipSlide}
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
              onTrackMatteChange={(trackId, matte) => {
                setNodeMatte(trackId, matte);
                bumpScene();
              }}
              onTrackParentChange={(trackId, parentId, options) => {
                reparentNode(trackId, parentId, options);
                bumpScene();
              }}
              onTrackToggleFlag={(trackId, flag) => {
                const n = defaultSceneGraph.getNode(trackId);
                if (!n) return;
                // Each switch must write where the RENDERER reads. These used to
                // assign a top-level property on the node view, which the render
                // pipeline never consults — so the icon lit up and no pixel
                // changed, while the inspector's equivalent switch (writing the
                // `fx` component) changed pixels without lighting the icon.
                if (flag === 'preserveTransparency') {
                  setNodePreserveTransparency(trackId, !readNodePreserveTransparency(n));
                  bumpScene();
                  return;
                }
                if (flag === 'guide') {
                  const next = !isGuideLayer(trackId);
                  toggleGuideLayer(trackId);
                  notifyGuideLayerChange(next);
                  bumpScene();
                  return;
                }
                if (flag === 'threeD') {
                  // Honest gating: kinds the renderer can't project in 3D
                  // (groups/nulls/cameras/lights/solids/particles/audio) must
                  // not light a cube that changes no pixel.
                  if (!canBe3D(n)) {
                    useUIStore.getState().notify({
                      level: 'warning',
                      message: `3D isn't available for ${readNodeKind(n)} layers`,
                      durationMs: 2600,
                    });
                    return;
                  }
                  const next = !is3DEnabled(n);
                  set3DEnabled(trackId, next);
                  if (next) {
                    notifyCameraTipIfMissing((message, level) =>
                      useUIStore.getState().notify({ level, message, durationMs: 3200 }),
                    );
                  }
                } else if (flag === 'motionBlur') {
                  if (readNodeMotionBlur(n)) disableLayerMotionBlur(trackId, setNodeMotionBlur);
                  else enableLayerMotionBlurWithFeedback(trackId, setNodeMotionBlur);
                } else if (flag === 'adjustment') {
                  setAdjustmentWithFeedback(trackId, !readNodeAdjustment(n), setNodeAdjustment);
                } else if (flag === 'fxEnabled') {
                  setNodeFxEnabled(trackId, !readNodeFxEnabled(n));
                } else {
                  // `shy` is timeline-only state with no render meaning.
                  (n as any)[flag] = !(n as any)[flag];
                }
                bumpScene();
              }}
              onKeyframeSeek={handleKeyframeSeek}
              onKeyframeMove={handleKeyframeMove}
              onKeyframesDelete={handleKeyframesDelete}
              onKeyframeContextMenu={handleKeyframeContextMenu}
              onPropertyKeyframeToggle={handlePropertyKeyframeToggle}
              onPropertyStopwatch={handlePropertyStopwatch}
              onPropertyValue={handlePropertyValue}
              onPropertyValueChange={handlePropertyValueChange}
              onPropertyScrubStart={handlePropertyScrubStart}
              onPropertyScrubEnd={handlePropertyScrubEnd}
              selectedPropertyKeys={selectedPropertyKeys}
              onPropertySelect={handlePropertySelect}
              selectedTrackIds={selectedIds}
              expandedTrackIds={expandedIds}
              revealProps={revealFilter}
              onTrackToggleExpand={toggleExpand}
              onTrackActivate={handleTrackActivate}
              onClipMuteToggle={handleClipMuteToggle}
              onTrackRename={handleTrackRename}
              onTrackReorder={handleTrackReorder}
              onTrackColorChange={(trackId, color) => setNodeColor(trackId, color)}
            />
          }
          sidebarRenderers={getAllPanelRenderers()}
          inspectorRenderers={getAllPanelRenderers()}
        />
        {/* Consent, raised from anywhere: the sidebar, a detail tab or a
            premation:// link. Mounted once, at app level, so no install path
            can exist without it. */}
        <PluginConsentHost />
        {/* premation://plugin/<id> — focuses the Plugins panel and its tab. */}
        <PluginDeepLink />
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
