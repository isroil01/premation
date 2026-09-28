/**
 * Project-thumbnail capture on the MAIN thread, at idle.
 *
 * The frame is the ENGINE's (`getThumbnail` on the active composition — the
 * renderer every export uses), asked for with `requestIdleCallback` (a timeout
 * fallback where it is missing) so it lands between interactions rather than
 * inside one. The page renderer that drew it before is gone
 * (docs/TS_ENGINE_REMOVAL.md phase 4).
 */

import { engine } from '@core/engine/engineInstance';
import { activeCompIdNow } from '@hooks/useMirror';

/** Longest edge of a project poster frame. Big enough for a retina card. */
const THUMBNAIL_MAX_EDGE = 480;

/** The active composition's first frame from the engine, as an image blob; null when there is none. */
async function engineThumbnail(): Promise<Blob | null> {
  const id = activeCompIdNow();
  if (!id) return null;
  const res = await engine().query({ type: 'getThumbnail', item: id, time: 0, maxSize: THUMBNAIL_MAX_EDGE });
  if (!res.ok || res.value.data.length === 0) return null;
  return new Blob([res.value.data as BlobPart], { type: `image/${res.value.format || 'png'}` });
}

type IdleHandle = { cancel(): void };

function whenIdle(fn: () => void, timeoutMs: number): IdleHandle {
  const g = globalThis as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (id: number) => void;
  };
  if (typeof g.requestIdleCallback === 'function') {
    const id = g.requestIdleCallback(fn, { timeout: timeoutMs });
    return { cancel: () => g.cancelIdleCallback?.(id) };
  }
  const id = setTimeout(fn, 0);
  return { cancel: () => clearTimeout(id) };
}

/**
 * Render the active composition's poster frame once the main thread is idle
 * and hand the JPEG (or null) to `onBlob`. Returns a cancel function; a
 * cancelled capture never calls `onBlob`.
 */
export function captureThumbnailWhenIdle(
  onBlob: (blob: Blob | null) => void,
  opts: { idleTimeoutMs?: number } = {},
): () => void {
  let cancelled = false;
  const handle = whenIdle(() => {
    if (cancelled) return;
    // Asked at idle time, not at schedule time: the comp may have changed.
    void engineThumbnail()
      .catch(() => null)
      .then((blob) => {
        if (!cancelled) onBlob(blob ?? null);
      });
  }, opts.idleTimeoutMs ?? 2000);
  return () => {
    cancelled = true;
    handle.cancel();
  };
}
