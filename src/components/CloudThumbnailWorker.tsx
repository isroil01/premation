import { useEffect, useRef } from 'react';
import { api } from '@core/api/client';
import { documentMirror } from '@stores/documentMirror';
import { captureThumbnailWhenIdle } from './thumbnailCapture';

/**
 * Project-thumbnail capture for cloud projects: render the poster frame and
 * upload it.
 *
 * Kept its name, but it is no longer a Web Worker — the worker version never
 * produced a thumbnail (no `document`, and an empty scene graph, inside a
 * worker). The render now runs on the main thread at idle; see
 * thumbnailCapture.ts.
 */
export function CloudThumbnailWorker({ projectId }: { projectId: string }): null {
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastCaptureRef = useRef(0);
  const dirtyRef = useRef(false);
  const capturingRef = useRef(false);

  useEffect(() => {
    let cancelCapture: (() => void) | null = null;
    const upload = (blob: Blob | null): void => {
      if (blob) void api.setProjectThumbnail(projectId, blob);
    };

    const capture = (): void => {
      if (!dirtyRef.current || capturingRef.current) return;
      capturingRef.current = true;
      dirtyRef.current = false;
      cancelCapture = captureThumbnailWhenIdle((blob) => {
        cancelCapture = null;
        capturingRef.current = false;
        upload(blob);
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
      // Capture the final thumbnail on unmount so the last edit gets one. Not
      // cancelled with the rest: it is deliberately allowed to finish after
      // the component is gone (the scene is still in memory while it renders).
      const pendingCapture = cancelCapture as (() => void) | null;
      if (dirtyRef.current) {
        pendingCapture?.();
        captureThumbnailWhenIdle(upload);
      }
    };
  }, [projectId]);

  return null;
}
