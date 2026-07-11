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
import { IconButton } from '@components/IconButton';
import { Timeline, type TimelineProps } from '@layout/Timeline';
import { cn } from '@utils/cn';
import { useWorkspaceStore } from '@stores/workspaceStore';
import { useLayoutStore } from '@stores/layoutStore';
import { getTimelineController } from '@core/timeline/TimelineController';
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
  const { className, transport, ...timelineProps } = props;
  const ws = useWorkspaceStore((s) => (s.activeId ? s.workspaces[s.activeId] : null));
  const toggleTimeline = useLayoutStore((s) => s.toggleRegion);

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

            <div className={styles.zoom}>
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
      <div className={styles.body}>
        <Timeline {...timelineModelProps} />
      </div>
    </section>
  );
}
