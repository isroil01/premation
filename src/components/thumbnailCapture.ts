/**
 * Project-thumbnail capture on the MAIN thread, at idle.
 *
 * This used to run in a Web Worker (`src/workers/thumbnailWorker.ts`) and never
 * produced a thumbnail. `renderThumbnailBlob` creates its canvas with
 * `document.createElement`, a worker has no `document`, so every capture threw
 * before rendering and the worker posted `null` — which both callers read as
 * "nothing to upload" and dropped without a word.
 *
 * Moving the draw to an OffscreenCanvas inside the worker would not have
 * rescued it. A worker imports its OWN copies of the scene-graph and animation
 * singletons, and those are empty there — the project lives on the main thread
 * — so the best a worker could ever render is a blank comp of the right size.
 *
 * So the render runs where the scene is: one small frame through the same GPU
 * path export uses, scheduled with `requestIdleCallback` (a timeout fallback
 * where it is missing) so it lands between interactions rather than inside one.
 */

import { DEFAULT_COMPOSITION } from '@stores/compositionStore';
import { documentMirror } from '@stores/documentMirror';
import { activeCompIdNow } from '@hooks/useMirror';
import { compRecordFromSettings } from '@core/mirror/compFacts';

/** The active composition's size and background, from the document mirror (B4); the default comp when there is none. */
function activeCompFrame(): { width: number; height: number; background: string; transparent: boolean } {
  const id = activeCompIdNow();
  const comp = id ? documentMirror().comp(id) : undefined;
  const c = comp ? compRecordFromSettings(comp.id, comp.settings) : DEFAULT_COMPOSITION;
  return { width: c.width, height: c.height, background: c.background, transparent: c.transparent };
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
    // Read at render time, not at schedule time: an idle callback can land
    // seconds later, after a comp-size edit.
    const c = activeCompFrame();
    // Lazy: the export stack is only needed once a capture actually runs.
    void import('@core/export/exportManager')
      .then(({ renderThumbnailBlob }) =>
        renderThumbnailBlob({ width: c.width, height: c.height, background: c.background, transparent: c.transparent }),
      )
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
