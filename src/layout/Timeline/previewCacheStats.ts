/**
 * What the preview cache holds, phrased as the question people actually ask:
 * "is my work area ready to play?"
 *
 * The cache bars answer that geometrically — a green strip under the ruler —
 * which is the right answer while you are looking at the timeline and no
 * answer at all from the Preview menu at the top of the screen. So the same
 * coverage is also available as three numbers.
 *
 * The span is resolved with `idleCacheSpan` rather than by re-deriving the
 * work area here, so the readout describes EXACTLY the frames the idle pump
 * would fill — including the exclusive-end off-by-one that function exists to
 * get right. A readout that disagreed with the pump by one frame would say
 * "347 / 348" forever.
 */

import { viewportFrameCache } from '@core/rendering/frameCache';
import { activeViewportDiskCache } from '@core/rendering/frameDiskCache';
import { idleCacheSpan, type IdleCacheSpan } from '@core/rendering/idleCacheSpan';
import { getTimelineController } from '@core/timeline/TimelineController';
import { useCompositionStore } from '@stores/compositionStore';

const MB = 1024 * 1024;

export interface PreviewCacheStats {
  /** Frames of the span held in RAM right now. */
  cached: number;
  /** Frames the span has. 0 when there is nothing to cache. */
  total: number;
  /** True when the span is a work area rather than the whole composition. */
  workArea: boolean;
  /** RAM the preview cache holds — live plus parked generations. */
  ramMb: number;
  /** Disk-tier size, or null where no disk tier exists (jsdom, no IndexedDB). */
  diskMb: number | null;
}

/**
 * The span "Cache Work Area" fills: the work area when one is set, else the
 * whole composition.
 *
 * `wholeSpan: true` unconditionally — this is the explicit, user-pressed path,
 * so the `idleCacheWorkArea` preference (which only ever asked the BACKGROUND
 * pump to stay quiet) must not shrink it to a five-second look-ahead.
 */
export function previewCacheSpan(): IdleCacheSpan | null {
  const comp = useCompositionStore.getState();
  const fps = comp.fps || 0;
  const lastCompFrame = Math.max(0, Math.round((comp.durationSeconds || 0) * fps) - 1);
  return idleCacheSpan({
    playhead: 0,
    lastCompFrame,
    fps,
    workArea: getTimelineController().getWorkArea(),
    wholeSpan: true,
    aheadSeconds: 0,
  });
}

export function previewCacheStats(): PreviewCacheStats {
  const span = previewCacheSpan();
  const disk = activeViewportDiskCache();

  // A linear probe over the span. `has` and not `get`: a probe must not
  // re-order the LRU (the idle pump's comment says why — scanning a cached run
  // used to promote all of it, so eviction then dropped the frames nearest the
  // playhead) and must not fire a disk look-ahead per frame.
  let cached = 0;
  if (span) {
    for (let f = span.start; f <= span.end; f++) {
      if (viewportFrameCache.has(f)) cached += 1;
    }
  }

  return {
    cached,
    total: span ? span.length : 0,
    workArea: getTimelineController().getWorkArea() !== null,
    ramMb: viewportFrameCache.totalBytesHeld / MB,
    diskMb: disk ? disk.totalBytes / MB : null,
  };
}

/** `< 1` under a megabyte, whole megabytes above it. Shared by both readouts. */
export function formatCacheMb(mb: number): string {
  return mb < 1 ? '< 1 MB' : `${Math.round(mb)} MB`;
}

/** One line for a menu header: coverage, RAM, disk. */
export function describePreviewCache(s: PreviewCacheStats): string {
  const span = s.total > 0
    ? `${s.cached} / ${s.total} frames cached${s.workArea ? ' in work area' : ''}`
    : 'Nothing to cache';
  const disk = s.diskMb === null ? '' : ` · ${formatCacheMb(s.diskMb)} disk`;
  return `${span} · ${formatCacheMb(s.ramMb)} RAM${disk}`;
}
