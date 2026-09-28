/**
 * A footage item as the page's asset RECORD, from the engine's `ItemInfo`
 * alone (B4 round 5) — what the insert / new-comp / multicam / assemble
 * builders take (they were handed the page's asset store records). The item's
 * playable media is `ItemInfo.mediaUrl`; the probed facts are restated only
 * where the probe answered (`alphaProbed` / `audioProbed`), so an unprobed
 * field stays undefined as in the record.
 *
 * Not carried (session state the page keeps per item id, never document):
 * the thumbnail object URL, the proxy (the renderer resolves it by item id), the
 * analysis proxy, import time and origin. Pure: takes the ItemInfo, touches nothing.
 */

import type { Interpretation, ItemInfo } from '@motion/engine-api';
import type { ImportedAsset } from '@stores/assetStore';
import type { FootageInterpretation } from '@core/source/sourceInfo';
import { LABEL_COLORS } from '@core/scene/labelColor';

const FLICKS_PER_SECOND = 705_600_000;

/**
 * A rational rate as the float the page stores: the NTSC form (×1000/1001)
 * rounds back to the typed three decimals (29.97, 23.976, 59.94) — the engine
 * states a stored 29.97 as 30000/1001.
 */
export function rationalFps(r: ItemInfo['frameRate']): number | undefined {
  if (!r || !(r.den > 0) || !(r.num > 0)) return undefined;
  const fps = r.num / r.den;
  return r.den === 1001 ? Math.round(fps * 1000) / 1000 : fps;
}

/** model.ts `interpretationOf`, inverted: only the fields a default leaves unset stay unset. */
export function interpretOf(i: Interpretation | undefined, prev: FootageInterpretation | undefined): FootageInterpretation | undefined {
  if (!i) return prev;
  const next: FootageInterpretation = { ...(prev ?? {}) };
  if (i.alpha === 'premultiplied' || i.alpha === 'straight') next.alpha = i.alpha;
  else delete next.alpha;
  const conform = rationalFps(i.conformFrameRate);
  if (conform) next.conformFps = conform;
  else delete next.conformFps;
  if (i.pixelAspect !== 1 && Number.isFinite(i.pixelAspect) && i.pixelAspect > 0) next.par = i.pixelAspect;
  else delete next.par;
  if (i.fieldOrder === 'upperFirst') next.fields = 'upper';
  else if (i.fieldOrder === 'lowerFirst') next.fields = 'lower';
  else delete next.fields;
  if (i.loops !== 1 && Number.isFinite(i.loops) && i.loops >= 0) next.loopCount = i.loops;
  else delete next.loopCount;
  if (typeof i.removePulldown === 'number') next.pulldownPhase = i.removePulldown;
  else delete next.pulldownPhase;
  return Object.keys(next).length > 0 ? next : undefined;
}

/** The record's media type: the probe's (`mediaType`), else guessed from the streams. */
export function itemMediaType(info: ItemInfo): ImportedAsset['type'] {
  if (info.mediaType === 'image' || info.mediaType === 'video' || info.mediaType === 'audio') return info.mediaType;
  if (!info.hasVideo) return 'audio';
  return info.duration > 0 ? 'video' : 'image';
}

/** A footage item as an asset record (null for folders, compositions and anything else). */
export function itemAsset(info: ItemInfo): ImportedAsset | null {
  if (info.kind !== 'footage') return null;
  const md: NonNullable<ImportedAsset['metadata']> = {};
  if (info.width > 0) md.width = info.width;
  if (info.height > 0) md.height = info.height;
  if (info.duration > 0) md.duration = info.duration / FLICKS_PER_SECOND;
  const fps = rationalFps(info.frameRate);
  if (fps) md.fps = fps;
  if (info.audioProbed) md.hasAudioTrack = info.hasAudio;
  if (info.alphaProbed) md.hasAlpha = info.hasAlpha;
  if (info.codec) md.codec = info.codec;
  if (info.audioChannels > 0) md.audioChannels = info.audioChannels;
  const out: ImportedAsset = {
    id: info.id,
    name: info.name,
    type: itemMediaType(info),
    src: info.mediaUrl ?? '',
    size: info.fileBytes,
    folderId: info.parent ?? null,
    metadata: md,
  };
  if (info.path) out.path = info.path;
  const label = info.label > 0 ? LABEL_COLORS[info.label - 1]?.id : undefined;
  if (label) out.label = label;
  if (info.comment) out.comment = info.comment;
  if (info.tags.length > 0) out.tags = [...info.tags];
  const interpret = interpretOf(info.interpretation, undefined);
  if (interpret) out.interpret = interpret;
  return out;
}

/** The footage records of `ids` that the mirror has, in `ids` order. */
export function itemAssetsOf(m: { item(id: string): ItemInfo | undefined }, ids: Iterable<string>): ImportedAsset[] {
  const out: ImportedAsset[] = [];
  for (const id of ids) {
    const info = m.item(id);
    const a = info ? itemAsset(info) : null;
    if (a) out.push(a);
  }
  return out;
}
