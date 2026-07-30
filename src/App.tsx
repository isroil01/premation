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
import { type EasingPreset } from '@core/animation/keyframeAssistants';
import { applyEasingToSelection } from '@core/animation/easingSelection';
import { applyEasingToKeyframes } from '@core/animation/keyframeAssistants';
import { copyKeyframes, pasteKeyframes } from '@core/animation/keyframeClipboard';
import { viewportFrameCache } from '@core/rendering/frameCache';
import { useKeyframeSelectionStore } from '@stores/keyframeSelectionStore';
import { useSceneRevision, bumpScene } from '@stores/sceneStore';
import { VIDEO_AUDIO_MUTED_PROP } from '@core/audio/audioScene';
import { useProjectStore } from '@stores/projectStore';
import { usePlaybackClock } from '@layout/Timeline/usePlaybackClock';
import { useTimelineKeys } from '@layout/Timeline/useTimelineKeys';
import { useSpaceTransport } from '@hooks/useSpaceTransport';
import { getTimelineController, getRemappedTime, compToKeyframeTime, keyframeToCompTime } from '@core/timeline/TimelineController';
import {
  resolvePropertyMeta,
  propertyLabel,
  propertyOrder,
  groupPlaceholderPath,
} from '@core/inspector/propertyMeta';
import { Icon } from '@components/Icon';
import { EditorLayout } from '@layout/EditorLayout';

import { StatusBar } from '@layout/StatusBar';
import { getEventBus } from '@core/events/EventBus';
import { BottomTimeline } from '@layout/BottomTimeline';
import { TopNav } from '@layout/TopNav';
import { AiChatProvider } from '@layout/AiChat/AiChatContext';
import { getAllPanelRenderers } from '@layout/EditorLayout/DemoPanels';
import { PANEL_DEFS } from '@layout/EditorLayout/panelDefs';
import type { TimelineModel, TimelineTrack, TimelinePropertyTrack, TimelineClip } from '@layout/Timeline';
import type { TrackId } from '@app-types/common';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import {
  defaultAnimation,
  makeKeyframeId,
  parseKeyframeId,
  expandKeyframeProp,
  POSITION_PSEUDO_PROP,
} from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import { useCompositionStore } from '@stores/compositionStore';
import { readNodeKind, KIND_COLOR, KIND_ICON, KIND_FILL } from '@core/scene/sceneDerive';
import { readCompRef } from '@core/scene/compInstance';
import { getNodeBlend, setNodeBlend } from '@core/effects/blendMode';
import { getNodeMatte, setNodeMatte } from '@core/effects/matte';
import { readNodeFxEnabled, setNodeFxEnabled } from '@core/effects/effects';
import { readNodeMotionBlur, setNodeMotionBlur } from '@core/effects/motionBlur';
import { readNodeAdjustment, setNodeAdjustment } from '@core/effects/adjustment';
import { reparentNode, moveNodeAdjacent } from '@core/scene/parenting';
import { is3DEnabled, set3DEnabled, canBe3D } from '@core/scene/threeD';
import { notifyCameraTipIfMissing } from '@core/workspace/cameraNav';
import { openPalette } from '@stores/commandPaletteStore';
import { AccountButton } from '@layout/Auth/AccountButton';
import { openCompositionSettings } from '@layout/Composition/CompositionSettingsDialog';
import { FpsMeter } from '@layout/StatusBar/FpsMeter';
import { InfoReadout } from '@layout/StatusBar/InfoReadout';
import { VUMeter } from '@layout/StatusBar/VUMeter';
import { useFocusStore } from '@stores/focusStore';
import { useFocusContext } from '@layout/focus/useFocusContext';
import { openContextMenu } from '@stores/contextMenuStore';
import { useResponsiveLayout } from '@hooks/useResponsiveLayout';
import type { TimelineKeyframeRef } from '@layout/Timeline';
import type { KeyId, NodeId } from '@app-types/common';
import { updateNodeComponentProp } from '@core/inspector/InspectorAPI';
import { usePreferenceStore } from '@stores/preferenceStore';

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
  const node = defaultSceneGraph.getNode(nodeId);
  if (node) {
    for (const c of node.components) {
      const v = (c.props as Record<string, unknown>)[prop];
      if (typeof v === 'number') return v;
    }
    if (prop === 'x') return node.transform.position.x;
    if (prop === 'y') return node.transform.position.y;
  }
  const DEFAULTS: Record<string, number> = { scaleX: 1, scaleY: 1, opacity: 100 };
  return DEFAULTS[prop] ?? 0;
}

/** Times within this many seconds of each other are the same keyframe. */
const KEYFRAME_EPSILON = 1e-4;

function getNodeColor(node: any): string | undefined {
  return node.color ?? KIND_COLOR[readNodeKind(node)];
}

function setNodeColor(nodeId: string, color: string): void {
  const node = defaultSceneGraph.getNode(nodeId as any);
  if (!node) return;
  (node as any).color = color;
  bumpScene();
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

function EditorShellInner(): JSX.Element {
  const registerPanel = useLayoutStore((s) => s.registerPanel);
  const selectionCount = useSelectionStore((s) => s.ids.length);
  const selectedIds = useSelectionStore((s) => s.ids);
  const setSelected = useSelectionStore((s) => s.set);
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
  const activeTime = useProjectStore((s) => s.activeTabId ? (s.tabs[s.activeTabId]?.time ?? 0) : 0);
  
  const compFps = useCompositionStore((s) => s.fps);
  const compWidth = useCompositionStore((s) => s.width);
  const compHeight = useCompositionStore((s) => s.height);
  const compStartFrame = useCompositionStore((s) => s.startFrame);
  const compDuration = useCompositionStore((s) => s.durationSeconds);

  const focusIsolate = useFocusStore((s) => s.isolate);
  const { activeSet } = useFocusContext();
  
  // Enable responsive UI auto-collapsing behaviors
  useResponsiveLayout();

  // Context-aware auto-switching inspector panel on selection
  const lastSelectedNodeRef = useRef<string | null>(null);
  useEffect(() => {
    if (selectedIds.length === 0) {
      lastSelectedNodeRef.current = null;
      return;
    }
    const primaryId = selectedIds[0];
    if (!primaryId || primaryId === lastSelectedNodeRef.current) return;
    lastSelectedNodeRef.current = primaryId;

    const node = defaultSceneGraph.getNode(primaryId as any);
    if (!node) return;
    const kind = readNodeKind(node);

    // Only ever open a tab the current one CANNOT serve — never move the user off
    // a tab that still applies.
    //
    // This used to force 'style' for text and 'properties' for everything else on
    // every selection change, so reading Transform and clicking a text layer
    // yanked you to Style; adjusting a fill and clicking the next shape yanked you
    // back. Both target tabs are valid for both kinds, so the switch was pure
    // disruption. Kinds with a genuinely dedicated home (camera/light live in
    // Settings) are the only case worth acting on, and only when the active tab
    // has nothing to show for them.
    const active = useLayoutStore.getState().activePanelByRegion.rightInspector;
    const NEEDS_SETTINGS = kind === 'camera' || kind === 'light' || kind === 'particle';
    if (NEEDS_SETTINGS && active !== 'misc') {
      useLayoutStore.getState().openPanel('misc');
    }
  }, [selectedIds]);

  // Register the default panels exactly once.
  useEffect(() => {
    // Registrations come from the SHARED registry (panelDefs.ts) so a pop-out
    // window can resolve the same titles/icons — it renders PopoutRoute, never
    // EditorShell, so it never runs this effect and used to show a raw id.
    // On-demand panels are registered (so menus/shortcuts can open them) then
    // closed unless a persisted layout already had them open.
    const openBefore = new Set(Object.values(useLayoutStore.getState().panelOrder).flat());
    for (const p of PANEL_DEFS) {
      registerPanel({ id: p.id, title: p.title, icon: p.icon, region: p.region, weight: p.weight, closable: p.closable });
      if (p.onDemand && !openBefore.has(p.id)) useLayoutStore.getState().closePanel(p.id);
    }
  }, [registerPanel]);


  // Bumped when the engine's layers/clips change (add/remove/move/trim/split),
  // so the derived clip bars stay in sync.
  const [clipRev, setClipRev] = useState(0);

  const [expandedIds, setExpandedIds] = useState<ReadonlyArray<string>>([]);

  // Re-read engine markers + work area when they change (add/remove, in/out).
  // Declared here rather than beside its effect because the track model reads
  // layer markers, so it has to re-derive when one is added or removed.
  const [markerRev, setMarkerRev] = useState(0);

  // Timeline tracks derived from the scene graph — one track per node, in
  // layer order. Clip bars come from the Timeline Engine's layers for that node.
  const tracks = useMemo<TimelineTrack[]>(() => {
    void sceneRev;
    void clipRev;
    void markerRev;
    const controller = getTimelineController();
    const compId = activeCompId || 'comp_root';

    const result: TimelineTrack[] = [];

    const traverse = (parentId: string, depth: number) => {
      // AE stacking convention: the TOP timeline row is the FRONT-most layer.
      // Children render in order (last child drawn last = front), so rows list
      // them reversed. Before this, the top row was the BACK-most layer and a
      // newly-inserted layer appeared at the bottom — inverted muscle memory.
      const nodes = [...defaultSceneGraph.getChildren(parentId)].reverse();
      for (const node of nodes) {
        const kind = readNodeKind(node);
        // Per-property sub-tracks (revealed when the layer is expanded).
      let properties: TimelinePropertyTrack[] = defaultAnimation
        .tracksFor(node.id)
        .map((track) => ({
          prop: track.prop,
          // Label and unit both come from the property registry, resolved with
          // this node so `effect.<id>.<key>` reads "Glow Radius" and not its
          // raw path.
          label: propertyLabel(track.prop, node.id),
          keyframes: track.keyframes.map((kf, kfIndex, all) => ({
            id: makeKeyframeId(node.id, track.prop, kf.t) as KeyId,
            nodeId: node.id as NodeId,
            // Diamonds draw at the comp time where the renderer actually
            // applies the keyframe — the canonical inverse, which honors
            // trim/sourceIn, the active clip, stretch and precomp remaps.
            time: keyframeToCompTime(node.id, kf.t, track.prop),
            roving: kf.roving,
            // Both spellings: Easy Ease → Hold writes 'step' on a scalar track,
            // so checking only 'hold' meant a held keyframe never drew as one.
            isHold: kf.easing === 'hold' || kf.easing === 'step',
            // The glyph is drawn as two halves, so it needs BOTH sides. The
            // engine stores easing on the segment that starts at a keyframe, so
            // the incoming side is the previous keyframe's.
            easeIn: all[kfIndex - 1]?.easing,
            easeOut: kf.easing,
            isFirst: kfIndex === 0,
            isLast: kfIndex === all.length - 1,
          })),
          // A real (animated) row edits its own prop — one field, so the value
          // can be changed here rather than only in the inspector.
          valueProps: [track.prop],
          valueUnit: resolvePropertyMeta(track.prop, node.id).unit || undefined,
          // The row's stopwatch toggles exactly what its fields edit.
          stopwatchProps: [track.prop],
        }));
        
      // Non-scalar (data) tracks: Source Text, gradient stops, path points.
      // Diamond-only rows — there is no numeric value to scrub; the stopwatch
      // key is the data prop so the reveal/expand machinery treats them like
      // any other animated row.
      for (const dt of defaultAnimation.dataTracksFor(node.id)) {
        if (dt.keyframes.length === 0) continue;
        properties.push({
          prop: dt.prop,
          label: propertyLabel(dt.prop, node.id),
          keyframes: dt.keyframes.map((kf, kfIndex, all) => ({
            id: makeKeyframeId(node.id, dt.prop, kf.t) as KeyId,
            nodeId: node.id as NodeId,
            time: keyframeToCompTime(node.id, kf.t, dt.prop),
            // `text` can never tween, so its rows are always hold. Otherwise
            // report the keyframe's own curve — data keyframes carry easing
            // exactly like scalar ones, so the diamond must draw it or Easy
            // Ease on a puppet pin would apply with no visible feedback.
            isHold: dt.kind === 'text' || kf.easing === 'hold' || kf.easing === 'step' || undefined,
            easeIn: all[kfIndex - 1]?.easing,
            easeOut: kf.easing,
            isFirst: kfIndex === 0,
            isLast: kfIndex === all.length - 1,
          })),
          stopwatchProps: [dt.prop],
        });
      }

      const separated = node.components.find((c) => c.type === 'Transform')?.props.separateDimensions === true;
      if (!separated) {
        const posProps = properties.filter(p => p.prop === 'x' || p.prop === 'y' || p.prop === 'z');
        if (posProps.length > 0) {
          properties = properties.filter(p => p.prop !== 'x' && p.prop !== 'y' && p.prop !== 'z');
          const mergedKfs = new Map<number, TimelineKeyframeRef>();
          for (const pt of posProps) {
            for (const kf of pt.keyframes) {
              if (!mergedKfs.has(kf.time)) {
                // The id must carry the STORED keyframe time, like every
                // per-property row — `kf.time` is absolute. The source row's id
                // already encodes the exact stored time, so lift it from there
                // rather than round-tripping through the (frame-quantizing)
                // inverse conversion.
                const layerT = parseKeyframeId(kf.id)?.t ?? compToKeyframeTime(node.id, kf.time);
                mergedKfs.set(kf.time, {
                  ...kf,
                  id: makeKeyframeId(node.id, POSITION_PSEUDO_PROP, layerT) as KeyId,
                });
              }
            }
          }
          properties.unshift({
            prop: POSITION_PSEUDO_PROP,
            label: propertyLabel(POSITION_PSEUDO_PROP),
            keyframes: Array.from(mergedKfs.values()).sort((a, b) => a.time - b.time),
            // The merged Position row edits the two real props behind it.
            valueProps: ['x', 'y'],
            valueUnit: resolvePropertyMeta(POSITION_PSEUDO_PROP).unit || undefined,
            stopwatchProps: ['x', 'y'],
          });
        }
      }

      // AE-style static property tree: every transformable layer always
      // exposes its Transform group in the timeline — even with zero
      // keyframes — so animation can START here (twirl open → stopwatch),
      // not only from the inspector. Placeholder rows carry animated:false
      // and the engine props their stopwatch keys.
      const hasTransform = node.components.some((c) => c.type === 'Transform');
      const hasStyle = node.components.some((c) => c.type === 'Style' || c.type === 'Text');
      if (hasTransform && kind !== 'audio') {
        const has = (...props: string[]) => properties.some((p) => props.includes(p.prop));
        const placeholders: TimelinePropertyTrack[] = [];
        // Label, unit and sort position all come from the property registry —
        // the placeholder only decides WHICH real props it stands for.
        const placeholder = (key: string, stopwatchProps: string[]) => {
          const path = groupPlaceholderPath(key);
          const meta = resolvePropertyMeta(path);
          placeholders.push({ prop: path, label: meta.label, keyframes: [], animated: false, stopwatchProps,
            // A static row is still editable: AE lets you set a value before
            // keyframing, and the props it would key are the props it edits.
            valueProps: stopwatchProps, valueUnit: meta.unit || undefined });
        };
        const is3DNode = is3DEnabled(node);
        if (kind !== 'camera' && !has('anchorX', 'anchorY', 'anchorZ')) {
          placeholder('anchor', is3DNode ? ['anchorX', 'anchorY', 'anchorZ'] : ['anchorX', 'anchorY']);
        }
        if (!has(POSITION_PSEUDO_PROP, 'x', 'y', 'z')) {
          placeholder('position', is3DNode || kind === 'camera' ? ['x', 'y', 'z'] : ['x', 'y']);
        }
        if (kind !== 'camera' && !has('scale', 'scaleX', 'scaleY', 'scaleZ')) {
          placeholder('scale', is3DNode ? ['scaleX', 'scaleY', 'scaleZ'] : ['scaleX', 'scaleY']);
        }
        if (kind !== 'camera' && !has('rotation', 'rotationX', 'rotationY', 'orientationX', 'orientationY', 'orientationZ')) {
          placeholder('rotation', is3DNode ? ['rotation', 'rotationX', 'rotationY'] : ['rotation']);
        }
        if (is3DNode && kind !== 'camera' && !has('orientationX', 'orientationY', 'orientationZ')) {
          placeholder('orientation', ['orientationX', 'orientationY', 'orientationZ']);
        }
        if (hasStyle && !has('opacity')) placeholder('opacity', ['opacity']);
        // Stable-sort into AE's canonical Transform order (Anchor → Position →
        // Scale → Rotation → Orientation → Opacity), leaving non-transform rows
        // after them in their original relative order. The order lives on each
        // property's registry entry, so a new property sorts itself.
        properties = [...placeholders, ...properties].sort(
          (a, b) => propertyOrder(a.prop, node.id) - propertyOrder(b.prop, node.id),
        );
      }

      // Flat union of all keyframes (collapsed summary row).
      const keyframes: TimelineKeyframeRef[] = properties.flatMap((p) => p.keyframes);
      // The asset a clip's waveform is drawn from. Audio layers carry it on
      // their Audio component; a VIDEO layer's own track hangs off the same
      // asset as its picture, so the bar can show the sound it will actually
      // play — cutting to a beat was otherwise guesswork.
      const audioComp = node.components.find((c) => c.type === 'Audio');
      const mediaAssetId =
        (audioComp?.props?.__assetId as string | undefined) ??
        (node.components.find((c) => typeof (c.props as Record<string, unknown>)?.assetId === 'string')
          ?.props as Record<string, unknown> | undefined)?.assetId as string | undefined;
      const waveAssetId = kind === 'audio' || kind === 'video' ? mediaAssetId : undefined;
      // Clip bars for this node = its Timeline Engine layers (seconds).
      const clips: TimelineClip[] = controller.getLayersForNode(node.id).map((l) => ({
        id: l.id,
        trackId: node.id as TrackId,
        nodeId: node.id as NodeId,
        start: l.start / compFps,
        duration: l.duration / compFps,
        label: node.name ?? node.id,
        color: (node as any).color ?? KIND_FILL[kind],
        ...(waveAssetId ? { assetId: waveAssetId } : {}),
        // The window this bar shows onto its source, in SOURCE seconds. Trim
        // moves the edges, slip slides both — the waveform reads these so it
        // shows the audible region rather than the whole file squeezed to fit.
        sourceInSec: l.clip.sourceIn / compFps,
        sourceOutSec: (l.clip.sourceIn + l.clip.duration) / compFps,
      }));
      const track: TimelineTrack = {
        id: node.id as TrackId,
        name: node.name ?? node.id,
        kind,
        icon: KIND_ICON[kind],
        color: (node as any).color ?? KIND_COLOR[kind],
        muted: node.visible === false,
        audioMuted: isLayerAudioMuted(node),
        locked: node.locked === true,
        solo: node.solo === true,
        blendMode: getNodeBlend(node.id),
        matteMode: getNodeMatte(node.id),
        parent: node.parent ?? null,
        nodeColor: getNodeColor(node),
        threeD: is3DEnabled(node),
        // Read from the same place the renderer does, so the icons reflect what
        // is actually being drawn (and agree with the inspector's switches).
        motionBlur: readNodeMotionBlur(node),
        fxEnabled: readNodeFxEnabled(node),
        adjustment: readNodeAdjustment(node),
        shy: (node as any).shy === true,
        keyframes,
        properties,
        clips,
        // Layer markers, already on the comp axis (see getLayerMarkers).
        markers: controller.getLayerMarkers(node.id).map((m) => ({
          id: m.id,
          time: m.time,
          label: m.label,
          ...(m.color ? { color: m.color } : {}),
        })),
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
  }, [sceneRev, clipRev, markerRev, compFps, expandedIds, activeCompId]);

  // Mirror the scene graph into the Timeline Engine's layers on STRUCTURAL
  // changes only (add/remove/reparent). Pure keyframe or property edits do not
  // change layer geometry, so there is no need to walk the whole scene for them.
  // Previously this was keyed on sceneRev, which fired on every drag tick and
  // caused a full syncFromScene walk 30-60 times/second during a slider drag.
  useEffect(() => {
    const sub = getEventBus().on('SceneGraphChanged', () => getTimelineController().syncFromScene());
    return () => sub.dispose();
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

    const sub = getEventBus().on('RevealAnimatedProps', (evt: { nodeIds: string[], mode: 'animated' | 'modified' }) => {
      const { nodeIds, mode } = evt;
      const targetIds = nodeIds.length > 0 ? nodeIds : tracksRef.current.map(t => t.id);
      
      // Static placeholder rows (animated:false) are part of the always-there
      // property tree, not animation — U must ignore them, or it would expand
      // every layer and reveal the full tree instead of keyframed props only.
      const animatedProps = (id: string) =>
        (tracksRef.current.find((t) => t.id === id)?.properties ?? []).filter(
          (p) => p.animated !== false,
        );

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

  // RAM-preview coverage for the timeline's green cache bar — throttled to
  // 250ms so per-frame cache puts during playback don't thrash React.
  const [cachedRanges, setCachedRanges] = useState<ReadonlyArray<{ start: number; end: number }>>([]);
  useEffect(() => {
    let pending: ReturnType<typeof setTimeout> | null = null;
    const off = viewportFrameCache.onChange(() => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        setCachedRanges(viewportFrameCache.ranges(compFps || 30));
      }, 250);
    });
    return () => {
      off();
      if (pending) clearTimeout(pending);
    };
  }, [compFps]);

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
    // Keep currentTime in the model as a fallback for consumers that read it
    // directly (GraphEditor, timecode display in BottomTimeline header). Its
    // identity doesn't affect the timeline row tree because BottomTimeline
    // prefers the separate playheadTime prop.
    currentTime: activeTime,
    pixelsPerSecond: pps,
    markers,
    tracks: focusTracks,
    cachedRanges,
    ...(workArea ? { workArea } : {}),
  }), [focusTracks, pps, markers, workArea, compDuration, compFps, compStartFrame, cachedRanges, activeTime]);

  // Real-time playback clock: pumps the Timeline Engine while `playing` is set.
  usePlaybackClock();
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
    const node = defaultSceneGraph.getNode(trackId);
    if (!node) return;
    node.name = newName;
    bumpScene();
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
    if (kind === 'audio') {
      const comp = node.components.find((c) => c.type === 'Audio');
      if (!comp) return;
      const next = comp.props?.__muted === true ? undefined : true;
      defaultSceneGraph.writeProp(nodeId, comp.id, '__muted', next);
    } else {
      const comp = node.components.find((c) => c.type === 'Transform');
      if (!comp) return;
      const next = (comp.props as Record<string, unknown>)?.[VIDEO_AUDIO_MUTED_PROP] === true ? undefined : true;
      defaultSceneGraph.writeProp(nodeId, comp.id, VIDEO_AUDIO_MUTED_PROP, next);
    }
    bumpScene();
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
  /**
   * The keyframe navigator's diamond — the only affordance that creates a
   * keyframe WITHOUT changing the value. Anchoring ("hold here, then move
   * away") is impossible otherwise: the stopwatch writes only the *first*
   * keyframe, so every later one would need a value change to exist.
   */
  const handlePropertyKeyframeToggle = (trackId: string, prop: string): void => {
    // Same source as the model's currentTime, so what the navigator draws and
    // what this writes can't disagree.
    const layerT = getRemappedTime(trackId, activeTime);
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
    // The stopwatch is lit when animated, so clicking it means "turn this off" —
    // the same control both ways, as in AE. It used to only ever create, so the
    // timeline could start an animation but never end one.
    if (props.some((p) => defaultAnimation.isAnimated(trackId, p))) {
      runAnimEdit('Disable animation', () => {
        for (const p of props) defaultAnimation.removeTrack(trackId, p);
      });
      return;
    }
    const layerT = getRemappedTime(trackId, activeTime);
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
    propertyValueAt(trackId, prop, getRemappedTime(trackId, activeTime));

  const handlePropertyValueChange = (trackId: string, prop: string, value: number): void => {
    const node = defaultSceneGraph.getNode(trackId);
    if (!node || node.locked) return;
    const rawTime = activeTime;
    const layerT = getRemappedTime(trackId, rawTime);
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
    const comp = node.components.find((c) => typeof (c.props as Record<string, unknown>)[prop] === 'number');
    if (comp) updateNodeComponentProp(defaultSceneGraph, trackId, comp.id, prop, value);
  };
  // Timeline easing pills (Linear/Ease/EaseIn/EaseOut/Hold). Apply to the
  // currently selected keyframes; if none are selected, fall back to every
  // keyframe on the selected layers so the pill always has a visible effect.
  const handleSetEasing = (preset: EasingPreset): void => {
    if (applyEasingToSelection(preset)) return;
    useUIStore.getState().notify({
      level: 'info',
      message: 'Select keyframes first, then choose an easing.',
      durationMs: 3000,
    });
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

    openContextMenu(x, y, [
      { id: 'easy-ease', label: 'Easy Ease', shortcut: 'F9', onSelect: ease('Ease') },
      { id: 'ease-in', label: 'Easy Ease In', shortcut: 'Shift+F9', onSelect: ease('EaseIn') },
      { id: 'ease-out', label: 'Easy Ease Out', shortcut: 'Ctrl+Shift+F9', onSelect: ease('EaseOut') },
      { id: 'linear', label: 'Linear Interpolation', onSelect: ease('Linear') },
      { id: 'sep-ease', separator: true },
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
                  <Icon name="layers" size={11} style={{ color: 'var(--color-text-tertiary)' }} />
                  <span style={{ fontWeight: 500 }}>{activeTitle ?? 'Untitled'}</span>
                  <span style={{ fontFamily: 'var(--font-family-mono)', fontSize: '10px', color: 'var(--color-text-tertiary)' }}>
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
                  <FpsMeter />
                  <span style={{ opacity: 0.4 }}>·</span>
                  <span style={{ fontFamily: 'var(--font-family-mono)', fontVariantNumeric: 'tabular-nums' }}>
                    {framesToTimecode(activeTime, compFps, compStartFrame)}
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
              onTrackMatteChange={(trackId, matte) => {
                setNodeMatte(trackId, matte);
                bumpScene();
              }}
              onTrackParentChange={(trackId, parentId) => {
                reparentNode(trackId, parentId);
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
                  setNodeMotionBlur(trackId, !readNodeMotionBlur(n));
                } else if (flag === 'adjustment') {
                  setNodeAdjustment(trackId, !readNodeAdjustment(n));
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
              onKeyframeContextMenu={handleKeyframeContextMenu}
              onPropertyKeyframeToggle={handlePropertyKeyframeToggle}
              onPropertyStopwatch={handlePropertyStopwatch}
              onPropertyValue={handlePropertyValue}
              onPropertyValueChange={handlePropertyValueChange}
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
      </div>
    </div>
  );
}

/**
 * Is this layer's AUDIO muted? (Separate from the visibility eye, which hides
 * the picture.) Module scope on purpose: it is called from the `tracks` memo,
 * which runs during render well before any `const` declared inside the
 * component body has initialised — as a component-scope const it threw
 * "Cannot access before initialization" and took the whole editor down.
 */
function isLayerAudioMuted(node: ReturnType<typeof defaultSceneGraph.getNode>): boolean {
  if (!node) return false;
  const kind = readNodeKind(node);
  if (kind === 'audio') {
    return node.components.find((c: { type: string }) => c.type === 'Audio')?.props?.__muted === true;
  }
  if (kind !== 'video') return false;
  return node.components.some(
    (c: { props?: Record<string, unknown> }) => c.props?.[VIDEO_AUDIO_MUTED_PROP] === true,
  );
}

export function App(): JSX.Element {
  return (
    <Providers>
      <EditorShell />
    </Providers>
  );
}
