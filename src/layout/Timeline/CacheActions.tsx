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
 * ## What the engine offers
 *
 * The cache is the engine's (video memory, filled by the frames it draws). It
 * can be emptied (`purgeCache`); it cannot be asked to pre-render a span, so
 * "cache now" is shown disabled with the reason rather than pretending — see
 * `previewCacheCommands`. A disk row appears only if the engine ever reports a
 * disk tier.
 *
 * ## Self-subscribing, throttled — like CacheBars
 *
 * Coverage changes on every cached frame. This leaf reads the engine's
 * coverage snapshot at {@link REFRESH_HZ} and nothing above it re-renders,
 * which is the same contract `CacheBars` documents at length and for the same
 * reason. 2Hz, not 10: this is a frame COUNT, and a number ticking ten times a
 * second is unreadable in a way a growing bar is not.
 */

import { useCallback, useEffect, useState, memo } from 'react';
import { Icon } from '@components/Icon';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { subscribeEngineCache } from './engineCacheCoverage';
import {
  CACHE_WORK_AREA_UNAVAILABLE,
  cacheWorkAreaNow,
  canCacheWorkArea,
  installPreviewCacheCommands,
  purgeDiskCache,
  purgeRamPreview,
} from './previewCacheCommands';
import { describePreviewCache, previewCacheStats, type PreviewCacheStats } from './previewCacheStats';
import styles from './CacheActions.module.css';

/** How often the readout re-reads coverage while it is changing. */
const REFRESH_HZ = 2;

/**
 * The live coverage readout and a way to re-read it after an action. The
 * subscription is here rather than in the component so the toolbar's
 * last-resort `⋯` menu (`TimelineToolbarOverflow`) can list the same rows
 * from the same numbers when the button group has had to leave the row.
 */
export function usePreviewCacheStats(): { stats: PreviewCacheStats; refresh: () => void } {
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
    // every change until it fires rides along. Subscribing is also what keeps
    // the engine coverage poll running while this readout is on screen.
    const off = subscribeEngineCache(() => {
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

  return { stats, refresh };
}

/**
 * The dropdown's rows: cache now (disabled, with the reason, while there is
 * nothing to cache), purge RAM, and purge disk when the engine has a disk tier.
 */
export function previewCacheMenuItems(stats: PreviewCacheStats, refresh: () => void): DropdownItem[] {
  const hasRam = stats.ramMb > 0;
  const canCache = canCacheWorkArea();
  const items: DropdownItem[] = [
    { type: 'label', label: describePreviewCache(stats) },
    { type: 'separator' },
    {
      type: 'item',
      id: 'cache-work-area',
      label: stats.workArea ? 'Cache Work Area Now' : 'Cache Composition Now',
      icon: 'refresh',
      disabled: !canCache || stats.total === 0,
      onSelect: () => {
        cacheWorkAreaNow();
        refresh();
      },
    },
  ];
  if (!canCache) items.push({ type: 'label', label: CACHE_WORK_AREA_UNAVAILABLE });
  items.push(
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
  );
  // The engine's cache is video memory only; `diskMb` is null until it reports
  // a disk tier, and a purge row for a tier that does not exist is noise.
  if (stats.diskMb !== null) {
    items.push({
      type: 'item',
      id: 'purge-disk',
      label: 'Purge Disk Cache',
      icon: 'trash',
      danger: true,
      onSelect: () => {
        purgeDiskCache();
        refresh();
      },
    });
  }
  return items;
}

function CacheActionsImpl(): JSX.Element {
  const { stats, refresh } = usePreviewCacheStats();
  const full = stats.total > 0 && stats.cached >= stats.total;
  const canCache = canCacheWorkArea();
  const what = stats.workArea ? 'work area' : 'composition';
  const cacheTitle = full
    ? `${stats.workArea ? 'Work area' : 'Composition'} is already cached`
    : canCache
      ? `Cache ${what} now — ${describePreviewCache(stats)}`
      : `${describePreviewCache(stats)}. ${CACHE_WORK_AREA_UNAVAILABLE}`;

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
        title={cacheTitle}
        aria-label={canCache ? 'Cache work area now' : `Cache work area now — unavailable. ${CACHE_WORK_AREA_UNAVAILABLE}`}
        disabled={!canCache || stats.total === 0}
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
        items={previewCacheMenuItems(stats, refresh)}
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
