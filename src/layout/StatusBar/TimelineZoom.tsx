/**
 * TimelineZoom — zoom out · slider · percentage · zoom in · fit, for the status bar.
 *
 * Reads and writes the timeline controller directly rather than taking props,
 * because it no longer lives inside the timeline panel: it sits in the app's
 * status bar, beside the fps readout. Zoom changes made anywhere (the wheel,
 * the +/- keys, the graph editor) come back through `TimelineZoomChanged`, so
 * the slider tracks them without the panel having to hand anything down.
 *
 * The two FIT actions are the reason this control stopped being four buttons.
 * Stepping by ×1.4 until the comp happens to fit is not zooming, it is
 * guessing; every editor with a timeline has a "show me all of it" key, and the
 * work-area variant is the one people reach for while grading a preview range.
 */

import { useEffect, useState } from 'react';
import { Icon } from '@components/Icon';
import { getTimelineController } from '@core/timeline/TimelineController';
import {
  subscribeTimelineViewport,
  getTimelineViewport,
} from '@layout/Timeline/timelineViewport';
import {
  fitTimelineToComposition,
  fitTimelineToWorkArea,
  hasWorkArea,
  TIMELINE_ZOOM_MIN,
  TIMELINE_ZOOM_MAX,
} from '@layout/Timeline/timelineFit';
import { installTimelineFitCommands } from '@layout/Timeline/timelineFitCommands';
import styles from './TimelineZoom.module.css';

const ZOOM_STEP = 1.4;
/** Pixels per second that reads as "100%". */
const ZOOM_DEFAULT = 80;

const clamp = (v: number): number => Math.min(TIMELINE_ZOOM_MAX, Math.max(TIMELINE_ZOOM_MIN, v));

export function TimelineZoom(): JSX.Element {
  const [pps, setPps] = useState(() => getTimelineController().getPixelsPerSecond());
  /** Whether a timeline is mounted and measured — both fit actions need a width. */
  const [fitReady, setFitReady] = useState(() => getTimelineViewport().width > 0);
  const [workAreaSet, setWorkAreaSet] = useState(false);

  useEffect(() => {
    const c = getTimelineController();
    const sync = (): void => setPps(c.getPixelsPerSecond());
    sync();
    const sub = c.timeline.events.on('TimelineZoomChanged', sync);
    return () => sub.dispose();
  }, []);

  // The fit buttons are only live once the timeline panel has reported how wide
  // its lanes are — with no width there is nothing to fit INTO, and the action
  // would either do nothing or slam the zoom to a clamp bound.
  useEffect(() => subscribeTimelineViewport((s) => setFitReady(s.width > 0)), []);

  // The work area is optional, and B/N set it from anywhere. Tracked so the
  // button disables itself rather than being a control that silently no-ops.
  useEffect(() => {
    const c = getTimelineController();
    const sync = (): void => setWorkAreaSet(hasWorkArea());
    sync();
    const sub = c.timeline.events.on('RangeChanged', sync);
    return () => sub.dispose();
  }, []);

  // Commands (menu / palette / keyboard: `;` and Alt+`;`). Idempotent, so
  // remounting the status bar does not re-register anything.
  useEffect(() => installTimelineFitCommands(), []);

  const setZoom = (next: number): void => {
    const c = getTimelineController();
    c.setPixelsPerSecond(clamp(next), c.currentSeconds);
    setPps(c.getPixelsPerSecond());
  };

  const afterFit = (): void => setPps(getTimelineController().getPixelsPerSecond());

  const pct = Math.round((pps / ZOOM_DEFAULT) * 100);

  return (
    <div className={styles.zoom}>
      <button
        type="button"
        className={styles.iconBtn}
        title="Zoom Out"
        disabled={pps <= TIMELINE_ZOOM_MIN}
        onClick={() => setZoom(pps / ZOOM_STEP)}
      >
        <Icon name="zoom-out" size="sm" />
      </button>
      <input
        type="range"
        min={TIMELINE_ZOOM_MIN}
        max={TIMELINE_ZOOM_MAX}
        value={clamp(pps)}
        onChange={(e) => setZoom(Number(e.target.value))}
        className={styles.range}
        aria-label="Timeline zoom"
        title={`Timeline Zoom: ${pct}%`}
      />
      <button
        type="button"
        className={styles.label}
        title="Reset zoom to 100%"
        onClick={() => setZoom(ZOOM_DEFAULT)}
      >
        {pct}%
      </button>
      <button
        type="button"
        className={styles.iconBtn}
        title="Zoom In"
        disabled={pps >= TIMELINE_ZOOM_MAX}
        onClick={() => setZoom(pps * ZOOM_STEP)}
      >
        <Icon name="zoom-in" size="sm" />
      </button>
      <span className={styles.divider} aria-hidden />
      <button
        type="button"
        className={styles.iconBtn}
        title="Fit Composition to Timeline  (;)"
        aria-label="Fit composition to timeline"
        disabled={!fitReady}
        onClick={() => {
          fitTimelineToComposition();
          afterFit();
        }}
      >
        <Icon name="fit" size="sm" />
      </button>
      <button
        type="button"
        className={styles.iconBtn}
        title="Fit Work Area to Timeline  (Alt+;)"
        aria-label="Fit work area to timeline"
        disabled={!fitReady || !workAreaSet}
        onClick={() => {
          fitTimelineToWorkArea();
          afterFit();
        }}
      >
        <Icon name="frame" size="sm" />
      </button>
    </div>
  );
}
