/**
 * The viewport frame cache, as the engine reports it (`getCacheCoverage`).
 *
 * The timeline bars and the Preview menu used to read the page preview cache.
 * The picture is the engine's, and that cache is the one playback fills, so
 * the bars follow this snapshot. A subscriber keeps a poll running; with none,
 * nothing asks.
 */

import { engine } from '@core/engine/engineInstance';
import { activeCompIdNow } from '@hooks/useMirror';
import { flicksToSeconds } from '@motion/engine-api';

export interface EngineCacheSnapshot {
  /** Comp time, seconds, end exclusive. */
  ram: Array<{ start: number; end: number }>;
  disk: Array<{ start: number; end: number }>;
  ramBytes: number;
  diskBytes: number;
}

const EMPTY: EngineCacheSnapshot = { ram: [], disk: [], ramBytes: 0, diskBytes: 0 };

let snap: EngineCacheSnapshot = EMPTY;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let inflight = false;

function sameRanges(a: EngineCacheSnapshot['ram'], b: EngineCacheSnapshot['ram']): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.start !== b[i]!.start || a[i]!.end !== b[i]!.end) return false;
  }
  return true;
}

function publish(next: EngineCacheSnapshot): void {
  if (snap.ramBytes === next.ramBytes && snap.diskBytes === next.diskBytes
    && sameRanges(snap.ram, next.ram) && sameRanges(snap.disk, next.disk)) return;
  snap = next;
  for (const listener of listeners) listener();
}

async function sample(): Promise<void> {
  if (inflight) return;
  inflight = true;
  try {
    const comp = activeCompIdNow() ?? undefined;
    const res = await engine().query({ type: 'getCacheCoverage', ...(comp ? { comp } : {}) });
    if (!res.ok) return;
    const toSec = (ranges: Array<{ start: number; end: number }>): EngineCacheSnapshot['ram'] =>
      ranges.map((range) => ({ start: flicksToSeconds(range.start), end: flicksToSeconds(range.end) }));
    publish({
      ram: toSec(res.value.ram),
      disk: toSec(res.value.disk),
      ramBytes: res.value.ramBytes,
      diskBytes: res.value.diskBytes,
    });
  } catch {
    // The engine is restarting. The last snapshot stays until the next answer.
  } finally {
    inflight = false;
  }
}

function loop(): void {
  void sample().finally(() => {
    if (listeners.size === 0) {
      timer = null;
      return;
    }
    timer = setTimeout(loop, 100);
  });
}

export function engineCacheSnapshot(): EngineCacheSnapshot {
  return snap;
}

export function subscribeEngineCache(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) loop();
  return () => {
    listeners.delete(listener);
  };
}
