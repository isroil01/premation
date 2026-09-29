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

/** The engine's largest still. */
export const ENGINE_STILL_MAX = 4096;

function toBlob(t: Thumbnail): Blob | null {
  if (t.data.length === 0) return null;
  return new Blob([t.data as BlobPart], { type: `image/${t.format || 'png'}` });
}

const clampSize = (maxSize: number): number => Math.max(1, Math.min(ENGINE_STILL_MAX, Math.round(maxSize)));

/** `compId` of the open document at composition second `seconds`. */
export async function engineCompStill(compId: string, seconds: number, maxSize: number): Promise<Blob | null> {
  const res = await engine().query({ type: 'getThumbnail', item: compId, time: secondsToFlicks(Math.max(0, seconds)), maxSize: clampSize(maxSize) });
  return res.ok ? toBlob(res.value) : null;
}

/** A composition of `document` (an EditorDocument) at `seconds`; `compId` absent = its active tab's. */
export async function engineDocumentStill(document: unknown, seconds: number, maxSize: number, compId?: string): Promise<Blob | null> {
  const res = await engine().query({
    type: 'renderDocumentStill',
    document: JSON.stringify(document),
    ...(compId ? { comp: compId } : {}),
    time: secondsToFlicks(Math.max(0, seconds)),
    maxSize: clampSize(maxSize),
  });
  if (!res.ok) throw new Error(res.error.message);
  return toBlob(res.value);
}
