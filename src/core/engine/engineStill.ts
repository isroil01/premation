/**
 * Stills from the ENGINE's renderer — the frames the viewport, the export and
 * the thumbnails draw (docs/TS_ENGINE_REMOVAL.md phase 4):
 *
 *   engineCompStill       a composition of the open document at a time
 *                         (`getThumbnail`: Save Frame As / Copy Frame, the AI's
 *                         render feedback and filmstrip, the live side of a
 *                         version compare)
 *   engineDocumentStill   a composition of ANOTHER document (`renderDocumentStill`:
 *                         a saved version, drawn without opening it)
 *
 * Both answer a PNG, the long side ≤ `maxSize` (at most 4096), or null when the
 * engine could not draw it.
 */

import { secondsToFlicks, type Thumbnail } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';
import { engineFailure } from './engineFailure';

/** The engine's largest still. */
export const ENGINE_STILL_MAX = 4096;

function toBlob(t: Thumbnail): Blob | null {
  if (t.data.length === 0) return null;
  return new Blob([t.data as BlobPart], { type: `image/${t.format || 'png'}` });
}

const clampSize = (maxSize: number): number => Math.max(1, Math.min(ENGINE_STILL_MAX, Math.round(maxSize)));

/**
 * The engine waits on its renderer for a still at most ~2 s (it must keep
 * answering the supervisor's heartbeat) and then says `busy`: a heavy still
 * is asked for again rather than lost.
 */
const STILL_ATTEMPTS = 4;

async function askUntilReady<R extends { ok: boolean; error?: { code: string } }>(ask: () => Promise<R>): Promise<R> {
  let res = await ask();
  for (let i = 1; i < STILL_ATTEMPTS && !res.ok && res.error?.code === 'busy'; i++) res = await ask();
  return res;
}

/** `compId` of the open document at composition second `seconds`. */
export async function engineCompStill(compId: string, seconds: number, maxSize: number): Promise<Blob | null> {
  const res = await askUntilReady(() =>
    engine().query({ type: 'getThumbnail', item: compId, time: secondsToFlicks(Math.max(0, seconds)), maxSize: clampSize(maxSize) }));
  return res.ok ? toBlob(res.value) : null;
}

/**
 * A footage ITEM at source second `seconds`, decoded by the engine (ProRes,
 * DNx, MXF… — whatever the page's <video> cannot play). One attempt: a viewer
 * asking for the next frame supersedes a busy one.
 */
export async function engineFootageStill(itemId: string, seconds: number, maxSize: number): Promise<Blob | null> {
  const res = await engine().query({ type: 'getThumbnail', item: itemId, time: secondsToFlicks(Math.max(0, seconds)), maxSize: clampSize(maxSize) });
  return res.ok ? toBlob(res.value) : null;
}

/**
 * One frame of a composition as a PNG at full size (up to ENGINE_STILL_MAX) —
 * Save Frame As / Copy Frame. `frame` is a composition frame index.
 */
export function engineCompFrameStill(comp: { id: string; fps: number; width: number; height: number }, frame: number): Promise<Blob | null> {
  const fps = comp.fps > 0 ? comp.fps : 30;
  return engineCompStill(comp.id, frame / fps, Math.max(comp.width, comp.height));
}

/** A composition of `document` (an EditorDocument) at `seconds`; `compId` absent = its active tab's. */
export async function engineDocumentStill(document: unknown, seconds: number, maxSize: number, compId?: string): Promise<Blob | null> {
  const res = await askUntilReady(() => engine().query({
    type: 'renderDocumentStill',
    document: JSON.stringify(document),
    ...(compId ? { comp: compId } : {}),
    time: secondsToFlicks(Math.max(0, seconds)),
    maxSize: clampSize(maxSize),
  }));
  if (!res.ok) throw engineFailure(res.error);
  return toBlob(res.value);
}
