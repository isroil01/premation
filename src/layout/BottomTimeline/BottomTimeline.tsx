/**
 * BottomTimeline — bottom region host.
 *
 *   <BottomTimeline model={...} onScrub={...} />
 *
 * For now it just renders the Timeline component inside the panel. The
 * transport bar (play / pause / jump) is provided as a default but the
 * engine can replace it via the `transport` prop.
 */

import { useMemo, useState, useEffect, type ReactNode } from 'react';
import { Icon } from '@components/Icon';
import { IconButton } from '@components/IconButton';
import { Timeline, type TimelineProps } from '@layout/Timeline';
import { GraphEditor } from '@layout/Timeline/GraphEditor';
import { cn } from '@utils/cn';
import { useWorkspaceStore } from '@stores/projectStore';
import { useLayoutStore } from '@stores/layoutStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useRenderQualityStore } from '@stores/renderQualityStore';
import { getTimelineController } from '@core/timeline/TimelineController';
import type { EasingPreset } from '@core/animation/keyframeAssistants';
import { useFocusStore } from '@stores/focusStore';
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

function formatTime(sec: number, fps: number): string {
  const totalFrames = Math.floor(sec * fps);
  const m = Math.floor(totalFrames / (fps * 60));
  const s = Math.floor((totalFrames / fps) % 60);
  const f = totalFrames % fps;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}:${f.toString().padStart(2, '0')}`;
}

const ZOOM_STEP = 1.4;
const ZOOM_MIN = 4;
const ZOOM_MAX = 800;
const ZOOM_DEFAULT = 80;

export function BottomTimeline(props: BottomTimelineProps): JSX.Element {
  const { className, transport, onSetEasing, ...timelineProps } = props;
  const ws = useWorkspaceStore((s) => (s.activeId ? s.workspaces[s.activeId] : null));
  const toggleTimeline = useLayoutStore((s) => s.toggleRegion);
  // Read collapse state directly from the store so the header always knows.
  const isCollapsed = useLayoutStore((s) => s.regions.bottomTimeline.collapsed);
  const selectedIds = useSelectionStore((s) => s.ids);
  const focusPath = useFocusStore((s) => s.path);
  const jumpToFocus = useFocusStore((s) => s.jumpTo);

  // Graph Editor toggle state (AE: the "Graph Editor" button in the timeline header)
  const [graphEditorOpen, setGraphEditorOpen] = useState(false);
  const [looping, setLooping] = useState(false);
  const draftQuality = useRenderQualityStore((s) => s.draft);
  const setDraftQuality = useRenderQualityStore((s) => s.setDraft);
  // Horizontal scroll mirror from Timeline → GraphEditor for pixel-alignment
  const [scrollLeft, setScrollLeft] = useState(0);

  // Wire looping state → TimelineController work area
  useEffect(() => {
    const ctrl = getTimelineController();
    if (looping) {
      const dur = ctrl.durationSeconds;
      ctrl.setWorkArea(0, dur);
    } else {
      ctrl.clearWorkArea();
    }
  }, [looping]);

  const fps = props.model.frameRate;
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

  return (
    <section className={cn(styles.root, className)}>
      <header className={styles.header}>
        {transport ?? (
          <>
            {/* AE-style: the timecode leads the timeline panel. */}
            <div className={styles.timecode}>
              {formatTime(ws?.time ?? props.model.currentTime, fps)}
              <span className={styles.timecodeTotal}>/ {formatTime(props.model.duration, fps)}</span>
            </div>

            <div className={styles.transport}>
              <IconButton aria-label="Skip to start" title="Go to start (Home)" size="sm" onClick={() => getTimelineController().goToStart()}>
                <Icon name="skip-back" size={12} />
              </IconButton>
              <IconButton aria-label="Previous frame" title="Previous frame (Page Up)" size="sm" onClick={() => getTimelineController().previousFrame()}>
                <Icon name="chevron-left" size={13} />
              </IconButton>
              <IconButton
                aria-label={ws?.playing ? 'Pause' : 'Play'}
                title={ws?.playing ? 'Pause (Space)' : 'Play (Space)'}
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
              <IconButton aria-label="Skip to end" title="Go to end (End)" size="sm" onClick={() => getTimelineController().goToEnd()}>
                <Icon name="skip-forward" size={12} />
              </IconButton>
              <IconButton
                aria-label="Add marker at playhead"
                title="Add marker at playhead"
                size="sm"
                onClick={() => getTimelineController().addMarkerAtPlayhead()}
              >
                <Icon name="marker" size={12} />
              </IconButton>
            </div>

            {/* Loop + Draft Quality toggles — AE staple controls */}
            <div className={styles.toggleGroup}>
              <button
                type="button"
                className={looping ? styles.toggleBtnActive : styles.toggleBtn}
                title="Loop playback"
                onClick={() => setLooping((v) => !v)}
              >
                <Icon name="rotate-cw" size={11} />
                Loop
              </button>
              <button
                type="button"
                className={draftQuality ? styles.toggleBtnActive : styles.toggleBtn}
                title="Draft quality (faster preview)"
                onClick={() => setDraftQuality(!draftQuality)}
              >
                Draft
              </button>
            </div>

            {/* Keyframe interpolation controls */}
            <div className={styles.interpGroup}>
              {(['Linear', 'Ease', 'EaseIn', 'EaseOut', 'Hold'] as const).map((ease) => (
                <button
                  key={ease}
                  type="button"
                  className={styles.interpBtn}
                  title={`Set keyframe interpolation: ${ease}`}
                  onClick={() => {
                    onSetEasing?.(ease);
                  }}
                >
                  {ease === 'Linear' ? '◆—◆' :
                   ease === 'Ease'   ? '◆⌒◆' :
                   ease === 'EaseIn' ? '◆⤴' :
                   ease === 'EaseOut'? '⤵◆' :
                                       '◆|◆'}
                </button>
              ))}
            </div>

            <div className={styles.zoom}>
              {/* Graph Editor toggle — the signature AE feature */}
              <button
                type="button"
                className={graphEditorOpen ? styles.graphBtnActive : styles.graphBtn}
                title="Toggle Graph Editor (Shift+F3)"
                aria-pressed={graphEditorOpen}
                onClick={() => setGraphEditorOpen((v) => !v)}
              >
                <Icon name="track" size={13} />
                Graph Editor
              </button>

              <span className={styles.zoomDivider} aria-hidden />

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

              <IconButton
                aria-label="Zoom out"
                size="sm"
                disabled={!onZoom || pps <= ZOOM_MIN}
                onClick={() => onZoom?.(clampZoom(pps / ZOOM_STEP))}
              >
                <Icon name="zoom-out" size={12} />
              </IconButton>
              <button
                type="button"
                className={styles.zoomLabel}
                title="Reset zoom to 100%"
                disabled={!onZoom}
                onClick={() => onZoom?.(ZOOM_DEFAULT)}
              >
                {zoomPct}%
              </button>
              <IconButton
                aria-label="Zoom in"
                size="sm"
                disabled={!onZoom || pps >= ZOOM_MAX}
                onClick={() => onZoom?.(clampZoom(pps * ZOOM_STEP))}
              >
                <Icon name="zoom-in" size={12} />
              </IconButton>

              <span className={styles.zoomDivider} aria-hidden />

              <IconButton
                aria-label="Collapse timeline"
                size="sm"
                title="Collapse timeline"
                onClick={() => toggleTimeline('bottomTimeline')}
              >
                <Icon name="panel-bottom" size={13} />
              </IconButton>
            </div>
          </>
        )}
      </header>

      {/* ── Timeline Tabs ── */}
      {!isCollapsed && (
        <div className={styles.tabBar}>
          <button
            type="button"
            className={cn(styles.tab, focusPath.length === 0 && styles.tabActive)}
            onClick={() => jumpToFocus(-1)}
          >
            Main Composition
          </button>
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
