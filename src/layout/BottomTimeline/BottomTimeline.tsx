/**
 * BottomTimeline — bottom region host.
 *
 *   <BottomTimeline model={...} onScrub={...} />
 *
 * For now it just renders the Timeline component inside the panel. The
 * transport bar (play / pause / jump) is provided as a default but the
 * engine can replace it via the `transport` prop.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { Icon } from '@components/Icon';
import { useCompositionStore } from '@stores/compositionStore';
import { framesToTimecode } from '@core/time/timecode';
import { Timeline, headerWidthFor, type TimelineProps } from '@layout/Timeline';
import { GraphEditor } from '@layout/Timeline/GraphEditor';
import { cn } from '@utils/cn';
import { useWorkspaceStore } from '@stores/projectStore';
import { useLayoutStore } from '@stores/layoutStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useRenderQualityStore } from '@stores/renderQualityStore';
import { useOnionSkinStore } from '@stores/onionSkinStore';
import { usePropertySelectionStore } from '@stores/propertySelectionStore';
import { useUIStore } from '@stores/uiStore';
import { useMotionBlurStore } from '@stores/motionBlurStore';
import { usePreferenceStore } from '@stores/preferenceStore';

import { useFocusStore } from '@stores/focusStore';
import { openContextMenu } from '@stores/contextMenuStore';
import { getTimelineController } from '@core/timeline/TimelineController';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { flattenComposition } from '@core/scene/sceneDerive';
import { deleteComposition, duplicateComposition } from '@core/composition/compositionOps';
import { openCompositionSettings } from '@layout/Composition/CompositionSettingsDialog';
import { customConfirm, customPrompt } from '@components/Modal';
import { OnionSkinSettingsPopover } from './OnionSkinSettings';
import styles from './BottomTimeline.module.css';

export interface BottomTimelineProps extends Omit<TimelineProps, 'className'> {
  className?: string;
  /** Override the default transport bar. */
  transport?: ReactNode;
}

/* The zoom CONTROL moved to the status bar (`TimelineZoom`); these two survive
   because the graph editor still clamps whatever it is handed. */
const ZOOM_MIN = 4;
const ZOOM_MAX = 800;

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
  const cycleTimelineColumns = useUIStore((s) => s.cycleTimelineColumns);
  
  const motionBlurEnabled = useMotionBlurStore((s) => s.enabled);
  const setMotionBlurEnabled = useMotionBlurStore((s) => s.setEnabled);

  const draftQuality = useRenderQualityStore((s) => s.draft);
  const setDraftQuality = useRenderQualityStore((s) => s.setDraft);
  const onionEnabled = useOnionSkinStore((s) => s.enabled);
  const toggleOnion = useOnionSkinStore((s) => s.toggle);
  const updateComp = useCompositionStore((s) => s.update);
  // Horizontal scroll mirror from Timeline → GraphEditor for pixel-alignment
  const [scrollLeft, setScrollLeft] = useState(0);

  const fps = props.model.frameRate;
  const startFrame = useCompositionStore((s) => s.startFrame);
  const pps = props.model.pixelsPerSecond;
  const onZoom = props.onZoom;
  const clampZoom = (v: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v));
  const prefHeaderWidth = usePreferenceStore((s) => s.timelineHeaderWidth);
  /**
   * The same number the Timeline lays its header column out with — the sub-header
   * above it splits on this pixel, so the search field ends where the column
   * legend ends and the navigator starts where the lanes start.
   *
   * It used to take `max(pref, headerWidthFor(columns))`, a floor the Timeline
   * itself dropped when the header column learned to scroll. The two then
   * disagreed the moment you dragged the divider in: the rows narrowed and the
   * search bar above them did not, so the one vertical line running down the
   * panel broke in half.
   */
  const headerWidth = props.model.trackHeaderWidth ?? prefHeaderWidth ?? headerWidthFor(timelineColumns);

  // Compact (28px) is the default of the three sizes the button cycles. A
  // motion comp is usually many short layers, and the taller rows pushed most
  // of them below the fold on a laptop — you spent the first interaction with
  // every project shrinking the rows back down.
  const [rowTrackHeight, setRowTrackHeight] = useState(28);

  const playheadTime = ws?.time ?? timelineProps.model.currentTime;
  const model = useMemo<TimelineProps['model']>(
    () => ({ ...timelineProps.model, trackHeight: rowTrackHeight }),
    [timelineProps.model, rowTrackHeight],
  );
  const timelineModelProps: TimelineProps & { playheadTime: number } = {
    ...timelineProps,
    model,
    playheadTime,
  };

  const proportionalScrub = usePropertySelectionStore((s) => s.proportional);
  const setProportionalScrub = usePropertySelectionStore((s) => s.setProportional);
  // Preview resolution and the loop flag moved out with the transport — they
  // are read by `TransportBar` under the stage now.
  const [searchQuery, setSearchQuery] = useState('');

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
                className={styles.tab}
                onClick={() => useLayoutStore.getState().openPanel('renderQueue')}
                title="Open Render Queue"
              >
                <Icon name="queue" size="sm" />
                <span>Render Queue</span>
              </button>
              <span className={styles.tabDivider} aria-hidden />
              {tabOrder.length === 0 ? (
                <button
                  type="button"
                  className={cn(styles.tab, styles.tabActive)}
                  title="Composition (none)"
                >
                  <span>(none)</span>
                </button>
              ) : (
                tabOrder.map((tid) => {
                  const tab = projectTabs[tid];
                  if (!tab) return null;
                  const node = defaultSceneGraph.getNode(tab.compositionId);
                  const label =
                    comps[tab.compositionId]?.name ?? node?.name ?? tab.title ?? tab.compositionId;
                  const isActive = tid === activeTabId && focusPath.length === 0;
                  const openCompTabMenu = (e: React.MouseEvent): void => {
                    e.preventDefault();
                    const compId = tab.compositionId;
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
                      { id: 'duplicate', label: 'Duplicate', icon: 'copy', onSelect: () => duplicateComposition(compId) },
                      { id: 'sep', separator: true },
                      {
                        id: 'delete',
                        label: 'Delete Composition',
                        icon: 'trash',
                        danger: true,
                        onSelect: async () => {
                          const layers = Math.max(0, flattenComposition(defaultSceneGraph, compId).length - 1);
                          const warn = layers > 0
                            ? `Delete “${label}” and its ${layers} layer${layers === 1 ? '' : 's'}?`
                            : `Delete “${label}”?`;
                          if (await customConfirm('Delete Composition', warn, { isDanger: true, confirmLabel: 'Delete' })) {
                            deleteComposition(compId);
                          }
                        },
                      },
                    ]);
                  };
                  return (
                    <div key={tid} style={{ display: 'flex', alignItems: 'center', height: '100%' }}>
                      <button
                        type="button"
                        className={cn(styles.tab, isActive && styles.tabActive)}
                        onClick={() => {
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
                const node = defaultSceneGraph.getNode(id);
                const name = node?.name || id;
                return (
                  <div key={id} style={{ display: 'flex', alignItems: 'center', height: '100%' }}>
                    <span className={styles.tabChevron}>&gt;</span>
                    <button
                      type="button"
                      className={cn(styles.tab, focusPath.length - 1 === idx && styles.tabActive)}
                      onClick={() => jumpToFocus(idx)}
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

      {/* ── Unified Sub-header: Search Bar & Switches (Left) + Comp Tabs (Right) ── */}
      {!isCollapsed && (
        <div className={styles.subHeaderRow}>
          {/* Left Column: Timecode, Search Bar and Action Buttons spanning exactly the Track Header width */}
          <div className={styles.searchBarCol} style={{ width: headerWidth }}>
            <div className={styles.timecodeBlock}>
              <button
                type="button"
                className={styles.timecodeMain}
                title="Current timecode (Click to seek)"
                onClick={() => {
                  // `customPrompt`, not `window.prompt`: Electron has no
                  // `prompt`, so in the desktop build this button did nothing
                  // at all. The lint rule that names it exists for that reason.
                  void customPrompt(
                    'Go to Time',
                    'Timecode or seconds',
                    (ws?.time ?? props.model.currentTime).toFixed(2),
                  ).then((sec) => {
                    if (sec === null) return;
                    const val = parseFloat(sec);
                    if (!Number.isNaN(val)) getTimelineController().seekSeconds(val);
                  });
                }}
              >
                {framesToTimecode(ws?.time ?? props.model.currentTime, fps, startFrame)}
              </button>
              <span className={styles.timecodeSub}>
                {String(Math.round((ws?.time ?? props.model.currentTime) * fps)).padStart(5, '0')} ({fps.toFixed(2)} fps)
              </span>
            </div>

            <div className={styles.searchContainer}>
              <Icon name="search" size="sm" className={styles.searchIcon} />
              <input
                type="text"
                placeholder="Filter layers & props..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className={styles.searchInput}
                aria-label="Search layers and properties"
              />
              {searchQuery && (
                <button
                  type="button"
                  className={styles.searchClear}
                  onClick={() => setSearchQuery('')}
                  title="Clear search filter"
                >
                  <Icon name="close" size="sm" />
                </button>
              )}
            </div>

            <div className={styles.timelineSwitchesGroup}>
              <button
                type="button"
                className={graphEditorOpen ? styles.toggleIconActive : styles.toggleIcon}
                title="Toggle Graph Editor (Shift+F3)"
                aria-label="Toggle Graph Editor"
                aria-pressed={graphEditorOpen}
                onClick={() => setGraphEditorOpen(!graphEditorOpen)}
              >
                {/* A curve, because that is what the graph editor shows. It was
                    `track` — a bulleted-list glyph that means "playlist" and
                    named the panel this button REPLACES, not the one it
                    opens. */}
                <Icon name="graph-value" size="sm" />
              </button>

              <button
                type="button"
                className={globalShy ? styles.toggleIconActive : styles.toggleIcon}
                title={globalShy ? 'Hide Shy Layers (Active)' : 'Hide Shy Layers (Inactive)'}
                aria-label="Hide Shy Layers"
                aria-pressed={globalShy}
                onClick={() => setGlobalShy(!globalShy)}
              >
                <Icon name="shy" size="sm" />
              </button>

              <button
                type="button"
                className={motionBlurEnabled ? styles.toggleIconActive : styles.toggleIcon}
                title={motionBlurEnabled ? 'Enable Motion Blur (Active)' : 'Enable Motion Blur (Inactive)'}
                aria-label="Enable Motion Blur"
                aria-pressed={motionBlurEnabled}
                onClick={() => setMotionBlurEnabled(!motionBlurEnabled)}
              >
                <Icon name="motion-blur" size="sm" />
              </button>

              <button
                type="button"
                className={draftQuality ? styles.toggleIconActive : styles.toggleIcon}
                title="Draft 3D / Fast Preview"
                aria-label="Draft 3D"
                aria-pressed={draftQuality}
                onClick={() => setDraftQuality(!draftQuality)}
              >
                <Icon name="zap" size="sm" />
              </button>

              <button
                type="button"
                className={onionEnabled ? styles.toggleIconActive : styles.toggleIcon}
                title={
                  onionEnabled
                    ? 'Onion Skinning (Active) — ghosts of nearby frames, while paused'
                    : 'Onion Skinning (Inactive)'
                }
                aria-label="Onion Skinning"
                aria-pressed={onionEnabled}
                onClick={toggleOnion}
              >
                {/* Onion skinning is about TIME — ghosts of the frames either
                    side of the playhead. `layers` is the stack glyph, which is
                    the other axis entirely (depth), and is already the comp
                    tab's icon two rows up. */}
                <Icon name="history" size="sm" />
              </button>

              {/* The store's before/after/step/opacity were unreachable: the
                  toggle turned on whatever the defaults were and that was the
                  whole feature. See OnionSkinSettings. */}
              <OnionSkinSettingsPopover className={styles.toggleIconChevron} />

              <button
                type="button"
                className={proportionalScrub ? styles.toggleIconActive : styles.toggleIcon}
                title={
                  proportionalScrub
                    ? 'Proportional Scrubbing (On) — a drag on one selected property ramps across the selection, first 0% → last 100%'
                    : 'Proportional Scrubbing (Off) — a drag moves every selected property by the same amount'
                }
                aria-label="Proportional Scrubbing"
                aria-pressed={proportionalScrub}
                onClick={() => setProportionalScrub(!proportionalScrub)}
              >
                <Icon name="distribute-horizontal" size="sm" />
              </button>

              <button
                type="button"
                className={timelineColumns === 'both' ? styles.toggleIconActive : styles.toggleIcon}
                title={
                  timelineColumns === 'switches'
                    ? 'Toggle Switches / Modes — showing Switches (click for Modes)'
                    : timelineColumns === 'modes'
                      ? 'Toggle Switches / Modes — showing Modes (click for both)'
                      : 'Toggle Switches / Modes — showing both (click for Switches)'
                }
                aria-label="Toggle Switches / Modes"
                onClick={cycleTimelineColumns}
              >
                {/* A pane grid — the button chooses which COLUMN BLOCK the
                    track header shows. `panel-right` is the dock glyph and read
                    as "open a side panel". */}
                <Icon name="layout" size="sm" />
              </button>

              <button
                type="button"
                className={rowTrackHeight > 28 ? styles.toggleIconActive : styles.toggleIcon}
                title={`Timeline Row Height: ${rowTrackHeight === 28 ? 'Compact (28px)' : rowTrackHeight === 36 ? 'Normal (36px)' : 'Tall (46px)'} (Click to toggle)`}
                aria-label="Change timeline row height"
                onClick={() => {
                  setRowTrackHeight((h) => (h === 28 ? 36 : h === 36 ? 46 : 28));
                }}
              >
                <Icon name="expand" size="sm" />
              </button>
            </div>
          </div>

          {/*
            Right Column: the time navigator alone.

            The render queue and the composition tabs used to trail it here.
            They are the panel's IDENTITY — which comp am I looking at — so
            they now open the header row above, in the space the transport
            vacated, where a tab strip reads as a tab strip instead of as the
            tail of a zoom slider.
          */}
          <div className={styles.navigatorCol}>
            {/* AE-Style Time Navigator / Overview Zoom Track */}
            <div
              className={styles.timeNavigatorTrack}
              title="Time Navigator — click to seek"
              onPointerDown={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                getTimelineController().seekSeconds(ratio * props.model.duration);
              }}
            >
              {/*
                A fill from ZERO to the playhead, not a window sliding along the
                track. The window was sized off the ZOOM level and centred on
                the current time, so what moved as the comp played was a
                fixed-width block of colour — it told you where you were only
                if you read its centre, and its width changed meaning every
                time you zoomed. A bar that fills answers "how far in am I"
                without being read at all.
              */}
              <div
                className={styles.timeNavigatorFill}
                style={{
                  width: `${Math.min(100, Math.max(0, ((ws?.time ?? props.model.currentTime) / (props.model.duration || 1)) * 100))}%`,
                }}
              >
                <div className={styles.timeNavPlayhead} />
              </div>
            </div>

          </div>
        </div>
      )}

      <div className={cn(styles.body, isCollapsed && styles.bodyCollapsed)}>
        <div style={{ display: graphEditorOpen ? 'none' : 'flex', flex: 1, flexDirection: 'column', minHeight: 0, height: '100%' }}>
          <Timeline
            {...timelineModelProps}
            searchQuery={searchQuery}
            globalShy={globalShy}
            columns={timelineColumns}
            onDurationChange={(v) => {
              updateComp({ durationSeconds: v });
              getTimelineController().setDurationSeconds(v);
            }}
            onScroll={(px) => {
              setScrollLeft(px);
              timelineProps.onScroll?.(px);
            }}
            scrollLeftSync={graphEditorOpen ? undefined : scrollLeft}
          />
        </div>

        {/* Graph Editor panel — full height view replacing track rows below the header toolbar when toggled */}
        {graphEditorOpen && (
          <GraphEditor
            selectedNodeIds={selectedIds}
            propertyFilter={searchQuery}
            currentTime={playheadTime}
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
        )}
      </div>

    </section>
  );
}
