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
import { clampPps } from '@layout/Timeline/zoomAnchor';
import { Providers } from '@providers/Providers';
import { useLayoutStore, consumeLayoutMigration } from '@stores/layoutStore';
import { reconcileActiveWorkspace } from '@core/layout/workspaceManager';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import { type EasingPreset } from '@core/animation/keyframeAssistants';
import { applyEasingToKeyframes } from '@core/animation/keyframeAssistants';
import { copyKeyframes, pasteKeyframes } from '@core/animation/keyframeClipboard';
import { viewportFrameCache } from '@core/rendering/frameCache';
import { createViewportDiskCache } from '@core/rendering/frameDiskCache';
import { useKeyframeSelectionStore } from '@stores/keyframeSelectionStore';
import { useSceneRevision, bumpScene } from '@stores/sceneStore';
import { isMediaDecodeRepaint } from '@core/rendering/mediaRepaint';
import { useProjectStore } from '@stores/projectStore';
import { getTime as playheadNow } from '@stores/playbackClockStore';
import { usePlaybackClock } from '@layout/Timeline/usePlaybackClock';
import { useTimelineKeys } from '@layout/Timeline/useTimelineKeys';
import { clipRippleMenuItems } from '@layout/Timeline/clipEditCommands';
import { useSpaceTransport } from '@hooks/useSpaceTransport';
import { getTimelineController, getRemappedTime, compToKeyframeTime, keyframeToCompTime } from '@core/timeline/TimelineController';
import { staticOrDefaultValue, writeStaticPropertyValue } from '@core/inspector/propertyValue';
import { MASK_ANIM_PROP, buildStaticPropertyTree } from '@core/timeline/propertyTree';
import { PATH_ANIM_PROP, togglePathAnimation } from '@core/workspace/pathCommands';
import { modifiedPropertyRows } from '@core/animation/modifiedProps';
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
import { EditorLayout } from '@layout/EditorLayout';

import { EditorStatusBar } from '@layout/StatusBar';
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
  setTransition,
  transitionAtCut,
  compIdForTransition,
  DEFAULT_TRANSITION_FRAMES,
  TRANSITION_KINDS,
  TRANSITION_LABEL,
} from '@core/timeline/transitions';
import {
  TRANSITION_ALIGNMENTS,
  TRANSITION_ALIGNMENT_LABEL,
} from '@layout/Timeline/transitionOverlay';
import {
  TIMELINE_EDIT_MODES,
  setTimelineEditMode,
  getTimelineEditMode,
} from '@layout/Timeline/timelineEditMode';
import { useCompositionStore } from '@stores/compositionStore';
import { readNodeKind, flattenScene } from '@core/scene/sceneDerive';
import { toggleLayerAudioMute } from '@core/audio/audioLayerSwitches';
import { applyTimeStretch, isRetimableLayer, stretchValueOf } from '@core/animation/layerTimeCommands';
import { AUDIO_WAVEFORM_ROW } from '@core/timeline/propertyTree';
import { AUDIO_LEVEL_DB_PROP, AUDIO_PAN_PROP } from '@core/audio/audioParams';
import { openLayerOnDoubleClick } from '@layout/LayerViewer/openLayer';
import { setNodeBlend } from '@core/effects/blendMode';
import { setNodeMatte } from '@core/effects/matte';
import { reparentNode, moveNodeAdjacent } from '@core/scene/parenting';
import { renameLayer } from '@core/scene/renameLayer';
import { toggleLayerFlags } from '@core/scene/layerFlags';
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

/* The playhead RIGHT NOW is `playheadNow()` — `getTime` from the playback
 * clock store, read non-reactively. For event handlers: they fire at event
 * time, so a render-captured value buys them nothing — while a reactive
 * subscription in the shell re-rendered the whole editor tree every playback
 * frame just to keep that captured value fresh. The clock store is the live
 * authority during playback; the project store's copy lags by the 4Hz mirror.
 *
 * The ONE render-time consumer of the playhead in the shell is the status
 * bar's self-subscribing <StatusBarTimecode/> (`useCurrentTime`), isolated so
 * only that span re-renders per comp frame, not EditorShellInner. */
function EditorShellInner(): JSX.Element {
  const registerPanel = useLayoutStore((s) => s.registerPanel);
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
  // (The comp title / dirty flag used to be read here for the inlined status
  // bar; they now live in ProjectStatus + EditorTabs, which subscribe themselves.)
  const activeCompId = useProjectStore((s) => (s.activeTabId ? s.tabs[s.activeTabId]?.compositionId : undefined));
  // NO reactive playhead subscription here. `time` changes once per comp frame
  // during playback, and a subscription re-rendered this ~1355-line shell (and
  // reconciled its entire unmemoized return tree — TopNav, dock, timeline) on
  // every single frame, starving the main thread the renderer and the <video>
  // pipeline needed. The only render-time reader was the status-bar timecode
  // (now the self-subscribing <StatusBarTimecode/>); everything else that
  // needs the playhead is an EVENT HANDLER, which reads `playheadNow()` at
  // event time — non-reactive and always current.

  const compFps = useCompositionStore((s) => s.fps);
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
      registerPanel({ id: p.id, title: p.title, icon: p.icon, region: p.region, weight: p.weight, closable: p.closable, onDemand: p.onDemand });
      if (p.onDemand && !openBefore.has(p.id)) useLayoutStore.getState().closePanel(p.id);
    }
    // A pre-2026-09-15 layout was migrated at load (its tab lists dropped), so
    // the panels above registered into the new defaults. If the user had a
    // specialised builtin workspace active, put ITS panels back — Color should
    // still open on Scopes — rather than silently demoting them to Default.
    if (consumeLayoutMigration()) reconcileActiveWorkspace();
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
    return deriveTimelineTracks({ activeCompId, compFps, expandedIds, revs: { anim: animRev, clip: clipRev, marker: markerRev } });
  // `sceneRev` is deliberately NOT a dependency — `valueRev` is, and it IS
  // `sceneRev` gated on there being an expanded row to show a value on. Listing
  // the raw counter here as well defeated that gate completely: the memo ran on
  // every drag tick again, which is the cost the gate exists to avoid, and the
  // comment above went on describing a fix the deps array had cancelled.
  }, [graphRev, animRev, clipRev, markerRev, valueRev, compFps, expandedIds, activeCompId]);

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
    /*
      A RENAME that arrives as a value write. `node.name = …` beside a prop edit
      (the text tool naming a layer after what it says) announces `NodeUpdated`
      and nothing structural, so the tracks above — derived on `graphRev` — kept
      the old name: the Layers panel and the inspector read "PREMIUM" while the
      timeline row and its bar still read "Text". Names are compared per event,
      for the one node it names, so a slider drag costs a Map lookup and no more.
    */
    const names = new Map<string, string | undefined>();
    const nameSub = bus.on('NodeUpdated', ({ nodeId }) => {
      const name = defaultSceneGraph.getNode(nodeId)?.name;
      const known = names.has(nodeId);
      const before = names.get(nodeId);
      names.set(nodeId, name);
      // First sight of a node: compare against what the timeline is showing.
      const shown = known ? before : tracksRef.current.find((t) => t.id === nodeId)?.name;
      if (shown === undefined || shown === name) return;
      getTimelineController().syncFromScene();
      setGraphRev((v) => v + 1);
    });
    return () => {
      graphSub.dispose();
      animSub.dispose();
      nameSub.dispose();
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
  /**
   * Toggle a layer's solo. `exclusive` is AE's Alt+click — "turn off all other
   * solo switches", which leaves this layer the only one soloed. Solo covers
   * picture AND sound in AE, and `voicesOf` in audioScene already silences
   * non-soloed voices, so this one flag drives both.
   */
  const toggleTrackSolo = (trackId: string, exclusive = false): void => {
    const node = defaultSceneGraph.getNode(trackId);
    if (!node) return;
    if (exclusive) {
      // Alt+click a lit switch clears everything (nothing soloed); Alt+click an
      // unlit one isolates it. Either way every OTHER switch goes dark.
      const only = !node.solo;
      runDocumentEdit(only ? 'Solo only this layer' : 'Clear all solos', () => {
        for (const n of flattenScene(defaultSceneGraph)) {
          if (n.solo) n.solo = false;
        }
        if (only) node.solo = true;
        bumpScene();
      });
      return;
    }
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
  const handleZoom = useCallback((next: number, anchorSeconds?: number): void => {
    const c = getTimelineController();
    // Anchor on the point the gesture was aimed at, falling back to the
    // playhead when there was none (a slider, a keyboard zoom).
    c.setPixelsPerSecond(clampPps(next), anchorSeconds ?? c.currentSeconds);
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
    //   UU  → toggle *modified* properties (animated, expressed, or set away
    //         from the default) — see `modifiedProps.ts`
    //   P/S/R/T/A → position / scale / rotation / opacity / anchor
    //   M / F / MM → mask shape / mask feather / all mask properties
    //   E   → effects
    //   L / LL → audio levels / waveform
    //   Shift+<key> → ADD that property to what is already revealed
    // Each list names every row id that property can appear as: the raw engine
    // props, the merged 'Position' pseudo-row, and the static '__static:*'
    // placeholder shown before any keyframes exist.
    //
    // Masks: the shape is ONE whole-mask track (`setMaskAnim` stores
    // snapshots); feather / opacity / expansion are per-path tracks
    // (`mask.<pathId>.<key>`, see maskPropPath). M = shape, F = feather rows,
    // MM = every mask row the property tree lists.
    const REVEAL: Record<string, ReadonlyArray<string>> = {
      p: ['x', 'y', 'z', POSITION_PSEUDO_PROP, '__static:position'],
      s: ['scale', 'scaleX', 'scaleY', '__static:scale'],
      r: ['rotation', 'rotationX', 'rotationY', '__static:rotation'],
      t: ['opacity', '__static:opacity'],
      m: [MASK_ANIM_PROP, 'mask'],
      f: [MASK_ANIM_PROP, 'mask.feather'],
      a: ['anchorX', 'anchorY', '__static:anchor'],
      // AE's L = "show only Audio Levels". This named the GROUP key ('audio'),
      // but the filter matches on a row's `prop` — so L expanded the layer and
      // then hid every row, which looked like the layer had no audio at all.
      // Both the dB track and the legacy video-layer percent are listed, so a
      // project saved before the dB migration still reveals its level.
      l: [AUDIO_LEVEL_DB_PROP, AUDIO_PAN_PROP, 'audioLevel'],
    };

    // AE's LL — a second L within the double-tap window swaps the Audio group
    // for the waveform alone. Handled here rather than in ShortcutManager's
    // UU path because single L never was a command: it is this listener.
    const DOUBLE_TAP_MS = 400;
    let lastL = 0;
    let lastM = 0;

    /** Rows derived from the property TREE — the model only builds rows for expanded tracks. */
    const effectRows = (ids: readonly string[]): string[] => [
      ...new Set(ids.flatMap((id) => buildStaticPropertyTree(id).filter((r) => r.group === 'effects').map((r) => r.prop))),
    ];
    const allMaskRows = (ids: readonly string[]): string[] => [
      ...new Set([MASK_ANIM_PROP, ...ids.flatMap((id) => buildStaticPropertyTree(id).filter((r) => r.group === 'masks').map((r) => r.prop))]),
    ];
    /** Shift+U: the animated rows, spelled the way the timeline draws them. */
    const animatedRows = (ids: readonly string[]): string[] => {
      const rows = new Set<string>();
      for (const id of ids) {
        const separated = defaultSceneGraph.getNode(id)?.components.find((c) => c.type === 'Transform')?.props.separateDimensions === true;
        for (const p of defaultAnimation.animatedProps(id)) {
          if (!separated && (p === 'x' || p === 'y' || p === 'z')) rows.add(POSITION_PSEUDO_PROP);
          else rows.add(p);
        }
      }
      return [...rows];
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
      const rawTime = playheadNow();
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

      // Bare 'u' is the registry command (CommandSystem → RevealAnimatedProps);
      // only Shift+U — add animated props to the reveal — lands here.
      const isReveal = REVEAL[key] !== undefined || key === 'e' || (key === 'u' && e.shiftKey);
      if (!isReveal) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // Expand the selection and switch which props are shown.
      const sel = useSelectionStore.getState().ids;
      if (sel.length === 0) return;
      let rows: ReadonlyArray<string> =
        key === 'e' ? effectRows(sel)
        : key === 'u' ? animatedRows(sel)
        // F: the per-path `mask.<pathId>.feather` rows (plus the shape row).
        : key === 'f' ? allMaskRows(sel).filter((p) => p === MASK_ANIM_PROP || p.endsWith('.feather'))
        : REVEAL[key]!;
      if (key === 'm' && !e.shiftKey) {
        // AE's MM: a second M within the double-tap window reveals every mask
        // property; a third falls back to the shape alone.
        const now = Date.now();
        if (now - lastM < DOUBLE_TAP_MS) {
          rows = allMaskRows(sel);
          lastM = 0;
        } else {
          lastM = now;
        }
      }
      if (rows.length === 0) return;
      e.preventDefault();
      if (e.shiftKey) {
        // AE's Shift+<reveal key>: ADD to what is revealed rather than replace.
        const add = rows;
        setRevealFilter((cur) => (cur === null ? add : [...new Set([...cur, ...add])]));
        setExpandedIds((cur) => [...new Set([...cur, ...sel])]);
        return;
      }
      if (key === 'l') {
        const now = Date.now();
        // LL shows only the waveform; a third L within the window falls back to
        // the group, so the pair toggles rather than sticking on the waveform.
        if (now - lastL < DOUBLE_TAP_MS) {
          rows = [AUDIO_WAVEFORM_ROW];
          lastL = 0;
        } else {
          lastL = now;
        }
      }
      setRevealFilter(rows);
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

      if (mode === 'modified') {
        // AE's UU: animated, expressed, OR set away from the default — read
        // from the scene and engine, not the model (which only builds rows for
        // expanded tracks and cannot see an un-keyed 50 % scale).
        const withRows = targetIds
          .map((id) => ({ id, rows: modifiedPropertyRows(id) }))
          .filter((v) => v.rows.length > 0);
        const filter = new Set<string>();
        for (const v of withRows) for (const r of v.rows) filter.add(r);
        setRevealFilter(filter.size > 0 ? [...filter] : null);
        setExpandedIds((cur) => {
          const revealed = targetIds.every((id: string) => cur.includes(id));
          const set = new Set(cur);
          if (revealed) for (const id of targetIds) set.delete(id);
          else for (const v of withRows) set.add(v.id);
          return [...set];
        });
        return;
      }

      if (mode === 'animated') {
        /*
          Read the ENGINE, as `force` does. The model only builds property rows
          for tracks that are already EXPANDED, so asking it which props a
          COLLAPSED layer animates — the one case U exists for — always answered
          "none": select a keyframed camera, press U, nothing happened. The
          model rows are kept as a second source for anything the engine does
          not list (data tracks the model surfaces).
        */
        const enginePropsOf = (id: string): string[] => {
          const node = defaultSceneGraph.getNode(id);
          const separated = node?.components.find((c) => c.type === 'Transform')?.props.separateDimensions === true;
          const out = new Set<string>(animatedProps(id).map((p) => p.prop));
          for (const p of defaultAnimation.animatedProps(id)) {
            if (!separated && (p === 'x' || p === 'y' || p === 'z')) out.add(POSITION_PSEUDO_PROP);
            else out.add(p);
          }
          return [...out];
        };
        const propsById = new Map(targetIds.map((id) => [id, enginePropsOf(id)] as const));
        const animatedInTarget = targetIds.filter((id) => (propsById.get(id)?.length ?? 0) > 0);
        // Filter the revealed rows to the animated ones (AE's U shows only
        // keyframed properties; the chevron twirl shows the whole tree).
        const filter = new Set<string>();
        for (const id of animatedInTarget) for (const p of propsById.get(id) ?? []) filter.add(p);
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

  // A Shift span or a lane marquee arrives already resolved — the timeline is
  // the only thing that knows the row order a span runs along.
  const handleTrackSelectMany = (trackIds: ReadonlyArray<string>): void => {
    setSelected([...trackIds]);
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
    const edit = toggleLayerAudioMute(nodeId);
    if (!edit) return;
    runDocumentEdit(edit.label, () => {
      edit.apply();
      bumpScene();
    });
  };

  const handleTrackActivate = (trackId: string): void => {
    const node = defaultSceneGraph.getNode(trackId);
    if (!node) return;
    // AE: double-clicking a layer opens it — a comp instance its source comp
    // (with the navigator trail and the playhead carried across), a group its
    // own subtree, footage and solids the Layer panel — per the two "Opening
    // Layers with Double-click" preferences. See openLayer.ts.
    if (openLayerOnDoubleClick(trackId)) return;
    // A comp instance whose source is gone opens nothing; isolating its empty
    // card would read as a bug.
    if (readNodeKind(node) === 'comp') return;
    focusIsolate(trackId);
    setSelected([trackId]);
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
    // A shape's Path row: a whole-outline data track, like the mask row above.
    if (props[0] === PATH_ANIM_PROP) {
      togglePathAnimation(trackId);
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
  // A multi-row drag or a stagger: one undo entry for the whole gesture.
  const handleClipMoveMany = (
    moves: ReadonlyArray<{ clipId: string; start: number }>,
    label?: string,
  ): void => {
    getTimelineController().setClipStarts(
      moves.map((m) => ({ layerId: m.clipId, startSeconds: m.start })),
      label,
    );
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
      { id: 'sep-remove', separator: true },
      /*
       * Ripple Delete / Lift / Extract.
       *
       * Built by `clipRippleMenuItems` rather than spelled out here: the three
       * differ only in whether the gap closes, and that distinction is worth
       * exactly one home. See `layout/Timeline/clipEditCommands.ts` — the same
       * module registers the commands behind them, so the palette, the menus
       * and Shift+Delete cannot drift apart from this menu.
       */
      ...clipRippleMenuItems(clipId, bumpScene),
      { id: 'sep-time', separator: true },
      {
        id: 'time-stretch',
        label: 'Time Stretch…',
        disabled: !nodeId,
        onSelect: async () => {
          if (!nodeId || !time) return;
          const raw = await customPrompt('Time Stretch', 'Enter new stretch percentage (100% = original speed):', String(stretchValueOf(nodeId)));
          if (raw !== null) {
            const parsed = parseFloat(raw);
            // The shared path: footage changes rate; any other layer bakes bar,
            // keys and markers (negative = reverse). One undo step either way.
            const allowed = isRetimableLayer(nodeId) ? parsed >= 1 : parsed !== 0;
            if (!isNaN(parsed) && allowed && Math.abs(parsed) <= 1000) {
              void applyTimeStretch([nodeId], parsed, 'in');
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
            /*
             * Alignment — where the transition sits relative to the cut.
             *
             * The record has carried this since transitions shipped and every
             * entry point wrote 'centred', so the other two placements existed
             * only in the type. A submenu of three named values next to the
             * bracket's click-to-cycle: the same property, picked rather than
             * stepped, for when you know which one you want. One undo entry
             * each, because `setTransition` re-materializes the transition
             * inside a single history entry.
             */
            {
              id: 'transition-alignment',
              label: 'Alignment',
              children: TRANSITION_ALIGNMENTS.map((alignment) => ({
                id: `transition-alignment-${alignment}`,
                label: `${TRANSITION_ALIGNMENT_LABEL[alignment]}${
                  existingTransition.alignment === alignment ? '  ✓' : ''
                }`,
                onSelect: () => {
                  if (existingTransition.alignment === alignment) return;
                  void setTransition(compIdForTransition(cut), existingTransition.id, {
                    alignment,
                  }).then((res) => {
                    if (!res.ok) void customAlert('Transition', res.reason);
                  });
                },
              })),
            },
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
          statusBar={<EditorStatusBar layerCount={tracks.length} />}
          timeline={
            <BottomTimeline
              model={timelineModel}
              onScrub={handleScrub}
              onWorkAreaChange={(start, end) => getTimelineController().setWorkArea(start, end)}
              onClipMove={handleClipMove}
              onClipMoveMany={handleClipMoveMany}
              onClipTrim={handleClipTrim}
              onClipSlip={handleClipSlip}
              onClipSlide={handleClipSlide}
              onClipContextMenu={handleClipContextMenu}
              onScroll={(px) => getTimelineController().setScrollPixels(px)}
              onZoom={handleZoom}
              onTrackSelect={handleTrackSelect}
              onTrackSelectMany={handleTrackSelectMany}
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
                // The switch VERBS live in `@core/scene/layerFlags`, beside the
                // graph they write. They used to be spelled out right here —
                // which is where the TIMELINE happens to draw its switches, so
                // the Layers panel could not offer the same switch without a
                // second copy, and `CompositingSection` and `SelectionHeader`
                // already had two more. One set of verbs, three sets of buttons.
                //
                // `collapse` is the exception: `TrackHeaderColumn` calls
                // `toggleCollapseSwitch` on its own because the switch means two
                // different things by layer kind (Collapse Transformations on a
                // comp, Continuous Rasterize on a vector), so it never arrives.
                if (flag === 'collapse') return;
                toggleLayerFlags([trackId], flag, trackId);
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
