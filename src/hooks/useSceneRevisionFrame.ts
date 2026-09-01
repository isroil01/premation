/**
 * Scene-revision subscription, coalesced to ONE re-render per animation frame.
 *
 * `useSceneRevision((s) => s.rev)` re-renders its component synchronously on
 * every revision bump — and a viewport drag bumps once per POINTER EVENT
 * (120-240/s on a modern mouse), several times faster than anything is
 * painted. Components that only need to track the scene visually (the
 * viewport shell, SVG gizmo overlays) subscribe through this instead: they
 * still see every change, at most one reconciliation per painted frame.
 *
 * Not for logic that must observe every individual revision synchronously —
 * that is what the raw store subscription is for.
 */

import { useEffect, useState } from 'react';
import { useSceneRevision } from '@stores/sceneStore';

export function useSceneRevisionFrame(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let raf: number | null = null;
    const unsub = useSceneRevision.subscribe(() => {
      if (raf !== null) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        setTick((t) => t + 1);
      });
    });
    return () => {
      unsub();
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, []);
  return tick;
}

export default useSceneRevisionFrame;
