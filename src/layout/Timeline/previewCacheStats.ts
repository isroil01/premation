/**
 * What the preview cache holds, phrased as the question people actually ask:
 * "is my work area ready to play?"
 *
 * The cache bars answer that geometrically — a green strip under the ruler —
 * which is the right answer while you are looking at the timeline and no
 * answer at all from the Preview menu at the top of the screen. So the same
 * coverage is also available as three numbers.
 *
 * The numbers are the ENGINE's (`getCacheCoverage`, through
 * `engineCacheCoverage`): the frames its video-memory frame cache holds and the
 * bytes they take. It has no disk tier, so `diskMb` is null until it reports one.
 *
 * The span is resolved with `idleCacheSpan` rather than by re-deriving the
 * work area here — it gets the exclusive-end off-by-one right, and a readout
 * that was one frame out would say "347 / 348" forever.
 */

import { idleCacheSpan, type IdleCacheSpan } from '@core/timeline/idleCacheSpan';
import { engineCacheSnapshot } from './engineCacheCoverage';
import { settingsDurationSeconds, settingsFps, settingsHasWorkArea, settingsWorkArea } from '@core/mirror/compFacts';
import { documentMirror } from '@stores/documentMirror';
import { activeCompIdNow } from '@hooks/useMirror';

const MB = 1024 * 1024;

export interface PreviewCacheStats {
  /** Frames of the span the engine's frame cache holds right now. */
  cached: number;
  /** Frames the span has. 0 when there is nothing to cache. */
  total: number;
  /** True when the span is a work area rather than the whole composition. */
  workArea: boolean;
  /** Memory the engine's frame cache holds (video memory). */
  ramMb: number;
  /** Disk-tier size, or null while the engine reports none (it has no disk tier). */
  diskMb: number | null;
}

/**
 * The span the readout counts: the work area when one is set, else the whole
 * composition (`wholeSpan: true` — never a look-ahead window).
 */
export function previewCacheSpan(): IdleCacheSpan | null {
  // The active composition's settings from the document mirror (B4). Its work
  // area is the whole composition when none is set, which spans the same frames.
  const settings = documentMirror().comp(activeCompIdNow() ?? '')?.settings;
  if (!settings) return null;
  const fps = settingsFps(settings, 0);
  const lastCompFrame = Math.max(0, Math.round(settingsDurationSeconds(settings, 0) * fps) - 1);
  return idleCacheSpan({
    playhead: 0,
    lastCompFrame,
    fps,
    workArea: settingsWorkArea(settings),
    wholeSpan: true,
    aheadSeconds: 0,
  });
}

function frameInRanges(frame: number, fps: number, ranges: ReadonlyArray<{ start: number; end: number }>): boolean {
  const t = frame / fps;
  return ranges.some((range) => t >= range.start - 1e-6 && t < range.end - 1e-6);
}

export function previewCacheStats(): PreviewCacheStats {
  const span = previewCacheSpan();
  const coverage = engineCacheSnapshot();

  let cached = 0;
  if (span) {
    const settings = documentMirror().comp(activeCompIdNow() ?? '')?.settings;
    const fps = settingsFps(settings, 30);
    for (let f = span.start; f <= span.end; f++) {
      if (frameInRanges(f, fps, coverage.ram)) cached += 1;
    }
  }

  return {
    cached,
    total: span ? span.length : 0,
    // Whether a work area is SET: the API states "none" as the whole composition (settingsHasWorkArea).
    workArea: settingsHasWorkArea(documentMirror().comp(activeCompIdNow() ?? '')?.settings),
    ramMb: coverage.ramBytes / MB,
    diskMb: coverage.diskBytes > 0 ? coverage.diskBytes / MB : null,
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
