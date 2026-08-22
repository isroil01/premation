/**
 * The local edition's project-thumbnail capture — CloudThumbnailWorker's
 * timing policy with a DISK sink instead of an API POST.
 *
 * Same worker, same 120s floor between captures, same edit-driven dirtiness,
 * same final capture on unmount. What differs is the destination: the blob is
 * content-hashed into <userData>/thumbs (thumbCache) and the hash recorded on
 * the project's index row, which is what puts a picture on the start screen's
 * card the next time the app launches.
 *
 * The current project is resolved PER CAPTURE, not per mount: the local
 * edition mounts this once for the session, and the user opens and saves
 * different bundles under it. A capture with no current bundle path (unsaved
 * scratch, packed .motion file, browser tab) is simply skipped — those have
 * no index row for the hash to live on.
 */

import { useEffect, useRef } from 'react';
import { getEventBus } from '@core/events/EventBus';
import { useCompositionStore } from '@stores/compositionStore';
import { getProjectManager } from '@core/services/coreServices';
import { isBundlePath } from '@core/project/bundle/bundleProjectIO';
import { storeThumb, thumbCacheAvailable } from '@core/localIndex/thumbCache';
import { recordProjectThumb } from '@core/localIndex/indexWriter';

export function LocalThumbnailWorker(): null {
  const workerRef = useRef<Worker | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastCaptureRef = useRef(0);
  const dirtyRef = useRef(false);
  const capturingRef = useRef(false);

  useEffect(() => {
    if (!thumbCacheAvailable()) return undefined; // browser tab — no disk sink
    const worker = new Worker(new URL('../workers/thumbnailWorker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;

    const handleMessage = (e: MessageEvent): void => {
      const blob: Blob | null = e.data;
      const path = getProjectManager().getState().current?.path;
      if (!blob || !path || !isBundlePath(path)) return;
      void storeThumb(blob).then((hash) => {
        if (hash) void recordProjectThumb(path, hash);
      });
    };
    worker.addEventListener('message', handleMessage);

    const capture = (): void => {
      if (!dirtyRef.current || capturingRef.current) return;
      const path = getProjectManager().getState().current?.path;
      if (!path || !isBundlePath(path)) return; // nowhere for the hash to live
      capturingRef.current = true;
      dirtyRef.current = false;
      const c = useCompositionStore.getState();
      worker.postMessage({
        width: c.width,
        height: c.height,
        background: c.background,
        transparent: c.transparent,
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
        capturingRef.current = false;
      }, wait);
    };

    const bus = getEventBus();
    const subs = [bus.on('AnimationChanged', onChange), bus.on('SceneGraphChanged', onChange)];

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      subs.forEach((s) => s.dispose());
      worker.removeEventListener('message', handleMessage);
      worker.terminate();
    };
  }, []);

  return null;
}
