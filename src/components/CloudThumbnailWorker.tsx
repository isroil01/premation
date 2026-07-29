import { useEffect, useRef } from 'react';
import { api } from '@core/api/client';
import { getEventBus } from '@core/events/EventBus';
import { useCompositionStore } from '@stores/compositionStore';

/**
 * Thumbnail generation using a Web Worker to avoid blocking the main thread.
 * The worker receives the composition dimensions and returns a Blob which is
 * uploaded to the server.
 */
export function CloudThumbnailWorker({ projectId }: { projectId: string }): null {
  const workerRef = useRef<Worker | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastCaptureRef = useRef(0);
  const dirtyRef = useRef(false);
  const capturingRef = useRef(false);

  useEffect(() => {
    // Dynamically import the worker (Vite syntax)
    const worker = new Worker(new URL('../workers/thumbnailWorker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;

    const handleMessage = (e: MessageEvent) => {
      const blob: Blob | null = e.data;
      if (blob) {
        void api.setProjectThumbnail(projectId, blob);
      }
    };
    worker.addEventListener('message', handleMessage);

    const capture = () => {
      if (!dirtyRef.current || capturingRef.current) return;
      capturingRef.current = true;
      dirtyRef.current = false;
      const c = useCompositionStore.getState();
      const payload = {
        width: c.width,
        height: c.height,
        background: c.background,
        transparent: c.transparent,
      };
      worker.postMessage(payload);
      // Worker will post back the Blob
    };

    const onChange = () => {
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
    const subs = [
      bus.on('AnimationChanged', onChange),
      bus.on('SceneGraphChanged', onChange),
    ];

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      subs.forEach((s) => s.dispose());
      worker.removeEventListener('message', handleMessage);
      // Capture final thumbnail on unmount BEFORE terminating the worker —
      // otherwise the postMessage is silently dropped and the last edit never
      // gets a thumbnail. Best effort: post, then terminate after a short
      // grace so the message has time to flush.
      if (dirtyRef.current) {
        const c = useCompositionStore.getState();
        worker.postMessage({
          width: c.width,
          height: c.height,
          background: c.background,
          transparent: c.transparent,
        });
        setTimeout(() => worker.terminate(), 250);
      } else {
        worker.terminate();
      }
    };
  }, [projectId]);

  return null;
}
