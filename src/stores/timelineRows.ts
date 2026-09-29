/**
 * The timeline's After Effects ROW projection of each layer, as the engine
 * answers it (`getTimelineRows`, B4 round 8): the rows in AE's twirl order with
 * the legacy track names behind them (both engines' static property tree).
 *
 *   • `timelineRowsNow(layer)` — render code: this mirror revision's answer,
 *     else the last known one while a fetch is in flight (undefined before the
 *     first). `subscribeTimelineRows` hears answers landing.
 *   • `fetchTimelineRows(layers)` — a callback's exact answer.
 */

import type { TimelineRow } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';
import { documentMirror } from './documentMirror';

interface Entry {
  rev: number;
  rows: readonly TimelineRow[];
}

const MAX_LAYERS = 512;
const entries = new Map<string, Entry>();
const inFlight = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function land(layer: string, rev: number, rows: readonly TimelineRow[]): void {
  if (entries.size > MAX_LAYERS) entries.clear();
  const prev = entries.get(layer);
  // Keep the old array when nothing changed, so row identity holds across revisions.
  const same = prev && JSON.stringify(prev.rows) === JSON.stringify(rows);
  entries.set(layer, { rev, rows: same ? prev.rows : rows });
  if (!same) {
    version += 1;
    for (const l of listeners) l();
  }
}

/** Each layer's rows asked of the engine now (callbacks); a layer the engine does not know is left out. */
export async function fetchTimelineRows(layers: ReadonlyArray<string>): Promise<Map<string, readonly TimelineRow[]>> {
  const out = new Map<string, readonly TimelineRow[]>();
  if (layers.length === 0) return out;
  const rev = documentMirror().revision;
  const res = await engine().query({ type: 'getTimelineRows', layers: [...layers] });
  if (!res.ok) return out;
  for (const s of res.value.sets) {
    land(s.layer, rev, s.rows);
    out.set(s.layer, entries.get(s.layer)!.rows);
  }
  return out;
}

/** The layer's rows: this revision's answer, else the last known one (undefined before the first) while it is fetched. */
export function timelineRowsNow(layer: string): readonly TimelineRow[] | undefined {
  const e = entries.get(layer);
  const rev = documentMirror().revision;
  if (e && e.rev === rev) return e.rows;
  if (!inFlight.has(layer)) {
    inFlight.add(layer);
    void engine().query({ type: 'getTimelineRows', layers: [layer] }).then((res) => {
      inFlight.delete(layer);
      const set = res.ok ? res.value.sets.find((s) => s.layer === layer) : undefined;
      land(layer, rev, set?.rows ?? []);
    }, () => {
      inFlight.delete(layer);
    });
  }
  return e?.rows;
}

/** Subscribe to answers that change a layer's rows. */
export function subscribeTimelineRows(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Bumps when an answer changes some layer's rows. */
export function timelineRowsVersion(): number {
  return version;
}

/** Tests. */
export function resetTimelineRows(): void {
  entries.clear();
  inFlight.clear();
  version += 1;
}
