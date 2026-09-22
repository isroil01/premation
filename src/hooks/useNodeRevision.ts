/**
 * React subscriptions to the per-node revision counter.
 *
 * The counter itself — and the event-bus wiring that feeds it — lives in
 * `@core/inspector/nodeRevision`; this file is only the `useState`/`useEffect`
 * glue, kept out of `src/core` so the engine never imports React
 * (docs/NATIVE_CORE_PLAN.md §4 T0). See the core module for why the revision
 * is per node and why it is not coalesced to a frame.
 */

import { useEffect, useState } from 'react';
import { subscribeNodeRevision } from '@core/inspector/nodeRevision';

/**
 * Re-render when THIS node changes — and only then. A null id subscribes to
 * nothing.
 */
export function useNodeRevision(nodeId: string | null | undefined): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!nodeId) return undefined;
    return subscribeNodeRevision(nodeId, () => setTick((t) => t + 1));
  }, [nodeId]);
  return tick;
}

/** The same, for a whole selection: any of these nodes changing re-renders. */
export function useNodesRevision(nodeIds: ReadonlyArray<string>): number {
  const [tick, setTick] = useState(0);
  const key = nodeIds.join(' ');
  useEffect(() => {
    const ids = key ? key.split(' ') : [];
    if (ids.length === 0) return undefined;
    const bump = (): void => setTick((t) => t + 1);
    const unsubs = ids.map((id) => subscribeNodeRevision(id, bump));
    return () => {
      for (const u of unsubs) u();
    };
  }, [key]);
  return tick;
}
