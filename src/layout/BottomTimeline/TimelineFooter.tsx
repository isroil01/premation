/**
 * TimelineFooter — the timeline's readouts and view controls: render time,
 * cache, Toggle Switches / Modes, the zoom slider, and the sideways scrollbars
 * of the layer columns and of the lanes, each shown only while it has something
 * to scroll.
 *
 * They draw in the editor's status bar, so the timeline panel gives that height
 * to its rows (owner 2026-11-05). A popped-out timeline has no status bar, so
 * there they stay at the foot of the panel.
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useUIStore } from '@stores/uiStore';
import { useTimelineStatusSlotStore } from '@stores/timelineStatusSlotStore';
import { viewportHudStats } from '@stores/viewportDisplayStore';
import { TimelineZoom } from '@layout/StatusBar/TimelineZoom';
import { ScrollProxyBar } from '@layout/StatusBar/ScrollProxyBar';
import { usePreviewCacheStats } from '@layout/Timeline/CacheActions';
import { describePreviewCache } from '@layout/Timeline/previewCacheStats';
import { t } from '@core/i18n';
import { cn } from '@utils/cn';
import styles from './BottomTimeline.module.css';

/** How often the readout re-reads the render loop's rolling mean. */
const SAMPLE_MS = 500;

/**
 * The rolling mean of the last real renders, read twice a second — not per
 * played frame (performance discipline: no React render per frame). The state
 * only changes when the rounded figure does, so a steady comp renders nothing.
 */
function FrameRenderTime(): JSX.Element {
  const [ms, setMs] = useState(() => Math.round(viewportHudStats.sample().frameMs));
  useEffect(() => {
    const id = window.setInterval(() => {
      const next = Math.round(viewportHudStats.sample().frameMs);
      setMs((cur) => (cur === next ? cur : next));
    }, SAMPLE_MS);
    return () => window.clearInterval(id);
  }, []);
  return (
    <span className={cn(styles.footerReadout, styles.footerRenderTime)} title={t('timeline.footer.renderTimeTitle', 'Mean time to render a frame, over the last 30 renders')}>
      {t('timeline.footer.renderTime', 'Frame Render Time:')} <b className={styles.footerValue}>{ms > 0 ? `${ms}ms` : '—'}</b>
    </span>
  );
}

/**
 * The cache lanes under the navigator, as two figures: how much of the comp
 * (or work area) plays from memory, and how much the disk tier holds. Read
 * at 2Hz through `usePreviewCacheStats`, never per frame.
 */
function CacheReadout(): JSX.Element {
  const { stats } = usePreviewCacheStats();
  if (stats.total <= 0) return <span className={cn(styles.footerReadout, styles.footerCache)}>{t('timeline.footer.cacheEmpty', 'Cache —')}</span>;
  const ram = Math.round((stats.cached / stats.total) * 100);
  const disk = stats.diskMb === null ? null : Math.round((stats.onDisk / stats.total) * 100);
  return (
    <span className={cn(styles.footerReadout, styles.footerCache)} title={describePreviewCache(stats)}>
      {disk === null
        ? t('timeline.footer.cacheRam', 'Cache {ram}% RAM', { ram })
        : t('timeline.footer.cacheRamDisk', 'Cache {ram}% RAM · {disk}% disk', { ram, disk })}
    </span>
  );
}

export interface TimelineFooterProps {
  /** The track-header column's width, so the in-place footer sits under its columns. */
  headerWidth: number;
  /** The lanes' scrollbar. Off while the Graph Editor covers them: it scrolls itself. */
  lanesBar: boolean;
}

export function TimelineFooter({ headerWidth, lanesBar }: TimelineFooterProps): JSX.Element {
  const cycleColumns = useUIStore((s) => s.cycleTimelineColumns);
  const leftSlot = useTimelineStatusSlotStore((s) => s.left);
  const rightSlot = useTimelineStatusSlotStore((s) => s.right);
  const headerScroller = useTimelineStatusSlotStore((s) => s.headerScroller);
  const lanesScroller = useTimelineStatusSlotStore((s) => s.lanesScroller);

  const readouts = (
    <>
      <FrameRenderTime />
      <CacheReadout />
      <button
        type="button"
        className={styles.footerToggle}
        title={t('timeline.footer.toggleColumnsTitle', 'Cycle the columns: Switches, Modes, both (F4)')}
        onClick={() => cycleColumns()}
      >
        {t('timeline.footer.toggleColumns', 'Toggle Switches / Modes')}
      </button>
      <ScrollProxyBar target={headerScroller} label={t('timeline.footer.scrollColumns', 'Scroll the layer columns sideways')} />
    </>
  );
  const view = (
    <>
      <ScrollProxyBar target={lanesBar ? lanesScroller : null} label={t('timeline.footer.scrollLanes', 'Scroll the timeline sideways')} />
      <TimelineZoom />
    </>
  );

  if (leftSlot && rightSlot) {
    return (
      <>
        {createPortal(readouts, leftSlot)}
        {createPortal(view, rightSlot)}
      </>
    );
  }
  return (
    <div className={styles.footer} aria-label={t('timeline.footer.aria', 'Timeline footer')}>
      <div className={styles.footerLeft} style={{ width: headerWidth }}>{readouts}</div>
      <div className={styles.footerRight}>{view}</div>
    </div>
  );
}

export default TimelineFooter;
