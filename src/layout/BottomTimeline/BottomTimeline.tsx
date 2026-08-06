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
import { useUIStore } from '@stores/uiStore';
import { useMotionBlurStore } from '@stores/motionBlurStore';

import { useFocusStore } from '@stores/focusStore';
import { getTimelineController } from '@core/timeline/TimelineController';
import { bumpScene } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { ViewportTools } from '@layout/Workspace/ViewportTools';
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

  const draftQuality = useRenderQualityStore((s) => s.draft);
  const setDraftQuality = useRenderQualityStore((s) => s.setDraft);
  const updateComp = useCompositionStore((s) => s.update);
  // Horizontal scroll mirror from Timeline → GraphEditor for pixel-alignment
  const [scrollLeft, setScrollLeft] = useState(0);

  const fps = props.model.frameRate;
  const startFrame = useCompositionStore((s) => s.startFrame);
  const pps = props.model.pixelsPerSecond;
  const onZoom = props.onZoom;
  const zoomPct = Math.round((pps / ZOOM_DEFAULT) * 100);
  const clampZoom = (v: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v));

  const [rowTrackHeight, setRowTrackHeight] = useState(24);

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

  const previewResolution = useRenderQualityStore((s) => s.resolution);
  const setResolution = useRenderQualityStore((s) => s.setResolution);
  const [looping, setLoopingState] = useState(() => getTimelineController().isLooping());
  const [searchQuery, setSearchQuery] = useState('');

  return (
    <section className={cn(styles.root, className)}>
      <header className={styles.header}>
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
              <Icon name="search" size="sm" className={styles.searchIcon} />
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
                  <Icon name="close" size="sm" />
                </button>
              )}
            </div>

            <div className={styles.transportDivider} />

            {/* Playback Transport Buttons */}
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
                <Icon name={ws?.playing ? 'pause' : 'play'} size="md" weight={ws?.playing ? 'regular' : 'fill'} />
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

            {/*
              Preview quality, beside the marker button.

              It sits with playback rather than with the clip operations because
              that is what it is: a playback setting, changed while scrubbing,
              and it was previously stranded at the far right past three groups
              of editing tools nobody passes on the way to it.
            */}
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
                items={([1, 2, 3, 4] as PreviewResolution[]).map((r) => ({
                  type: 'item' as const,
                  id: `res-${r}`,
                  label: `${RESOLUTION_LABELS[r]} · ${RESOLUTION_PERCENT[r]}`,
                  icon: (r === previewResolution ? 'check' : undefined) as any,
                  onSelect: () => setResolution(r),
                }))}
              />
            </div>

            <div className={styles.transportDivider} />

            {/* Layer Clip Operations */}
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
              auto-keyframe, rulers/safe/channel, zoom, pop out — plus the two
              status badges that used to sit in a bar above the canvas.

              They were a pill floating over the bottom-left of the stage. Here
              they are in the same row as Play and the trim buttons, which is
              where every other control acting on time and layers already was.
              Over there they covered the canvas, and covered a different part
              of it at every zoom level. `ViewportTools` owns its own contextual
              show/hide, so this is one line rather than a copy of its
              conditions.
            */}
            <div className={styles.transportCluster}>
              <ViewportTools />
            </div>



            {/* AE Timeline Header Tools */}
            <div className={styles.aeHeaderTools}>
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

              {/* Row Height Size Changer Button */}
              <button
                type="button"
                className={rowTrackHeight > 24 ? styles.toggleIconActive : styles.toggleIcon}
                title={`Timeline Row Height: ${rowTrackHeight}px (Click to toggle Compact / Normal / Tall)`}
                aria-label="Change timeline row height"
                onClick={() => {
                  setRowTrackHeight((h) => (h === 22 ? 26 : h === 26 ? 30 : 22));
                }}
              >
                <Icon name="layers" size="sm" />
              </button>
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
          />
        </div>

        {/* Graph Editor panel — full height view replacing track rows below the header toolbar when toggled */}
        {graphEditorOpen && (
          <GraphEditor
            selectedNodeIds={selectedIds}
            currentTime={props.model.currentTime}
            duration={props.model.duration}
            pixelsPerSecond={pps}
            scrollLeft={scrollLeft}
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
