/**
 * BottomTimeline — bottom region host.
 *
 *   <BottomTimeline model={...} onScrub={...} />
 *
 * For now it just renders the Timeline component inside the panel. The
 * transport bar (play / pause / jump) is provided as a default but the
 * engine can replace it via the `transport` prop.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import { TIMELINE_PPS_MAX, TIMELINE_PPS_MIN } from '@layout/Timeline/zoomAnchor';
import { Icon } from '@components/Icon';
import { SearchField } from '@components/SearchField';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { activeCompIdNow, useActiveMirrorComp } from '@hooks/useMirror';
import { documentMirror } from '@stores/documentMirror';
import { settingsStartFrame } from '@core/mirror/compFacts';
import { framesToTimecode } from '@core/time/timecode';
import { Timeline, type TimelineProps } from '@layout/Timeline';
import { previewCacheMenuItems, usePreviewCacheStats } from '@layout/Timeline/CacheActions';
import { GraphEditor } from '@layout/Timeline/GraphEditor';
import { TimelineSnapButton, useTimelineToolsMenu } from '@layout/Timeline/TimelineTools';
import { useTransportDemote } from '@layout/Workspace/useTransportDemote';
import { cn } from '@utils/cn';
import { useWorkspaceStore } from '@stores/projectStore';
import { useCurrentTime, useThrottledTime, getTime as getPlayheadTime } from '@stores/playbackClockStore';
import { LiveTimecode } from '@layout/Timeline/LiveTimecode';
import { useLivePlayhead } from '@layout/Timeline/useLivePlayhead';
import type { GraphEditorProps } from '@layout/Timeline/GraphEditor';
import { useLayoutStore } from '@stores/layoutStore';
import { useTimelinePanelStore } from '@stores/timelinePanelStore';
import { RenderQueuePanel } from '@layout/RenderQueue/RenderQueuePanel';
import { useSelectionStore } from '@stores/selectionStore';
import { usePropertySelectionStore } from '@stores/propertySelectionStore';
import { useUIStore } from '@stores/uiStore';
import { usePreferenceStore } from '@stores/preferenceStore';

import { useFocusStore } from '@stores/focusStore';
import { openContextMenu } from '@stores/contextMenuStore';
import { seekPlayhead } from '@core/timeline/timelineView';
import { setCompDuration } from '@layout/Timeline/timelineEdits';
import { deleteCompositionEdit, deleteCompositionWarning, duplicateCompositionEdit } from '@layout/Scene/sceneEdits';
import { openCompositionSettings } from '@layout/Composition/CompositionSettingsDialog';
import { customConfirm } from '@components/Modal';
import { parseGoToTime } from '@layout/Timeline/goToTime';
import { TIMELINE_EXTRA_COLUMNS, parseExtraColumns, toggleExtraColumn, type TimelineExtraColumn } from '@layout/Timeline/timelineColumns';
import { ROW_HEIGHT_PRESETS } from '@layout/Timeline/rowHeightDrag';
import {
  NAV_MIN_WIDTH,
  navigatorHit,
  navigatorWindow,
  panWindow,
  resizeWindow,
  scrollForWindow,
  zoomForWindow,
  type NavWindow,
} from '@layout/Timeline/timeNavigator';
import { getTimelineViewport, scrollTimelineTo, subscribeTimelineViewport } from '@layout/Timeline/timelineViewport';
import { TIMELINE_LEFT_OFFSET, resolveTrackHeaderWidth } from '@layout/Timeline/timelineShared';
import { navigatorColumnFor } from './toolbarGeometry';
import { TimelineToolbarOverflow } from './TimelineToolbarOverflow';
import { fitTimelineToComposition } from '@layout/Timeline/timelineFit';
import { useTranscriptStore } from '@layout/Transcript';
import styles from './BottomTimeline.module.css';

export interface BottomTimelineProps extends Omit<TimelineProps, 'className'> {
  className?: string;
  /** Override the default transport bar. */
  transport?: ReactNode;
}

/* The zoom CONTROL moved to the status bar (`TimelineZoom`); these two survive
   because the graph editor still clamps whatever it is handed. Re-exported
   from `zoomAnchor` rather than re-declared: three files clamping to numbers
   they each spelled out is three chances for them to disagree, and they did —
   the panel's ceiling was raised for sub-frame work while these stayed at 800,
   which would have silently capped it. */
const ZOOM_MIN = TIMELINE_PPS_MIN;
const ZOOM_MAX = TIMELINE_PPS_MAX;

/**
 * What the toolbar's LEFT column gives up when it runs short.
 *
 * After Effects' timeline header holds a timecode, a search field and a few
 * switches, and since 2026-10-07 so does this one: the Premiere-style edit
 * tools, Playhead Follow and the preview-cache actions are rows of View ▾, and
 * transitions are added from the Library (drag onto a cut or a layer's edge).
 * What is left is timecode · Snap · filter · Graph Editor · View ▾, and the
 * one rung folds View ▾ into a `⋯` when the header column is dragged narrow.
 *
 * Measured on the column itself (`useTransportDemote`), not a breakpoint: the
 * width is the user's drag.
 */
export const TIMELINE_TOOLBAR_DEMOTE_ORDER = ['more'] as const;
export type TimelineToolbarGroup = (typeof TIMELINE_TOOLBAR_DEMOTE_ORDER)[number];
export function isToolbarShed(group: TimelineToolbarGroup, level: number): boolean {
  return TIMELINE_TOOLBAR_DEMOTE_ORDER.indexOf(group) < level;
}

/**
 * An element's left edge in client pixels, live.
 *
 * The navigator column is placed from the lanes' client-space left edge
 * (`timelineViewport`), so the row needs its own to subtract. A ResizeObserver
 * rather than a one-off read: the docks either side of the panel move this
 * edge without any window event, and every one of those moves resizes the
 * row. `key` re-arms it when the row remounts (the panel collapses and
 * reopens) — the ref object itself never changes identity.
 */
function useClientLeft(ref: RefObject<HTMLElement | null>, key: unknown): { left: number; width: number } {
  const [edge, setEdge] = useState({ left: 0, width: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = (): void => {
      const r = el.getBoundingClientRect();
      // Same object when nothing moved: a ResizeObserver tick must not re-render the panel.
      setEdge((prev) => (prev.left === r.left && prev.width === r.width ? prev : { left: r.left, width: r.width }));
    };
    read();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', read);
      return () => window.removeEventListener('resize', read);
    }
    const ro = new ResizeObserver(read);
    ro.observe(el);
    window.addEventListener('resize', read);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', read);
    };
  }, [ref, key]);
  return edge;
}

const ROW_HEIGHT_LABEL: Record<number, string> = { 28: 'Compact', 36: 'Normal', 46: 'Tall' };

/** The navigator playhead's CSS `left`, as a percentage of the comp. */
function navPlayheadLeft(time: number, duration: number): string {
  return `${Math.min(100, Math.max(0, (time / (duration || 1)) * 100))}%`;
}

/**
 * The Graph Editor, fed the LIVE playhead.
 *
 * It draws its own playhead line and snaps drags to it, and it is only mounted
 * while open — so it keeps its per-tick re-render, scoped to itself, rather
 * than inheriting the panel's throttled display time. `live` is false for an
 * embed with no tab, which keeps the model's time.
 */
/** With nothing selected, how many of the comp's layers the graph looks at. */
const GRAPH_ALL_LAYERS_CAP = 60;

function GraphEditorAtPlayhead({
  live,
  fallbackTime,
  ...props
}: Omit<GraphEditorProps, 'currentTime'> & { live: boolean; fallbackTime: number }): JSX.Element {
  const liveTime = useCurrentTime();
  return <GraphEditor {...props} currentTime={live ? liveTime : fallbackTime} />;
}

export function BottomTimeline(props: BottomTimelineProps): JSX.Element {
  const { className, transport, ...timelineProps } = props;
  const ws = useWorkspaceStore((s) => (s.activeTabId ? s.tabs[s.activeTabId] : null));
  // Project tabs (main comp + any group/precomp tabs opened by double-click).
  const tabOrder = useWorkspaceStore((s) => s.tabOrder);
  const projectTabs = useWorkspaceStore((s) => s.tabs);
  const activeTabId = useWorkspaceStore((s) => s.activeTabId);
  const comps = useWorkspaceStore((s) => s.comps);
  const setActiveTab = useWorkspaceStore((s) => s.actions.setActiveTab);
  const closeTab = useWorkspaceStore((s) => s.actions.closeTab);
  // Read collapse state directly from the store so the header always knows.
  const isCollapsed = useLayoutStore(
    (s) => s.regions.bottomTimeline.collapsed || s.regions.bottomTimeline.size <= 60,
  );
  // The panel's other tab: the Render Queue takes the body, as in After Effects.
  const showQueue = useTimelinePanelStore((s) => s.view === 'renderQueue');
  const setPanelView = useTimelinePanelStore((s) => s.setView);
  const selectedIds = useSelectionStore((s) => s.ids);
  const focusPath = useFocusStore((s) => s.path);
  const jumpToFocus = useFocusStore((s) => s.jumpTo);

  // Graph Editor toggle state (AE: the "Graph Editor" button in the timeline header)
  const graphEditorOpen = useUIStore((s) => s.graphEditorOpen);
  const setGraphEditorOpen = useUIStore((s) => s.setGraphEditorOpen);
  const globalShy = useUIStore((s) => s.globalShy);
  const setGlobalShy = useUIStore((s) => s.setGlobalShy);
  // AE's "Toggle Switches / Modes" — the switch column and the Mode/TrkMat/
  // Parent columns compete for the same width, and showing both needs a header
  // wider than any default panel. See `TimelineColumns`.
  const timelineColumns = useUIStore((s) => s.timelineColumns);
  const setTimelineColumns = useUIStore((s) => s.setTimelineColumns);
  // The two optional lanes' switches. Both live in the UI store rather than
  // in preferences: they answer "what am I looking at right now", not "how do
  // I like my editor" — and a heat lane that came back on after a restart
  // would be diffing against a baseline from a session nobody remembers.
  const heatSource = useUIStore((s) => s.timelineHeatSource);
  const setTimelineHeatSource = useUIStore((s) => s.setTimelineHeatSource);
  const transcriptLaneOn = useUIStore((s) => s.timelineTranscriptLane);
  const setTimelineTranscriptLane = useUIStore((s) => s.setTimelineTranscriptLane);
  const hasTranscript = useTranscriptStore((s) => (activeCompIdNow() ?? 'comp_root') in s.byComp);
  
  // Horizontal scroll mirror from Timeline → GraphEditor for pixel-alignment
  const [scrollLeft, setScrollLeft] = useState(0);

  /*
    What the graph plots. A selection, when there is one; otherwise the comp's
    layers — the graph keeps only those with keyframes — so opening it on an
    animated comp shows its motion at once. Capped: each id loads that layer's
    property tree, and a 2,000-layer comp must not load them all to draw a
    panel nobody asked to fill.
  */
  const graphNodeIds = useMemo(
    () => (selectedIds.length > 0 ? selectedIds : props.model.tracks.slice(0, GRAPH_ALL_LAYERS_CAP).map((t) => t.id)),
    [selectedIds, props.model.tracks],
  );
  const fps = props.model.frameRate;
  // The displayed timecode of frame 0, from the active comp's mirror record (B4).
  const startFrame = settingsStartFrame(useActiveMirrorComp()?.settings);
  const pps = props.model.pixelsPerSecond;
  const onZoom = props.onZoom;
  const clampZoom = (v: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v));
  const setPref = usePreferenceStore((s) => s.set);
  const prefHeaderWidth = usePreferenceStore((s) => s.timelineHeaderWidth);
  const extraColumnPref = usePreferenceStore((s) => s.timelineExtraColumns);
  // The same parse <Timeline> applies, so the two cannot disagree about how
  // many columns the header is sized for.
  const extraColumns = useMemo<TimelineExtraColumn[]>(
    () => parseExtraColumns(extraColumnPref),
    [extraColumnPref],
  );
  // Compact (28px) is the default of the three sizes the button cycles. A
  // motion comp is usually many short layers, and the taller rows pushed most
  // of them below the fold on a laptop — you spent the first interaction with
  // every project shrinking the rows back down.
  //
  // PERSISTED, because that first interaction was happening on every restart
  // too: a local `useState` meant the choice lasted exactly as long as the
  // window. Row height is a fact about the display you work on, not about the
  // project, so it belongs in preferences and not in the document.
  const rowTrackHeight = usePreferenceStore((s) => s.timelineRowHeight);

  // The DISPLAY clock, not the live one: exact while paused, ≤10 Hz while
  // playing. Everything that must move every frame — the playhead line, the
  // ruler fill, the timecode, the navigator's playhead — follows the live
  // clock imperatively (`livePlayhead`, `LiveTimecode`, `useLivePlayhead`), so
  // playback no longer re-renders this panel and the whole row tree 60×/s.
  // No tab at all falls back to the model.
  const displayTime = useThrottledTime();
  const playheadTime = ws ? displayTime : timelineProps.model.currentTime;
  const model = useMemo<TimelineProps['model']>(
    () => ({ ...timelineProps.model, trackHeight: rowTrackHeight }),
    [timelineProps.model, rowTrackHeight],
  );
  const timelineModelProps: TimelineProps & { playheadTime: number } = {
    ...timelineProps,
    model,
    playheadTime,
    livePlayhead: !!ws,
  };

  // The navigator's playhead tick, moved every frame without a render.
  const navPlayheadRef = useRef<HTMLDivElement | null>(null);
  const navDurationRef = useRef(props.model.duration);
  navDurationRef.current = props.model.duration;
  useLivePlayhead((t) => {
    const el = navPlayheadRef.current;
    if (el) el.style.left = navPlayheadLeft(t, navDurationRef.current);
  }, !!ws);

  const proportionalScrub = usePropertySelectionStore((s) => s.proportional);
  const setProportionalScrub = usePropertySelectionStore((s) => s.setProportional);
  // Preview resolution and the loop flag moved out with the transport — they
  // are read by `TransportBar` under the stage now.
  const [searchQuery, setSearchQuery] = useState('');

  /**
   * The toolbar's left column is the track-header column's width — the SAME
   * number `<Timeline>` resolves for the headers below, from the same inputs,
   * so the seam between the buttons and the navigator is the seam between the
   * headers and the lanes. Dragging the header resizer moves both at once.
   */
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const { left: rowLeft, width: rowWidth } = useClientLeft(toolbarRef, isCollapsed);
  // `rowWidth` is the panel's width, the same one `<Timeline>` measures below —
  // so both cap the header identically (see `capHeaderToPanel`).
  const headerWidth = resolveTrackHeaderWidth(
    timelineProps.model.trackHeaderWidth,
    prefHeaderWidth,
    timelineColumns,
    extraColumns.length,
    rowWidth,
  );

  // How many groups the left column has shed — see TIMELINE_TOOLBAR_DEMOTE_ORDER.
  // Measured on the COLUMN: its width is the header width, not the row's.
  const toolsColRef = useRef<HTMLDivElement | null>(null);
  const toolbarLevel = useTransportDemote(toolsColRef, TIMELINE_TOOLBAR_DEMOTE_ORDER.length);
  const moreShed = isToolbarShed('more', toolbarLevel);

  // ── Go-to-time, inline ────────────────────────────────────────────────────
  const [goToOpen, setGoToOpen] = useState(false);
  const goToRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!goToOpen) return;
    const el = goToRef.current;
    el?.focus();
    el?.select();
  }, [goToOpen]);

  // ── Time navigator ────────────────────────────────────────────────────────
  /*
    The bar draws the WINDOW the lanes are showing, not a fill from zero. A
    fill answered "how far in am I" and nothing else; at any zoom past "whole
    comp" the question you actually have is "which part of the comp am I
    looking at", and only a box with two ends can answer it — and be dragged.
  */
  const navRef = useRef<HTMLDivElement | null>(null);
  // The lanes' geometry, as <Timeline> measures it: client width, client-space
  // left edge, and the minimap's overlay at the right when it is showing. Live
  // — the window is drawn against the width the lanes actually have, and the
  // navigator COLUMN is placed over them from the same record.
  const lanes = useSyncExternalStore(subscribeTimelineViewport, getTimelineViewport, getTimelineViewport);
  const navViewport = lanes.width;
  /**
   * Where the navigator sits: the lanes' span, from the ruler's time origin
   * to the visible clips' right edge. `null` while there is nothing to align
   * to (graph editor open, panel collapsed) — the column then takes what is
   * left of the row. See `toolbarGeometry`.
   */
  const navCol = navigatorColumnFor(lanes, rowLeft);
  const navWindow = useMemo<NavWindow>(
    () =>
      navigatorWindow({
        scrollLeft,
        viewportWidth: navViewport,
        pixelsPerSecond: pps,
        duration: props.model.duration,
        leftOffset: TIMELINE_LEFT_OFFSET,
      }),
    [scrollLeft, navViewport, pps, props.model.duration],
  );

  const applyNavWindow = useCallback(
    (win: NavWindow, zoomed: boolean): void => {
      const duration = props.model.duration;
      if (!(duration > 0)) return;
      if (!zoomed) {
        scrollTimelineTo(scrollForWindow(win, { duration, pixelsPerSecond: pps }));
        return;
      }
      const next = zoomForWindow(win, { duration, viewportWidth: navViewport }, { min: ZOOM_MIN, max: ZOOM_MAX });
      onZoom?.(next.pixelsPerSecond);
      // After the zoom, not with it — the lane content is only as wide as the
      // CURRENT zoom until React re-renders, and the browser clamps a
      // scrollLeft past that width away. Same reasoning as `fitTimelineToRange`.
      const apply = (): void => scrollTimelineTo(next.scrollLeft);
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(apply);
      else apply();
    },
    [props.model.duration, pps, navViewport, onZoom],
  );

  const onNavPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      const el = navRef.current;
      if (!el || e.button !== 0) return;
      const rect = el.getBoundingClientRect();
      if (!(rect.width > 0)) return;
      const hit = navigatorHit(e.clientX - rect.left, navWindow, rect.width);
      // Outside the box is still a seek — the bar has always been clickable and
      // taking that away to add dragging would be a net loss.
      if (hit === 'outside') {
        const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        seekPlayhead(ratio * props.model.duration);
        return;
      }
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startWin = navWindow;
      const move = (ev: PointerEvent): void => {
        const dx = (ev.clientX - startX) / rect.width;
        if (hit === 'body') applyNavWindow(panWindow(startWin, dx), false);
        else applyNavWindow(resizeWindow(startWin, hit, dx), true);
      };
      const up = (): void => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        try {
          el.releasePointerCapture(e.pointerId);
        } catch {
          /* the capture is already gone when the pointer left the window */
        }
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [navWindow, applyNavWindow, props.model.duration],
  );

  /**
   * The View menu's rows — the seven toggles that used to be buttons. Built
   * here, once, so the View ▾ trigger and the `⋯` menu that replaces it at the
   * last rung list the very same rows.
   */
  const timelineTools = useTimelineToolsMenu();
  const previewCache = usePreviewCacheStats();
  const viewItems: DropdownItem[] = [
        // The edit tools and Playhead Follow (AE's timeline has no tool row).
        ...timelineTools.items,
        { type: 'separator' },
        { type: 'checkbox', id: 'tl-view-shy', label: 'Hide Shy Layers', checked: globalShy, onChange: setGlobalShy },
        {
          type: 'checkbox',
          id: 'tl-view-proportional',
          label: 'Proportional Scrubbing — a drag on one selected property ramps across the selection',
          checked: proportionalScrub,
          onChange: setProportionalScrub,
        },
        {
          /* One row, three states: off is in the list, and off costs
             nothing — the diff is not computed at all. */
          type: 'item',
          id: 'tl-view-heat',
          icon: 'sparkles',
          label: `Highlight what changed: ${heatSource === 'off' ? 'Off' : heatSource === 'save' ? 'since last save' : 'last AI run'}`,
          submenu: [
            { type: 'checkbox', id: 'tl-view-heat-off', label: 'Off', checked: heatSource === 'off', onChange: () => setTimelineHeatSource('off') },
            { type: 'checkbox', id: 'tl-view-heat-save', label: 'Since the last save', checked: heatSource === 'save', onChange: () => setTimelineHeatSource('save') },
            { type: 'checkbox', id: 'tl-view-heat-ai', label: 'The last AI run', checked: heatSource === 'ai', onChange: () => setTimelineHeatSource('ai') },
          ],
        },
        {
          /* Disabled until the comp has been transcribed: a lane that
             can only ever be empty teaches people the feature is
             broken. */
          type: 'checkbox',
          id: 'tl-view-transcript',
          label: hasTranscript ? 'Transcript lane' : 'Transcript lane — transcribe this composition first (Transcript panel)',
          checked: transcriptLaneOn,
          disabled: !hasTranscript,
          onChange: setTimelineTranscriptLane,
        },
        { type: 'separator' },
        {
          /* AE's "Toggle Switches / Modes" — the switch column and the
             Mode / TrkMat / Parent columns compete for the same width. */
          type: 'item',
          id: 'tl-view-columns-mode',
          icon: 'layout',
          label: `Switches / Modes: ${timelineColumns === 'switches' ? 'Switches' : timelineColumns === 'modes' ? 'Modes' : 'Both'}`,
          submenu: [
            { type: 'checkbox', id: 'tl-view-cols-switches', label: 'Switches', checked: timelineColumns === 'switches', onChange: () => setTimelineColumns('switches') },
            { type: 'checkbox', id: 'tl-view-cols-modes', label: 'Modes', checked: timelineColumns === 'modes', onChange: () => setTimelineColumns('modes') },
            { type: 'checkbox', id: 'tl-view-cols-both', label: 'Both', checked: timelineColumns === 'both', onChange: () => setTimelineColumns('both') },
          ],
        },
        {
          /* In / Out / Duration — off by default; each costs 72px of
             a header column people already drag narrower. */
          type: 'item',
          id: 'tl-view-columns',
          icon: 'sliders-h',
          label: extraColumns.length > 0
            ? `Columns: ${extraColumns.map((c) => TIMELINE_EXTRA_COLUMNS.find((d) => d.id === c)?.label).join(', ')}`
            : 'Columns',
          submenu: TIMELINE_EXTRA_COLUMNS.map<DropdownItem>((c) => ({
            type: 'checkbox',
            id: `tl-view-col-${c.id}`,
            label: c.label,
            checked: extraColumns.includes(c.id),
            onChange: () => setPref('timelineExtraColumns', toggleExtraColumn(extraColumns, c.id)),
          })),
        },
        {
          /* The three presets. The grip on the column seam drags the
             height continuously; this is the discrete form of it. */
          type: 'item',
          id: 'tl-view-row-height',
          icon: 'expand',
          label: `Row height: ${ROW_HEIGHT_LABEL[rowTrackHeight] ?? `${rowTrackHeight}px`}`,
          submenu: ROW_HEIGHT_PRESETS.map<DropdownItem>((h) => ({
            type: 'checkbox',
            id: `tl-view-row-${h}`,
            label: `${ROW_HEIGHT_LABEL[h] ?? 'Custom'} (${h}px)`,
            checked: rowTrackHeight === h,
            onChange: () => setPref('timelineRowHeight', h),
          })),
        },
        { type: 'separator' },
        // The preview cache's state and actions (AE keeps these in the
        // Composition / Edit ▸ Purge menus, not as timeline buttons).
        { type: 'item', id: 'tl-view-cache', icon: 'refresh', label: 'Preview cache', submenu: previewCacheMenuItems(previewCache.stats, previewCache.refresh) },
      ];

  return (
    <section className={cn(styles.root, className)}>
      <header className={styles.header}>
        {transport ?? (
          <>
            {/* ── Centre: Render Queue + Composition Tabs ── */}
            <div className={styles.headerTabs}>
              {/* No leading divider. It was separating the tab strip from the
                  split/trim cluster that used to sit to its left; with that
                  gone it was a rule against the panel edge, holding the first
                  tab off the corner it should start in. */}
              <button
                type="button"
                className={cn(styles.tab, showQueue && styles.tabActive)}
                aria-pressed={showQueue}
                onClick={() => setPanelView('renderQueue')}
                title="Render Queue (F6)"
              >
                <Icon name="queue" size="sm" />
                <span>Render Queue</span>
              </button>
              <span className={styles.tabDivider} aria-hidden />
              {tabOrder.length === 0 ? (
                // No composition is open: a label, not a button that does nothing.
                <span className={cn(styles.tab, styles.tabActive)} title="No composition open">
                  <span>(none)</span>
                </span>
              ) : (
                tabOrder.map((tid) => {
                  const tab = projectTabs[tid];
                  if (!tab) return null;
                  // The name from the mirror (B4): the composition's, or — a group opened as a tab — the layer's.
                  const mirror = documentMirror();
                  // The mirror first: it is the engine's name in every window (a pop-out's
                  // local comps store still holds its seeded "Main Comp").
                  const label =
                    mirror.comp(tab.compositionId)?.settings.name
                    ?? comps[tab.compositionId]?.name
                    ?? mirror.layer(tab.compositionId)?.name
                    ?? tab.title
                    ?? tab.compositionId;
                  const isActive = !showQueue && tid === activeTabId && focusPath.length === 0;
                  const openCompTabMenu = (e: React.MouseEvent): void => {
                    e.preventDefault();
                    const compId = tab.compositionId;
                    // A group opened in its own tab is a LAYER of another comp,
                    // not a composition: duplicating or deleting "it" here
                    // would act on the group inside its parent.
                    // (B4: the mirror names a group as a LAYER; a composition is never one.)
                    const isGroupTab = !documentMirror().comp(compId) && !!documentMirror().layer(compId);
                    openContextMenu(e.clientX, e.clientY, [
                      {
                        id: 'settings',
                        label: 'Composition Settings…',
                        icon: 'settings',
                        onSelect: () => {
                          setActiveTab(tid);
                          openCompositionSettings();
                        },
                      },
                      ...(isGroupTab ? [] : [
                      { id: 'duplicate', label: 'Duplicate', icon: 'copy' as const, onSelect: () => {
                        // `duplicateComposition` + `renameItem` ("<name> copy") in one entry.
                        void duplicateCompositionEdit(compId);
                      } },
                      { id: 'sep', separator: true },
                      {
                        id: 'delete',
                        label: 'Delete Composition',
                        icon: 'trash' as const,
                        danger: true,
                        onSelect: async () => {
                          const warn = deleteCompositionWarning(label, compId);
                          if (await customConfirm('Delete Composition', warn, { isDanger: true, confirmLabel: 'Delete' })) {
                            // `removeItems` (+ its tabs closed); the LAST comp keeps the legacy re-seed (see there).
                            await deleteCompositionEdit(compId);
                          }
                        },
                      },
                      ]),
                    ]);
                  };
                  return (
                    <div key={tid} style={{ display: 'flex', alignItems: 'center', height: '100%' }}>
                      <button
                        type="button"
                        className={cn(styles.tab, isActive && styles.tabActive)}
                        onClick={() => {
                          setPanelView('timeline');
                          setActiveTab(tid);
                          jumpToFocus(-1);
                        }}
                        onContextMenu={openCompTabMenu}
                      >
                        <Icon name="layers" size="sm" />
                        <span>{label}</span>
                        {tabOrder.length > 1 && (
                          <span
                            className={styles.tabClose}
                            role="button"
                            tabIndex={0}
                            aria-label={`Close ${label}`}
                            title={`Close ${label}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              closeTab(tid);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                e.stopPropagation();
                                closeTab(tid);
                              }
                            }}
                          >
                            <Icon name="close" size="sm" />
                          </span>
                        )}
                      </button>
                    </div>
                  );
                })
              )}
              {focusPath.map((id, idx) => {
                const name = documentMirror().layer(id)?.name || id;
                return (
                  <div key={id} style={{ display: 'flex', alignItems: 'center', height: '100%' }}>
                    <span className={styles.tabChevron}>&gt;</span>
                    <button
                      type="button"
                      className={cn(styles.tab, !showQueue && focusPath.length - 1 === idx && styles.tabActive)}
                      onClick={() => {
                        setPanelView('timeline');
                        jumpToFocus(idx);
                      }}
                    >
                      {name}
                    </button>
                  </div>
                );
              })}
            </div>

          </>
        )}
      </header>

      {/*
        ── The toolbar row ──
        ONE row between the comp tabs and the tracks, in TWO columns that are
        the columns beneath it.

        LEFT, exactly the track-header column's width: timecode · Snap ·
        filter · Graph Editor · View ▾ — After Effects' timeline header. It
        never crosses the seam: when the header is dragged narrow View ▾ folds
        into one `⋯` (`useTransportDemote`, `TIMELINE_TOOLBAR_DEMOTE_ORDER`),
        with the filter giving up its width first.

        RIGHT, exactly the lanes: the time navigator alone, placed from the
        lanes' own measurement so its left edge is the ruler's time origin and
        its right edge is the visible clips' — a click at an x seeks the frame
        the ruler shows at that x, and the window sits over the span of clips
        it stands for.

        The seven small toggles that used to sit here (shy, proportional
        scrubbing, what-changed, transcript lane, switches/modes, columns, row
        height) are rows of the View menu; the edit tools and the chips were a
        second header row inside <Timeline> and are not any more.
      */}
      {!isCollapsed && !showQueue && (
        <div
          ref={toolbarRef}
          className={styles.subHeaderRow}
          role="toolbar"
          aria-label="Timeline tools"
          data-timeline-toolbar=""
        >
          {/* ── Left column: the buttons, the header column's width ── */}
          <div
            ref={toolsColRef}
            className={styles.toolsCol}
            style={{ width: headerWidth }}
            data-timeline-toolbar-tools=""
          >
            <div className={styles.timecodeBlock}>
              {goToOpen ? (
                /*
                  An INLINE field, not `customPrompt`. A modal to type four
                  characters stole focus from the panel, dimmed the very ruler
                  you were aiming at, and could not be dismissed by clicking
                  back where you were looking. Typing in place keeps the comp
                  visible, and the grammar (`+10`, `1:04`, `320f`, `2.5s`)
                  lives in `goToTime.ts` where it is pinned by tests.
                */
                <input
                  ref={goToRef}
                  type="text"
                  className={styles.timecodeInput}
                  aria-label="Go to time"
                  defaultValue={framesToTimecode(ws ? getPlayheadTime() : playheadTime, fps, startFrame)}
                  onBlur={() => setGoToOpen(false)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.stopPropagation();
                      setGoToOpen(false);
                      return;
                    }
                    if (e.key !== 'Enter') return;
                    e.stopPropagation();
                    const sec = parseGoToTime(e.currentTarget.value, {
                      currentSeconds: ws ? getPlayheadTime() : playheadTime,
                      fps,
                      startFrame,
                      durationSeconds: props.model.duration,
                    });
                    if (sec !== null) seekPlayhead(sec);
                    setGoToOpen(false);
                  }}
                />
              ) : (
                <button
                  type="button"
                  className={styles.timecodeMain}
                  title="Current timecode — click to type a time (1:04, 320f, 2.5s, +10)"
                  onClick={() => setGoToOpen(true)}
                >
                  {ws ? <LiveTimecode fps={fps} startFrame={startFrame} /> : framesToTimecode(playheadTime, fps, startFrame)}
                </button>
              )}
              <span className={styles.timecodeSub}>
                {ws ? <LiveTimecode fps={fps} startFrame={startFrame} format="frames" /> : String(Math.round(playheadTime * fps) + startFrame).padStart(5, '0')} ({fps.toFixed(2)} fps)
              </span>
            </div>

            <span className={styles.toolbarDivider} aria-hidden="true" />
            <TimelineSnapButton />

            <SearchField
              className={styles.searchContainer}
              size="sm"
              placeholder="Filter layers & props…"
              ariaLabel="Search layers and properties"
              value={searchQuery}
              onChange={setSearchQuery}
            />

            <div className={styles.timelineSwitchesGroup}>
              {/*
                The Graph Editor switch, with its NAME. It was a lone curve
                glyph among a dozen icon toggles — the one mode switch on the
                panel, and the hardest control on it to find. Named, and lit
                while the graph is showing, it reads as what it is: the lanes
                and the curves are two views of the same layers.
              */}
              <button
                type="button"
                className={graphEditorOpen ? styles.graphToggleActive : styles.graphToggle}
                title={graphEditorOpen ? 'Back to the layer bars (Shift+F3)' : 'Show curves instead of layer bars (Shift+F3)'}
                aria-label="Toggle Graph Editor"
                aria-pressed={graphEditorOpen}
                onClick={() => setGraphEditorOpen(!graphEditorOpen)}
              >
                <Icon name="graph-value" size="sm" />
                <span>Graph Editor</span>
              </button>

              {moreShed ? (
                /* The one rung: View ▾ folds into a `⋯`. */
                <TimelineToolbarOverflow viewItems={viewItems} />
              ) : (
                /* View ▾ — how the timeline lists layers, the timeline tools
                   and the preview cache. Each row is a store write or a
                   registered command. */
                <Dropdown
                  placement="bottom-end"
                  trigger={
                    <button
                      type="button"
                      className={styles.toggleBtn}
                      aria-label="Timeline view options"
                      title="View — timeline tool, playhead follow, shy layers, switches / modes, columns, row height, preview cache"
                    >
                      View
                      <Icon name="chevron-down" size="sm" className={styles.triggerChevron} />
                    </button>
                  }
                  items={viewItems}
                />
              )}
            </div>
          </div>

          {/*
            ── Right column: the time navigator, over the lanes ──
            Pinned to the lanes' measured span when there is one; otherwise
            (graph editor open, nothing mounted) it takes what is left.
          */}
          <div
            className={cn(styles.navigatorCol, navCol && styles.navigatorColPinned)}
            style={navCol ? { left: navCol.left, width: navCol.width } : undefined}
            data-timeline-toolbar-navigator=""
          >
            <div
              ref={navRef}
              className={styles.timeNavigatorTrack}
              title="Time Navigator — drag the box to pan, its ends to zoom, double-click to fit the comp; click outside it to seek"
              role="scrollbar"
              aria-label="Time navigator"
              aria-orientation="horizontal"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(navWindow.left * 100)}
              onPointerDown={onNavPointerDown}
              onDoubleClick={() => {
                fitTimelineToComposition();
              }}
            >
              {/* The playhead is drawn UNDER the window so the window's own
                  edges stay the two things you can aim at. */}
              <div
                ref={navPlayheadRef}
                className={styles.timeNavPlayhead}
                // With a tab, `left` is the live subscription's (below) — a
                // React-managed value would be the throttled one.
                style={ws ? undefined : { left: navPlayheadLeft(playheadTime, props.model.duration) }}
              />
              <div
                className={styles.timeNavigatorWindow}
                style={{
                  left: `${navWindow.left * 100}%`,
                  width: `${Math.max(NAV_MIN_WIDTH, navWindow.width) * 100}%`,
                }}
              >
                <span className={styles.timeNavGrip} data-edge="start" />
                <span className={styles.timeNavGrip} data-edge="end" />
              </div>
            </div>
          </div>
        </div>
      )}

      <div className={cn(styles.body, isCollapsed && styles.bodyCollapsed)}>
        {/*
          The timeline stays mounted AND visible under the graph. The Graph
          Editor used to replace the whole body, layer list included — so with
          nothing selected it was an empty grid with no way to select anything
          short of leaving it. It covers the body again (owner's choice,
          2026-10: the widest graph), but is never blank or a dead end now:
          with nothing selected it plots every animated layer, and it carries
          its own list of curves to pick from (`showCurveList`).
        */}
        {/* Its own stacking context: the timeline's sticky headers and playhead
            (z-index up to 61) stay UNDER the graph and the Render Queue. */}
        <div style={{ display: 'flex', flex: 1, flexDirection: 'column', minHeight: 0, height: '100%', isolation: 'isolate' }}>
          <Timeline
            {...timelineModelProps}
            searchQuery={searchQuery}
            globalShy={globalShy}
            columns={timelineColumns}
            onDurationChange={(v) => { void setCompDuration(v); }}
            onScroll={(px) => {
              setScrollLeft(px);
              timelineProps.onScroll?.(px);
            }}
            scrollLeftSync={graphEditorOpen ? undefined : scrollLeft}
          />
        </div>

        {/* Graph Editor — over the whole timeline body, with its own curve list. */}
        {graphEditorOpen && (
          <div className={styles.graphOverlay}>
          <GraphEditorAtPlayhead
            live={!!ws}
            fallbackTime={playheadTime}
            selectedNodeIds={graphNodeIds}
            showingAllLayers={selectedIds.length === 0}
            showCurveList
            propertyFilter={searchQuery}
            duration={props.model.duration}
            pixelsPerSecond={pps}
            scrollLeft={scrollLeft}
            onScrollChange={(px) => {
              setScrollLeft(px);
              timelineProps.onScroll?.(px);
            }}
            onZoom={onZoom ? (next) => onZoom(clampZoom(next)) : undefined}
            frameRate={fps}
            onScrub={props.onScrub}
          />
          </div>
        )}

        {/* The Render Queue tab: over the body, the timeline kept mounted under
            it so coming back is instant and nothing it holds is lost. */}
        {showQueue && (
          <div className={styles.queueOverlay}>
            <RenderQueuePanel />
          </div>
        )}
      </div>

    </section>
  );
}
