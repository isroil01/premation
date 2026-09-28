/**
 * One overlay's share of the main viewport's overlay geometry subscription
 * (B4 round 5): its layers × kinds and the view modes whose cameras it reads,
 * requested under a per-instance owner (two mounts of the same overlay — the
 * main viewport and a 4-up pane — never withdraw each other's request) and
 * withdrawn on unmount.
 *
 * Returns a tick that changes when the subscription lands and whenever a frame's
 * geometry is pushed (the C++ engine draws the viewport): the caller re-reads
 * `overlayLayer` / `overlayView` then. While the page's renderer draws it, the
 * records are the TypeScript engine's for the painted time — the caller's own
 * time dependency re-reads them.
 */

import { useEffect, useId, useMemo, useState } from 'react';
import type { OverlayKind } from '@motion/engine-api';
import { MAIN_VIEWPORT, requestOverlayLayers, subscribeOverlayGeometry } from '@stores/overlayGeometry';

export function useOverlayRequest(
  name: string,
  layers: readonly string[],
  kinds: readonly OverlayKind[],
  views: readonly string[],
): number {
  const id = useId();
  const owner = `${name}:${id}`;
  const [tick, setTick] = useState(0);
  // Stable keys, so a caller rebuilding equal arrays per render does not re-send.
  const layersKey = layers.join('\u0001');
  const kindsKey = kinds.join(',');
  const viewsKey = views.join('\u0001');
  const req = useMemo(
    () => ({ layers: layersKey ? layersKey.split('\u0001') : [], kinds: kindsKey ? (kindsKey.split(',') as OverlayKind[]) : [], views: viewsKey ? viewsKey.split('\u0001') : [] }),
    [layersKey, kindsKey, viewsKey],
  );
  useEffect(() => {
    let live = true;
    void requestOverlayLayers(MAIN_VIEWPORT, owner, req.layers, req.kinds, req.views).then(() => {
      if (live) setTick((t) => t + 1);
    });
    return () => {
      live = false;
    };
  }, [owner, req]);
  useEffect(() => () => { void requestOverlayLayers(MAIN_VIEWPORT, owner, [], [], []); }, [owner]);
  useEffect(() => subscribeOverlayGeometry(MAIN_VIEWPORT, () => setTick((t) => t + 1)), []);
  return tick;
}
