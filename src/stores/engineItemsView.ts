/**
 * F2 — the assets store's ITEMS half, and the project store's COMPOSITIONS, as
 * views of the engine's document when
 * the engine owns it (docs/NATIVE_CORE_PLAN.md §5 Phase F2, inventory row
 * "useAssetStore + documentItems").
 *
 * The engine's items (`ItemInfo`, the mirror's `items`) are the truth for what
 * the project document says about its footage: which items exist, their
 * names, folders, labels, comments, tags, interpretation, the attached proxy
 * and the probed facts. Whenever they change (an item command, undo, redo,
 * open, another window) the store's records are patched from them.
 *
 * What stays the page's: the SESSION half of each record — its object URL
 * (`src`), thumbnail, the analysis proxy, import time, source — keyed by the
 * item id, as the plan says ("object URLs, thumbnails and decode caches stay
 * UI session state keyed by item id until E1 moves decode"). A footage item
 * the page has no record for (imported by another window, a script, or opened
 * from a project) gets one whose `src` is the file the engine names; the
 * media layer resolves it like any other path.
 *
 * Only engine → store: every UI write to items already is an engine command
 * (B3, `lint:engine-writes`), so there is nothing to send back. A replica
 * restore (`isRestoringDocument()`) that lands while this is bound is
 * overwritten by the next mirror change, and the mirror's value is applied at
 * bind time.
 */

import type { CompSettings, Interpretation, ItemInfo } from '@motion/engine-api';
import { useAssetStore, replaceProjectItems, type AssetFolder, type ImportedAsset } from './assetStore';
import { useProjectStore, type CompositionSettings } from './projectStore';
import type { MirrorComp } from './documentMirror';
import { channelsToHex } from '@core/mirror/paintFields';
import { LABEL_COLORS } from '@core/scene/labelColor';
import type { FootageInterpretation } from '@core/source/sourceInfo';

/** What the binders read from the document mirror (DocumentMirror satisfies it). */
export interface ItemsMirrorView {
  readonly items: ReadonlyMap<string, ItemInfo>;
  readonly comps: ReadonlyMap<string, MirrorComp>;
  subscribe(keys: readonly string[], listener: () => void): () => void;
}

const FLICKS_PER_SECOND = 705_600_000;

function rationalFps(r: ItemInfo['frameRate']): number | undefined {
  return r && r.den > 0 && r.num > 0 ? r.num / r.den : undefined;
}

/** `setItemLabel` stores footage labels by palette id (model.ts `labelIdOf`). */
function labelIdOf(index: number): string | undefined {
  return index > 0 ? LABEL_COLORS[index - 1]?.id : undefined;
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

function typeOf(info: ItemInfo): ImportedAsset['type'] {
  if (!info.hasVideo) return 'audio';
  return info.duration > 0 ? 'video' : 'image';
}

/** A file path as the media layer reads it (desktop: the path itself; `file://` URLs pass through). */
function srcForPath(path: string): string {
  return path;
}

/** One footage record: the engine's document fields over the page's session fields. */
export function assetFromItem(info: ItemInfo, prev: ImportedAsset | undefined): ImportedAsset {
  const md = { ...(prev?.metadata ?? {}) };
  if (info.width > 0) md.width = info.width;
  if (info.height > 0) md.height = info.height;
  if (info.duration > 0) md.duration = info.duration / FLICKS_PER_SECOND;
  const fps = rationalFps(info.frameRate);
  if (fps) md.fps = fps;
  if (info.hasVideo && info.hasAudio) md.hasAudioTrack = true;
  if (info.hasAlpha) md.hasAlpha = true;
  if (info.codec) md.codec = info.codec;
  if (info.audioChannels > 0) md.audioChannels = info.audioChannels;
  const next: ImportedAsset = {
    ...(prev ?? { id: info.id, type: typeOf(info), src: srcForPath(info.path), size: 0 }),
    id: info.id,
    name: info.name,
    folderId: info.parent ?? null,
    size: info.fileBytes > 0 ? info.fileBytes : prev?.size ?? 0,
    metadata: md,
  };
  const label = labelIdOf(info.label);
  if (label) next.label = label;
  else delete next.label;
  if (info.comment) next.comment = info.comment;
  else delete next.comment;
  if (info.tags.length > 0) next.tags = [...info.tags];
  else delete next.tags;
  if (info.path) next.path = info.path;
  const interpret = interpretOf(info.interpretation, prev?.interpret);
  if (interpret) next.interpret = interpret;
  else delete next.interpret;
  // The attached proxy is document state (ItemInfo reports a READY proxy's
  // file); one the page is still generating or that failed stays the page's.
  if (info.proxyPath && info.proxyEnabled) {
    next.proxy = { ...(prev?.proxy ?? {}), status: 'ready', src: info.proxyPath };
  } else if (prev?.proxy?.status === 'ready') {
    delete next.proxy;
  }
  return next;
}

/**
 * The store's items as the engine's document has them, in the engine's order.
 * Session fields of records the engine still lists are kept.
 */
export function itemsFromMirror(
  items: ReadonlyMap<string, ItemInfo>,
  current: { assets: readonly ImportedAsset[]; folders: readonly AssetFolder[] },
): { assets: ImportedAsset[]; folders: AssetFolder[] } {
  const prevById = new Map(current.assets.map((a) => [a.id, a]));
  const assets: ImportedAsset[] = [];
  const folders: AssetFolder[] = [];
  for (const info of items.values()) {
    if (info.kind === 'folder') folders.push({ id: info.id, name: info.name, parentId: info.parent ?? null });
    else if (info.kind === 'footage') assets.push(assetFromItem(info, prevById.get(info.id)));
  }
  return { assets, folders };
}

/**
 * Install the binding (the engine-owned session does, and disposes it with the
 * session). Applies the mirror's items at once.
 */
export function bindEngineItems(mirror: ItemsMirrorView): () => void {
  let last = '';
  const apply = (): void => {
    const s = useAssetStore.getState();
    const next = itemsFromMirror(mirror.items, s);
    const key = JSON.stringify(next);
    // Unchanged (an event for a composition item, a comp-only batch): no store write, no bus traffic.
    if (key === last && key === JSON.stringify({ assets: s.assets, folders: s.folders })) return;
    last = key;
    replaceProjectItems(next);
  };
  const dispose = mirror.subscribe(['items'], apply);
  apply();
  return dispose;
}

// ── Compositions ─────────────────────────────────────────────────────────

type StoredComp = CompositionSettings & {
  folderId?: string;
  comment?: string;
  label?: number;
  renderer3d?: CompSettings['renderer3d'];
  dropFrame?: boolean;
  preserveFrameRate?: boolean;
  preserveResolution?: boolean;
};

function parseJson(text: string | undefined): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * One composition's stored settings from the engine's CompSettings (model.ts
 * `compSettings`, inverted) over what the page had — fields CompSettings does
 * not carry are kept. The work area and the root JSON fields live in the
 * timeline / scene graph, not this record.
 */
export function compFromInfo(id: string, s: CompSettings, item: ItemInfo | undefined, prev: CompositionSettings | undefined): CompositionSettings {
  const fps = s.frameRate.den > 0 && s.frameRate.num > 0 ? s.frameRate.num / s.frameRate.den : prev?.fps ?? 30;
  const next: StoredComp = {
    ...((prev ?? {}) as StoredComp),
    id,
    name: s.name,
    width: s.width,
    height: s.height,
    fps,
    durationSeconds: s.duration / FLICKS_PER_SECOND,
    background: channelsToHex(s.background),
    transparent: s.transparent,
    startFrame: Math.round((s.startTimecode / FLICKS_PER_SECOND) * fps),
    renderer3d: s.renderer3d,
    globalLightAngle: s.globalLightAngle,
    globalLightAltitude: s.globalLightAltitude,
    dropFrame: s.dropFrame,
    preserveFrameRate: s.preserveFrameRate,
    preserveResolution: s.preserveResolution,
  };
  if (s.pixelAspect !== 1) next.pixelAspect = s.pixelAspect;
  else delete next.pixelAspect;
  const paint = parseJson(s.backgroundPaint);
  if (paint && typeof paint === 'object') next.backgroundPaint = paint as CompositionSettings['backgroundPaint'];
  else delete next.backgroundPaint;
  if (s.pristine === true) next.pristine = true;
  else delete next.pristine;
  const world = parseJson(s.world);
  for (const k of ['defaultEnvPreset', 'groundLevel', 'showSkyBackdrop', 'ssao'] as const) delete next[k];
  if (world && typeof world === 'object') Object.assign(next, world);
  if (item) {
    if (item.parent) next.folderId = item.parent;
    else delete next.folderId;
    if (item.comment) next.comment = item.comment;
    else delete next.comment;
    if (item.label > 0) next.label = item.label;
    else delete next.label;
  }
  return next;
}

/** The project store's compositions as the engine's document has them. */
export function compsFromMirror(
  comps: ReadonlyMap<string, MirrorComp>,
  items: ReadonlyMap<string, ItemInfo>,
  current: Readonly<Record<string, CompositionSettings>>,
): Record<string, CompositionSettings> {
  const out: Record<string, CompositionSettings> = {};
  for (const [id, c] of comps) out[id] = compFromInfo(id, c.settings, items.get(id), current[id]);
  return out;
}

/**
 * Install the compositions binding: the project store's `comps` follow the
 * mirror (tabs, breadcrumbs and the playhead copy stay the page's editor state).
 */
export function bindEngineComps(mirror: ItemsMirrorView): () => void {
  let last = '';
  const apply = (): void => {
    const current = useProjectStore.getState().comps;
    const next = compsFromMirror(mirror.comps, mirror.items, current);
    const key = JSON.stringify(next);
    if (key === last && key === JSON.stringify(current)) return;
    last = key;
    useProjectStore.getState().actions.replaceComps(next);
  };
  const dispose = mirror.subscribe(['comps', 'items'], apply);
  apply();
  return dispose;
}
