/**
 * The local edition's project-thumbnail capture — CloudThumbnailWorker's
 * timing policy with a DISK sink instead of an API POST.
 *
 * Same idle-scheduled main-thread render (see thumbnailCapture.ts for why it
 * is not a worker any more, despite the name), same 120s floor between
 * captures, same edit-driven dirtiness. What differs is the destination: the
 * blob is content-hashed into <userData>/thumbs (thumbCache) and the hash
 * recorded on the project's index row, which is what puts a picture on the
 * start screen's card the next time the app launches.
 *
 * The current project is resolved PER CAPTURE, not per mount: the local
 * edition mounts this once for the session, and the user opens and saves
 * different bundles under it. A capture with no current bundle path (unsaved
 * scratch, packed .motion file, browser tab) is simply skipped — those have
 * no index row for the hash to live on.
 */

import { useEffect, useRef } from 'react';
import { documentMirror } from '@stores/documentMirror';
import { getProjectManager } from '@core/services/coreServices';
import { isBundlePath } from '@core/project/bundle/bundleProjectIO';
import { storeThumb, thumbCacheAvailable } from '@core/localIndex/thumbCache';
import { recordProjectThumb } from '@core/localIndex/indexWriter';
import { captureThumbnailWhenIdle } from './thumbnailCapture';

export function LocalThumbnailWorker(): null {
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastCaptureRef = useRef(0);
  const dirtyRef = useRef(false);
  const capturingRef = useRef(false);

  useEffect(() => {
    if (!thumbCacheAvailable()) return undefined; // browser tab — no disk sink
    let cancelCapture: (() => void) | null = null;

    const capture = (): void => {
      if (!dirtyRef.current || capturingRef.current) return;
      const path = getProjectManager().getState().current?.path;
      if (!path || !isBundlePath(path)) return; // nowhere for the hash to live
      capturingRef.current = true;
      dirtyRef.current = false;
      cancelCapture = captureThumbnailWhenIdle((blob) => {
        cancelCapture = null;
        capturingRef.current = false;
        // Re-resolved: the user may have switched bundles while it rendered.
        const at = getProjectManager().getState().current?.path;
        if (!blob || !at || !isBundlePath(at)) return;
        void storeThumb(blob).then((hash) => {
          if (hash) void recordProjectThumb(at, hash);
        });
      });
    };

    const onChange = (): void => {
      dirtyRef.current = true;
      if (timerRef.current) return;
      const wait = Math.max(0, 120_000 - (Date.now() - lastCaptureRef.current));
      timerRef.current = setTimeout(() => {
        timerRef.current = undefined;
        capture();
        lastCaptureRef.current = Date.now();
      }, wait);
    };

    // Every document revision (B4: the mirror's `doc` key); a landed video
    // decode is not one.
    const unsubscribe = documentMirror().subscribe(['doc'], onChange);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      unsubscribe();
      cancelCapture?.();
    };
  }, []);

  return null;
}
