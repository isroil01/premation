/**
 * TimelineZoom — zoom out · slider · percentage · zoom in, for the status bar.
 *
 * Reads and writes the timeline controller directly rather than taking props,
 * because it no longer lives inside the timeline panel: it sits in the app's
 * status bar, beside the fps readout. Zoom changes made anywhere (the wheel,
 * the +/- keys, the graph editor) come back through `TimelineZoomChanged`, so
 * the slider tracks them without the panel having to hand anything down.
 */

import { useEffect, useState } from 'react';
import { Icon } from '@components/Icon';
import { getTimelineController } from '@core/timeline/TimelineController';
import styles from './TimelineZoom.module.css';

const ZOOM_STEP = 1.4;
const ZOOM_MIN = 4;
const ZOOM_MAX = 800;
/** Pixels per second that reads as "100%". */
const ZOOM_DEFAULT = 80;

const clamp = (v: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v));

export function TimelineZoom(): JSX.Element {
  const [pps, setPps] = useState(() => getTimelineController().getPixelsPerSecond());

  useEffect(() => {
    const c = getTimelineController();
    const sync = (): void => setPps(c.getPixelsPerSecond());
    sync();
    const sub = c.timeline.events.on('TimelineZoomChanged', sync);
    return () => sub.dispose();
  }, []);

  const setZoom = (next: number): void => {
    const c = getTimelineController();
    c.setPixelsPerSecond(clamp(next), c.currentSeconds);
    setPps(c.getPixelsPerSecond());
  };

  const pct = Math.round((pps / ZOOM_DEFAULT) * 100);

  return (
    <div className={styles.zoom}>
      <button
        type="button"
        className={styles.iconBtn}
        title="Zoom Out"
        disabled={pps <= ZOOM_MIN}
        onClick={() => setZoom(pps / ZOOM_STEP)}
      >
        <Icon name="zoom-out" size="sm" />
      </button>
      <input
        type="range"
        min={ZOOM_MIN}
        max={ZOOM_MAX}
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
        disabled={pps >= ZOOM_MAX}
        onClick={() => setZoom(pps * ZOOM_STEP)}
      >
        <Icon name="zoom-in" size="sm" />
      </button>
    </div>
  );
}
