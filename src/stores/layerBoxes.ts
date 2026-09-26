/**
 * Layers' DRAWN boxes as the engine measures them (`getLayerBounds` in layer
 * space, ENGINE_API.md §15.12) — `readGeometry`'s box: a shape's size, a text
 * layer's measured extent, a group's union.
 *
 * Two ways in:
 *   • `layerBoxAt(layer, time)` — a synchronous read for render code: the
 *     answer for this mirror revision, else the last known box while a batched
 *     query (one per time, every layer asked in the same tick) is in flight.
 *     `useLayerBoxes()` re-renders a component when answers land.
 *   • `fetchLayerBox(layer, time)` — a callback's exact answer.
 *
 * Never per played frame: the cache is keyed by (layer, time) and cleared with
 * the document revision; per-frame geometry is the overlay push's.
 */

import type { LayerBounds } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';
import { documentMirror } from './documentMirror';

export interface LayerBox {
  /** Base (unscaled) size, px. */
  width: number;
  height: number;
  /** Where the box centre sits relative to the layer origin, local px (a group's union, text's font box). */
  offsetX: number;
  offsetY: number;
}

interface Entry {
  rev: number;
  box: LayerBox | null;
}

const MAX_ENTRIES = 2000;
const entries = new Map<string, Entry>();
const pending = new Map<number, Set<string>>();
const inFlight = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
let flushScheduled = false;

const keyOf = (layer: string, time: number): string => `${layer}\u0000${time}`;

function boxOf(b: LayerBounds): LayerBox {
  return { width: b.bounds.width, height: b.bounds.height, offsetX: b.bounds.x + b.bounds.width / 2, offsetY: b.bounds.y + b.bounds.height / 2 };
}

function notify(): void {
  version += 1;
  for (const l of listeners) l();
}

function flush(): void {
  flushScheduled = false;
  const batches = [...pending];
  pending.clear();
  for (const [time, layerSet] of batches) {
    const layers = [...layerSet];
    const rev = documentMirror().revision;
    void engine().query({ type: 'getLayerBounds', layers, time, space: 'layer', includeEffects: false }).then((res) => {
      if (entries.size > MAX_ENTRIES) entries.clear();
      const got = new Map((res.ok ? res.value.bounds : []).map((b) => [b.layer, boxOf(b)]));
      for (const layer of layers) {
        const key = keyOf(layer, time);
        inFlight.delete(key);
        // A failed batch (a text layer the engine cannot measure, a removed layer) leaves no box.
        entries.set(key, { rev, box: got.get(layer) ?? null });
      }
      notify();
    });
  }
}

/**
 * The layer's drawn box at `time` (comp-time flicks): this revision's answer,
 * else the last known one (undefined before the first) while it is fetched.
 * Null when the engine has no box for it (audio, a text style it cannot measure).
 */
export function layerBoxAt(layer: string, time: number): LayerBox | null | undefined {
  const key = keyOf(layer, time);
  const e = entries.get(key);
  const rev = documentMirror().revision;
  if (e && e.rev === rev) return e.box;
  if (!inFlight.has(key)) {
    inFlight.add(key);
    let set = pending.get(time);
    if (!set) pending.set(time, (set = new Set()));
    set.add(layer);
    if (!flushScheduled) {
      flushScheduled = true;
      queueMicrotask(flush);
    }
  }
  return e?.box ?? undefined;
}

/** The layer's drawn box at `time`, asked of the engine now (callbacks). Null when it has none. */
export async function fetchLayerBox(layer: string, time: number): Promise<LayerBox | null> {
  const res = await engine().query({ type: 'getLayerBounds', layers: [layer], time, space: 'layer', includeEffects: false });
  const b = res.ok ? res.value.bounds.find((x) => x.layer === layer) : undefined;
  return b ? boxOf(b) : null;
}

/** Subscribe to answers landing (useLayerBoxes). */
export function subscribeLayerBoxes(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Bumps when any answer lands (useSyncExternalStore snapshot). */
export function layerBoxesVersion(): number {
  return version;
}
