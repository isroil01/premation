/**
 * The cache lane's own controls.
 *
 * The green and blue strips under the ruler have always been a READOUT: they
 * tell you what is cached and offer nothing to do about it. The two things
 * anyone wants at that moment — "fill the rest of it" and "throw it away" —
 * lived in the Preferences dialog (both purges) and nowhere at all (caching on
 * demand: you could only wait 1.5 seconds and hope the idle pump agreed).
 *
 * This is that button group, mounted at the right end of the lane's row so it
 * sits with the thing it acts on. It renders next to the time navigator rather
 * than inside the scrolling lane itself: the lane scrolls horizontally with the
 * comp, and a control that slides off the edge of the panel when you scroll is
 * a control you cannot find.
 *
 * ## Self-subscribing, throttled — like CacheBars
 *
 * Coverage changes on every cached frame. This leaf reads it directly from the
 * cache at {@link REFRESH_HZ} and nothing above it re-renders, which is the
 * same contract `CacheBars` documents at length and for the same reason. 2Hz,
 * not 10: this is a frame COUNT, and a number ticking ten times a second is
 * unreadable in a way a growing bar is not.
 */

import { useCallback, useEffect, useState, memo } from 'react';
import { Icon } from '@components/Icon';
import { Dropdown } from '@components/Dropdown';
import { viewportFrameCache } from '@core/rendering/frameCache';
import { activeViewportDiskCache } from '@core/rendering/frameDiskCache';
import {
  cacheWorkAreaNow,
  installPreviewCacheCommands,
  purgeDiskCache,
  purgeRamPreview,
} from './previewCacheCommands';
import { describePreviewCache, previewCacheStats, type PreviewCacheStats } from './previewCacheStats';
import styles from './CacheActions.module.css';

/** How often the readout re-reads coverage while it is changing. */
const REFRESH_HZ = 2;

function CacheActionsImpl(): JSX.Element {
  const [stats, setStats] = useState<PreviewCacheStats>(() => previewCacheStats());

  // The commands exist because this component does; registering from here
  // keeps the feature one unit, the way `timelineFitCommands` is installed by
  // the control that owns it. Idempotent.
  useEffect(() => {
    installPreviewCacheCommands();
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const sample = (): void => {
      const next = previewCacheStats();
      setStats((prev) => (sameStats(prev, next) ? prev : next));
    };

    const flush = (): void => {
      timer = null;
      sample();
    };

    // Trailing throttle: the first change of a burst schedules one flush and
    // every change until it fires rides along.
    const off = viewportFrameCache.onChange(() => {
      if (timer !== null) return;
      timer = setTimeout(flush, 1000 / REFRESH_HZ);
    });

    sample();

    return () => {
      off();
      if (timer !== null) clearTimeout(timer);
    };
  }, []);

  const refresh = useCallback(() => {
    setStats(previewCacheStats());
  }, []);

  const full = stats.total > 0 && stats.cached >= stats.total;
  const hasRam = stats.ramMb > 0;
  const hasDisk = activeViewportDiskCache() !== null;

  return (
    <div className={styles.group} role="group" aria-label="Preview cache">
      {stats.total > 0 && (
        <span className={styles.readout} aria-hidden>
          {stats.cached}/{stats.total}
        </span>
      )}

      <button
        type="button"
        className={styles.btn}
        title={
          full
            ? `${stats.workArea ? 'Work area' : 'Composition'} is already cached`
            : `Cache ${stats.workArea ? 'work area' : 'composition'} now — ${describePreviewCache(stats)}`
        }
        aria-label="Cache work area now"
        disabled={stats.total === 0}
        onClick={() => {
          cacheWorkAreaNow();
          refresh();
        }}
      >
        <Icon name="refresh" size="sm" />
      </button>

      <Dropdown
        placement="bottom-end"
        trigger={
          <button
            type="button"
            className={styles.btn}
            title="Preview cache actions"
            aria-label="Preview cache actions"
          >
            <Icon name="more-horizontal" size="sm" />
          </button>
        }
        items={[
          { type: 'label', label: describePreviewCache(stats) },
          { type: 'separator' },
          {
            type: 'item',
            id: 'cache-work-area',
            label: stats.workArea ? 'Cache Work Area Now' : 'Cache Composition Now',
            icon: 'refresh',
            disabled: stats.total === 0,
            onSelect: () => {
              cacheWorkAreaNow();
              refresh();
            },
          },
          { type: 'separator' },
          {
            type: 'item',
            id: 'purge-ram',
            label: 'Purge RAM Preview',
            icon: 'trash',
            disabled: !hasRam,
            onSelect: () => {
              purgeRamPreview();
              refresh();
            },
          },
          {
            type: 'item',
            id: 'purge-disk',
            label: 'Purge Disk Cache',
            icon: 'trash',
            danger: true,
            disabled: !hasDisk,
            onSelect: () => {
              purgeDiskCache();
              refresh();
            },
          },
        ]}
      />
    </div>
  );
}

function sameStats(a: PreviewCacheStats, b: PreviewCacheStats): boolean {
  return (
    a.cached === b.cached
    && a.total === b.total
    && a.workArea === b.workArea
    // Megabytes, not bytes: the readout rounds, so a byte of churn must not
    // re-render a component that samples on a timer to avoid exactly that.
    && Math.round(a.ramMb) === Math.round(b.ramMb)
    && (a.diskMb === null || b.diskMb === null
      ? a.diskMb === b.diskMb
      : Math.round(a.diskMb) === Math.round(b.diskMb))
  );
}

export const CacheActions = memo(CacheActionsImpl);
export default CacheActions;
