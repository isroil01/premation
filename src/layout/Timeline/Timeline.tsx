/**
 * Timeline — UI shell for the timeline panel (spec: "Default state: calm").
 *
 * Calm by default: every layer is a SINGLE row showing one neutral animation
 * block that summarizes where its keyframes live. A track expands — via the
 * disclosure chevron or the `U` reveal shortcut — into one sub-row per animated
 * property, each with its own draggable keyframes. Collapsed rows stay quiet.
 *
 * Layout:
 *   - Ruler (top) with a cache bar directly beneath it (cached = green 40%)
 *   - TrackHeader column (left) | Lanes (right, scrolls both axes)
 *   - Rows (track + expanded property sub-rows) are virtualized uniformly.
 *
 * This component contains ZERO animation or playback logic — it is a
 * controlled renderer that reports intents to the host.
 */

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { cn } from '@utils/cn';
import { CacheBars } from './CacheBars';
import { Icon, type IconName } from '@components/Icon';
import { ROW_HEIGHT_PRESETS, ROW_HEIGHT_MIN, ROW_HEIGHT_MAX, rowHeightFromDrag } from './rowHeightDrag';
import { collectClipSnapTargets, snapClipTime } from './clipSnap';
import { collectClipCuts, findClipCutNear, type ClipCut } from './clipCuts';
import { useTimelineEditModeStore } from './timelineEditMode';
import { readTransitionDrag, isTransitionDrag } from './transitionPalette';
import { hasCanvasDrag, readCanvasDrag } from '@core/dnd/canvasDrag';
import { replaceLayerSourceWithAsset, resolveReplaceTarget } from '@core/scene/replaceSourceDrop';
import {
  layoutTransitions,
  durationFromEdgeDrag,
  nextTransitionAlignment,
  TRANSITION_ALIGNMENT_LABEL,
  type TransitionBox,
} from './transitionOverlay';
import { installTransitionCommands } from './transitionCommands';
import {
  useTransitionStore,
  addTransition,
  removeTransition,
  setTransition,
  previewTransition,
  commitTransitionPreview,
  compIdForTransition,
  DEFAULT_TRANSITION_FRAMES,
  TRANSITION_LABEL,
} from '@core/timeline/transitions';
import { getTimelineController } from '@core/timeline/TimelineController';
import { registerTimelineScroll, setTimelineLaneGeometry, setTimelineViewportWidth } from './timelineViewport';
import { zoomAroundTime, zoomStep } from './zoomAnchor';
import { resolveTrackSelection, selectIntentFor, type SelectModifiers } from './trackRangeSelect';
import { usePreferenceStore } from '@stores/preferenceStore';
import { useResizeObserver } from '@hooks/useResizeObserver';
import { clamp } from '@utils/lang';
import type { TimelineModel, TimelinePropertyTrack, TimelineClip } from './TimelineModel';
import { type LayerBlendMode } from '@core/effects/blendMode';
import { OPEN_WINDOW, cullTicks, pagedTimeWindow, sameWindow, timeInWindow, type TimeWindow } from './visibleWindow';
import { kfPreviewForRow, previewsForRow } from './dragOverlay';
import { createEdgeAutoScroller, followScrollLeft } from './playheadFollow';
import { useLivePlayhead } from './useLivePlayhead';
import { getTime as getLiveTime } from '@stores/playbackClockStore';
import { flushRenderNow } from '@core/perf/framePump';
import { installTimelineExpandCommands, recursiveTogglePlan, expandAllPlan, collapseAllPlan, registerTimelineExpansion } from './expandCollapse';
import { registerTimelineFitSource } from './fitSelection';
import { installTimelineSnapCommands, toggleTimelineSnap } from './snapCommands';
import { TIMELINE_EXTRA_COLUMNS, parseExtraColumns, type TimelineExtraColumn } from './timelineColumns';
import styles from './Timeline.module.css';
import { useUIStore } from '@stores/uiStore';
import { MarkerLane } from './MarkerLane';
import { MARKER_LANE_HEIGHT } from './markerGeometry';
import { TranscriptLane } from './TranscriptLane';
import { TRANSCRIPT_LANE_HEIGHT } from './transcriptGeometry';
import { HeatLane } from './HeatLane';
import { addCompMarkerAtPlayhead, addLayerMarkersAtPlayhead, installTimelineMarkerCommands } from './markerCommands';
import { deleteSelectionFromTimeline, installTimelineClipEditCommands, rippleDeleteSelection } from './clipEditCommands';
import { stickyCategoryFor } from './stickyCategory';
import { activeCompRootId } from '@core/scene/activeComp';
import {
  RULER_HEIGHT_DEFAULT,
  TRACK_HEIGHT_DEFAULT,
  TIMELINE_LEFT_OFFSET,
  CUT_GRAB_PX,
  CUT_ZONE_PX,
  TRACK_HEADER_MIN_WIDTH,
  headerWidthFor,
  resolveTrackHeaderWidth,
  TIMELINE_TOP_PADDING,
  cutKeyOf,
  TIMELINE_BOTTOM_PADDING,
  getPropertyCategory,
  type Row,
} from './timelineShared';
import { WaveformLane } from './WaveformLane';
import { AUDIO_WAVEFORM_ROW } from '@core/timeline/propertyTree';
import { DragHud, type DragHudState } from './DragHudOverlay';
import { Minimap, Ruler, generateRulerTicks, rulerProgressWidth } from './RulerStack';
import { TrackHeader, PropertyHeader, TrackCategoryHeader } from './TrackHeaderColumn';
import { canResetProperties, resetProperties, resetTransforms } from '@core/scene/layerTransformOps';
import { expressionMenuItems } from '@core/animation/expressionCommands';
import { useCompositionStore } from '@stores/compositionStore';
import { TrackContent, LaneRow } from './Lanes';
import { Keyframes } from './KeyframeLayer';
import { useClipDrag } from './useClipDrag';
import { useKeyframeDrag } from './useKeyframeDrag';
import { useMarquee } from './useMarquee';

// The names other files import from here — kept on this module after the
// split so no importer moves.
export { TIMELINE_LEFT_OFFSET, TRACK_HEADER_MIN_WIDTH, headerWidthFor } from './timelineShared';
export { PropertyHeader } from './TrackHeaderColumn';
export { areRowPropsEqual } from './rowMemo';

// Row-height presets and grip bounds live in `rowHeightDrag.ts`; re-exported
// so the sub-header's cycle button keeps its import.
export { ROW_HEIGHT_PRESETS, ROW_HEIGHT_MIN, ROW_HEIGHT_MAX };

export interface TimelineProps {
  model: TimelineModel;
  onScrub?: (time: number) => void;
  /** Composition duration edit (seconds) from dragging the timeline end handle. */
  onDurationChange?: (duration: number) => void;
  /** Work-area edit (seconds) from dragging the band's edges or body. */
  onWorkAreaChange?: (start: number, end: number) => void;
  /** Clip moved to a new absolute start (seconds). */
  onClipMove?: (clipId: string, start: number) => void;
  /**
   * Move several bars as ONE undoable action — what a multi-row drag and a
   * stagger commit.
   *
   * Not expressible as a loop over `onClipMove`: each of those is a separate
   * engine command, so a twenty-layer drag would cost twenty Ctrl+Z and could
   * be half-undone into a state the user never arranged.
   */
  onClipMoveMany?: (
    moves: ReadonlyArray<{ clipId: string; start: number }>,
    label?: string,
  ) => void;
  /** Clip edge trimmed to an absolute time (seconds). `ripple` closes the gap on in/out trim. */
  onClipTrim?: (clipId: string, edge: 'start' | 'end', time: number, opts?: { ripple?: boolean }) => void;
  /** Alt-drag clip body: slip source under a fixed bar (sourceInSec). */
  onClipSlip?: (clipId: string, sourceInSec: number) => void;
  /** Shift+Alt-drag clip body: slide bar + trim abutting neighbors (new start sec). */
  onClipSlide?: (clipId: string, startSec: number) => void;
  /** Right-click a clip (for split / delete). */
  onClipContextMenu?: (clipId: string, clientX: number, clientY: number) => void;
  onTrackSelect?: (trackId: string, additive: boolean) => void;
  /**
   * Replace the layer selection wholesale — what a Shift+click span and a
   * lane marquee produce.
   *
   * Separate from `onTrackSelect` because that one is per-row and additive,
   * and a span cannot be expressed as a sequence of those without the host
   * seeing (and re-rendering for) every intermediate selection. A host that
   * does not provide it keeps the old per-row behaviour, minus range select.
   */
  onTrackSelectMany?: (trackIds: ReadonlyArray<string>) => void;
  onScroll?: (scrollLeft: number) => void;
  /**
   * Horizontal scroll to RESTORE (px). The lanes own their scroll position, but
   * while the Graph Editor replaces them it scrolls on its own; on return the
   * lanes jump to wherever the graph left off so the two views stay aligned.
   */
  scrollLeftSync?: number;
  /**
   * `anchorSeconds` is the time the gesture was aimed at — the point under
   * the pointer for a wheel zoom. A host that keeps its own scroll position
   * should anchor on it; omitted, the host's own default (the playhead) is
   * the right fallback for a zoom with no pointer, like a slider or a chord.
   */
  onZoom?: (pixelsPerSecond: number, anchorSeconds?: number) => void;
  selectedTrackIds?: ReadonlyArray<string>;
  /** Tracks whose animated properties are revealed (expanded). */
  expandedTrackIds?: ReadonlyArray<string>;
  /** Restrict revealed sub-rows to these props (P/S/R/T reveal); null = all. */
  revealProps?: ReadonlyArray<string> | null;
  onTrackToggleExpand?: (trackId: string) => void;
  /** Double-click a track — enter it (precomp) or isolate it (Focus Mode). */
  onTrackActivate?: (trackId: string) => void;
  /** Toggle a layer's AUDIO mute from its clip bar's speaker glyph. Distinct
   *  from the track's visibility eye, which mutes the picture. */
  onClipMuteToggle?: (nodeId: string) => void;
  onTrackToggleVisible?: (trackId: string) => void;
  onTrackToggleLock?: (trackId: string) => void;
  /** `exclusive` is Alt+click: AE's "turn off all other solo switches". */
  onTrackToggleSolo?: (trackId: string, exclusive: boolean) => void;
  onTrackBlendModeChange?: (trackId: string, mode: LayerBlendMode) => void;
  onTrackMatteChange?: (trackId: string, matte: any) => void;
  onTrackParentChange?: (trackId: string, parentId: string | null, options?: { preserveWorld?: boolean }) => void;
  onTrackToggleFlag?: (trackId: string, flag: 'shy' | 'collapse' | 'fxEnabled' | 'motionBlur' | 'adjustment' | 'threeD' | 'guide' | 'preserveTransparency') => void;
  /** Rename a layer (confirmed on blur/Enter). */
  onTrackRename?: (trackId: string, newName: string) => void;
  onKeyframeSeek?: (keyframeId: string) => void;
  onKeyframeMove?: (keyframeId: string, time: number) => void;
  onKeyframesDelete?: (keyframeIds: ReadonlyArray<string>) => void;
  onKeyframeContextMenu?: (keyframeId: string, clientX: number, clientY: number) => void;
  /**
   * The keyframe navigator's diamond: add a keyframe at the playhead holding
   * the property's current value, or remove the one already there.
   */
  onPropertyKeyframeToggle?: (trackId: string, prop: string) => void;
  /**
   * A static placeholder row's stopwatch: create the first keyframe(s) for
   * the given engine props, enabling animation from the timeline (AE-style).
   */
  onPropertyStopwatch?: (trackId: string, props: ReadonlyArray<string>) => void;
  /**
   * The value to show in a property row's field, sampled at the playhead.
   * Supplied by the app because only it owns the scene + animation engine —
   * this component stays presentational.
   */
  onPropertyValue?: (trackId: string, prop: string) => number;
  /** Set a property's value from the timeline (keyframes when animated). */
  onPropertyValueChange?: (trackId: string, prop: string, value: number) => void;
  /**
   * A value-field scrub is beginning / has ended on this property. Lets the
   * owner snapshot the selected properties' start values so the drag can be
   * distributed across them (Proportional Scrubbing).
   */
  onPropertyScrubStart?: (trackId: string, prop: string) => void;
  onPropertyScrubEnd?: () => void;
  /** Property ROW selection: `${trackId}::${prop}` keys, in selection order. */
  selectedPropertyKeys?: ReadonlyArray<string>;
  /** Click on a property name. `toggle` is Ctrl/Cmd-click (add/remove). */
  onPropertySelect?: (trackId: string, prop: string, mode: 'replace' | 'toggle') => void;
  /** Called when user drags a track row to a new position. toIndex is 0-based. */
  onTrackReorder?: (fromId: string, toIndex: number) => void;
  onTrackColorChange?: (trackId: string, color: string) => void;
  className?: string;
  searchQuery?: string;
  globalShy?: boolean;
  /**
   * AE's Toggle Switches / Modes. `switches` shows shy·fx·blur·adjustment·
   * guide·T·3D; `modes` shows Mode·TrkMat·Parent; `both` shows the lot and
   * needs a very wide header. Defaults to `both` so an embedder that has not
   * been taught about the toggle keeps every column it had.
   */
  columns?: 'switches' | 'modes' | 'both';
  /**
   * Playhead time in seconds, supplied SEPARATELY from `model` so playback
   * (60 fps) does not rebuild the model and force the entire row tree to
   * re-render. When set, the playhead visual, the per-property "at playhead"
   * markers, the playhead-keyboard nudge, and the PropertyHeader time all
   * read from this value; `model.currentTime` is then used only for
   * non-realtime consumers (GraphEditor, BottomTimeline timecode).
   */
  playheadTime?: number;
  /**
   * The host passes a THROTTLED `playheadTime` (exact while paused, ≤10 Hz
   * while playing — `useThrottledTime`) and the timeline follows the LIVE
   * clock itself for everything that has to move every frame: the playhead
   * line and grabber, the ruler's progress fill, the slider's aria value and
   * the auto-follow scroll. Those are written through refs from a clock
   * subscription, so playback does not re-render the timeline at all.
   *
   * Off (the default) for embeds without a tab, which keep driving the
   * playhead purely from `playheadTime`.
   */
  livePlayhead?: boolean;
}

function Timeline({
  model,
  onScrub,
  onWorkAreaChange,
  onClipMove,
  onClipMoveMany,
  onClipTrim,
  onClipSlip,
  onClipSlide,
  onClipContextMenu,
  onTrackSelect,
  onTrackSelectMany,
  onScroll,
  scrollLeftSync,
  onZoom,
  selectedTrackIds,
  expandedTrackIds,
  revealProps,
  onTrackToggleExpand,
  onTrackActivate,
  onClipMuteToggle,
  onTrackToggleVisible,
  onTrackToggleLock,
  onTrackToggleSolo,
  onTrackBlendModeChange,
  onTrackMatteChange,
  onTrackParentChange,
  onTrackToggleFlag,
  onTrackRename,
  onKeyframeSeek,
  onKeyframeMove,
  onKeyframesDelete,
  onKeyframeContextMenu,
  onPropertyKeyframeToggle,
  onPropertyStopwatch,
  onPropertyValue,
  onPropertyValueChange,
  onPropertyScrubStart,
  onPropertyScrubEnd,
  selectedPropertyKeys,
  onPropertySelect,
  onTrackReorder,
  onTrackColorChange,
  className,
  searchQuery,
  globalShy,
  columns = 'both',
  onDurationChange,
  playheadTime,
  livePlayhead = false,
}: TimelineProps): JSX.Element {
  const showSwitches = columns !== 'modes';
  const showModes = columns !== 'switches';
  const rulerHeight = model.rulerHeight ?? RULER_HEIGHT_DEFAULT;
  /**
   * The optional lanes that ride WITH the ruler: markers above it, the
   * transcript below it. They are part of the sticky chrome rather than of the
   * scrolling rows, because both answer "what is at this TIME" and an answer
   * that scrolls away with the layers is no answer at all.
   *
   * `rulerStackHeight` is the number every layout below has to agree on — the
   * header column's own band, the row list's offset, the minimap's viewport.
   * A single derived constant, because the failure mode of getting one of them
   * wrong is that the track headers stop lining up with their own lanes, which
   * is only visible if you look for it.
   */
  const transcriptLaneOn = useUIStore((s) => s.timelineTranscriptLane);
  const heatSource = useUIStore((s) => s.timelineHeatSource);
  const rulerChromeHeight = MARKER_LANE_HEIGHT + (transcriptLaneOn ? TRANSCRIPT_LANE_HEIGHT : 0);
  const rulerStackHeight = rulerHeight + rulerChromeHeight;
  const trackHeight = model.trackHeight ?? TRACK_HEIGHT_DEFAULT;
  // The header column is user-resizable: property names + their value fields
  // need very different room depending on what's open, and a fixed column
  // either truncates labels or wastes half the panel. The model can still
  // pin a width (tests, embeds); otherwise it is the user's preference.
  const prefHeaderWidth = usePreferenceStore((s) => s.timelineHeaderWidth);
  const setPref = usePreferenceStore((s) => s.set);
  // What the visible columns need. It is the DEFAULT and the reset target, no
  // longer a floor on the drag: the header column scrolls horizontally now, so
  // narrowing it hides columns behind an edge you can scroll back — which is
  // the AE behaviour, and does not force the panel to a width the user did not
  // ask for. See `.colHeads` / `.trackHeaderScroller`.
  // ── Optional In / Out / Duration columns ───────────────────────
  const extraColumnPref = usePreferenceStore((s) => s.timelineExtraColumns);
  const extraColumns = useMemo<TimelineExtraColumn[]>(
    // Stretch is offered only when there is a time-stretch API to drive it;
    // there is none today (see the report), so it is filtered out rather than
    // shipped as a column that shows 100% and refuses every edit.
    () => parseExtraColumns(extraColumnPref).filter((c) => c !== 'stretch'),
    [extraColumnPref],
  );

  const minHeaderWidth = headerWidthFor(columns, extraColumns.length);

  // Playhead is the one value that changes 60×/s during playback. We accept
  // it as a separate prop so the model can stay referentially stable and the
  // row tree (memos below) doesn't recompute. Fall back to model.currentTime
  // for callers that still pass the time inside the model.
  const currentTime = playheadTime ?? model.currentTime;

  const lanesRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  /** The row minimap, when it is showing — it overlays the lanes' right edge. */
  const minimapRef = useRef<HTMLDivElement | null>(null);
  /**
   * The column-head strip, kept in step with the rows' horizontal scroll.
   *
   * The heads live in the ruler and the rows live in their own scroller, so
   * they are two boxes that happen to share a column model — scroll one and the
   * legend stops naming the columns under it. Written straight to the DOM
   * rather than through state: this fires on every frame of a drag-scroll, and
   * re-rendering every visible row to move one strip 4px is not what a scroll
   * should cost.
   */
  const colHeadsRef = useRef<HTMLDivElement | null>(null);
  const { ref: containerRef, size } = useResizeObserver<HTMLDivElement>();
  // The same resolution the panel's toolbar makes for its left column — see
  // `resolveTrackHeaderWidth` — so the two edges are one edge. Capped to the
  // measured panel so the lanes always keep room (see `capHeaderToPanel`).
  const headerWidth = resolveTrackHeaderWidth(model.trackHeaderWidth, prefHeaderWidth, columns, extraColumns.length, size.width);
  /** Latest `onScroll`, so the mount-once viewport effect can report a
   *  programmatic scroll without re-registering on every render. */
  const onScrollRef = useRef(onScroll);
  onScrollRef.current = onScroll;
  const [scrollLeft, setScrollLeft] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);

  // ── Publish the lane viewport, for out-of-panel zoom actions ────
  // "Fit composition" lives in the status bar and cannot measure this: the lane
  // width is whatever is left after the user-resizable header column, which is
  // known here and nowhere else. Written to a module store rather than lifted
  // through props — the timeline's host does not connect the two panels, and
  // this fires on every frame of a divider drag.
  //
  // The panel's toolbar reads the same record to put the time navigator over
  // the lanes: the left edge (client space — the row subtracts its own) and
  // the width the minimap covers at the right, when it is showing.
  const publishLanes = useCallback((): void => {
    const el = lanesRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const minimap = minimapRef.current;
    const gutter = minimap
      ? Math.max(0, rect.left + el.clientWidth - minimap.getBoundingClientRect().left)
      : 0;
    setTimelineLaneGeometry({ width: el.clientWidth, left: rect.left, gutter });
  }, []);
  useEffect(() => {
    const el = lanesRef.current;
    if (!el) return;
    const publish = publishLanes;
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    const unregister = registerTimelineScroll((px) => {
      el.scrollLeft = px;
      setScrollLeft(el.scrollLeft);
      onScrollRef.current?.(el.scrollLeft);
    });
    return () => {
      ro.disconnect();
      // Only blank the measurement if no OTHER timeline (the popout window)
      // took over in the meantime — React mounts the new one before this runs.
      if (unregister()) setTimelineViewportWidth(0);
    };
  }, [publishLanes]);

  // ── Header column: resize + scroll ─────────────────────────────
  const resizeRef = useRef<{ startX: number; startW: number } | null>(null);
  const onHeaderResizeDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = { startX: e.clientX, startW: headerWidth };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [headerWidth]);

  const onHeaderResizeMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const st = resizeRef.current;
    if (!st) return;
    // Floor keeps the switch column reachable; ceiling keeps the lanes usable.
    // Past the minimum the columns scroll rather than shrink, so dragging in
    // costs nothing but visible width.
    setPref(
      'timelineHeaderWidth',
      clamp(st.startW + (e.clientX - st.startX), TRACK_HEADER_MIN_WIDTH, 900),
    );
  }, [setPref]);

  // ── Row height: drag the grip on the column seam ────────────────
  const rowHeightRef = useRef<{ startY: number; startH: number } | null>(null);
  const onRowHeightDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    // Stopped, or the same press also starts the COLUMN-WIDTH drag this grip
    // is nested inside, and the header jumps sideways as the rows grow.
    e.stopPropagation();
    rowHeightRef.current = { startY: e.clientY, startH: trackHeight };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
  }, [trackHeight]);

  const onRowHeightMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const st = rowHeightRef.current;
    if (!st) return;
    e.stopPropagation();
    // Rate and clamp are `rowHeightFromDrag`'s — see that module for why half
    // a pixel of row per pixel of drag.
    setPref('timelineRowHeight', rowHeightFromDrag(st.startH, e.clientY - st.startY));
  }, [setPref]);

  const onRowHeightUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!rowHeightRef.current) return;
    e.stopPropagation();
    rowHeightRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort */
    }
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  const onHeaderResizeUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    resizeRef.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);
  useEffect(() => () => {
    if (!resizeRef.current) return;
    resizeRef.current = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  /**
   * Scrolling over the header column scrolls the rows.
   *
   * The header is `overflow: hidden` and follows the lanes' scrollTop, so with
   * many rows a wheel over the names did nothing at all — you had to move the
   * pointer into the lanes to scroll. Forwarding the wheel keeps ONE scrollbar
   * (two would fight and drift) while making both halves scrollable.
   */
  const onHeaderWheel = useCallback((e: ReactWheelEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey) return; // zoom gesture — leave it to the root
    const lanes = lanesRef.current;
    if (!lanes) return;
    lanes.scrollTop += e.deltaY;
  }, []);

  // ── Category accordion collapse state ──
  const [collapsedCategoryKeys, setCollapsedCategoryKeys] = useState<Set<string>>(new Set());
  const toggleCategory = useCallback((trackId: string, categoryKey: string) => {
    const key = `${trackId}:${categoryKey}`;
    setCollapsedCategoryKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // ── Flatten tracks + expanded property sub-rows into a uniform row list ──
  const expanded = useMemo(() => new Set(expandedTrackIds ?? []), [expandedTrackIds]);

  /**
   * Expand / collapse ALL, and the recursive twirl.
   *
   * Expansion is the HOST's state (`expandedTrackIds` + `onTrackToggleExpand`),
   * so the timeline cannot set it — it can only toggle ids one at a time.
   * `expandCollapse.ts` therefore hands back a PLAN and this replays it. Held
   * in a ref so the commands, which are registered once, always read the
   * current tracks rather than the ones present when they were built.
   */
  const expandPlanRef = useRef({ tracks: model.tracks, expanded, toggle: onTrackToggleExpand });
  expandPlanRef.current = { tracks: model.tracks, expanded, toggle: onTrackToggleExpand };
  const runExpandPlan = useCallback((ids: readonly string[]) => {
    const { toggle } = expandPlanRef.current;
    for (const id of ids) toggle?.(id);
  }, []);
  useEffect(() => installTimelineExpandCommands(), []);
  useEffect(
    () =>
      registerTimelineExpansion({
        expandAll: () => {
          const { tracks, expanded: open } = expandPlanRef.current;
          runExpandPlan(expandAllPlan(tracks, open));
        },
        collapseAll: () => {
          const { tracks, expanded: open } = expandPlanRef.current;
          runExpandPlan(collapseAllPlan(tracks, open));
        },
      }),
    [runExpandPlan],
  );
  /** Alt+click a disclosure: the track and everything under it go the same way. */
  const toggleExpandRow = useCallback(
    (trackId: string, recursive: boolean) => {
      if (!recursive) {
        onTrackToggleExpand?.(trackId);
        return;
      }
      const { tracks, expanded: open } = expandPlanRef.current;
      runExpandPlan(recursiveTogglePlan(tracks, open, trackId).toggle);
    },
    [onTrackToggleExpand, runExpandPlan],
  );

  // The fit-selection command (Shift+;) runs from a chord or a menu, outside
  // this component, and needs the geometry only the mounted timeline has.
  const fitSourceRef = useRef({ tracks: model.tracks, selectedTrackIds: selectedTrackIds ?? [] });
  fitSourceRef.current = { tracks: model.tracks, selectedTrackIds: selectedTrackIds ?? [] };
  useEffect(() => registerTimelineFitSource(() => fitSourceRef.current), []);

  // ── Snap ───────────────────────────────────────────────────────
  // A switch, not only a held key. `S` is claimed by the root below, so the
  // global `S` (reveal Scale) keeps working everywhere outside this panel.
  const snapOn = usePreferenceStore((s) => s.timelineSnap);
  /**
   * The seven AE switches at rest.
   *
   * Hidden until hover by default (`timelineSwitchesOnHover`), because the
   * switch block is seven glyphs per row that are OFF on almost every layer
   * and read as noise at a glance — while the three things you actually scan a
   * track list for (the eye, the solo dot, the lock) live in the gutter on the
   * left and are always there. Hovering a row brings them back, and a row you
   * are working on can PIN them through its own control; the global escape
   * hatch is the Switches/Modes cycle button, which stays exactly as it was.
   */
  const switchesOnHover = usePreferenceStore((s) => s.timelineSwitchesOnHover);
  /**
   * Rows that have pinned their switches open. Session state, not a
   * preference: it is a scratch note about the layer being worked on right
   * now, and layer ids are not stable across a reload anyway.
   */
  const [pinnedSwitchRows, setPinnedSwitchRows] = useState<ReadonlySet<string>>(() => new Set());
  const toggleSwitchPin = useCallback((trackId: string) => {
    setPinnedSwitchRows((prev) => {
      const next = new Set(prev);
      if (next.has(trackId)) next.delete(trackId);
      else next.add(trackId);
      return next;
    });
  }, []);
  useEffect(() => installTimelineSnapCommands(), []);

  const revealSet = useMemo(
    () => (revealProps ? new Set(revealProps) : null),
    [revealProps],
  );
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const query = searchQuery?.trim().toLowerCase();

    for (const track of model.tracks) {
      if (globalShy && (track as any).shy) {
        continue;
      }
      const trackName = (track.name ?? '').toLowerCase();
      // `canExpand` first: a collapsed track ships no `properties` at all, so
      // reading only the payload hid the chevron on every un-keyed layer and
      // sealed off the static Transform tree behind it.
      const hasProps =
        track.canExpand === true || (track.properties?.length ?? 0) > 0 || track.isGroup === true;

      const layerMatches = !query || trackName.includes(query);
      const matchingProps = query && track.properties
        ? track.properties.filter(
          (p) =>
            p.prop.toLowerCase().includes(query) ||
            (p.label ?? '').toLowerCase().includes(query)
        )
        : [];

      const hasMatchingProps = matchingProps.length > 0;

      if (!query || layerMatches || hasMatchingProps) {
        const isExpanded = hasProps && (expanded.has(track.id) || hasMatchingProps);
        out.push({ type: 'track', track, expanded: isExpanded, hasProps });

        if (track.properties) {
          let shownProps = track.properties;
          if (query) {
            if (hasMatchingProps) {
              shownProps = matchingProps;
            } else if (layerMatches && isExpanded) {
              shownProps = revealSet
                ? track.properties.filter((p) => revealSet.has(p.prop))
                : track.properties;
            } else {
              shownProps = [];
            }
          } else {
            if (isExpanded) {
              shownProps = revealSet
                ? track.properties.filter((p) => revealSet.has(p.prop))
                : track.properties;
            } else {
              shownProps = [];
            }
          }

          if (shownProps.length > 0) {
            // Group shownProps by category
            const catMap = new Map<string, { key: string; label: string; icon: IconName; order: number; props: TimelinePropertyTrack[] }>();
            for (const prop of shownProps) {
              const cat = getPropertyCategory(prop);
              if (!catMap.has(cat.key)) {
                catMap.set(cat.key, { ...cat, props: [] });
              }
              catMap.get(cat.key)!.props.push(prop);
            }

            const sortedCats = Array.from(catMap.values()).sort((a, b) => a.order - b.order);

            for (const cat of sortedCats) {
              const catKey = `${track.id}:${cat.key}`;
              const isCatExpanded = !collapsedCategoryKeys.has(catKey);
              out.push({
                type: 'category',
                track,
                categoryKey: cat.key,
                label: cat.label,
                icon: cat.icon,
                expanded: isCatExpanded,
                count: cat.props.length,
              });

              if (isCatExpanded) {
                for (const prop of cat.props) {
                  out.push({ type: 'prop', track, prop, categoryKey: cat.key });
                }
              }
            }
          }
        }
      }
    }
    return out;
  }, [model.tracks, expanded, revealSet, searchQuery, globalShy, collapsedCategoryKeys]);

  // ── Transitions ────────────────────────────────────────────────
  /**
   * Where each TRACK sits in the flattened row list.
   *
   * Not `model.tracks.indexOf` — expanded property sub-rows, category headings,
   * shy layers and the search filter all sit between tracks, so the track's
   * position in the model and its position on screen are different numbers the
   * moment anything is open.
   */
  const trackRowIndex = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((row, i) => {
      if (row.type === 'track') map.set(row.track.id, i);
    });
    return map;
  }, [rows]);

  /**
   * Every comp's transitions, flattened.
   *
   * Comp-agnostic on purpose: this component is only ever handed the ACTIVE
   * comp's tracks, and `layoutTransitions` drops any record whose two nodes are
   * not among them — so filtering by comp id here would be a second, weaker copy
   * of a test the layout already makes, and one more place to be wrong about
   * which comp is active.
   */
  const transitionsByComp = useTransitionStore((s) => s.byComp);
  const allTransitions = useMemo(
    () => Object.values(transitionsByComp).flat(),
    [transitionsByComp],
  );
  const transitionBoxes = useMemo(
    () => layoutTransitions(allTransitions, model.tracks, (id) => trackRowIndex.get(id), model.frameRate || 30),
    [allTransitions, model.tracks, trackRowIndex, model.frameRate],
  );

  /** Every cut in the comp — the roll grab, the drop zones and the double-click
   *  target are all the same set, found once per model change. */
  const clipCuts = useMemo(
    () => collectClipCuts(model.tracks, { seamTolerance: 1 / (model.frameRate || 30) }),
    [model.tracks, model.frameRate],
  );
  /** A ref alongside it, so the roll's pointer-down reads the current set
   *  without the drag listeners being re-bound on every model identity change. */
  const clipCutsRef = useRef(clipCuts);
  clipCutsRef.current = clipCuts;

  /** The selected transition — what Delete removes and what draws lit. */
  const [selectedTransitionId, setSelectedTransitionId] = useState<string | null>(null);
  /** The cut a chip is currently hovering over, keyed as `left|right`. */
  const [dropCutKey, setDropCutKey] = useState<string | null>(null);
  /**
   * A chip is in flight over the lanes.
   *
   * Separate from `dropCutKey` on purpose: every cut lights up faintly as soon
   * as the drag enters, so the user can SEE where the droppable places are
   * before aiming at one. Keying that off the hovered cut alone would show
   * nothing until they had already found a target, which is the moment the
   * hint stops being useful.
   */
  const [chipDragging, setChipDragging] = useState(false);
  /**
   * Why the last transition was refused.
   *
   * Shown rather than logged: "there is not enough source handle for a 12-frame
   * dissolve" is the one thing standing between the user and the edit they
   * asked for, and a silent no-op reads as a broken feature.
   */
  const [transitionError, setTransitionError] = useState<string | null>(null);

  // Registered from here, like the fit and edit-mode commands: the feature
  // ships as one unit and nothing else has to be edited to add a kind.
  useEffect(() => installTransitionCommands(), []);

  /**
   * Roving tabindex over the layer rows.
   *
   * `activeTrackId` is the one row in the tab order; the arrows move it, and
   * an effect focuses whatever the id resolves to after the move (the rows are
   * virtualized, so the destination may not have existed when the key was
   * pressed). `null` means "the first row", which is what a listbox entered
   * with Tab should land on.
   */
  const [activeTrackId, setActiveTrackId] = useState<string | null>(null);

  // ── Row selection (click, Shift span, Ctrl toggle) ──────────────
  //
  // The ORDER a Shift span runs along is the flattened, filtered, shy-aware
  // row list — which only this component has. That is why the span is resolved
  // here and the host is handed a finished selection rather than a modifier.
  const trackRowOrder = useMemo<string[]>(
    () => rows.filter((r) => r.type === 'track').map((r) => r.track.id as string),
    [rows],
  );
  /**
   * Where the last span started. A ref, not state: it is read inside click
   * handlers and never rendered, and putting it in state would re-render every
   * row on a plain click for a value none of them display.
   */
  const selectionAnchorRef = useRef<string | null>(null);

  /**
   * Everything the click resolver reads that CHANGES, refreshed each render.
   *
   * `selectTrack` below has to be referentially stable, and this is why.
   * `areRowPropsEqual` — the memo every row subcomponent uses — deliberately
   * treats two functions as equal whatever their identity, on the stated
   * assumption that row callbacks close over nothing but the row's stable id.
   * A `selectTrack` that closed over `selectedTrackIds` would break that
   * assumption silently: the rows keep the FIRST closure they were given, so
   * every click after the first would resolve against the selection as it was
   * when the row last genuinely re-rendered. Ctrl+click would replace instead
   * of toggling, and a span would be computed from a stale base.
   *
   * A ref is the fix rather than widening the comparator: the comparator is
   * load-bearing (the panel re-renders up to 60×/s during playback and these
   * rows must not follow), and the callback genuinely does not need to change.
   */
  const selectLiveRef = useRef({ order: trackRowOrder, selected: selectedTrackIds ?? [] as ReadonlyArray<string>, onTrackSelect, onTrackSelectMany });
  selectLiveRef.current = { order: trackRowOrder, selected: selectedTrackIds ?? [], onTrackSelect, onTrackSelectMany };

  /**
   * Apply a click on `trackId` with its modifiers.
   *
   * Falls back to the per-row callback when the host has not provided the
   * many-at-once one, so a host that only wired `onTrackSelect` keeps working
   * (with Shift behaving as the plain toggle it always did there).
   */
  const selectTrack = useCallback((trackId: string, mods: SelectModifiers) => {
    const live = selectLiveRef.current;
    const intent = selectIntentFor(mods);
    if (!live.onTrackSelectMany) {
      live.onTrackSelect?.(trackId, intent !== 'replace');
      selectionAnchorRef.current = trackId;
      return;
    }
    const next = resolveTrackSelection({
      order: live.order,
      selected: live.selected,
      anchor: selectionAnchorRef.current,
      clicked: trackId,
      intent,
    });
    selectionAnchorRef.current = next.anchor;
    // Re-publishing an identical selection re-renders every row for nothing,
    // and a plain click on the already-selected row is the commonest click.
    if (!next.unchanged) live.onTrackSelectMany(next.ids);
  }, []);
  /** Live handle for the drag hooks, which run outside the render closure. */
  const selectTrackRef = useRef(selectTrack);
  selectTrackRef.current = selectTrack;
  /** Where an untouched list puts its tab stop: the first layer row. */
  const firstTrackRowIndex = rows.findIndex((r) => r.type === 'track');
  const pendingFocusRef = useRef<string | null>(null);
  useEffect(() => {
    const id = pendingFocusRef.current;
    if (id === null) return;
    pendingFocusRef.current = null;
    const el = headerRef.current?.querySelector(`[data-track-id="${CSS.escape(id)}"]`);
    if (el instanceof HTMLElement) el.focus();
  });

  /**
   * The listbox's keyboard contract.
   *
   *   ↑ / ↓        move the active row
   *   Home / End   first / last
   *   Shift+↑/↓    extend the selection over the rows crossed
   *   Enter        open / close the layer's property tree
   *   Space        toggle its visibility
   *
   * Arrow keys are consumed only while a row has focus, so the keyframe nudge
   * and the viewport's own nudge keep them everywhere else. Enter is the
   * disclosure rather than "select" because the row is already selected by the
   * time you can press it — moving here selects, which is the listbox rule.
   */
  const onRowListKey = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>): void => {
      const target = e.target as HTMLElement | null;
      // Only the ROW itself. A key pressed on a switch, a dropdown or the name
      // field inside the row belongs to that control — Space on the eye button
      // is the button's own activation, and handling it here as well would
      // toggle visibility twice and land back where it started.
      if (!target || !target.matches?.('[data-track-id]')) return;
      const row = target;
      const here = row.getAttribute('data-track-id');
      if (!here) return;
      const ids = rows.filter((r) => r.type === 'track').map((r) => r.track.id as string);
      const at = ids.indexOf(here);
      if (at < 0) return;

      const move = (to: number): void => {
        const id = ids[Math.min(ids.length - 1, Math.max(0, to))];
        if (id === undefined || id === here) return;
        e.preventDefault();
        e.stopPropagation();
        setActiveTrackId(id);
        pendingFocusRef.current = id;
        // Virtualized: bring the destination into view or it will not exist to
        // be focused. The lanes own the scroll; the header column follows it.
        const index = rows.findIndex((r) => r.type === 'track' && r.track.id === id);
        const lanes = lanesRef.current;
        if (lanes && index >= 0) {
          const top = TIMELINE_TOP_PADDING + index * trackHeight;
          if (top < lanes.scrollTop) lanes.scrollTop = top;
          else if (top + trackHeight > lanes.scrollTop + lanes.clientHeight) {
            lanes.scrollTop = top + trackHeight - lanes.clientHeight;
          }
        }
        // Shift extends the span from the anchor, a plain move replaces and
        // re-anchors — the same rules as a click, so the two agree.
        selectTrackRef.current(id, { shift: e.shiftKey, meta: false });
      };

      switch (e.key) {
        case 'ArrowDown':
          move(at + 1);
          return;
        case 'ArrowUp':
          move(at - 1);
          return;
        case 'Home':
          move(0);
          return;
        case 'End':
          move(ids.length - 1);
          return;
        case 'Enter': {
          e.preventDefault();
          e.stopPropagation();
          toggleExpandRow(here, e.altKey);
          return;
        }
        case ' ': {
          e.preventDefault();
          e.stopPropagation();
          onTrackToggleVisible?.(here);
          return;
        }
        default:
      }
    },
    [rows, trackHeight, onTrackToggleVisible, toggleExpandRow],
  );

  // ── Derived geometry ───────────────────────────────────────────
  const totalSeconds = Math.max(model.duration, 1);
  const pps = model.pixelsPerSecond;
  // Lanes extend past the comp end when clips overhang it (AE-style), so an
  // overhanging bar stays visible/scrollable instead of clipping at the edge.
  const contentSeconds = useMemo(() => {
    let max = totalSeconds;
    for (const t of model.tracks) {
      for (const c of t.clips ?? []) max = Math.max(max, c.start + c.duration);
    }
    return max;
  }, [model.tracks, totalSeconds]);
  const laneWidth = TIMELINE_LEFT_OFFSET + (contentSeconds + 1) * pps;
  const totalLanesHeight = TIMELINE_TOP_PADDING + rows.length * trackHeight + TIMELINE_BOTTOM_PADDING;
  const effectiveLanesHeight = Math.max(totalLanesHeight, Math.max(0, size.height - rulerStackHeight));
  /** The row minimap shows only when the rows overflow one screen. */
  const minimapShown = size.height > 0 && totalLanesHeight > size.height - rulerStackHeight;
  // The minimap is an overlay, so the lanes do not resize when it appears —
  // the ResizeObserver above would not notice. Re-publish on the toggle, after
  // the minimap has laid out.
  useLayoutEffect(() => {
    publishLanes();
  }, [minimapShown, publishLanes]);

  // ── Vertical virtualization (rows) ─────────────────────────────
  const visibleRowCount = Math.ceil(size.height / trackHeight) + 8;
  const startRow = Math.max(0, Math.floor(Math.max(0, scrollTop - TIMELINE_TOP_PADDING) / trackHeight) - 4);
  const endRow = Math.min(rows.length, startRow + visibleRowCount);
  const visibleRows = useMemo(() => rows.slice(startRow, endRow), [rows, startRow, endRow]);

  // ── Horizontal culling ─────────────────────────────────────────
  // The stretch of the comp worth painting: the visible screen plus one either
  // side, snapped to page boundaries so it changes only when the scroll
  // crosses one (see `visibleWindow.ts`). Held by identity across scrolls
  // that stay inside the page, so the rows' memo sees the same object.
  const lanesWidth = Math.max(0, size.width - headerWidth);
  const timeWindowRef = useRef<TimeWindow>(OPEN_WINDOW);
  const timeWindow = useMemo(() => {
    const next = pagedTimeWindow({ scrollLeft, viewportWidth: lanesWidth, pixelsPerSecond: pps, leftOffset: TIMELINE_LEFT_OFFSET });
    if (sameWindow(timeWindowRef.current, next)) return timeWindowRef.current;
    timeWindowRef.current = next;
    return next;
  }, [scrollLeft, lanesWidth, pps]);

  // ── Horizontal scrolling sync (header follows lanes) ──────────
  const onLanesScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      setScrollLeft(el.scrollLeft);
      setScrollTop(el.scrollTop);
      if (headerRef.current) headerRef.current.scrollTop = el.scrollTop;
      onScroll?.(el.scrollLeft);
    },
    [onScroll],
  );

  // Restore an externally-driven scroll (the Graph Editor's) when it changes.
  useEffect(() => {
    const el = lanesRef.current;
    if (scrollLeftSync === undefined || !el) return;
    if (Math.abs(el.scrollLeft - scrollLeftSync) > 0.5) el.scrollLeft = scrollLeftSync;
  }, [scrollLeftSync]);

  /**
   * Playhead auto-follow.
   *
   * Written straight to the scroller, not through `setScrollLeft` — the DOM
   * scroll event that the write provokes updates the state for us, and driving
   * it from here as well would mean two writers for one number. Suspended
   * while a drag holds the lanes: an edge auto-scroll and a follow pulling in
   * opposite directions is a scroller that vibrates.
   */
  /** True while a drag owns the lanes' scroll (see the edge auto-scroller). */
  const dragScrollBusyRef = useRef(false);
  const edgeScrollerRef = useRef<ReturnType<typeof createEdgeAutoScroller> | null>(null);
  /** The last pointermove of the running drag, replayed after each edge step. */
  const lastDragEventRef = useRef<PointerEvent | null>(null);
  useEffect(() => () => edgeScrollerRef.current?.stop(), []);

  const followMode = usePreferenceStore((s) => s.timelineFollowMode);
  // Read through refs so the live clock subscription (below) can follow on
  // every tick without re-subscribing when the zoom or the mode changes.
  const followGeomRef = useRef({ followMode, pps });
  followGeomRef.current = { followMode, pps };
  /**
   * The playhead position the last follow acted on. Follow exists to keep an
   * ADVANCING playhead visible; when the playhead has not moved, any re-page
   * is being caused by something else — a zoom, a resize, or simply another
   * render — and overruling the user's scroll position for those is wrong.
   *
   * This is what made the anchored wheel-zoom appear not to work. The zoom
   * anchor set the correct scroll, and then `useLivePlayhead` — which calls
   * this after EVERY render, not just on a clock tick — immediately paged back
   * to a playhead that had not moved since. Guarding the one `useEffect` was
   * not enough precisely because that is not the only caller; the rule belongs
   * here, where every caller goes through it.
   */
  const lastFollowedRef = useRef<number | null>(null);
  // Turning follow ON (or switching mode) should snap to the playhead even
  // though it has not moved — that IS the user asking for it.
  useEffect(() => {
    lastFollowedRef.current = null;
  }, [followMode]);
  const followTo = useCallback((t: number): void => {
    const el = lanesRef.current;
    const { followMode: mode, pps: p } = followGeomRef.current;
    if (!el || mode === 'off' || dragScrollBusyRef.current) return;
    if (lastFollowedRef.current !== null && Math.abs(lastFollowedRef.current - t) < 1e-6) return;
    lastFollowedRef.current = t;
    const next = followScrollLeft({
      mode,
      playheadX: TIMELINE_LEFT_OFFSET + t * p,
      scrollLeft: el.scrollLeft,
      viewportWidth: el.clientWidth,
      contentWidth: el.scrollWidth,
      leftOffset: TIMELINE_LEFT_OFFSET,
    });
    if (next !== null) el.scrollLeft = next;
    // lanesRef is a stable ref object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    // Live: the LIVE time, never the throttled prop — following a value up to
    // 100ms old at a page boundary would page back, then forward again.
    followTo(livePlayhead ? getLiveTime() : currentTime);
  }, [followMode, currentTime, pps, livePlayhead, followTo]);

  // ── Wheel zoom (Ctrl + Wheel), anchored at the pointer ─────────
  //
  // The zoom is published to the host, which pushes a new `pixelsPerSecond`
  // back down through the model; the scroll that keeps the pointer's time
  // still can only be applied once that has rendered, because it is measured
  // in the NEW scale. So the gesture records where the anchor must land and a
  // layout effect below applies it on the frame the zoom arrives — the same
  // two-step the graph editor uses.
  //
  // The anchor is recorded as a PAIR — hold this TIME at this screen x — not
  // as a finished scroll position. The requested zoom does not survive the
  // round trip unchanged: the host clamps it and the engine stores it as
  // pixels-per-FRAME, so what comes back differs from what went out by a float
  // hair. A pending scroll computed from the requested zoom would either be
  // slightly wrong or, if guarded on the zoom matching, be discarded on every
  // single gesture. Resolving the pair against whatever zoom actually arrives
  // is correct for both.
  const zoomAnchorRef = useRef<{ time: number; viewportX: number } | null>(null);
  const onWheel = useCallback(
    (e: ReactWheelEvent<HTMLDivElement>) => {
      if (!e.ctrlKey && !e.metaKey) return;
      const lanes = lanesRef.current;
      if (!lanes || !onZoom) return;
      e.preventDefault();
      const next = zoomStep(pps, e.deltaY);
      if (next === pps) return;
      const viewportX = e.clientX - lanes.getBoundingClientRect().left;
      const time = pps > 0 ? (viewportX + lanes.scrollLeft - TIMELINE_LEFT_OFFSET) / pps : 0;
      zoomAnchorRef.current = { time, viewportX };
      // The host also hands the engine an anchor for its own `scrollX`; tell
      // it the point the gesture is about, or the engine re-anchors on the
      // playhead and the two disagree about where the view is.
      onZoom(next, time);
    },
    [pps, onZoom],
  );

  // Apply a pending zoom anchor the moment the new scale is on screen.
  useLayoutEffect(() => {
    const pending = zoomAnchorRef.current;
    if (!pending) return;
    zoomAnchorRef.current = null;
    const lanes = lanesRef.current;
    if (!lanes) return;
    const { scrollLeft } = zoomAroundTime({
      pps,
      nextPps: pps,
      time: pending.time,
      viewportX: pending.viewportX,
      leftOffset: TIMELINE_LEFT_OFFSET,
    });
    lanes.scrollLeft = scrollLeft;
  }, [pps]);

  // Stable, so <Minimap>'s memo can actually skip — an inline arrow here is a
  // new prop identity on every frame of playback, which would make the memo
  // wrapper pure overhead.
  const onMinimapScrollTo = useCallback((top: number) => {
    if (lanesRef.current) lanesRef.current.scrollTop = top;
  }, []);

  // ── Scrubbing / playhead drag ──────────────────────────────────
  const draggingRef = useRef(false);
  const onPlayheadDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!lanesRef.current) return;
    draggingRef.current = true;
    // A scrub is a drag the viewport should degrade for (Adaptive Resolution),
    // exactly like a gizmo drag — same flag, same subscriber.
    useUIStore.getState().setDragging(true);
    const rect = lanesRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left + lanesRef.current.scrollLeft - TIMELINE_LEFT_OFFSET;
    const time = clamp(x / pps, 0, totalSeconds);
    onScrub?.(time);
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
  }, [lanesRef, pps, totalSeconds, onScrub]);
  useEffect(() => {
    // Scrubs COALESCE to one seek per animation frame. A pointer emits moves
    // far faster than the display refreshes (120–1000 Hz), and each seek is a
    // clock write that re-renders every time reader and asks the viewport for
    // a frame — only the last one per frame is ever seen. The seek then runs
    // inside the rAF and flushes the viewport in the same frame.
    let raf: number | null = null;
    let pending: number | null = null;
    const flushScrub = (): void => {
      if (raf !== null) {
        cancelAnimationFrame(raf);
        raf = null;
      }
      if (pending === null) return;
      const t = pending;
      pending = null;
      onScrub?.(t);
    };
    const onMove = (e: PointerEvent): void => {
      if (!draggingRef.current || !lanesRef.current) return;
      const rect = lanesRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left + scrollLeft - TIMELINE_LEFT_OFFSET;
      pending = clamp(x / pps, 0, totalSeconds);
      if (raf !== null) return;
      raf = requestAnimationFrame((frameTs) => {
        raf = null;
        if (pending === null) return;
        const t = pending;
        pending = null;
        onScrub?.(t);
        flushRenderNow(frameTs);
      });
    };
    const onUp = (): void => {
      if (!draggingRef.current) return;
      // The release lands exactly where the pointer let go.
      flushScrub();
      draggingRef.current = false;
      useUIStore.getState().setDragging(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      // A re-bind mid-drag (the lanes scrolled) must not drop the last move.
      flushScrub();
      if (draggingRef.current) {
        draggingRef.current = false;
        useUIStore.getState().setDragging(false);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };
  }, [pps, scrollLeft, totalSeconds, onScrub]);

  // ── Work-area band drag (edge handles resize in/out; body moves) ──
  const waDrag = useRef<null | { mode: 'in' | 'out' | 'move'; startX: number; s: number; e: number }>(null);
  const startWaDrag = useCallback(
    (mode: 'in' | 'out' | 'move') => (ev: ReactPointerEvent<HTMLDivElement>) => {
      if (!model.workArea || !lanesRef.current) return;
      ev.stopPropagation();
      const lanesRect = lanesRef.current.getBoundingClientRect();
      waDrag.current = {
        mode,
        startX: ev.clientX - lanesRect.left + scrollLeft,
        s: model.workArea.start,
        e: model.workArea.end,
      };
      try {
        (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
      } catch {
        /* best-effort capture (synthetic/edge pointers) */
      }
      document.body.style.userSelect = 'none';
    },
    [model.workArea, scrollLeft],
  );
  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      const d = waDrag.current;
      if (!d || !lanesRef.current || !onWorkAreaChange) return;
      const lanesRect = lanesRef.current.getBoundingClientRect();
      const contentX = e.clientX - lanesRect.left + scrollLeft;
      const deltaSec = (contentX - d.startX) / pps;
      const minGap = 1 / (model.frameRate || 30);
      let s = d.s;
      let en = d.e;
      if (d.mode === 'in') {
        s = clamp(d.s + deltaSec, 0, d.e - minGap);
      } else if (d.mode === 'out') {
        en = clamp(d.e + deltaSec, d.s + minGap, totalSeconds);
      } else {
        const width = d.e - d.s;
        s = clamp(d.s + deltaSec, 0, totalSeconds - width);
        en = s + width;
      }
      onWorkAreaChange(s, en);
    };
    const onUp = (): void => {
      if (!waDrag.current) return;
      waDrag.current = null;
      document.body.style.userSelect = '';
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (waDrag.current) {
        waDrag.current = null;
        document.body.style.userSelect = '';
      }
    };
  }, [pps, scrollLeft, totalSeconds, onWorkAreaChange, model.frameRate]);

  // ── Composition duration drag (extend / shorten video length) ────
  const durationDragCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => durationDragCleanupRef.current?.(), []);
  const startDurationDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!onDurationChange) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startDuration = model.duration;
    const owner = e.currentTarget;
    try {
      owner.setPointerCapture(e.pointerId);
    } catch {
      // best-effort
    }

    const onPointerMove = (moveEvent: PointerEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaSec = deltaX / pps;
      const newDuration = Math.max(0.1, startDuration + deltaSec);

      // Snap to frames
      const fps = model.frameRate || 30;
      const frameIndex = Math.round(newDuration * fps);
      const snappedDuration = Math.max(1 / fps, frameIndex / fps);

      onDurationChange?.(snappedDuration);
    };

    const cleanup = (): void => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      durationDragCleanupRef.current = null;
    };
    const onPointerUp = (upEvent: PointerEvent) => {
      try {
        owner.releasePointerCapture(upEvent.pointerId);
      } catch {
        // best-effort
      }
      cleanup();
    };

    durationDragCleanupRef.current?.();
    durationDragCleanupRef.current = cleanup;
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

  // ── Clip drag (body = move; Alt+body = slip; Shift+Alt = slide; edges = trim) ──
  // The gesture lives in `useClipDrag`; only the snap context it shares with
  // the razor stays here (the razor reads it too).
  /**
   * Everything a clip drag needs to build its snap targets, refreshed each
   * render. A ref rather than a dependency so the drag listeners below are not
   * re-bound (and the in-flight gesture torn down) every time the model object
   * changes identity — which, during playback, is every frame.
   */
  const clipSnapCtx = useRef({ tracks: model.tracks, markers: model.markers, workArea: model.workArea, currentTime, duration: model.duration });
  clipSnapCtx.current = { tracks: model.tracks, markers: model.markers, workArea: model.workArea, currentTime, duration: model.duration };

  // ── Edit modes (select / razor / slip / slide / roll) ──────────────
  /**
   * Which NLE edit a plain drag on a clip performs, from the tool row above.
   *
   * The modifier gestures are deliberately KEPT alongside this: in `select`
   * mode Alt-drag still slips and Alt+Shift-drag still slides, exactly as they
   * did. Removing them would break the muscle memory of the only people who
   * ever found the features, in the same change that makes them discoverable
   * for everyone else.
   */
  const editMode = useTimelineEditModeStore((s) => s.mode);

  /** Where a razor click would land, while the pointer is over the lanes. */
  const [razorAt, setRazorAt] = useState<number | null>(null);
  /**
   * The drag read-out: how far the edit has travelled and what it produced.
   *
   * Slip, slide and roll all leave the bar's outline where it was or move it
   * without changing its length, so the canvas shows almost nothing while you
   * drag one. Without a number on screen these are three gestures whose whole
   * effect is invisible until you let go. Positioned in CLIENT coordinates and
   * rendered at the panel root, so it follows the pointer over the ruler and
   * the header column too.
   */
  const [dragHud, setDragHud] = useState<DragHudState | null>(null);

  // The marker and ripple/lift/extract commands are installed by the panel
  // that owns their behaviour, not by a provider: a command in the palette
  // whose only handler lives in an unmounted file is the failure this codebase
  // keeps finding. Both installers are idempotent.
  useEffect(() => {
    installTimelineMarkerCommands();
    installTimelineClipEditCommands();
  }, []);

  const fpsRef = useRef(model.frameRate || 30);
  fpsRef.current = model.frameRate || 30;

  /** Comp seconds under a client X, in the lanes' own coordinate space. */
  const lanesTimeAt = useCallback(
    (clientX: number): number | null => {
      const lanes = lanesRef.current;
      if (!lanes) return null;
      const rect = lanes.getBoundingClientRect();
      return (clientX - rect.left + lanes.scrollLeft - TIMELINE_LEFT_OFFSET) / pps;
    },
    [pps],
  );

  /**
   * Snap a razor's frame the same way a clip drag snaps — to the playhead, a
   * neighbouring bar's edge, a marker, the work area, or the frame grid. A
   * razor that only quantized to frames would make "cut exactly where that
   * other layer starts" a by-eye operation, which is most of what a razor is
   * for. Nothing is excluded from the target list: unlike a drag, the razor is
   * not one of the bars, so it may latch onto every one of them.
   */
  const snapRazorTime = useCallback(
    (time: number): number => {
      const targets = collectClipSnapTargets({
        tracks: clipSnapCtx.current.tracks,
        playheadTime: clipSnapCtx.current.currentTime,
        markers: clipSnapCtx.current.markers,
        workArea: clipSnapCtx.current.workArea ?? null,
        compDuration: clipSnapCtx.current.duration,
      });
      return snapClipTime(time, targets, {
        pixelsPerSecond: pps,
        frameDuration: 1 / (model.frameRate || 30),
      }).time;
    },
    [pps, model.frameRate],
  );

  /**
   * RAZOR — split at `time`.
   *
   * Calls the controller directly rather than reporting an intent upward, and
   * that is a deliberate exception to this component's "controlled renderer"
   * rule. There is no `onClipSplit` prop, the host that would grow one is
   * outside this feature's reach, and the alternative — no razor — is worse
   * than one import. The component already reaches for the scene graph and the
   * audio engine for the same kind of reason.
   *
   * `all` is Shift+click: every bar the frame falls inside, on every track,
   * which is how you cut a stack of layers at one beat. Each split is its own
   * history entry, matching `splitSelectedAtPlayhead`.
   */
  const razorAtTime = useCallback(
    (time: number, all: boolean, clipId?: string): void => {
      const controller = getTimelineController();
      const inside = (c: TimelineClip): boolean => time > c.start && time < c.start + c.duration;
      const targets: TimelineClip[] = [];
      for (const track of model.tracks) {
        for (const clip of track.clips ?? []) {
          if (!inside(clip)) continue;
          if (all || clip.id === clipId) targets.push(clip);
        }
      }
      for (const clip of targets) controller.splitClip(clip.id, time);
    },
    [model.tracks],
  );

  /**
   * Where the razor would land, tracked while the pointer is over the lanes.
   *
   * The line is the whole point of the tool being a MODE rather than a menu
   * item: a razor you cannot aim is a razor you undo. It is drawn at the
   * SNAPPED frame, so what you see before the click is exactly where the cut
   * goes — showing the raw pointer position and then cutting somewhere else
   * would be worse than showing nothing.
   */
  const onRazorPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const raw = lanesTimeAt(e.clientX);
      setRazorAt(raw === null ? null : snapRazorTime(raw));
    },
    [lanesTimeAt, snapRazorTime],
  );
  const clearRazorAt = useCallback(() => setRazorAt(null), []);

  // ── Transition gestures ────────────────────────────────────────
  /**
   * Apply a kind to a cut, reporting a refusal rather than swallowing it.
   *
   * `addTransition` refuses when the source handles cannot pay for the overlap,
   * and that refusal is the single most important message this feature produces:
   * without it a dissolve dropped on a cut with no handle simply does nothing,
   * and the user's conclusion is that the feature is broken rather than that the
   * clips are already at their ends.
   */
  const applyTransition = useCallback(
    (cut: ClipCut, kind: Parameters<typeof addTransition>[2]): void => {
      void addTransition(cut.leftNodeId, cut.rightNodeId, kind, DEFAULT_TRANSITION_FRAMES, 'centred').then(
        (res) => {
          if (!res.ok) setTransitionError(res.reason);
          else setSelectedTransitionId(res.record.id);
        },
      );
    },
    [],
  );

  /**
   * The cut under a client point, or null.
   *
   * The ROW matters as much as the time: a comp cut to a beat has many bars
   * ending on the same frame, and `findClipCutNear` needs the row the pointer is
   * over to tell which of the coincident cuts is meant — the same
   * disambiguation the roll tool makes, from the same helper.
   */
  const lanesCutAt = useCallback(
    (clientX: number, clientY: number): ClipCut | null => {
      const lanes = lanesRef.current;
      if (!lanes) return null;
      const time = lanesTimeAt(clientX);
      if (time === null) return null;
      const rect = lanes.getBoundingClientRect();
      const y = clientY - rect.top + lanes.scrollTop - rulerStackHeight - TIMELINE_TOP_PADDING;
      const rowIndex = Math.floor(y / trackHeight);
      const row = rowIndex >= 0 ? rows[rowIndex] : undefined;
      const trackId = row ? row.track.id : null;
      return findClipCutNear(clipCutsRef.current, time, pps > 0 ? CUT_GRAB_PX / pps : 0, trackId);
    },
    [lanesTimeAt, rulerStackHeight, trackHeight, rows, pps],
  );

  /**
   * Chip drag and drop, handled by the LANES rather than by a strip at each cut.
   *
   * A drop target drawn at the cut would sit exactly on top of both clips' trim
   * handles, and an element there swallows the single most likely gesture at a
   * cut. The lanes already know where the pointer is, so the target is computed
   * rather than rendered — and the strip that lights up is left purely
   * decorative.
   */
  /** The layer (track) id under a client Y in the lanes, or null. */
  const lanesTrackIdAt = useCallback(
    (clientY: number): string | null => {
      const lanes = lanesRef.current;
      if (!lanes) return null;
      const rect = lanes.getBoundingClientRect();
      const y = clientY - rect.top + lanes.scrollTop - rulerStackHeight - TIMELINE_TOP_PADDING;
      const row = y >= 0 ? rows[Math.floor(y / trackHeight)] : undefined;
      return row ? (row.track.id as string) : null;
    },
    [rulerStackHeight, trackHeight, rows],
  );

  const onLanesDragOver = useCallback(
    (e: ReactDragEvent<HTMLDivElement>): void => {
      if (!isTransitionDrag(e.dataTransfer)) {
        // AE Alt-drag from the Assets panel onto a layer bar: replace source.
        if (e.altKey && hasCanvasDrag(e)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setChipDragging(true);
      const cut = lanesCutAt(e.clientX, e.clientY);
      const key = cut ? cutKeyOf(cut) : null;
      setDropCutKey((k) => (k === key ? k : key));
    },
    [lanesCutAt],
  );

  const onLanesDrop = useCallback(
    (e: ReactDragEvent<HTMLDivElement>): void => {
      const kind = readTransitionDrag(e.dataTransfer);
      setDropCutKey(null);
      setChipDragging(false);
      if (!kind) {
        // Alt-drop an asset on a layer's lane → replace that layer's source
        // (transforms, keyframes and effects kept).
        const payload = e.altKey ? readCanvasDrag(e) : null;
        if (payload?.kind === 'asset') {
          e.preventDefault();
          replaceLayerSourceWithAsset(resolveReplaceTarget(lanesTrackIdAt(e.clientY)), payload.assetId);
        }
        return;
      }
      e.preventDefault();
      const cut = lanesCutAt(e.clientX, e.clientY);
      setTransitionError(cut ? null : 'Drop a transition on a cut — the point where one clip ends and the next begins.');
      if (cut) applyTransition(cut, kind);
    },
    [lanesCutAt, applyTransition, lanesTrackIdAt],
  );

  /** Double-click a cut → the default 12-frame cross dissolve. */
  const onLanesDoubleClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>): void => {
      const cut = lanesCutAt(e.clientX, e.clientY);
      if (!cut) return;
      e.preventDefault();
      e.stopPropagation();
      setTransitionError(null);
      applyTransition(cut, 'crossDissolve');
    },
    [lanesCutAt, applyTransition],
  );

  /**
   * Live resize of a transition by dragging one of its ends.
   *
   * The preview goes through the SAME materialise path the commit does — not a
   * cheaper approximation drawn over the top — so what you see mid-drag is the
   * edit, including the point at which the handles run out and the bracket stops
   * growing. `previewTransition` records nothing; `commitTransitionPreview`
   * rewinds to where the drag began and re-applies the final duration as one
   * undo entry.
   */
  const transitionDrag = useRef<
    null | { id: string; compId: string; edge: 'start' | 'end'; box: TransitionBox; frames: number }
  >(null);

  const onTransitionEdgeDown = useCallback(
    (box: TransitionBox, edge: 'start' | 'end', e: ReactPointerEvent<HTMLDivElement>): void => {
      e.preventDefault();
      e.stopPropagation();
      const rec = allTransitions.find((t) => t.id === box.id);
      if (!rec) return;
      setSelectedTransitionId(box.id);
      transitionDrag.current = {
        id: box.id,
        compId: compIdForTransition(rec),
        edge,
        box,
        frames: rec.durationFrames,
      };
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'ew-resize';
    },
    [allTransitions],
  );

  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      const d = transitionDrag.current;
      if (!d) return;
      const rec = allTransitions.find((t) => t.id === d.id);
      if (!rec) return;
      const time = lanesTimeAt(e.clientX);
      if (time === null) return;
      const frames = durationFromEdgeDrag(d.box, d.edge, time, rec.alignment, fpsRef.current);
      if (frames === d.frames) return;
      d.frames = frames;
      previewTransition(d.compId, d.id, frames);
      setDragHud({
        x: e.clientX,
        y: e.clientY,
        lines: [`${TRANSITION_LABEL[rec.kind]}`, `${frames} ${frames === 1 ? 'frame' : 'frames'}`],
      });
    };
    const onUp = (): void => {
      const d = transitionDrag.current;
      transitionDrag.current = null;
      setDragHud(null);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      if (!d) return;
      void commitTransitionPreview(d.compId, d.id, d.frames);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [allTransitions, lanesTimeAt]);

  /**
   * Cycle a transition's alignment — the bracket's kind label is the switch.
   *
   * A click rather than a submenu on the bracket itself: the three placements
   * are one property with three values, and the bracket redraws to the new
   * shape immediately, so cycling reads as "try the next one" instead of
   * needing a menu round-trip. The context menu still offers the three by name
   * for anyone who wants to pick rather than step.
   */
  const cycleTransitionAlignment = useCallback(
    (id: string): void => {
      const rec = allTransitions.find((t) => t.id === id);
      if (!rec) return;
      setSelectedTransitionId(id);
      void setTransition(compIdForTransition(rec), rec.id, {
        alignment: nextTransitionAlignment(rec.alignment),
      }).then((res) => {
        if (!res.ok) setTransitionError(res.reason);
      });
    },
    [allTransitions],
  );

  /**
   * Delete removes the SELECTED transition and nothing else.
   *
   * Its own listener rather than a branch inside the keyframe one, and it runs
   * first only when a transition is actually selected — so Delete still deletes
   * layers and keyframes exactly as it did, and a transition can only be removed
   * while its bracket is lit.
   */
  useEffect(() => {
    if (!selectedTransitionId) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      const rec = allTransitions.find((t) => t.id === selectedTransitionId);
      if (!rec) return;
      e.preventDefault();
      e.stopPropagation();
      setSelectedTransitionId(null);
      void removeTransition(compIdForTransition(rec), rec.id);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [selectedTransitionId, allTransitions]);

  // Leaving the razor drops its guide line. Without this the line is stranded
  // at the last position the pointer had, over a timeline where clicking does
  // something else entirely.
  useEffect(() => {
    if (editMode !== 'razor') setRazorAt(null);
  }, [editMode]);

  const { clipSnap, clipPreviews, onClipDown } = useClipDrag({
    model,
    pps,
    totalSeconds,
    snapOn,
    editMode,
    lanesRef,
    lanesTimeAt,
    razorAtTime,
    snapRazorTime,
    clipCutsRef,
    clipSnapCtx,
    fpsRef,
    dragScrollBusyRef,
    edgeScrollerRef,
    lastDragEventRef,
    setDragHud,
    selectedTrackIds,
    selectTrack,
    rowOrder: trackRowOrder,
    onClipMove,
    onClipMoveMany,
    onClipTrim,
    onClipSlip,
    onClipSlide,
  });

  // ── Playhead keyboard nudge (role="slider" must be operable) ──
  // Arrow keys step one frame; Shift steps one second; Home/End jump to bounds.
  const onPlayheadKey = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const frame = 1 / (model.frameRate || 30);
      // Nudge from where the playhead IS, not from the throttled display value.
      const at = livePlayhead ? getLiveTime() : currentTime;
      let next: number | null = null;
      switch (e.key) {
        case 'ArrowLeft':
          next = at - (e.shiftKey ? 1 : frame);
          break;
        case 'ArrowRight':
          next = at + (e.shiftKey ? 1 : frame);
          break;
        case 'Home':
          next = 0;
          break;
        case 'End':
          next = totalSeconds;
          break;
        default:
          return;
      }
      e.preventDefault();
      onScrub?.(clamp(next, 0, totalSeconds));
    },
    [model.frameRate, currentTime, totalSeconds, onScrub, livePlayhead],
  );

  // ── Track row reorder ──────────────────────────────────────────────────────
  const rowDrag = useRef<{ id: string; startY: number; currentIndex: number } | null>(null);

  /*
    Stable per-row handlers. `TrackHeader` is memoised, and a memo is only as
    good as its props: every row used to get a fresh closure for each of its
    fourteen callbacks on every Timeline render, so no row ever skipped — on a
    2,000-layer comp adding one layer re-rendered every visible header. The
    closures below are created once per track id and read the CURRENT
    callbacks through a ref, so they never go stale and never change identity.
    Row styles are cached by (top, height) for the same reason.
  */
  const latestRowCallbacks = useRef({
    toggleExpandRow, onTrackActivate, selectTrack, onTrackToggleVisible, onTrackToggleLock, onTrackToggleSolo,
    onClipMuteToggle, onTrackBlendModeChange, onTrackMatteChange, onTrackParentChange, onTrackToggleFlag,
    onTrackRename, toggleSwitchPin, setActiveTrackId,
  });
  latestRowCallbacks.current = {
    toggleExpandRow, onTrackActivate, selectTrack, onTrackToggleVisible, onTrackToggleLock, onTrackToggleSolo,
    onClipMuteToggle, onTrackBlendModeChange, onTrackMatteChange, onTrackParentChange, onTrackToggleFlag,
    onTrackRename, toggleSwitchPin, setActiveTrackId,
  };
  const rowRealIndex = useRef(new Map<string, number>());
  const rowHandlerCache = useRef(new Map<string, ReturnType<typeof makeRowHandlers>>());
  function makeRowHandlers(id: string) {
    const L = latestRowCallbacks;
    return {
      onToggleExpand: (recursive: boolean) => L.current.toggleExpandRow(id, recursive),
      onActivate: () => L.current.onTrackActivate?.(id),
      onClick: (mods: SelectModifiers) => L.current.selectTrack(id, mods),
      onToggleVisible: () => L.current.onTrackToggleVisible?.(id),
      onToggleLock: () => L.current.onTrackToggleLock?.(id),
      onToggleSolo: (exclusive: boolean) => L.current.onTrackToggleSolo?.(id, exclusive),
      onToggleAudio: () => L.current.onClipMuteToggle?.(id),
      onBlendModeChange: (mode: LayerBlendMode) => L.current.onTrackBlendModeChange?.(id, mode),
      onMatteChange: (matte: unknown) => L.current.onTrackMatteChange?.(id, matte as never),
      onParentChange: (parentId: string | null, options?: { preserveWorld?: boolean; jump?: boolean }) => L.current.onTrackParentChange?.(id, parentId, options),
      onToggleFlag: (flag: Parameters<NonNullable<typeof onTrackToggleFlag>>[1]) => L.current.onTrackToggleFlag?.(id, flag),
      onRename: (name: string) => L.current.onTrackRename?.(id, name),
      onToggleSwitchPin: () => L.current.toggleSwitchPin(id),
      onRowFocus: () => L.current.setActiveTrackId(id),
      onReorderStart: (e: ReactPointerEvent<HTMLDivElement>) => {
        const idx = rowRealIndex.current.get(id) ?? 0;
        rowDrag.current = { id, startY: e.clientY, currentIndex: idx };
        document.body.style.userSelect = 'none';
      },
    };
  }
  const handlersFor = (id: string) => {
    let h = rowHandlerCache.current.get(id);
    if (!h) { h = makeRowHandlers(id); rowHandlerCache.current.set(id, h); }
    return h;
  };
  const rowStyleCache = useRef(new Map<string, CSSProperties>());
  const rowStyleFor = (top: number, height: number): CSSProperties => {
    const key = `${top}|${height}`;
    let st = rowStyleCache.current.get(key);
    if (!st) { st = { position: 'absolute', top, left: 0, right: 0, height }; rowStyleCache.current.set(key, st); }
    return st;
  };
  const [rowDragOver, setRowDragOver] = useState<number | null>(null);

  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      const d = rowDrag.current;
      if (!d || !headerRef.current) return;
      const rect = headerRef.current.getBoundingClientRect();
      const relY = e.clientY - rect.top + (headerRef.current.scrollTop ?? 0);
      const idx = Math.max(0, Math.min(rows.length, Math.round(Math.max(0, relY - TIMELINE_TOP_PADDING) / trackHeight)));
      setRowDragOver(idx);
    };
    const onUp = (): void => {
      const d = rowDrag.current;
      if (!d) return;
      const idx = rowDragOver;
      rowDrag.current = null;
      setRowDragOver(null);
      document.body.style.userSelect = '';
      if (idx === null) return;
      // The pixel math yields FLATTENED row indices (which include expanded
      // property sub-rows), but reorder consumers expect a sibling/track
      // index — convert both sides, else drops land at the wrong position
      // whenever any layer above is expanded.
      const toTrackIndex = (flatIdx: number): number =>
        rows.slice(0, Math.max(0, Math.min(flatIdx, rows.length))).filter((r) => r.type === 'track').length;
      const to = toTrackIndex(idx);
      const from = toTrackIndex(d.currentIndex);
      if (to !== from && to !== from + 1) {
        onTrackReorder?.(d.id, to);
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [rows, trackHeight, rowDragOver, onTrackReorder]);

  // ── Multi-keyframe selection + drag ────────────────────────────
  // Lives in `useKeyframeDrag`; the store-backed selection comes back out
  // because the marquee and the keyboard shortcuts below share it.
  const { selectedKfIds, setSelectedKfIds, kfPreview, onKeyframeDown, scaleGripIds, kfSnap } = useKeyframeDrag({
    model,
    currentTime,
    pps,
    scrollLeft,
    totalSeconds,
    snapOn,
    lanesRef,
    setDragHud,
    onKeyframeMove,
    onKeyframeSeek,
  });

  // ── Marquee (rubber-band) keyframe selection ──────────────────
  const { marqueeRect, onLanesPointerDown } = useMarquee({
    rows,
    lanesRef,
    rulerStackHeight,
    effectiveLanesHeight,
    editMode,
    lanesTimeAt,
    razorAtTime,
    snapRazorTime,
    selectedKfIds,
    setSelectedKfIds,
    pps,
    trackHeight,
  });

  // ── Keyframe selection keyboard shortcuts ──────────────────────
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      if (
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable
      ) {
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedKfIds.size > 0) {
          e.preventDefault();
          e.stopPropagation();
          if (onKeyframesDelete) onKeyframesDelete([...selectedKfIds]);
          else selectedKfIds.forEach(id => onKeyframeMove?.(id, -1));
          setSelectedKfIds(new Set());
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        e.preventDefault();
        e.stopPropagation();
        // Select all keyframes across all tracks
        const allIds = new Set<string>();
        model.tracks.forEach((track) => {
          track.keyframes?.forEach((kf) => allIds.add(kf.id));
          track.properties?.forEach((property) => {
            property.keyframes.forEach((kf) => allIds.add(kf.id));
          });
        });
        setSelectedKfIds(allIds);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedKfIds, model.tracks, onKeyframeMove, onKeyframesDelete, setSelectedKfIds]);

  // ── Ruler ticks ────────────────────────────────────────────────
  const allTicks = useMemo(
    () => generateRulerTicks(
      totalSeconds,
      pps,
      model.frameRate,
      (model.startFrame ?? 0) / (model.frameRate || 30),
      TIMELINE_LEFT_OFFSET,
      // Page-snapped, so this re-runs on a page crossing, not on every scroll.
      timeWindow === OPEN_WINDOW ? undefined : timeWindow,
    ),
    [totalSeconds, pps, model.frameRate, model.startFrame, timeWindow],
  );
  // Only the ticks on screen (plus a page either side) reach the DOM: a long
  // comp zoomed in is thousands of ticks, almost all of them off-screen.
  const ticks = useMemo(() => cullTicks(allTicks, timeWindow, pps, TIMELINE_LEFT_OFFSET), [allTicks, timeWindow, pps]);

  // Layer number column (AE-style) — index within the track order.
  const trackIndexById = useMemo(
    () => new Map(model.tracks.map((t, i) => [t.id, i + 1])),
    [model.tracks],
  );

  /**
   * The category heading to pin while scrolled inside an expanded layer.
   *
   * `scrollTop` is measured from the top of the row list, so the padding above
   * the first row has to come off before it means "which row is at the top".
   */
  const stickyCategory = useMemo(() => {
    const found = stickyCategoryFor(rows, scrollTop - TIMELINE_TOP_PADDING, trackHeight);
    if (!found) return null;
    const row = rows[found.index];
    return row && row.type === 'category' ? { row, offset: found.offset } : null;
  }, [rows, scrollTop, trackHeight]);

  const playheadX = TIMELINE_LEFT_OFFSET + currentTime * pps;

  // ── Live playhead (see `livePlayhead`) ─────────────────────────
  // The three things that move every frame, written straight to the DOM from
  // the clock. In live mode React never manages their position (the JSX below
  // omits it), so a re-render with the throttled time cannot fight them.
  const playheadRef = useRef<HTMLDivElement | null>(null);
  const stickyPlayheadRef = useRef<HTMLDivElement | null>(null);
  const rulerFillRef = useRef<HTMLDivElement | null>(null);
  const liveGeomRef = useRef({ pps, totalSeconds });
  liveGeomRef.current = { pps, totalSeconds };
  useLivePlayhead((t) => {
    const { pps: p, totalSeconds: dur } = liveGeomRef.current;
    const transform = `translateX(${TIMELINE_LEFT_OFFSET + t * p}px)`;
    const line = playheadRef.current;
    if (line) {
      line.style.transform = transform;
      line.setAttribute('aria-valuenow', String(t));
      line.setAttribute('aria-valuetext', `${t.toFixed(2)} seconds`);
    }
    if (stickyPlayheadRef.current) stickyPlayheadRef.current.style.transform = transform;
    if (rulerFillRef.current) rulerFillRef.current.style.width = `${rulerProgressWidth(t, dur, p)}px`;
    followTo(t);
  }, livePlayhead);

  const fps = model.frameRate || 30;

  // `data-edit-mode` publishes the armed tool to CSS. Cursors are the one part
  // of a mode that has to reach elements this component does not re-render when
  // the mode changes — every clip bar, on every virtualized row — and one
  // attribute on the root covers all of them for a single write.
  return (
    <div
      ref={containerRef}
      className={cn(styles.root, className)}
      onWheel={onWheel}
      /* `s` is claimed so the snap switch can take it WITH THE TIMELINE
         FOCUSED while the global `S` (reveal Scale) keeps working everywhere
         else — ShortcutManager listens in the capture phase and skips a chord
         an ancestor of the focused element has claimed.
         `j` / `k` are claimed for the same reason: here they are AE's previous
         / next keyframe (`useTimelineKeys`, which reads this very claim),
         everywhere else they are the transport's shuttle. Unclaimed, `k` was
         dispatched to a global chord in the capture phase and "next keyframe"
         never ran while `j`, its twin, did. */
      data-shortcut-claim="delete backspace shift+delete Ctrl+a Meta+a s m alt+m j k"
      data-tour="timeline"
      data-edit-mode={editMode}
      onKeyDown={(e) => {
        if (e.ctrlKey || e.metaKey) return;
        const t = e.target as HTMLElement | null;
        if (t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA' || t?.isContentEditable) return;
        // `S` — the snap switch, panel-scoped so the global `S` (reveal Scale)
        // keeps working everywhere else. See `snapCommands`.
        if ((e.key === 's' || e.key === 'S') && !e.altKey) {
          e.preventDefault();
          e.stopPropagation();
          toggleTimelineSnap();
          return;
        }
        // `M` — a comp marker at the playhead; `Alt+M` — a layer marker on
        // each selected layer. Claimed rather than registered globally for the
        // same reason `S` is: a bare letter taken globally is taken from every
        // other panel forever.
        if (e.key === 'm' || e.key === 'M') {
          e.preventDefault();
          e.stopPropagation();
          if (e.altKey) addLayerMarkersAtPlayhead();
          else addCompMarkerAtPlayhead();
          return;
        }
        // `Shift+Delete` — ripple delete: the layers go AND the gap closes.
        // Guarded on a keyframe selection being empty, because plain Delete on
        // this panel means "delete the selected keyframes" and Shift must not
        // silently escalate that to deleting their layers.
        if (e.shiftKey && e.key === 'Delete' && selectedKfIds.size === 0) {
          e.preventDefault();
          e.stopPropagation();
          rippleDeleteSelection();
          return;
        }
        // Plain `Delete` / `Backspace` with no keyframes selected — the
        // selected LAYERS. The claim above exists so a keyframe selection can
        // own these keys, but a claim makes ShortcutManager skip them whatever
        // is selected, and nothing here picked them back up: click a layer's
        // name (which focuses its header, inside the claim), press Delete,
        // and nothing happened. A `<select>` keeps its own keys, and the
        // keyframe and transition deletes are untouched — the first is the
        // `selectedKfIds` guard, the second runs in the capture phase and has
        // already stopped the event by the time it would reach this handler.
        if (
          (e.key === 'Delete' || e.key === 'Backspace') &&
          !e.shiftKey && !e.altKey &&
          t?.tagName !== 'SELECT' &&
          selectedKfIds.size === 0 &&
          deleteSelectionFromTimeline()
        ) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
    >
      {/* No tool row of this component's own. The edit tools, the transition
          chips, snap and follow render in the timeline PANEL's toolbar row
          (`BottomTimeline` sub-header), the one row between the comp tabs and
          the tracks — so the panel has one header, not three. */}

      {/* A refusal, spelled out. Dismissed by clicking it or by the next
          successful transition; deliberately not a modal, because the fix
          (shorter transition, or trim the clips) is made in the timeline
          underneath it. */}
      {transitionError && (
        <div
          className={styles.transitionError}
          role="status"
          onClick={() => setTransitionError(null)}
          title="Click to dismiss"
        >
          {transitionError}
        </div>
      )}

      {/* Drag read-out for slip / slide / roll. `position: fixed` in CLIENT
          coordinates: the pointer is captured by the lanes but travels over the
          ruler, the header column and out of the panel entirely, and a badge
          positioned inside the scrolling lanes would be left behind by its own
          scroll offset the moment the drag auto-scrolled. */}
      <DragHud hud={dragHud} />

      <div
        className={styles.headerCol}
        style={{ width: headerWidth, height: '100%' }}
        onWheel={onHeaderWheel}
      >
        {/* The header column's band matches the lanes' whole sticky stack —
            ruler PLUS the marker and transcript lanes — or the track headers
            stop lining up with the lanes they name. The legend itself is
            pinned to the bottom `rulerHeight` of it, beside the real ruler. */}
        <div className={styles.ruler} style={{ height: rulerStackHeight }}>
          {/* Column heads for the switches and modes (AE layout). */}
          <div ref={colHeadsRef} className={styles.colHeads} style={{ top: rulerChromeHeight }}>
            {/* A/V toggles come FIRST, as they do in AE — the eye / solo / lock
                gutter is the left edge of the panel there, not something that
                trails the layer name. `.trackHeader` below is ordered to
                match; the two must stay in step or the legend names the wrong
                control. */}
            <div className={styles.colHeadPreInfo} aria-hidden>
              <span className={styles.colHeadItem}><Icon name="eye" size="sm" title="Video Visibility" /></span>
              <span className={styles.colHeadItem}><Icon name="audio" size="sm" title="Audio" /></span>
              <span className={styles.colHeadItem}><Icon name="circle" size="sm" title="Solo" /></span>
              <span className={styles.colHeadItem}><Icon name="lock" size="sm" title="Lock" /></span>
            </div>
            <span className={styles.colHeadLayer}>
              <span className={styles.colHeadIndex} aria-hidden>#</span>
              <span className={styles.colHeadLayerLabel}>Source Name</span>
              <button
                type="button"
                className={styles.colHeadPopOut}
                onClick={() => {
                  const url = `${window.location.origin}${window.location.pathname}#/popout/timeline`;
                  window.open(url, 'popout-timeline', 'width=1280,height=500,resizable=yes');
                }}
                title="Pop Out Timeline into Separate Window"
                aria-label="Pop out timeline into a separate window"
              >
                <Icon name="export" size="sm" />
              </button>
            </span>
            {/* Legend for the per-layer switch column below — one glyph per
                switch that actually exists on the rows, in ROW ORDER. The
                guide-layer glyph is not optional: `data-kind="guide"` ships on
                every row between adjustment and 3D, and a legend that skips a
                live switch is worse than no legend. */}
            {showSwitches && (
              <span className={styles.colHeadAeSwitches} aria-hidden>
                <span className={styles.colHeadItem}><Icon name="shy" size="sm" title="Shy" /></span>
                <span className={styles.colHeadItem}><Icon name="star" size="sm" title="Collapse Transformations / Continuous Rasterize" /></span>
                <span className={styles.colHeadItem}><span className={styles.fxText} title="Quality">/</span></span>
                <span className={styles.colHeadItem}><span className={styles.fxText} title="Effects">fx</span></span>
                <span className={styles.colHeadItem}><Icon name="video" size="sm" title="Frame Blending" /></span>
                <span className={styles.colHeadItem}><Icon name="motion-blur" size="sm" title="Motion Blur" /></span>
                <span className={styles.colHeadItem}><Icon name="adjustment" size="sm" title="Adjustment Layer" /></span>
                <span className={styles.colHeadItem}><Icon name="frame" size="sm" title="Guide Layer (not rendered)" /></span>
                <span className={styles.colHeadItem}><span className={styles.fxText} title="Preserve Underlying Transparency">T</span></span>
                <span className={styles.colHeadItem}><Icon name="3d" size="sm" title="3D Layer" /></span>
              </span>
            )}
            {showModes && (
              <>
                <span className={styles.colHeadMode}>Mode</span>
                <span className={styles.colHeadMatte}>TrkMat</span>
                <span className={styles.colHeadParent}>Parent &amp; Link</span>
              </>
            )}
            {extraColumns.map((id) => {
              const def = TIMELINE_EXTRA_COLUMNS.find((c) => c.id === id)!;
              return (
                <span key={id} className={styles.colHeadExtra} title={def.description}>
                  {def.label}
                </span>
              );
            })}
          </div>
        </div>
        <div
          ref={headerRef}
          className={styles.trackHeaderScroller}
          style={{ height: `calc(100% - ${rulerStackHeight}px)` }}
          onScroll={(e) => {
            const x = (e.currentTarget as HTMLDivElement).scrollLeft;
            if (colHeadsRef.current) colHeadsRef.current.style.transform = `translateX(${-x}px)`;
          }}
        >
          {/*
            A LISTBOX, and the arrow keys that come with one.

            Every row was `tabIndex={0}`, so reaching the tenth layer from the
            top of the panel cost ten tabs — and Tab is how you leave a control,
            not how you move within a list. One tab stop plus Up/Down is the
            listbox contract, and it is what the layer list already looked like.
          */}
          <div
            role="listbox"
            aria-label="Timeline layers"
            aria-multiselectable="true"
            style={{ height: effectiveLanesHeight, position: 'relative' }}
            onKeyDown={onRowListKey}
          >
            {visibleRows.map((row, i) => {
              const realIndex = startRow + i;
              const rowStyle = rowStyleFor(TIMELINE_TOP_PADDING + realIndex * trackHeight, trackHeight);
              if (row.type === 'track') {
                rowRealIndex.current.set(row.track.id, realIndex);
                const h = handlersFor(row.track.id);
                return (
                  <TrackHeader
                    key={`h_${row.track.id}`}
                    track={row.track}
                    index={trackIndexById.get(row.track.id) ?? 0}
                    selected={selectedTrackIds?.includes(row.track.id) ?? false}
                    expanded={row.expanded}
                    hasProps={row.hasProps}
                    onToggleExpand={h.onToggleExpand}
                    onActivate={h.onActivate}
                    onClick={h.onClick}
                    onToggleVisible={h.onToggleVisible}
                    onToggleLock={h.onToggleLock}
                    onToggleSolo={h.onToggleSolo}
                    onToggleAudio={onClipMuteToggle ? h.onToggleAudio : undefined}
                    onBlendModeChange={h.onBlendModeChange}
                    onMatteChange={h.onMatteChange}
                    onParentChange={h.onParentChange}
                    onToggleFlag={h.onToggleFlag}
                    onRename={h.onRename}
                    onTrackColorChange={onTrackColorChange}
                    switchesOnHover={switchesOnHover}
                    switchesPinned={pinnedSwitchRows.has(row.track.id)}
                    onToggleSwitchPin={h.onToggleSwitchPin}
                    showSwitches={showSwitches}
                    showModes={showModes}
                    extraColumns={extraColumns}
                    frameRate={fps}
                    active={
                      activeTrackId === null
                        ? realIndex === firstTrackRowIndex
                        : activeTrackId === row.track.id
                    }
                    onRowFocus={h.onRowFocus}
                    onReorderStart={row.track.locked ? noopReorderStart : h.onReorderStart}
                    style={rowStyle}
                  />
                );
              }
              if (row.type === 'category') {
                const categoryStyle: CSSProperties = {
                  ...rowStyle,
                  paddingLeft: 88 + (row.track.depth ?? 0) * 14,
                };
                return (
                  <TrackCategoryHeader
                    key={`h_${row.track.id}_cat_${row.categoryKey}`}
                    label={row.label}
                    icon={row.icon}
                    expanded={row.expanded}
                    count={row.count}
                    style={categoryStyle}
                    onToggle={() => toggleCategory(row.track.id, row.categoryKey)}
                    // AE's Transform group "Reset": keyframes off, defaults back.
                    onReset={
                      row.categoryKey === 'transform'
                        ? () => { resetTransforms([row.track.id], useCompositionStore.getState()); }
                        : undefined
                    }
                  />
                );
              }
              const propStyle: CSSProperties = {
                ...rowStyle,
                paddingLeft: 124 + (row.track.depth ?? 0) * 14,
              };
              return (
                <PropertyHeader
                  key={`h_${row.track.id}_${row.prop.prop}`}
                  whipNodeId={row.track.id}
                  whipProp={row.prop.prop}
                  label={row.prop.label}
                  style={propStyle}
                  keyframes={row.prop.keyframes}
                  currentTime={currentTime}
                  animated={row.prop.animated !== false}
                  onToggleKeyframe={
                    onPropertyKeyframeToggle
                      ? () => onPropertyKeyframeToggle(row.track.id, row.prop.prop)
                      : undefined
                  }
                  onStopwatch={
                    onPropertyStopwatch && row.prop.stopwatchProps
                      ? () => onPropertyStopwatch(row.track.id, row.prop.stopwatchProps!)
                      : undefined
                  }
                  valueProps={row.prop.valueProps}
                  valueUnit={row.prop.valueUnit}
                  propertyValue={
                    onPropertyValue ? (p) => onPropertyValue(row.track.id, p) : undefined
                  }
                  onValueChange={
                    onPropertyValueChange
                      ? (p, v) => onPropertyValueChange(row.track.id, p, v)
                      : undefined
                  }
                  onScrubStart={
                    onPropertyScrubStart ? (p) => onPropertyScrubStart(row.track.id, p) : undefined
                  }
                  onScrubEnd={onPropertyScrubEnd}
                  selected={
                    // A row is selected when ANY of the props it edits is — a
                    // merged Position row stands for x and y together.
                    !!selectedPropertyKeys?.some((k) =>
                      (row.prop.valueProps ?? row.prop.stopwatchProps ?? [row.prop.prop]).some(
                        (p) => k === `${row.track.id}::${p}`,
                      ),
                    )
                  }
                  onSelect={
                    onPropertySelect
                      ? (mode) => {
                          for (const p of row.prop.valueProps ?? row.prop.stopwatchProps ?? [row.prop.prop]) {
                            onPropertySelect(row.track.id, p, mode);
                            // A plain click replaces, but a row with several
                            // props must end up with ALL of them selected.
                            mode = 'toggle';
                          }
                        }
                      : undefined
                  }
                  onSeek={onScrub}
                  contextMenuItems={() => {
                    // Every real prop behind the row — a merged Position row
                    // resets x, y (and z) together, as AE's Reset does.
                    const props = row.prop.stopwatchProps ?? row.prop.valueProps ?? [row.prop.prop];
                    return [
                      {
                        id: 'reset',
                        label: 'Reset',
                        disabled: !canResetProperties(row.track.id, props),
                        onSelect: () => {
                          resetProperties(row.track.id, props, useCompositionStore.getState(), `Reset ${row.prop.label}`);
                        },
                      },
                      { id: 'expr-sep', separator: true },
                      // AE's Add / Enable-Disable / Remove Expression — the same
                      // helper (and undo step) as the inspector's `=` toggle.
                      ...expressionMenuItems(row.track.id, props),
                    ];
                  }}
                />
              );
            })}
            {/* ── The pinned category heading ─────────────────────────
                Scroll into a layer's forty effect parameters and the "Effects"
                heading is the first thing off the top of the panel; what is
                left is forty rows called "Radius" and "Amount" with nothing
                saying what they belong to. `position: sticky` cannot do this —
                the rows are absolutely positioned AND virtualized, so the real
                heading is unmounted at exactly the moment it would need to
                stick — so one extra copy is drawn, pinned, and pushed up by
                the next section as it arrives. See `stickyCategory.ts`. */}
            {stickyCategory ? (
              <TrackCategoryHeader
                label={stickyCategory.row.label}
                icon={stickyCategory.row.icon}
                expanded={stickyCategory.row.expanded}
                count={stickyCategory.row.count}
                sticky
                style={{
                  position: 'absolute',
                  top: scrollTop + stickyCategory.offset,
                  left: 0,
                  right: 0,
                  height: trackHeight,
                  zIndex: 3,
                }}
                onToggle={() =>
                  toggleCategory(stickyCategory.row.track.id, stickyCategory.row.categoryKey)
                }
                onReset={
                  stickyCategory.row.categoryKey === 'transform'
                    ? () => { resetTransforms([stickyCategory.row.track.id], useCompositionStore.getState()); }
                    : undefined
                }
              />
            ) : null}

            {/* Drop indicator — horizontal line showing insertion target during row drag */}
            {rowDragOver !== null && (
              <div
                className={styles.dropIndicator}
                style={{ top: TIMELINE_TOP_PADDING + rowDragOver * trackHeight }}
                aria-hidden
              />
            )}
          </div>
        </div>
      </div>

      {/* Drag the column edge to widen the header (AE-style). */}
      <div
        className={styles.headerResizer}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize track header column"
        onPointerDown={onHeaderResizeDown}
        onPointerMove={onHeaderResizeMove}
        onPointerUp={onHeaderResizeUp}
        onDoubleClick={() => setPref('timelineHeaderWidth', minHeaderWidth)}
        title="Drag to resize · double-click to reset"
      >
        {/* ── Row height ──────────────────────────────────────────────
            A grip where the header column meets the lanes, dragged VERTICALLY.
            The three presets already existed behind a button in the sub-header
            that cycles them, and a cycle is the wrong control for a continuous
            quantity: you press it three times to find out what the sizes are
            and then live with whichever was closest. Dragging answers "as tall
            as THIS" directly. Double-click returns to the compact default,
            which is the one preset anybody wants back.

            It sits INSIDE the column resizer so the two size gestures share
            one seam, and stops propagation so a vertical drag is never also a
            column-width drag. */}
        <div
          className={styles.rowHeightGrip}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Row height"
          aria-valuemin={ROW_HEIGHT_MIN}
          aria-valuemax={ROW_HEIGHT_MAX}
          aria-valuenow={trackHeight}
          title={`Row height ${trackHeight}px — drag up/down · double-click to reset`}
          onPointerDown={onRowHeightDown}
          onPointerMove={onRowHeightMove}
          onPointerUp={onRowHeightUp}
          onDoubleClick={(e) => {
            e.stopPropagation();
            setPref('timelineRowHeight', ROW_HEIGHT_PRESETS[0]);
          }}
        >
          <Icon name="grip-horizontal" size="sm" />
        </div>
      </div>
      {/* The razor's pointer tracking is bound ONLY while the razor is armed:
          it fires at pointer rate over the busiest element in the panel, and a
          handler that spends every one of those calls deciding it has nothing
          to do is a cost paid by every user who never picks up the tool. */}
      <div
        ref={lanesRef}
        className={styles.lanes}
        data-timeline-lanes=""
        onScroll={onLanesScroll}
        onPointerMove={editMode === 'razor' ? onRazorPointerMove : undefined}
        onPointerLeave={editMode === 'razor' ? clearRazorAt : undefined}
      >
        <div
          style={{
            width: laneWidth,
            minWidth: '100%',
            height: rulerStackHeight + effectiveLanesHeight,
            position: 'relative',
          }}
        >
          {/* The time header STICKS to the top of the lanes viewport.
              Ruler, cache bars, work area and the playhead grabber ride in one
              sticky stack: expand a layer's properties, scroll down, and the
              frame ruler is still there to scrub against. Before this they
              scrolled away with the rows and every frame change meant
              scrolling back up first. The composition-duration handle stays
              OUTSIDE the stack — it spans ruler + lanes, so it cannot stick. */}
          <div className={styles.stickyChrome} style={{ height: rulerStackHeight }}>
            {/* ── Marker lane ─────────────────────────────────────────
                ABOVE the ruler, not in it. A marker chip inside the ruler
                competes with the two gestures that band already owns —
                scrubbing and the work-area drag — for the same 26 pixels; up
                here it has a row of its own and the ruler keeps its whole
                height for the scrub. The full-height guide is still drawn down
                through the lanes below, and still takes no pointer events. */}
            <MarkerLane
              markers={model.markers}
              pps={pps}
              leftOffset={TIMELINE_LEFT_OFFSET}
              width={laneWidth}
              fps={fps}
              duration={model.duration}
              snap={snapOn}
              onSeek={onScrub}
            />

          <div className={styles.rulerStack} style={{ height: rulerHeight }}>
            <Ruler
              ticks={ticks}
              height={rulerHeight}
              width={laneWidth}
              onPointerDown={onPlayheadDown}
              currentTime={currentTime}
              duration={totalSeconds}
              pixelsPerSecond={pps}
              leftOffset={TIMELINE_LEFT_OFFSET}
              fillRef={livePlayhead ? rulerFillRef : undefined}
            />

            {/* Preview-coverage lanes (green = RAM, blue = disk). They
                SUBSCRIBE THEMSELVES to the frame cache rather than taking
                coverage as a prop: it changes on every rendered frame, and
                routing that through this component's model would re-render the
                whole timeline — and the app shell above it — 60 times a second.
                See CacheBars for the throttling. */}
            <CacheBars
              fps={fps}
              pixelsPerSecond={pps}
              leftOffset={TIMELINE_LEFT_OFFSET}
              rulerHeight={rulerHeight}
            />

            {/* Work-area band on the ruler (in/out region for looped playback).
                Drag the body to move it; drag an edge handle to trim in/out. */}
            {model.workArea ? (
              <div
                className={styles.workAreaBar}
                style={{
                  top: 14,
                  height: Math.max(12, rulerHeight - 17),
                  left: TIMELINE_LEFT_OFFSET + model.workArea.start * pps,
                  width: Math.max(2, (model.workArea.end - model.workArea.start) * pps),
                }}
                title="Work area — drag to move, drag edges to trim"
                aria-label="Work area"
                onPointerDown={onWorkAreaChange ? startWaDrag('move') : undefined}
              >
                <div
                  className={styles.workAreaHandle}
                  data-edge="in"
                  aria-label="Work area in"
                  onPointerDown={onWorkAreaChange ? startWaDrag('in') : undefined}
                />
                <div
                  className={styles.workAreaHandle}
                  data-edge="out"
                  aria-label="Work area out"
                  onPointerDown={onWorkAreaChange ? startWaDrag('out') : undefined}
                />
              </div>
            ) : null}

            {/* Playhead grabber, pinned to the ruler. The full-height line below
                lives in `lanesInner` and scrolls; this is the part you drag, so
                it has to stay reachable at any scroll offset. */}
            <div
              ref={stickyPlayheadRef}
              className={styles.stickyPlayhead}
              style={livePlayhead ? { height: rulerHeight } : { transform: `translateX(${playheadX}px)`, height: rulerHeight }}
              onPointerDown={onPlayheadDown}
              aria-hidden
            >
              <div className={styles.playheadHead} />
            </div>
          </div>

            {/* ── Transcript lane ─────────────────────────────────────
                UNDER the ruler, so the words sit between the time they are
                spoken at and the layers that show it. Opt-in: it is only
                meaningful for a comp that has been transcribed, and it costs
                the tracks their height. */}
            {transcriptLaneOn ? (
              <TranscriptLane
                rootId={activeCompRootId()}
                pps={pps}
                leftOffset={TIMELINE_LEFT_OFFSET}
                width={laneWidth}
                top={0}
                window={timeWindow}
                onSeek={onScrub}
              />
            ) : null}
          </div>

          {/* Composition duration drag handle on the ruler */}
          {onDurationChange ? (
            <div
              className={styles.durationHandle}
              style={{
                position: 'absolute',
                top: 0,
                height: rulerStackHeight + effectiveLanesHeight,
                left: TIMELINE_LEFT_OFFSET + model.duration * pps,
                width: 8,
                transform: 'translateX(-4px)',
                cursor: 'ew-resize',
                zIndex: 25,
              }}
              title="Drag to adjust composition duration"
              onPointerDown={startDurationDrag}
            >
              {/* The visual line */}
              <div
                style={{
                  position: 'absolute',
                  left: 3,
                  top: 0,
                  width: 2,
                  height: '100%',
                  backgroundColor: 'var(--color-primary)',
                  opacity: 0.8,
                }}
              />
              {/* The handle cap on the ruler */}
              <div
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  width: 8,
                  height: 8,
                  backgroundColor: 'var(--color-primary)',
                  borderRadius: '0 0 4px 4px',
                }}
              />
            </div>
          ) : null}

          <div
            className={styles.lanesInner}
            style={{ position: 'absolute', top: rulerStackHeight, left: 0, right: 0, height: effectiveLanesHeight }}
            onPointerDown={onLanesPointerDown}
            onDragOver={onLanesDragOver}
            onDragLeave={() => {
              setDropCutKey(null);
              setChipDragging(false);
            }}
            onDrop={onLanesDrop}
            onDoubleClick={onLanesDoubleClick}
          >
            {/* Snap indicator — a vertical line at whatever the in-flight drag
                latched onto. Without it, snapping is a mystery force: the
                keyframe stops where you did not put it and nothing says why. */}
            {kfSnap && (
              <div
                className={cn(
                  styles.kfSnapLine,
                  kfSnap.kind === 'playhead' && styles.kfSnapPlayhead,
                  kfSnap.kind === 'keyframe' && styles.kfSnapKeyframe,
                )}
                style={{ transform: `translateX(${TIMELINE_LEFT_OFFSET + kfSnap.time * pps}px)` }}
                aria-hidden
              />
            )}

            {/* The same indicator for a CLIP drag. Coloured by what was hit, so
                the line says *why* the bar stopped there — butted against a
                neighbour reads differently from parked on the playhead. */}
            {clipSnap && (
              <div
                className={cn(
                  styles.kfSnapLine,
                  clipSnap.kind === 'playhead' && styles.kfSnapPlayhead,
                  clipSnap.kind === 'clip' && styles.clipSnapClip,
                  clipSnap.kind === 'marker' && styles.clipSnapMarker,
                  (clipSnap.kind === 'workArea' || clipSnap.kind === 'comp') && styles.clipSnapBound,
                )}
                style={{ transform: `translateX(${TIMELINE_LEFT_OFFSET + clipSnap.time * pps}px)` }}
                aria-hidden
              />
            )}

            {/* The razor's aim: a full-height line at the frame a click would
                cut, already snapped. Distinct from the snap guide above — that
                one reports where a drag LANDED, this one predicts where a click
                will land, so it is drawn in the razor's own colour. */}
            {editMode === 'razor' && razorAt !== null && (
              <div
                className={cn(styles.kfSnapLine, styles.razorLine)}
                style={{ transform: `translateX(${TIMELINE_LEFT_OFFSET + razorAt * pps}px)` }}
                aria-hidden
              />
            )}

            {/* Row backgrounds */}
            {visibleRows.map((row, i) => {
              const realIndex = startRow + i;
              const key = row.type === 'track'
                ? `bg_${row.track.id}`
                : row.type === 'category'
                  ? `bg_${row.track.id}_cat_${row.categoryKey}`
                  : `bg_${row.track.id}_${row.prop.prop}`;
              return (
                <div
                  key={key}
                  className={cn(
                    styles.lane,
                    row.type === 'prop' && styles.lanePropBg,
                    realIndex % 2 === 0 && styles.laneAlt,
                  )}
                  style={{ position: 'absolute', top: TIMELINE_TOP_PADDING + realIndex * trackHeight, left: 0, right: 0, height: trackHeight }}
                />
              );
            })}

            {/* Row content: animation block + keyframes */}
            {visibleRows.map((row, i) => {
              const realIndex = startRow + i;
              const top = TIMELINE_TOP_PADDING + realIndex * trackHeight;
              if (row.type === 'track') {
                return (
                  <TrackContent
                    key={`c_${row.track.id}`}
                    track={row.track}
                    ghosted={row.track.ghosted ?? false}
                    pps={pps}
                    trackHeight={trackHeight}
                    top={top}
                    selected={selectedTrackIds?.includes(row.track.id) ?? false}
                    clipPreviews={previewsForRow(clipPreviews, row.track.clips)}
                    window={timeWindow}
                    onClipDown={onClipDown}
                    onClipContextMenu={onClipContextMenu}
                    onActivate={onTrackActivate}
                    clipMuted={row.track.audioMuted}
                    onClipMuteToggle={onClipMuteToggle}
                  />
                );
              }
              if (row.type === 'category') {
                return (
                  <LaneRow key={`c_${row.track.id}_cat_${row.categoryKey}`} top={top} trackHeight={trackHeight}>
                    <div />
                  </LaneRow>
                );
              }
              // AE's LL row: peaks, not diamonds. It carries no keyframes, so
              // rendering the usual lane would draw an empty strip.
              if (row.prop.prop === AUDIO_WAVEFORM_ROW) {
                return (
                  <LaneRow key={`c_${row.track.id}_wave`} top={top} trackHeight={trackHeight}>
                    <WaveformLane clips={row.track.clips ?? []} pps={pps} trackHeight={trackHeight} />
                  </LaneRow>
                );
              }
              return (
                <LaneRow key={`c_${row.track.id}_${row.prop.prop}`} top={top} trackHeight={trackHeight}>
                  <Keyframes
                    keyframes={row.prop.keyframes}
                    pps={pps}
                    fps={fps}
                    startFrame={model.startFrame ?? 0}
                    kfPreview={kfPreviewForRow(kfPreview, row.prop.keyframes)}
                    selectedKfIds={selectedKfIds}
                    scaleGripIds={scaleGripIds}
                    window={timeWindow}
                    locked={row.track.locked === true}
                    onKeyframeDown={onKeyframeDown}
                    onKeyframeContextMenu={onKeyframeContextMenu}
                  />
                </LaneRow>
              );
            })}

            {/* ── Cut markers ─────────────────────────────────────────
                Purely visual: a narrow strip at every cut that lights while a
                chip hovers it. It takes NO pointer events, deliberately — the
                strip sits exactly where both clips' trim handles are, and an
                interactive element there would eat the one gesture the user is
                most likely to want at a cut. The drag, the drop and the
                double-click are all handled by the lanes, which already know
                where the pointer is. */}
            {clipCuts.map((cut) => {
              const topRow = trackRowIndex.get(cut.leftTrackId);
              const bottomRow = trackRowIndex.get(cut.rightTrackId);
              if (topRow === undefined || bottomRow === undefined) return null;
              const first = Math.min(topRow, bottomRow);
              const last = Math.max(topRow, bottomRow);
              const key = cutKeyOf(cut);
              if (!chipDragging) return null;
              const over = dropCutKey === key;
              return (
                <div
                  key={key}
                  className={cn(styles.cutZone, over && styles.cutZoneOver)}
                  style={{
                    left: TIMELINE_LEFT_OFFSET + cut.time * pps - CUT_ZONE_PX / 2,
                    width: CUT_ZONE_PX,
                    top: TIMELINE_TOP_PADDING + first * trackHeight,
                    height: (last - first + 1) * trackHeight,
                  }}
                  aria-hidden
                />
              );
            })}

            {/* ── Transition brackets ─────────────────────────────────
                A bracket over the overlap rather than a bar in a lane of its
                own: the transition belongs to BOTH clips, and giving it a row
                would make it look like a third layer that could be moved
                independently of the two it joins. The ends are grips. */}
            {transitionBoxes.map((box) => {
              const selected = box.id === selectedTransitionId;
              // The layout box carries only geometry; the alignment lives on
              // the record, which is also what the toggle writes back to.
              const alignment =
                allTransitions.find((t) => t.id === box.id)?.alignment ?? 'centred';
              return (
                <div
                  key={box.id}
                  className={cn(styles.transitionBox, selected && styles.transitionBoxSelected)}
                  data-kind={box.kind}
                  style={{
                    left: TIMELINE_LEFT_OFFSET + box.start * pps,
                    width: Math.max(2, (box.end - box.start) * pps),
                    top: TIMELINE_TOP_PADDING + box.topRow * trackHeight,
                    height: (box.bottomRow - box.topRow + 1) * trackHeight,
                  }}
                  title={`${TRANSITION_LABEL[box.kind]} — drag an end to change its length, Delete to remove`}
                  aria-label={`${TRANSITION_LABEL[box.kind]} transition, ${TRANSITION_ALIGNMENT_LABEL[alignment].toLowerCase()}`}
                  onPointerDown={(e) => {
                    // Stopped so the press does not also start a clip drag or a
                    // marquee on the lane beneath.
                    e.stopPropagation();
                    setSelectedTransitionId(box.id);
                  }}
                >
                  <div
                    className={styles.transitionGrip}
                    data-edge="start"
                    aria-hidden
                    onPointerDown={(e) => onTransitionEdgeDown(box, 'start', e)}
                  />
                  {/* The kind label doubles as the alignment toggle: one
                      click steps centred → start-at-cut → end-at-cut, and the
                      bracket redraws where it now sits. */}
                  <button
                    type="button"
                    className={cn(styles.transitionLabel, styles.transitionAlign)}
                    data-alignment={alignment}
                    title={`${TRANSITION_LABEL[box.kind]} · ${TRANSITION_ALIGNMENT_LABEL[alignment]} — click to change alignment`}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      cycleTransitionAlignment(box.id);
                    }}
                  >
                    {box.label}
                  </button>
                  <div
                    className={styles.transitionGrip}
                    data-edge="end"
                    aria-hidden
                    onPointerDown={(e) => onTransitionEdgeDown(box, 'end', e)}
                  />
                </div>
              );
            })}

            {/* Past-comp-end shade — clips may overhang the composition (AE-style);
                this darkens the region beyond the comp so the bound stays legible. */}
            {contentSeconds > totalSeconds ? (
              <div
                className={styles.pastEndShade}
                style={{
                  left: TIMELINE_LEFT_OFFSET + totalSeconds * pps,
                  width: (contentSeconds + 1 - totalSeconds) * pps,
                  height: effectiveLanesHeight,
                }}
                aria-hidden
              />
            ) : null}

            {/* Work-area tint spanning all lanes (visual context for the region). */}
            {model.workArea ? (
              <div
                className={styles.workAreaTint}
                style={{
                  left: TIMELINE_LEFT_OFFSET + model.workArea.start * pps,
                  width: Math.max(2, (model.workArea.end - model.workArea.start) * pps),
                  height: effectiveLanesHeight,
                }}
                aria-hidden
              />
            ) : null}

            {/* ── "What changed" heat ─────────────────────────────────
                A self-subscribing, throttled leaf — the same shape as
                `CacheBars` and for the same reason: the answer moves on every
                edit, and carrying it in the model would replace the object the
                panel's whole memoization story is built on. Off by default and
                free when off. */}
            <HeatLane
              source={heatSource}
              tracks={model.tracks}
              trackRowIndex={trackRowIndex}
              pps={pps}
              leftOffset={TIMELINE_LEFT_OFFSET}
              trackHeight={trackHeight}
              topPadding={TIMELINE_TOP_PADDING}
              window={timeWindow}
            />

            {/* Marker GUIDES — the full-height line only. The chip you grab
                lives in `<MarkerLane>` above the ruler; this is the part that
                has to reach down through the lanes and must therefore stay
                click-through, or it would eat every gesture on every row it
                crosses. */}
            {model.markers.filter((m) => timeInWindow(m.time, timeWindow)).map((m) => (
              <div
                key={m.id}
                className={styles.marker}
                style={{
                  transform: `translateX(${TIMELINE_LEFT_OFFSET + m.time * pps}px)`,
                  color: m.color ?? undefined,
                }}
                aria-hidden
              />
            ))}

            {/* Marquee selection rectangle (drag on empty lane space). */}
            {marqueeRect ? (
              <div
                className={styles.marquee}
                style={{
                  left: marqueeRect.left,
                  top: marqueeRect.top,
                  width: marqueeRect.right - marqueeRect.left,
                  height: marqueeRect.bottom - marqueeRect.top,
                }}
                aria-hidden
              />
            ) : null}

            {/* Playhead */}
            <div
              ref={playheadRef}
              className={styles.playhead}
              style={livePlayhead ? { height: effectiveLanesHeight } : { transform: `translateX(${playheadX}px)`, height: effectiveLanesHeight }}
              onPointerDown={onPlayheadDown}
              onKeyDown={onPlayheadKey}
              tabIndex={0}
              role="slider"
              aria-label="Playhead"
              aria-orientation="horizontal"
              aria-valuemin={0}
              aria-valuemax={model.duration}
              aria-valuenow={livePlayhead ? undefined : currentTime}
              aria-valuetext={livePlayhead ? undefined : `${currentTime.toFixed(2)} seconds`}
            >
              <div className={styles.playheadHead} />
            </div>
          </div>
        </div>
      </div>

      {/* Layer minimap — auto-appears only when layers exceed one screen. */}
      {minimapShown ? (
        <Minimap
          ref={minimapRef}
          rows={rows}
          trackHeight={trackHeight}
          totalHeight={totalLanesHeight}
          viewportTop={rulerStackHeight}
          viewportHeight={size.height - rulerStackHeight}
          scrollTop={scrollTop}
          onScrollTo={onMinimapScrollTo}
        />
      ) : null}
    </div>
  );
}

/**
 * Memoize so that the row tree (and its many sub-memos) does not re-run
 * whenever the host re-renders for an unrelated reason — the entire point
 * of the `playheadTime` prop is that the model can stay referentially
 * stable across playback frames, and a plain `React.memo` on this entry
 * point makes that promise real.
 *
 * The file is consumed as `import { Timeline } from './Timeline'`; this
 * `React.memo` wrap is what that name resolves to, so consumers get the
 * skipped-render behavior for free.
 */
const MemoizedTimeline = memo(Timeline);

/** For a locked row: the reorder gesture must not start, and a stable no-op keeps the memo. */
function noopReorderStart(): void {}
export { MemoizedTimeline as Timeline };
