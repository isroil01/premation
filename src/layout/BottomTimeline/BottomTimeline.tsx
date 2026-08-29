/**
 * BottomTimeline — bottom region host.
 *
 *   <BottomTimeline model={...} onScrub={...} />
 *
 * For now it just renders the Timeline component inside the panel. The
 * transport bar (play / pause / jump) is provided as a default but the
 * engine can replace it via the `transport` prop.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Icon } from '@components/Icon';
import { Dropdown } from '@components/Dropdown';
import { useCompositionStore } from '@stores/compositionStore';
import { framesToTimecode } from '@core/time/timecode';
import { Timeline, type TimelineProps } from '@layout/Timeline';
import { GraphEditor } from '@layout/Timeline/GraphEditor';
import { cn } from '@utils/cn';
import { useWorkspaceStore } from '@stores/projectStore';
import { useLayoutStore } from '@stores/layoutStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useRenderQualityStore, RESOLUTION_LABELS, RESOLUTION_PERCENT, type PreviewResolution } from '@stores/renderQualityStore';
import { useOnionSkinStore } from '@stores/onionSkinStore';
import { usePropertySelectionStore } from '@stores/propertySelectionStore';
import { useUIStore } from '@stores/uiStore';
import { useMotionBlurStore } from '@stores/motionBlurStore';
import { usePreferenceStore } from '@stores/preferenceStore';

import { useFocusStore } from '@stores/focusStore';
import { openContextMenu } from '@stores/contextMenuStore';
import { getTimelineController } from '@core/timeline/TimelineController';
import { bumpScene } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { flattenComposition } from '@core/scene/sceneDerive';
import { deleteComposition, duplicateComposition } from '@core/composition/compositionOps';
import { openCompositionSettings } from '@layout/Composition/CompositionSettingsDialog';
import { customConfirm } from '@components/Modal';
import { ViewportTools } from '@layout/Workspace/ViewportTools';
import { ZoomField } from '@layout/TopNav/ViewControls';
import styles from './BottomTimeline.module.css';

export interface BottomTimelineProps extends Omit<TimelineProps, 'className'> {
  className?: string;
  /** Override the default transport bar. */
  transport?: ReactNode;
}

const ZOOM_STEP = 1.4;
const ZOOM_MIN = 4;
const ZOOM_MAX = 800;
const ZOOM_DEFAULT = 80;

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
  const zoomPct = Math.round((pps / ZOOM_DEFAULT) * 100);
  const clampZoom = (v: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v));
  const prefHeaderWidth = usePreferenceStore((s) => s.timelineHeaderWidth);
  const headerWidth = props.model.trackHeaderWidth ?? prefHeaderWidth ?? 560;

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
  const previewResolution = useRenderQualityStore((s) => s.resolution);
  const setResolution = useRenderQualityStore((s) => s.setResolution);
  const adaptive = useRenderQualityStore((s) => s.adaptive);
  const adaptiveFloor = useRenderQualityStore((s) => s.adaptiveFloor);
  const setAdaptive = useRenderQualityStore((s) => s.setAdaptive);
  const [looping, setLoopingState] = useState(() => getTimelineController().isLooping());
  const [searchQuery, setSearchQuery] = useState('');
  // Looping is PER COMP; a state seeded once showed the previous tab's value
  // after switching comps.
  useEffect(() => {
    setLoopingState(getTimelineController().isLooping());
  }, [activeTabId]);

  return (
    <section className={cn(styles.root, className)}>
      <header className={styles.header}>
        {transport ?? (
          <>
            {/* ── Left Side: Timecode + Layer Split/Trim + Viewport Tools (up to Pop Out Viewport) ── */}
            <div className={styles.headerLeft}>
              {/* AE-style: the timecode leads the timeline panel. */}
              <div
                className={styles.timecode}
                title={`Current time — minutes : seconds : frames @ ${fps} fps`}
              >
                {framesToTimecode(ws?.time ?? props.model.currentTime, fps, startFrame)}
                <span className={styles.timecodeTotal}>/ {framesToTimecode(props.model.duration, fps, startFrame)}</span>
              </div>

              <div className={styles.transportDivider} />

              {/* Layer Clip Operations (Cut/Split, Trim In, Trim Out) */}
              <div className={styles.transportCluster}>
                <button
                  type="button"
                  className={styles.transportBtn}
                  title="Split Layer at Playhead (Ctrl+Shift+D)"
                  onClick={() => {
                    getTimelineController().splitSelectedAtPlayhead(selectedIds);
                    bumpScene();
                  }}
                >
                  <Icon name="scissors" size="sm" />
                </button>
                <button
                  type="button"
                  className={styles.transportBtn}
                  title="Trim In-Point to Playhead (Alt+[)"
                  onClick={() => {
                    getTimelineController().trimSelectedStartToPlayhead(selectedIds);
                    bumpScene();
                  }}
                >
                  <Icon name="trim-in" size="sm" />
                </button>
                <button
                  type="button"
                  className={styles.transportBtn}
                  title="Trim Out-Point to Playhead (Alt+])"
                  onClick={() => {
                    getTimelineController().trimSelectedEndToPlayhead(selectedIds);
                    bumpScene();
                  }}
                >
                  <Icon name="trim-out" size="sm" />
                </button>
              </div>

              <div className={styles.transportDivider} />

              {/*
                The viewport's own controls — motion path, the 3D switch,
                auto-keyframe, rulers/safe/channel, zoom, pop out.
              */}
              <div className={styles.transportCluster}>
                <ViewportTools />
              </div>
            </div>

            {/* ── Center: Transport Playback Controls (Start, Prev, Play, Next, End, Loop, Marker, Quality) ── */}
            <div className={styles.headerCenter}>
              <div className={styles.transportCluster}>
                <button
                  type="button"
                  className={styles.transportBtn}
                  title="Go to Start (Home)"
                  onClick={() => getTimelineController().goToStart()}
                >
                  <Icon name="skip-back" size="sm" />
                </button>
                <button
                  type="button"
                  className={styles.transportBtn}
                  title="Previous Frame (Page Up)"
                  onClick={() => getTimelineController().previousFrame()}
                >
                  <Icon name="chevron-left" size="sm" />
                </button>
                <button
                  type="button"
                  className={cn(styles.transportBtn, styles.playBtn, ws?.playing && styles.playBtnActive)}
                  title={ws?.playing ? 'Pause Playback (Space)' : 'Start Playback (Space)'}
                  onClick={() => getTimelineController().togglePlay()}
                >
                  <Icon name={ws?.playing ? 'pause' : 'play'} size="md" />
                </button>
                <button
                  type="button"
                  className={styles.transportBtn}
                  title="Next Frame (Page Down)"
                  onClick={() => getTimelineController().nextFrame()}
                >
                  <Icon name="chevron-right" size="sm" />
                </button>
                <button
                  type="button"
                  className={styles.transportBtn}
                  title="Go to End (End)"
                  onClick={() => getTimelineController().goToEnd()}
                >
                  <Icon name="skip-forward" size="sm" />
                </button>
                <button
                  type="button"
                  className={cn(styles.transportBtn, looping && styles.transportBtnActive)}
                  title={looping ? 'Loop Playback: ON' : 'Loop Playback: OFF'}
                  onClick={() => {
                    getTimelineController().setLooping(!looping);
                    setLoopingState(!looping);
                  }}
                >
                  <Icon name="loop" size="sm" />
                </button>
                <button
                  type="button"
                  className={styles.transportBtn}
                  title={
                    selectedIds.length === 1
                      ? 'Add Layer Marker'
                      : 'Add Composition Marker'
                  }
                  onClick={() => {
                    const ctrl = getTimelineController();
                    if (selectedIds.length === 1 && ctrl.addLayerMarkerAtPlayhead(selectedIds[0]!)) return;
                    ctrl.addMarkerAtPlayhead();
                  }}
                >
                  <Icon name="marker" size="sm" />
                </button>
              </div>

              {/* Preview quality dropdown ("Full", "Half", etc.) */}
              <div className={styles.transportCluster}>
                <Dropdown
                  placement="bottom-start"
                  trigger={
                    <button
                      type="button"
                      className={cn(styles.transportBtn, previewResolution !== 1 && styles.transportBtnActive)}
                      title="Preview Quality"
                      style={{ width: 'auto', padding: '0 6px', gap: 4, fontSize: 'var(--font-size-xs)' }}
                    >
                      <Icon name="graph-speed" size="sm" />
                      <span>{RESOLUTION_LABELS[previewResolution]}</span>
                    </button>
                  }
                  items={[
                    ...([1, 2, 3, 4] as PreviewResolution[]).map((r) => ({
                      type: 'item' as const,
                      id: `res-${r}`,
                      label: `${RESOLUTION_LABELS[r]} · ${RESOLUTION_PERCENT[r]}`,
                      icon: (r === previewResolution ? 'check' : undefined) as any,
                      onSelect: () => setResolution(r),
                    })),
                    { type: 'separator' as const },
                    {
                      type: 'checkbox' as const,
                      id: 'adaptive',
                      label: `Adaptive Resolution while dragging (${RESOLUTION_LABELS[adaptiveFloor]})`,
                      checked: adaptive,
                      onChange: setAdaptive,
                    },
                  ]}
                />
              </div>
            </div>

            {/* ── Right Side: AE Timeline Header Tools ── */}
            <div className={styles.headerRight}>
              <div className={styles.aeHeaderTools}>
                <ZoomField />
                <div className={styles.transportDivider} />
                <button
                  type="button"
                  className={graphEditorOpen ? styles.toggleIconActive : styles.toggleIcon}
                  title="Toggle Graph Editor (Shift+F3)"
                  aria-label="Toggle Graph Editor"
                  aria-pressed={graphEditorOpen}
                  onClick={() => setGraphEditorOpen(!graphEditorOpen)}
                >
                  <Icon name="track" size="sm" />
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
                  <Icon name="layers" size="sm" />
                </button>

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
          </>
        )}
      </header>

      {/* ── Timeline Tabs — After Effects style: Render Queue and Comp tabs ── */}
      {!isCollapsed && (
        <div className={styles.tabBar}>
          <button
            type="button"
            className={styles.tab}
            onClick={() => useLayoutStore.getState().openPanel('renderQueue')}
            title="Open Render Queue"
          >
            <Icon name="queue" size="sm" />
            <span>Render Queue</span>
          </button>
          <span className={styles.tabChevron} aria-hidden>|</span>
          {tabOrder.length === 0 ? (
            <button
              type="button"
              className={cn(styles.tab, styles.tabActive)}
              title="Composition (none)"
            >
              <span>(none)</span>
            </button>
          ) : (
            tabOrder.map((tid, idx) => {
              const tab = projectTabs[tid];
              if (!tab) return null;
              const node = defaultSceneGraph.getNode(tab.compositionId);
              const label =
                comps[tab.compositionId]?.name ?? node?.name ?? tab.title ?? tab.compositionId;
              const isActive = tid === activeTabId && focusPath.length === 0;
              // Right-click comp management — with the duplicate Project bin
              // gone, the comp tab IS the composition's handle, so it carries
              // the operations AE puts on a comp item. Delete always works:
              // deleting the last comp lands on the "(none)" empty state.
              const openCompTabMenu = (e: React.MouseEvent): void => {
                e.preventDefault();
                const compId = tab.compositionId;
                openContextMenu(e.clientX, e.clientY, [
                  {
                    id: 'settings',
                    label: 'Composition Settings…',
                    icon: 'settings',
                    onSelect: () => {
                      // The settings dialog edits the ACTIVE comp.
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
                  {idx > 0 && <span className={styles.tabChevron} aria-hidden>|</span>}
                  <button
                    type="button"
                    className={cn(styles.tab, isActive && styles.tabActive)}
                    onClick={() => {
                      setActiveTab(tid);
                      jumpToFocus(-1);
                    }}
                    onContextMenu={openCompTabMenu}
                  >
                    {label}
                  {idx > 0 && (
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
                      ×
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
      )}

      {/* ── Sub-header: Search Bar under Comp Tabs aligned with Left Table Header ── */}
      {!isCollapsed && (
        <div className={styles.searchBarRow}>
          <div className={styles.searchBarCol} style={{ width: headerWidth }}>
            <div className={styles.searchContainer}>
              <Icon name="search" size="sm" className={styles.searchIcon} />
              <input
                type="text"
                placeholder="Search Timeline..."
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
          </div>
          <div className={styles.searchBarRightGap} />
        </div>
      )}

      <div className={cn(styles.body, isCollapsed && styles.bodyCollapsed)}>
        <div style={{ display: graphEditorOpen ? 'none' : 'flex', flex: 1, flexDirection: 'column', minHeight: 0, height: '100%' }}>
          <Timeline
            {...timelineModelProps}
            searchQuery={searchQuery}
            globalShy={globalShy}
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

      {/* AE Timeline Bottom Footer / Status Bar */}
      {!isCollapsed && (
        <footer className={styles.bottomBar}>
          <div className={styles.bottomBarLeft} />

          <div className={styles.bottomBarRight}>
            <div className={styles.zoomSliderContainer}>
              <button
                type="button"
                className={styles.zoomIconBtn}
                title="Zoom Out"
                disabled={!onZoom || pps <= ZOOM_MIN}
                onClick={() => onZoom?.(clampZoom(pps / ZOOM_STEP))}
              >
                <Icon name="zoom-out" size="sm" />
              </button>
              <input
                type="range"
                min={ZOOM_MIN}
                max={ZOOM_MAX}
                value={clampZoom(pps)}
                onChange={(e) => onZoom?.(Number(e.target.value))}
                className={styles.zoomRangeInput}
                title={`Timeline Zoom: ${zoomPct}%`}
              />
              <button
                type="button"
                className={styles.zoomLabel}
                title="Reset zoom to 100%"
                disabled={!onZoom}
                onClick={() => onZoom?.(ZOOM_DEFAULT)}
              >
                {zoomPct}%
              </button>
              <button
                type="button"
                className={styles.zoomIconBtn}
                title="Zoom In"
                disabled={!onZoom || pps >= ZOOM_MAX}
                onClick={() => onZoom?.(clampZoom(pps * ZOOM_STEP))}
              >
                <Icon name="zoom-in" size="sm" />
              </button>
            </div>
          </div>
        </footer>
      )}
    </section>
  );
}
