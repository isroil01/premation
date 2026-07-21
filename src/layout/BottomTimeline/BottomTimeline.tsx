/**
 * BottomTimeline — bottom region host.
 *
 *   <BottomTimeline model={...} onScrub={...} />
 *
 * For now it just renders the Timeline component inside the panel. The
 * transport bar (play / pause / jump) is provided as a default but the
 * engine can replace it via the `transport` prop.
 */

import { useRef, useMemo, useState, type ReactNode } from 'react';
import { useContainerSize } from '@hooks/useContainerSize';
import { Dropdown } from '@components/Dropdown';
import { Icon, type IconName } from '@components/Icon';
import { IconButton } from '@components/IconButton';
import { useCompositionStore } from '@stores/compositionStore';
import { framesToTimecode } from '@core/time/timecode';
import { Timeline, type TimelineProps } from '@layout/Timeline';
import { GraphEditor } from '@layout/Timeline/GraphEditor';
import { cn } from '@utils/cn';
import { useWorkspaceStore } from '@stores/projectStore';
import { useLayoutStore } from '@stores/layoutStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useRenderQualityStore, RESOLUTION_LABELS, type PreviewResolution } from '@stores/renderQualityStore';
import { useUIStore } from '@stores/uiStore';
import { useMotionBlurStore } from '@stores/motionBlurStore';

import { getTimelineController } from '@core/timeline/TimelineController';
import type { EasingPreset } from '@core/animation/keyframeAssistants';
import { useFocusStore } from '@stores/focusStore';
import { bumpScene } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import styles from './BottomTimeline.module.css';

/** Track row-height presets (Premiere/Vegas-style). */
const ROW_HEIGHTS = [
  { key: 'S', label: 'Compact', value: 24 },
  { key: 'M', label: 'Normal', value: 30 },
  { key: 'L', label: 'Tall', value: 44 },
] as const;

export interface BottomTimelineProps extends Omit<TimelineProps, 'className'> {
  className?: string;
  /** Override the default transport bar. */
  transport?: ReactNode;
  /** Called when the user clicks an easing pill (Linear/Ease/EaseIn/EaseOut/Hold). */
  onSetEasing?: (preset: EasingPreset) => void;
}

const ZOOM_STEP = 1.4;
const ZOOM_MIN = 4;
const ZOOM_MAX = 800;
const ZOOM_DEFAULT = 80;

export function BottomTimeline(props: BottomTimelineProps): JSX.Element {
  const { className, transport, onSetEasing, ...timelineProps } = props;
  const ws = useWorkspaceStore((s) => (s.activeTabId ? s.tabs[s.activeTabId] : null));
  // Project tabs (main comp + any group/precomp tabs opened by double-click).
  const tabOrder = useWorkspaceStore((s) => s.tabOrder);
  const projectTabs = useWorkspaceStore((s) => s.tabs);
  const activeTabId = useWorkspaceStore((s) => s.activeTabId);
  const comps = useWorkspaceStore((s) => s.comps);
  const setActiveTab = useWorkspaceStore((s) => s.actions.setActiveTab);
  const closeTab = useWorkspaceStore((s) => s.actions.closeTab);
  // Read collapse state directly from the store so the header always knows.
  const region = useLayoutStore((s) => s.regions.bottomTimeline);
  const isCollapsed = region.collapsed || region.size <= 60;
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
  const onGpu = true;

  // The controller owns loop state. This was local `useState(false)`, which
  // both lied (playback always looped) and destroyed the work area.
  const [looping, setLoopingState] = useState(() => getTimelineController().isLooping());
  const setLooping = (on: boolean): void => {
    getTimelineController().setLooping(on);
    setLoopingState(on);
  };
  const draftQuality = useRenderQualityStore((s) => s.draft);
  const setDraftQuality = useRenderQualityStore((s) => s.setDraft);
  const previewResolution = useRenderQualityStore((s) => s.resolution);
  const setResolution = useRenderQualityStore((s) => s.setResolution);
  const updateComp = useCompositionStore((s) => s.update);
  // Horizontal scroll mirror from Timeline → GraphEditor for pixel-alignment
  const [scrollLeft, setScrollLeft] = useState(0);

  const fps = props.model.frameRate;
  const startFrame = useCompositionStore((s) => s.startFrame);
  const pps = props.model.pixelsPerSecond;
  const onZoom = props.onZoom;
  const zoomPct = Math.round((pps / ZOOM_DEFAULT) * 100);
  const clampZoom = (v: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v));

  // Row-height preset — cycles Compact → Normal → Tall. Overrides the model's
  // trackHeight so the whole timeline rescales without touching the host.
  const [rowIdx, setRowIdx] = useState(1);
  const row = ROW_HEIGHTS[rowIdx]!;
  const cycleRow = (): void => setRowIdx((i) => (i + 1) % ROW_HEIGHTS.length);
  const model = useMemo(
    () => ({ ...timelineProps.model, trackHeight: row.value }),
    [timelineProps.model, row.value],
  );
  const timelineModelProps = { ...timelineProps, model };

  const [searchQuery, setSearchQuery] = useState('');
  const headerRef = useRef<HTMLElement>(null);
  const { width: headerWidth } = useContainerSize(headerRef);
  const isNarrow = headerWidth > 0 && headerWidth < 1200;
  const isCompact = headerWidth > 0 && headerWidth < 800;

  const moreToolsMenu = [
    { type: 'checkbox', id: 'loop', label: 'Loop playback', checked: looping, onChange: setLooping },
    { type: 'checkbox', id: 'draft', label: 'Draft quality', checked: draftQuality, onChange: setDraftQuality },
    {
      type: 'item', id: 'res', label: `Resolution: ${RESOLUTION_LABELS[previewResolution]}`,
      submenu: ([1, 2, 3, 4] as PreviewResolution[]).map((r) => ({
        type: 'item' as const, id: `res-${r}`, label: RESOLUTION_LABELS[r],
        icon: (r === previewResolution ? 'check' : undefined) as IconName | undefined, onSelect: () => setResolution(r),
      })),
    },
    { type: 'checkbox', id: 'shy', label: 'Global Shy', checked: globalShy, onChange: setGlobalShy },
    { type: 'checkbox', id: 'motionblur', label: 'Motion Blur', checked: motionBlurEnabled, onChange: setMotionBlurEnabled, disabled: !onGpu },
    { type: 'separator' },
    { type: 'item', id: 'split', label: 'Split at Playhead', icon: 'scissors', onSelect: () => { getTimelineController().splitSelectedAtPlayhead(selectedIds); bumpScene(); } },
    { type: 'item', id: 'trimin', label: 'Trim In', icon: 'chevron-left', onSelect: () => { getTimelineController().trimSelectedStartToPlayhead(selectedIds); bumpScene(); } },
    { type: 'item', id: 'trimout', label: 'Trim Out', icon: 'chevron-right', onSelect: () => { getTimelineController().trimSelectedEndToPlayhead(selectedIds); bumpScene(); } },
    { type: 'separator' },
    { type: 'checkbox', id: 'graph', label: 'Graph Editor', checked: graphEditorOpen, onChange: setGraphEditorOpen },
  ] as const;

  return (
    <section className={cn(styles.root, className)}>
      <header className={styles.header} ref={headerRef}>
        {transport ?? (
          <>
            {/* AE-style: the timecode leads the timeline panel. */}
            <div
              className={styles.timecode}
              title={`Current time — minutes : seconds : frames @ ${fps} fps`}
            >
              {framesToTimecode(ws?.time ?? props.model.currentTime, fps, startFrame)}
              {/* Total shows the END timecode (start + duration), so a comp that
                  starts at 1:00:00:00 reads its real out-point, not a bare run. */}
              <span className={styles.timecodeTotal}>/ {framesToTimecode(props.model.duration, fps, startFrame)}</span>
            </div>

            {/* Timeline Search/Filter Bar */}
            <div className={styles.searchContainer}>
              <Icon name="search" size={12} className={styles.searchIcon} />
              <input
                type="text"
                placeholder="Filter layers/properties..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className={styles.searchInput}
                aria-label="Filter layers and properties"
              />
              {searchQuery && (
                <button
                  type="button"
                  className={styles.searchClear}
                  onClick={() => setSearchQuery('')}
                  title="Clear search filter"
                >
                  <Icon name="close" size={12} />
                </button>
              )}
            </div>

            <div className={styles.transport}>
              {!isCompact && (
                <IconButton aria-label="Skip to start" title="Go to start (Home)" size="sm" onClick={() => getTimelineController().goToStart()}>
                  <Icon name="skip-back" size={12} />
                </IconButton>
              )}
              <IconButton aria-label="Previous frame" title="Previous frame (Page Up)" size="sm" onClick={() => getTimelineController().previousFrame()}>
                <Icon name="chevron-left" size={13} />
              </IconButton>
              <IconButton
                aria-label={ws?.playing ? 'Pause' : 'Play'}
                title={ws?.playing ? 'Pause' : 'Play'}
                size="md"
                variant="primary"
                className={styles.play}
                onClick={() => getTimelineController().togglePlay()}
              >
                <Icon name={ws?.playing ? 'pause' : 'play'} size={12} />
              </IconButton>
              <IconButton aria-label="Next frame" title="Next frame (Page Down)" size="sm" onClick={() => getTimelineController().nextFrame()}>
                <Icon name="chevron-right" size={13} />
              </IconButton>
              {!isCompact && (
                <IconButton aria-label="Skip to end" title="Go to end (End)" size="sm" onClick={() => getTimelineController().goToEnd()}>
                  <Icon name="skip-forward" size={12} />
                </IconButton>
              )}
              {!isCompact && (
                <IconButton
                  aria-label="Add marker at playhead"
                  title={
                    selectedIds.length === 1
                      ? 'Add layer marker to the selected layer (travels with it)'
                      : 'Add composition marker at playhead'
                  }
                  size="sm"
                  onClick={() => {
                    // AE: a marker with one layer selected is a LAYER marker
                    // (moves with the layer); otherwise a composition marker.
                    const ctrl = getTimelineController();
                    if (selectedIds.length === 1 && ctrl.addLayerMarkerAtPlayhead(selectedIds[0]!)) return;
                    ctrl.addMarkerAtPlayhead();
                  }}
                >
                  <Icon name="marker" size={12} />
                </IconButton>
              )}
            </div>

            {/* Loop + Draft Quality toggles — AE staple controls */}
            {!isNarrow && (
              <>
                <div className={styles.toggleGroup}>
                  <button
                    type="button"
                    className={looping ? styles.toggleIconActive : styles.toggleIcon}
                    title="Loop playback"
                    aria-label="Loop playback"
                    aria-pressed={looping}
                    onClick={() => setLooping(!looping)}
                  >
                    <Icon name="loop" size={12} />
                  </button>
                  <button
                    type="button"
                    className={draftQuality ? styles.toggleIconActive : styles.toggleIcon}
                    title="Draft quality (faster preview)"
                    aria-label="Draft quality"
                    aria-pressed={draftQuality}
                    onClick={() => setDraftQuality(!draftQuality)}
                  >
                    <Icon name="zap" size={12} />
                  </button>
                  {/* Preview resolution — renders fewer pixels for faster playback. */}
                  <Dropdown
                    placement="top-start"
                    trigger={
                      <button
                        type="button"
                        className={previewResolution !== 1 ? styles.toggleBtnActive : styles.toggleBtn}
                        title="Preview resolution (fewer pixels = faster)"
                      >
                        {RESOLUTION_LABELS[previewResolution]}
                        <Icon name="chevron-down" size={10} />
                      </button>
                    }
                    items={([1, 2, 3, 4] as PreviewResolution[]).map((r) => ({
                      type: 'item',
                      id: `res-${r}`,
                      label: RESOLUTION_LABELS[r],
                      icon: r === previewResolution ? 'check' : undefined,
                      onSelect: () => setResolution(r),
                    }))}
                  />
                </div>

                {/* Global switches for Shy and Motion Blur */}
                <div className={styles.toggleGroup}>
                  <button
                    type="button"
                    className={globalShy ? styles.toggleIconActive : styles.toggleIcon}
                    title={globalShy ? 'Global Shy: Active (Shy layers hidden)' : 'Global Shy: Inactive (All layers visible)'}
                    aria-label="Global Shy"
                    aria-pressed={globalShy}
                    onClick={() => setGlobalShy(!globalShy)}
                  >
                    <Icon name="shy" size={12} />
                  </button>
                  <button
                    type="button"
                    className={motionBlurEnabled ? styles.toggleIconActive : styles.toggleIcon}
                    title={motionBlurEnabled ? 'Global Motion Blur: Enabled' : 'Global Motion Blur: Disabled'}
                    aria-label="Global Motion Blur"
                    aria-pressed={motionBlurEnabled}
                    onClick={() => setMotionBlurEnabled(!motionBlurEnabled)}
                  >
                    <Icon name="motion-blur" size={12} />
                  </button>
                </div>

                {/* Layer split / trim controls */}
                <div className={styles.toggleGroup}>
                  <button
                    type="button"
                    className={styles.toggleIcon}
                    title="Split selected layers at playhead (Ctrl+Shift+D)"
                    aria-label="Split at playhead"
                    onClick={() => {
                      getTimelineController().splitSelectedAtPlayhead(selectedIds);
                      bumpScene();
                    }}
                  >
                    <Icon name="scissors" size={12} />
                  </button>
                  <button
                    type="button"
                    className={styles.toggleIcon}
                    title="Trim Layer In point to playhead (Alt+[)"
                    aria-label="Trim In"
                    onClick={() => {
                      getTimelineController().trimSelectedStartToPlayhead(selectedIds);
                      bumpScene();
                    }}
                  >
                    <Icon name="trim-in" size={12} />
                  </button>
                  <button
                    type="button"
                    className={styles.toggleIcon}
                    title="Trim Layer Out point to playhead (Alt+])"
                    aria-label="Trim Out"
                    onClick={() => {
                      getTimelineController().trimSelectedEndToPlayhead(selectedIds);
                      bumpScene();
                    }}
                  >
                    <Icon name="trim-out" size={12} />
                  </button>
                </div>
              </>
            )}

            {isNarrow && (
              <div className={styles.toggleGroup}>
                <Dropdown
                  placement={isCollapsed ? 'top-start' : 'bottom-start'}
                  trigger={
                    <IconButton
                      aria-label="More timeline tools"
                      title="More timeline tools"
                      size="sm"
                    >
                      <Icon name="more-horizontal" size={14} />
                    </IconButton>
                  }
                  items={moreToolsMenu}
                />
              </div>
            )}

            {/* Keyframe interpolation controls — drawn curve icons (the old
                text glyphs ◆⌒◆ rendered inconsistently across fonts). */}
            <div className={styles.interpGroup}>
              {(['Linear', 'Ease', 'EaseIn', 'EaseOut', 'Hold'] as const).map((ease) => (
                <button
                  key={ease}
                  type="button"
                  className={styles.interpBtn}
                  title={`Set keyframe interpolation: ${ease}`}
                  aria-label={`Set keyframe interpolation: ${ease}`}
                  onClick={() => {
                    onSetEasing?.(ease);
                  }}
                >
                  <svg width="26" height="12" viewBox="0 0 26 12" fill="none" aria-hidden>
                    {ease === 'Linear' && <path d="M3 10 L23 2" stroke="currentColor" strokeWidth="1.4" />}
                    {ease === 'Ease' && <path d="M3 10 C 10 10, 16 2, 23 2" stroke="currentColor" strokeWidth="1.4" />}
                    {ease === 'EaseIn' && <path d="M3 10 C 13 7, 19 2.5, 23 2" stroke="currentColor" strokeWidth="1.4" />}
                    {ease === 'EaseOut' && <path d="M3 10 C 7 9.5, 13 5, 23 2" stroke="currentColor" strokeWidth="1.4" />}
                    {ease === 'Hold' && <path d="M3 10 H 13 V 2 H 23" stroke="currentColor" strokeWidth="1.4" />}
                    <rect x="1" y="8" width="4" height="4" transform="rotate(45 3 10)" fill="currentColor" />
                    <rect x="21" y="0" width="4" height="4" transform="rotate(45 23 2)" fill="currentColor" />
                  </svg>
                </button>
              ))}
            </div>

            <div className={styles.zoom}>
              {/* Graph Editor toggle — the signature AE feature */}
              {!isNarrow && (
                <>
                  <button
                    type="button"
                    className={graphEditorOpen ? styles.toggleIconActive : styles.toggleIcon}
                    // Shift+F3 is the EFFECTIVE binding: the AE preset remaps
                    // view.graphEditor's base Shift+G chord (shortcutOverrides).
                    title="Toggle Graph Editor (Shift+F3)"
                    aria-label="Toggle Graph Editor"
                    aria-pressed={graphEditorOpen}
                    onClick={() => setGraphEditorOpen(!graphEditorOpen)}
                  >
                    <Icon name="track" size={13} />
                  </button>
                  <span className={styles.zoomDivider} aria-hidden />
                </>
              )}

              {!isCompact && (
                <>
                  <button
                    type="button"
                    className={styles.rowHeightBtn}
                    title={`Row height: ${row.label} — click to cycle`}
                    aria-label={`Row height ${row.label}`}
                    onClick={cycleRow}
                  >
                    <Icon name="grip-horizontal" size={13} />
                    <span className={styles.rowHeightKey}>{row.key}</span>
                  </button>
                  <span className={styles.zoomDivider} aria-hidden />
                </>
              )}

              <IconButton
                aria-label="Zoom out"
                size="sm"
                disabled={!onZoom || pps <= ZOOM_MIN}
                onClick={() => onZoom?.(clampZoom(pps / ZOOM_STEP))}
              >
                <Icon name="zoom-out" size={12} />
              </IconButton>
              {!isCompact && (
                <button
                  type="button"
                  className={styles.zoomLabel}
                  title="Reset zoom to 100%"
                  disabled={!onZoom}
                  onClick={() => onZoom?.(ZOOM_DEFAULT)}
                >
                  {zoomPct}%
                </button>
              )}
              <IconButton
                aria-label="Zoom in"
                size="sm"
                disabled={!onZoom || pps >= ZOOM_MAX}
                onClick={() => onZoom?.(clampZoom(pps * ZOOM_STEP))}
              >
                <Icon name="zoom-in" size={12} />
              </IconButton>
            </div>
          </>
        )}
      </header>

      {/* ── Timeline Tabs — real project tabs (main comp + opened groups).
            Hidden while there is only the main comp and no focus breadcrumb —
            a single static tab is pure noise between the header and tracks. ── */}
      {!isCollapsed && (tabOrder.length > 1 || focusPath.length > 0) && (
        <div className={styles.tabBar}>
          {tabOrder.map((tid, idx) => {
            const tab = projectTabs[tid];
            if (!tab) return null;
            const node = defaultSceneGraph.getNode(tab.compositionId);
            const label =
              comps[tab.compositionId]?.name ?? node?.name ?? tab.title ?? tab.compositionId;
            const isActive = tid === activeTabId && focusPath.length === 0;
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
          })}
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

      <div className={cn(styles.body, isCollapsed && styles.bodyCollapsed)}>
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
        />

        {/* Graph Editor panel — slides in below the track rows when toggled */}
        {graphEditorOpen && (
          <GraphEditor
            selectedNodeIds={selectedIds}
            currentTime={props.model.currentTime}
            duration={props.model.duration}
            pixelsPerSecond={pps}
            scrollLeft={scrollLeft}
            height={200}
            onScrub={props.onScrub}
          />
        )}
      </div>
    </section>
  );
}
