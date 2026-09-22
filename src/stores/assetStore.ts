import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { shortId } from '@utils/lang';
import { api, isAuthenticated } from '@core/api/client';
import { AssetDatabase } from '@core/services/AssetDatabase';
import { isLocalFirst } from '@core/config/flags';
import { importLocalAsset } from '@core/assets/local/importLocalAsset';
import type { FootageInterpretation } from '@core/source/sourceInfo';
import { isPersistableProxy, type ProxyRecord } from '@core/assets/proxy';
import { probeMedia } from '@core/assets/mediaProbe';
import { maybeIngestForImport } from '@core/assets/ingest';
import { useUIStore } from '@stores/uiStore';
import { bumpScene, bumpSceneRevision } from '@stores/sceneStore';
import { rebindAssetSrcs } from '@core/scene/assetRebind';
import { failureReason, mediaKindOf, track as trackEvent } from '@core/analytics/productEvents';

export interface ImportedAsset {
  id: string;
  name: string;
  type: 'image' | 'video' | 'audio';
  src: string;
  size: number;
  /** Folder this asset lives in (null = library root). Organisation only. */
  folderId?: string | null;
  /**
   * How this asset came to exist. Absent means `'user'`.
   *
   * Read by the Assets panel to decide whether to SHELF it — see
   * `isLibraryAsset`. Persisted separately (see `SOURCE_KEY`), because the
   * stored asset record predates this field.
   */
  source?: AssetSource;
  /**
   * Small preview object URL for the Assets panel grid. Falls back to `src`
   * when absent (SVG, video, audio, or thumbnailing failed). Using this instead
   * of the full-res `src` is what keeps the panel fast with many images.
   */
  thumbSrc?: string;
  metadata?: {
    width?: number;
    height?: number;
    duration?: number;
    /**
     * Real source frame rate. Only the desktop ffmpeg probe can fill this in —
     * nothing in the browser reports a `<video>`'s rate — so it stays undefined
     * on web imports and every reader must handle that rather than substituting
     * the composition's rate.
     */
    fps?: number;
    /**
     * Whether the container has an audio stream. Only a real probe can answer
     * this at import; `undefined` means "nobody looked", which is a different
     * claim from `false` and the audio UI must distinguish them.
     */
    hasAudioTrack?: boolean;
    /** The file carries an alpha channel (probe: pix_fmt OR the container's
     *  alpha_mode tag). Gates the Alpha interpretation control — it is noise on
     *  the opaque footage that makes up most of a project. */
    hasAlpha?: boolean;
    audioChannels?: number;
    /** The probed stream codec (`h264`, `prores`, `aac`…) and container
     *  (`mov,mp4,m4a…`). Desktop ffprobe only; shown in the metadata drawer. */
    codec?: string;
    container?: string;
  };
  /**
   * Per-FILE reinterpretation (frame rate conform, pixel aspect, alpha, loop).
   * Lives on the asset rather than the layer so changing it updates every layer
   * using this footage at once. See `@core/source/sourceInfo`.
   */
  interpret?: FootageInterpretation;
  /**
   * Low-resolution stand-in used while EDITING only.
   *
   * Deliberately NOT reflected in `metadata`: a proxy substitutes pixels, never
   * facts. Size, duration, fps, PAR and alpha keep describing the original, so
   * `sourceOf` and every timing operation are unaffected by a proxy existing.
   * See `@core/assets/proxy`.
   */
  proxy?: ProxyRecord;
  /**
   * The ANALYSIS stand-in — 540p, short GOP, never displayed.
   *
   * A separate record rather than a variant of `proxy` because the two have
   * independent lifecycles: attaching, detaching or failing one says nothing
   * about the other, and the UI badges only the viewport one (a proxy nobody
   * can see is not a quality warning). See `@core/assets/proxy`.
   */
  analysisProxy?: ProxyRecord;
  /**
   * The user's ORGANISATION of the library — free-text tags and one colour
   * label (a `LABEL_COLORS` id). Persisted client-side like the folder map,
   * and collected into the bundle registry on save so they travel with the
   * project (`bundleAssetCollect`). Absent for most records.
   */
  tags?: string[];
  label?: string;
  /** When this asset entered the library (ms since epoch). Drives the Date
   *  column; absent for records written before it existed. */
  importedAt?: number;
  /**
   * Where the bytes came from on THIS machine, when known — the media
   * browser's import or a desktop file drop. Lets "Reveal in Explorer" open
   * the original rather than the bundle's content-addressed copy. Never
   * authoritative: the file can move or vanish, and every reader must cope.
   */
  path?: string;
}

/** Longest edge (px) of a generated panel thumbnail — comfortably sharp for the
 *  32px slot on hi-dpi displays while staying a few KB. */
const THUMB_MAX = 96;

/**
 * Decode an image file and re-encode a small thumbnail. Uses createImageBitmap
 * (off-main-thread decode) + an OffscreenCanvas when available. Returns null for
 * vector/undecodable inputs so the caller keeps the original as its own preview.
 */
async function makeImageThumb(file: File): Promise<Blob | null> {
  // SVG is vector text — tiny already, and rasterizing loses crispness.
  if (file.type === 'image/svg+xml' || /\.svg$/i.test(file.name)) return null;
  if (typeof createImageBitmap !== 'function') return null;
  let bmp: ImageBitmap | null = null;
  try {
    bmp = await createImageBitmap(file);
    const scale = Math.min(1, THUMB_MAX / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(bmp, 0, 0, w, h);
      return await canvas.convertToBlob({ type: 'image/webp', quality: 0.82 });
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0, w, h);
    return await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/webp', 0.82));
  } catch {
    return null;
  } finally {
    bmp?.close();
  }
}

/**
 * Read an SVG's intrinsic pixel size from its `width`/`height` attributes, or
 * failing that from the `viewBox` aspect. Returns null if the text can't be
 * parsed, so the caller can fall back to the <img> probe.
 */
async function readSvgIntrinsicSize(file: File): Promise<{ width: number; height: number } | null> {
  try {
    const text = await file.text();
    const svg = new DOMParser().parseFromString(text, 'image/svg+xml').querySelector('svg');
    if (!svg) return null;
    const parseLen = (v: string | null): number | null => {
      if (!v) return null;
      const n = parseFloat(v); // ignores unit suffixes (px, pt) and %
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    const w = parseLen(svg.getAttribute('width'));
    const h = parseLen(svg.getAttribute('height'));
    if (w && h) return { width: w, height: h };

    const vb = svg.getAttribute('viewBox');
    if (vb) {
      const parts = vb.split(/[\s,]+/).map(Number);
      if (parts.length === 4 && parts[2]! > 0 && parts[3]! > 0) {
        // One known dimension pins the scale; otherwise use the viewBox px size.
        if (w) return { width: w, height: (w * parts[3]!) / parts[2]! };
        if (h) return { width: (h * parts[2]!) / parts[3]!, height: h };
        return { width: parts[2]!, height: parts[3]! };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** A user-created folder for organising assets (After Effects "Project" folders). */
export interface AssetFolder {
  id: string;
  name: string;
  /** Parent folder id, or null for a top-level folder. */
  parentId: string | null;
}

interface AssetStoreState {
  assets: ImportedAsset[];
  folders: AssetFolder[];
}

/**
 * Where an asset came from. Decides where its bytes live, and whether the
 * LIBRARY lists it.
 *
 *  - `'user'` (default) — a library import (drag-drop, file picker). These can be
 *    large (multi-GB video) and are stored ON THE USER'S DISK (IndexedDB), never
 *    uploaded to Cloudinary. The tradeoff is deliberate: the library does not
 *    follow the account across devices, and we don't pay to warehouse everyone's
 *    raw footage. Server-side mp4 render is unaffected — the editor uploads
 *    rasterized frames, not source assets.
 *  - `'ai'` — a small, generated artifact (an AI image). Small enough to be worth
 *    keeping in the cloud so it persists and syncs; uploaded when signed in.
 *  - `'derived'` — produced BY the app from something already in the scene: a
 *    rasterized copy of a selection, an image a plugin generated. Stored like
 *    `'user'` (local, never uploaded) but NOT shelved by default — see below.
 *
 * ── Why `'derived'` exists ──────────────────────────────────────────────────
 *
 * Operations that duplicate or rasterize scene content were filing their output
 * as `'user'`, so the Assets panel filled up with copies the user never
 * imported, sitting alongside the footage they did. The library is meant to be
 * "the media I brought in"; a rasterized duplicate is scene content that
 * happens to need bytes behind it.
 *
 * It stays a real asset, deliberately. Layers reference it by id and it has to
 * persist and serialise like any other — "not in the library" is a statement
 * about the SHELF, not about the record. The Assets panel filters these out by
 * default and can show them on request, so nothing becomes unreachable or
 * undeletable, which is what hiding them outright would have cost.
 */
export type AssetSource = 'user' | 'ai' | 'derived';

/**
 * Sources the Assets panel shelves by default.
 *
 * Exported so the panel and the store agree by construction rather than by two
 * lists that have to be kept in step.
 */
export function isLibraryAsset(asset: { source?: AssetSource }): boolean {
  return (asset.source ?? 'user') !== 'derived';
}

interface AddAssetOptions {
  source?: AssetSource;
  /**
   * A pre-minted id. The media browser needs the id BEFORE the import
   * finishes so a drag payload can name the asset it is about to become.
   * Honoured by every storage path (the bundle registry accepts `meta.id`).
   */
  id?: string;
  /** The on-disk origin, when the caller knows it. See `ImportedAsset.path`. */
  path?: string;
}

interface AssetStoreActions {
  /** Import a file, optionally into a folder, and add it to the library. */
  addAsset: (file: File, folderId?: string | null, opts?: AddAssetOptions) => Promise<ImportedAsset>;
  /** High-performance batch import for multiple files/folders. */
  addAssetsBatch: (items: Array<{ file: File; folderId?: string | null }>) => Promise<ImportedAsset[]>;
  removeAsset: (id: string) => void;
  /**
   * Delete many assets at once.
   *
   * Not a loop over `removeAsset` at the call site: that would publish a store
   * update and rewrite the folder assignments once PER asset, so deleting a
   * fifty-file selection would re-render every subscriber fifty times and
   * persist the same list fifty times. One state write, one save.
   */
  removeAssets: (ids: readonly string[]) => void;
  /** Create a folder and return it. */
  createFolder: (name: string, parentId?: string | null) => AssetFolder;
  renameFolder: (id: string, name: string) => void;
  /** Delete a folder; its assets and subfolders move up to its parent. */
  removeFolder: (id: string) => void;
  /** Move an asset into a folder (null = root). */
  moveAssetToFolder: (assetId: string, folderId: string | null) => void;
  /**
   * Reinterpret a FILE — frame-rate conform, pixel aspect, alpha, loop count.
   * Patch-merged, and it applies to every layer using this asset at once, which
   * is the whole point: a mis-tagged import can be corrected after it has been
   * cut with. Pass a field as `undefined` to clear it back to the file's own
   * value.
   */
  setInterpretation: (assetId: string, patch: FootageInterpretation) => void;
  /** Write or clear an asset's proxy record. Pass null to detach. */
  setProxy: (assetId: string, proxy: ProxyRecord | null) => void;
  /** The analysis stand-in's record. Same contract as `setProxy`. */
  setAnalysisProxy: (assetId: string, proxy: ProxyRecord | null) => void;
  /** Replace an asset's tag list. Already-normalised (see `parseTags`). */
  setTags: (assetId: string, tags: readonly string[]) => void;
  /** Set (or with null, clear) the colour label on every id at once. */
  setLabel: (assetIds: readonly string[], label: string | null) => void;
  /** Replace the local list with the signed-in user's cloud assets. */
  loadFromCloud: () => Promise<void>;
  /**
   * Initialize local assets hydrated from IndexedDB.
   *
   * `only` narrows the hydration to those ids — what Open uses after a
   * `resetSession`, to bring back the footage the opened document references
   * without re-listing the whole device library in its Assets panel.
   */
  initialize: (opts?: { only?: ReadonlySet<string> }) => Promise<void>;
  /**
   * Empty the SESSION's asset list — New Project and Close Project.
   *
   * In memory only. The device library (IndexedDB), the cloud rows and the
   * organisation maps are untouched: crash recovery and single-file projects
   * reconnect their footage by asset id out of that library, so deleting from
   * it here would turn "start a new project" into "break the last one".
   */
  resetSession: () => void;
}

// ── Client-side organisation persistence ───────────────────────────
// Folders and asset→folder assignments are a pure organisation layer, kept in
// localStorage so they work identically for cloud and local (IndexedDB) assets
// without any backend schema change. Cloud/IndexedDB round-trips don't carry
// folderId, so we re-apply the saved assignment map after every load.
const FOLDERS_KEY = 'motion-editor.assetFolders.v1';
const ASSIGN_KEY = 'motion-editor.assetFolderAssignments.v1';
// Interpretation rides the same client-side persistence as folder assignments,
// and for the same reason: it is a statement the editor makes ABOUT a file, and
// neither the cloud schema nor the IndexedDB record carries it. Losing it on
// reload would silently un-conform footage that had already been cut with.
const INTERPRET_KEY = 'motion-editor.assetInterpretations.v1';
/**
 * Per-asset provenance, kept beside the folder map for the same reason it is:
 * it is a small fact ABOUT an asset that the asset's own stored record does
 * not carry, and it has to survive a reload or every derived copy comes back
 * looking like an import the next time the app opens.
 */
const SOURCE_KEY = 'motion-editor.assetSources.v1';
// Proxies persist alongside interpretations, for the same reason: the record is
// a statement the editor makes about a file, and neither the cloud schema nor
// the IndexedDB record carries it.
const PROXY_KEY = 'motion-editor.assetProxies.v1';
/** The analysis stand-in's records. A separate key, not a field inside the
 *  one above, so a store written by a build that predates this tier reads
 *  back unchanged instead of failing its shape check. */
const ANALYSIS_PROXY_KEY = 'motion-editor.assetAnalysisProxies.v1';
/**
 * Tags, colour label, import date and origin path — one map, because they
 * are written together (every add stamps a date; a tag edit rewrites the
 * row) and read together (`applyAssignments`). Same reasoning as the folder
 * map: facts ABOUT an asset that neither IndexedDB nor the cloud record
 * carries. The bundle registry gets tags and label too, on save, so a
 * project opened on another machine keeps its organisation.
 */
const ORGANISATION_KEY = 'motion-editor.assetOrganisation.v1';

/**
 * Assets that exist in the device library but were dropped from this session's
 * list by `resetSession`.
 *
 * Every map below is written WHOLESALE from the live asset list, so the first
 * import after a New Project would otherwise rewrite each of them without the
 * parked assets' rows — silently un-filing, un-tagging and un-conforming
 * footage the previous project still depends on. `keepParked` carries their
 * stored rows across such a write; an id leaves the set when it is hydrated
 * back (and a parked asset cannot be deleted — it is not in the list to pick).
 */
const parkedIds = new Set<string>();

/** Fold the stored rows of parked assets into a map that is about to replace them. */
function keepParked<T>(key: string, next: Record<string, T>): Record<string, T> {
  if (parkedIds.size === 0) return next;
  try {
    const raw = localStorage.getItem(key);
    const prev = raw ? (JSON.parse(raw) as Record<string, T>) : {};
    for (const id of parkedIds) if (!(id in next) && id in prev) next[id] = prev[id]!;
  } catch {
    /* unreadable store — nothing to carry */
  }
  return next;
}

/**
 * Bumped by `resetSession`. An `initialize` that started before a reset must
 * not land after it: the boot hydration is async (it reads every blob), and a
 * New Project clicked while it is in flight would otherwise be refilled with
 * the whole library a moment later.
 */
let sessionEpoch = 0;

/** Which of `ids` were parked by a reset and are therefore worth a library read. */
export function parkedAmong(ids: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const id of ids) if (parkedIds.has(id)) out.add(id);
  return out;
}

interface AssetOrganisation {
  tags?: string[];
  label?: string;
  importedAt?: number;
  path?: string;
}

function loadOrganisation(): Record<string, AssetOrganisation> {
  try {
    const raw = localStorage.getItem(ORGANISATION_KEY);
    return raw ? (JSON.parse(raw) as Record<string, AssetOrganisation>) : {};
  } catch {
    return {};
  }
}

/** Only rows with something in them are written; a bare asset is the absent case. */
function saveOrganisation(assets: ImportedAsset[]): void {
  try {
    const map: Record<string, AssetOrganisation> = {};
    for (const a of assets) {
      const row: AssetOrganisation = {};
      if (a.tags && a.tags.length > 0) row.tags = a.tags;
      if (a.label) row.label = a.label;
      if (a.importedAt) row.importedAt = a.importedAt;
      if (a.path) row.path = a.path;
      if (Object.keys(row).length > 0) map[a.id] = row;
    }
    localStorage.setItem(ORGANISATION_KEY, JSON.stringify(keepParked(ORGANISATION_KEY, map)));
  } catch {
    /* ignore */
  }
}

/** `File.path` — set by older Electron builds on dropped files; absent on the web. */
function originPathOf(file: File, explicit: string | undefined): string | undefined {
  if (explicit) return explicit;
  const p = (file as File & { path?: unknown }).path;
  return typeof p === 'string' && p.length > 0 ? p : undefined;
}

function loadFolders(): AssetFolder[] {
  try {
    const raw = localStorage.getItem(FOLDERS_KEY);
    return raw ? (JSON.parse(raw) as AssetFolder[]) : [];
  } catch {
    return [];
  }
}

function saveFolders(folders: AssetFolder[]): void {
  try {
    localStorage.setItem(FOLDERS_KEY, JSON.stringify(folders));
  } catch {
    /* quota / private mode — ignore */
  }
}

function loadAssignments(): Record<string, string> {
  try {
    const raw = localStorage.getItem(ASSIGN_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function saveAssignments(assets: ImportedAsset[]): void {
  try {
    const map: Record<string, string> = {};
    for (const a of assets) if (a.folderId) map[a.id] = a.folderId;
    localStorage.setItem(ASSIGN_KEY, JSON.stringify(keepParked(ASSIGN_KEY, map)));
  } catch {
    /* ignore */
  }
}

/**
 * Everything that has to happen when an asset stops existing, in one place.
 *
 * There are three ways to delete — one asset, a selection, or a folder and its
 * contents — and each has to revoke the same two blob URLs and issue the same
 * two deletes. Written out at each site they drift: whichever path is added
 * next copies whichever path the author happened to read, and a missed
 * `revokeObjectURL` leaks the decoded bytes for the life of the session
 * without anything visible going wrong.
 *
 * Deliberately does NOT touch store state. The caller removes the records, and
 * does it in a single write — see `removeAssets`.
 */
function releaseAsset(asset: ImportedAsset): void {
  if (asset.src.startsWith('blob:')) URL.revokeObjectURL(asset.src);
  if (asset.thumbSrc?.startsWith('blob:')) URL.revokeObjectURL(asset.thumbSrc);
  // Persistence failures must be LOUD: the row leaves the list either way, so
  // a swallowed failure here is precisely the "I deleted it and it came back
  // after reload" report — the store said gone, the disk/cloud still had it.
  void AssetDatabase.deleteAsset(asset.id).catch(() => {
    useUIStore.getState().notify({
      level: 'warning',
      message: `“${asset.name}” was removed from the project but could not be deleted from local storage — it may reappear after a reload.`,
      durationMs: 5000,
    });
  });
  if (isAuthenticated()) {
    void api.deleteAsset(asset.id).catch(() => {
      useUIStore.getState().notify({
        level: 'warning',
        message: `“${asset.name}” was removed locally but the cloud copy could not be deleted — it may reappear after a reload.`,
        durationMs: 5000,
      });
    });
  }
}

function loadSources(): Record<string, AssetSource> {
  try {
    const raw = localStorage.getItem(SOURCE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, AssetSource>) : {};
  } catch {
    return {};
  }
}

/** Only non-default sources are written — `'user'` is the absent case. */
function saveSources(assets: ImportedAsset[]): void {
  try {
    const map: Record<string, AssetSource> = {};
    for (const a of assets) if (a.source && a.source !== 'user') map[a.id] = a.source;
    localStorage.setItem(SOURCE_KEY, JSON.stringify(keepParked(SOURCE_KEY, map)));
  } catch {
    /* ignore */
  }
}

function loadInterpretations(): Record<string, FootageInterpretation> {
  try {
    const raw = localStorage.getItem(INTERPRET_KEY);
    return raw ? (JSON.parse(raw) as Record<string, FootageInterpretation>) : {};
  } catch {
    return {};
  }
}

/**
 * Restore proxy records.
 *
 * A persisted 'generating' is dropped rather than restored — see `saveProxies`.
 * It should never be written, but a record from a crashed session or a hand
 * -edited store must not resurrect a job with no child process behind it.
 */
function loadProxies(key: string = PROXY_KEY): Record<string, ProxyRecord> {
  try {
    const raw = localStorage.getItem(key);
    const map = raw ? (JSON.parse(raw) as Record<string, ProxyRecord>) : {};
    // Drop anything that cannot survive a reload — a 'generating' job with no
    // child behind it, or (the common case) a 'ready' record whose only src is
    // an ephemeral blob: URL that died with the previous session. Restoring
    // either would hand the decoder a dead url instead of falling back to full
    // resolution. Also cleans stores written by builds that persisted them.
    for (const [id, p] of Object.entries(map)) if (!isPersistableProxy(p)) delete map[id];
    return map;
  } catch {
    return {};
  }
}

/**
 * Persist proxy records.
 *
 * `generating` is deliberately NOT persisted. An ffmpeg child dies with the app,
 * so a stored 'generating' would reload as a job that will never finish and can
 * never be cancelled — the asset would sit spinning forever. On reload an
 * interrupted job is simply absent, and the asset is back to full resolution
 * with the Create Proxy action available again, which is the honest state.
 */
function saveProxies(assets: ImportedAsset[]): void {
  try {
    const map: Record<string, ProxyRecord> = {};
    // Persist only records that can be restored — never a blob-backed 'ready'
    // (dead on reload) or a 'generating' job (no child survives the app). See
    // isPersistableProxy: writing a liability is how the decoder later gets a
    // dead url instead of a clean fall back to full resolution.
    for (const a of assets) if (isPersistableProxy(a.proxy)) map[a.id] = a.proxy!;
    localStorage.setItem(PROXY_KEY, JSON.stringify(keepParked(PROXY_KEY, map)));
    const analysis: Record<string, ProxyRecord> = {};
    // Same durability rule, applied separately: the two records fail
    // independently, so one being unpersistable must not lose the other.
    for (const a of assets) if (isPersistableProxy(a.analysisProxy)) analysis[a.id] = a.analysisProxy!;
    localStorage.setItem(ANALYSIS_PROXY_KEY, JSON.stringify(keepParked(ANALYSIS_PROXY_KEY, analysis)));
  } catch {
    /* ignore */
  }
}

function saveInterpretations(assets: ImportedAsset[]): void {
  try {
    const map: Record<string, FootageInterpretation> = {};
    for (const a of assets) if (a.interpret && Object.keys(a.interpret).length > 0) map[a.id] = a.interpret;
    localStorage.setItem(INTERPRET_KEY, JSON.stringify(keepParked(INTERPRET_KEY, map)));
  } catch {
    /* ignore */
  }
}

/**
 * Fold a desktop ffprobe pass into an asset's metadata.
 *
 * Additive and best-effort by design. The media element already supplied size
 * and duration; the probe's unique contribution is the **real frame rate**,
 * the container's **pixel aspect**, and a definitive **audio stream inventory**
 * — none of which the browser can report. When no probe ran, the asset keeps
 * exactly the element-derived metadata it has always had (see `mediaProbe`'s
 * tier table), so import behaviour is unchanged rather than degraded.
 *
 * The probed rate goes to `metadata.fps` — the file's own truth. It is
 * deliberately NOT written to `interpret.conformFps`, which means "the user
 * overrode the file"; `footageSourceOf` already prefers conform over probed, so
 * writing both would make an untouched import indistinguishable from a
 * hand-conformed one and there would be nothing to reset to.
 */
async function applyProbe(file: File, asset: ImportedAsset): Promise<void> {
  if (asset.type !== 'video' && asset.type !== 'audio') return;
  const facts = await probeMedia(file);
  if (facts.tier !== 'probed') return;

  asset.metadata = {
    ...asset.metadata,
    ...(facts.width ? { width: facts.width } : {}),
    ...(facts.height ? { height: facts.height } : {}),
    // The element's duration is often rounded; the container's is exact.
    ...(facts.durationSec ? { duration: facts.durationSec } : {}),
    ...(facts.fps ? { fps: facts.fps } : {}),
    ...(facts.audio !== undefined ? { hasAudioTrack: facts.audio !== null } : {}),
    ...(facts.hasAlpha ? { hasAlpha: true } : {}),
    ...(facts.audio?.channels ? { audioChannels: facts.audio.channels } : {}),
    ...(facts.videoCodec ? { codec: facts.videoCodec } : facts.audio?.codec ? { codec: facts.audio.codec } : {}),
    ...(facts.container ? { container: facts.container } : {}),
  };
  // A non-square pixel aspect IS an interpretation — it is the container
  // telling us how it wants to be displayed, and the user can override it.
  if (facts.par) asset.interpret = { ...(asset.interpret ?? {}), par: facts.par };
}

/** Overlay the saved folder assignments and interpretations onto a freshly
 *  loaded asset list. */
function applyAssignments(assets: ImportedAsset[], folders: AssetFolder[]): ImportedAsset[] {
  const map = loadAssignments();
  const interp = loadInterpretations();
  const proxies = loadProxies();
  const analysisProxies = loadProxies(ANALYSIS_PROXY_KEY);
  const sources = loadSources();
  const organisation = loadOrganisation();
  const validFolder = new Set(folders.map((f) => f.id));
  return assets.map((a) => {
    const fid = map[a.id];
    const i = interp[a.id];
    const p = proxies[a.id];
    const ap = analysisProxies[a.id];
    const src = sources[a.id];
    const org = organisation[a.id];
    return {
      ...a,
      folderId: fid && validFolder.has(fid) ? fid : a.folderId ?? null,
      ...(i ? { interpret: i } : {}),
      ...(p ? { proxy: p } : {}),
      ...(ap ? { analysisProxy: ap } : {}),
      ...(src ? { source: src } : {}),
      // The asset's own record (a bundle restore carries tags and label)
      // wins over the local map only when the map has nothing to say.
      ...(org?.tags && org.tags.length > 0 ? { tags: org.tags } : {}),
      ...(org?.label ? { label: org.label } : {}),
      ...(org?.importedAt ? { importedAt: org.importedAt } : {}),
      ...(org?.path ? { path: org.path } : {}),
    };
  });
}

/**
 * Kick off import-time proxy generation for a freshly-added video asset.
 *
 * Fire-and-forget, and loaded via a dynamic import so the store does not couple
 * to the proxy manager at module-eval time (the manager imports this store
 * back). Non-video assets and every gating decision are handled inside
 * `maybeAutoGenerateProxy`; this only keeps the dependency edge lazy.
 */
function triggerAutoProxy(asset: ImportedAsset): void {
  if (asset.type !== 'video') return;
  void import('@core/assets/proxyManager')
    .then((m) => m.maybeAutoGenerateProxy(asset.id))
    .catch(() => {});
}

/** Extensions the drop targets admit that carry an empty or unhelpful MIME
 *  type in the browser (no ffmpeg edition, OS without a registered type).
 *  MIME wins when present; the extension is the fallback so an MXF/MTS drop
 *  is not silently filed as an IMAGE — which skipped the probe, produced an
 *  unbounded clip, and gave comp-from-footage nothing to derive from. */
const VIDEO_EXTS = /\.(mp4|m4v|mov|webm|mkv|avi|wmv|flv|mts|m2ts|mpg|mpeg|mpe|vob|ts|mxf|r3d|braw|ari|3gp|ogv)$/i;
const AUDIO_EXTS = /\.(mp3|wav|aac|m4a|ogg|oga|flac|opus|wma|aif|aiff)$/i;

function mediaTypeOf(file: File): 'image' | 'video' | 'audio' {
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  if (file.type.startsWith('image/')) return 'image';
  if (VIDEO_EXTS.test(file.name)) return 'video';
  if (AUDIO_EXTS.test(file.name)) return 'audio';
  return 'image';
}

/** A media-element metadata probe that cannot hang the import: some
 *  containers open but never fire `loadedmetadata` OR `error` (truncated
 *  MP4s, odd MKVs), and an unsettled promise here froze every
 *  `await addAsset(...)` caller — including comp-from-footage — with no
 *  error and no UI feedback. */
function probeWithTimeout(run: (done: () => void) => void, timeoutMs = 10_000): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    run(finish);
  });
}

/**
 * How deep inside an import we are. `addAsset` re-enters itself — a plugin
 * decode hands back a PNG, a PSD becomes one asset per layer — and only the
 * OUTERMOST call is something the user did.
 */
let importDepth = 0;

/**
 * Report an import the user made: one `media_imported` per kind with a count,
 * or an `import_failed` with a reason code. Assets the app makes for itself
 * (`derived`, `ai`) are not imports and are not reported.
 */
async function trackedImport<T>(files: File[], source: AssetSource, run: () => Promise<T>): Promise<T> {
  const outer = importDepth === 0 && source === 'user';
  importDepth++;
  try {
    const result = await run();
    if (outer && files.length > 0) {
      const byKind = new Map<string, number>();
      for (const f of files) {
        const kind = mediaKindOf(f);
        byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
      }
      for (const [kind, count] of byKind) trackEvent('media_imported', { kind, count });
    }
    return result;
  } catch (err) {
    if (outer) {
      trackEvent('import_failed', {
        kind: files[0] ? mediaKindOf(files[0]) : 'other',
        reason: failureReason(err),
      });
    }
    throw err;
  } finally {
    importDepth--;
  }
}

export const useAssetStore = create<AssetStoreState & AssetStoreActions>()(
  immer((set, get) => ({
    assets: [],
    folders: loadFolders(),

    addAsset: (file: File, folderId: string | null = null, opts: AddAssetOptions = {}) =>
      trackedImport([file], opts.source ?? 'user', async () => {
      const source: AssetSource = opts.source ?? 'user';

      /*
        A format only a PLUGIN can read.

        Checked FIRST, and deliberately: every branch below assumes the browser
        or ffmpeg can make sense of the bytes, and a `.tga` reaching them is an
        asset that imports as a broken image rather than as an error. Decoding
        here turns it into a PNG `File` and re-enters — the same move the PSD
        branch makes — so the bundle, the thumbnail and the asset record never
        learn a plugin was involved.

        Reserved extensions cannot be claimed (see `importerSchema.ts`), so this
        can never shadow the PSD branch or any built-in format.
      */
      {
        const { decodeWithPlugin } = await import('@core/assets/decodeWithPlugin');
        let decoded: File | null = null;
        try {
          decoded = await decodeWithPlugin(file);
        } catch (e) {
          // Named, and rethrown: a plugin that failed to decode the file the
          // user just dropped is the plugin's problem to surface, not a silent
          // fall-through to "unsupported file" that sends them looking at
          // their own file instead.
          useUIStore.getState().notify({
            level: 'error',
            message: `Import failed: ${e instanceof Error ? e.message : String(e)}`,
            durationMs: 6000,
          });
          throw e;
        }
        if (decoded) return get().addAsset(decoded, folderId, opts);
      }

      // Layered PSD → one PNG asset per layer (AE "Import as Composition" lite).
      if (/\.psd$/i.test(file.name)) {
        try {
          const { decodePsd, psdLayerToPngFile } = await import('@core/media/psd');
          const doc = decodePsd(await file.arrayBuffer());
          let first: ImportedAsset | null = null;
          for (const layer of doc.layers) {
            const png = await psdLayerToPngFile(layer, file.name);
            const a = await get().addAsset(png, folderId, opts);
            if (a && !first) first = a;
          }
          if (first) return first;
          throw new Error('PSD had no raster layers');
        } catch (e) {
          useUIStore.getState().notify({
            level: 'error',
            message: `PSD import failed: ${e instanceof Error ? e.message : String(e)}`,
            durationMs: 6000,
          });
          throw e;
        }
      }

      // Ingest: footage the browser cannot decode (ProRes/DNxHD .mov, MXF,
      // AVI…) is transcoded to a playable file BEFORE any branch below, so the
      // bundle, IndexedDB and the object URL all store something every decode
      // path can actually read. No-op off the desktop. See assets/ingest.ts.
      const originalExr = /\.exr$/i.test(file.name) ? file : null;
      file = (await maybeIngestForImport(file, (msg) =>
        useUIStore.getState().notify({ level: 'info', message: msg, durationMs: 4000 }))) ?? file;
      // Local-first: content-address the bytes into the open
      // project bundle and render from disk — never upload. Falls through to the
      // in-memory object-URL path (still upload-free) if no bundle is open.
      const originPath = originPathOf(file, opts.path);
      if (isLocalFirst()) {
        const imported = await importLocalAsset(file, opts.id ? { id: opts.id } : undefined);
        if (imported) {
          const type: 'image' | 'video' | 'audio' =
            imported.record.type === 'video' ? 'video' : imported.record.type === 'audio' ? 'audio' : 'image';
          const asset: ImportedAsset = {
            id: imported.record.id,
            name: file.name,
            type,
            src: imported.src,
            size: file.size,
            folderId,
            source,
            importedAt: Date.now(),
            ...(originPath ? { path: originPath } : {}),
            ...(imported.metadata ? { metadata: imported.metadata } : {}),
          };
          await applyProbe(file, asset);
          set((s) => {
            s.assets.push(asset);
          });
          saveAssignments(get().assets);
          saveSources(get().assets);
          saveOrganisation(get().assets);
          triggerAutoProxy(asset);
          if (originalExr) {
            try {
              const { importExrWithFloat } = await import('@core/media/floatExr');
              await importExrWithFloat(originalExr, asset.id);
            } catch { /* preview already imported */ }
          }
          return asset;
        }
      }

      // Cloud upload is now reserved for AI-generated artifacts: they are small
      // and worth persisting/syncing server-side. USER library imports never take
      // this branch — they can be gigabytes of raw footage, so they are stored on
      // the user's own disk (the IndexedDB path below) instead of our Cloudinary.
      // Skipped entirely under local-first, which never auto-uploads.
      if (source === 'ai' && isAuthenticated() && !isLocalFirst()) {
        try {
          const uploaded = await api.uploadAsset(file);
          const withFolder = { ...uploaded, folderId, source, importedAt: Date.now() };
          set((s) => {
            s.assets.push(withFolder);
          });
          saveAssignments(get().assets);
          saveSources(get().assets);
          saveOrganisation(get().assets);
          triggerAutoProxy(withFolder);
          return withFolder;
        } catch {
          // fall through to local blob on failure
        }
      }

      const id = opts.id ?? `asset_${shortId()}`;
      const src = URL.createObjectURL(file);
      const type = mediaTypeOf(file);

      const asset: ImportedAsset = {
        id,
        name: file.name,
        type,
        src,
        size: file.size,
        folderId,
        source,
        importedAt: Date.now(),
        ...(originPath ? { path: originPath } : {}),
      };

      // Read dimensions or duration if possible
      if (type === 'image') {
        // SVG: derive intrinsic size from width/height or viewBox. An <img>
        // reports a bogus 300×150 default for viewBox-only SVGs, which would
        // give the inserted layer the wrong aspect ratio.
        const svgSize = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name)
          ? await readSvgIntrinsicSize(file)
          : null;
        if (svgSize) {
          asset.metadata = svgSize;
        } else {
          await probeWithTimeout((done) => {
            const img = new Image();
            img.onload = () => {
              asset.metadata = { width: img.width, height: img.height };
              done();
            };
            img.onerror = () => done();
            img.src = src;
          });
        }
      } else if (type === 'audio') {
        await probeWithTimeout((done) => {
          const audio = new Audio();
          audio.onloadedmetadata = () => {
            asset.metadata = { duration: audio.duration };
            done();
          };
          audio.onerror = () => done();
          audio.src = src;
        });
      } else if (type === 'video') {
        await probeWithTimeout((done) => {
          const video = document.createElement('video');
          video.onloadedmetadata = () => {
            asset.metadata = {
              width: video.videoWidth,
              height: video.videoHeight,
              duration: video.duration,
            };
            done();
          };
          video.onerror = () => done();
          video.src = src;
        });
      }

      // Real stream facts, where a demuxer is available (desktop + ffprobe).
      // After the element pass so it can correct duration and add what the
      // element cannot know; before the IndexedDB write so it persists.
      await applyProbe(file, asset);

      // Downscaled panel preview (images only) — keeps the grid fast.
      const thumb = type === 'image' ? await makeImageThumb(file) : null;
      if (thumb) asset.thumbSrc = URL.createObjectURL(thumb);

      // Save to IndexedDB for local persistence
      await AssetDatabase.saveAsset({
        id,
        name: file.name,
        type,
        size: file.size,
        metadata: asset.metadata,
        data: file,
        thumb: thumb ?? undefined,
      }).catch((err) => console.error('[AssetStore] failed to save to IndexedDB:', err));

      set((s) => {
        s.assets.push(asset);
      });
      saveAssignments(get().assets);
      saveSources(get().assets);
      saveOrganisation(get().assets);
      triggerAutoProxy(asset);

      // Keep linear float planes for EXR (preview PNG is in `src`).
      // Await so the first paint can sample float textures, not only the 8-bit preview.
      if (originalExr) {
        try {
          const { importExrWithFloat } = await import('@core/media/floatExr');
          await importExrWithFloat(originalExr, id);
        } catch { /* preview already imported */ }
      }

      return asset;
    }),

    addAssetsBatch: (items: Array<{ file: File; folderId?: string | null }>): Promise<ImportedAsset[]> =>
      trackedImport(items.map((i) => i.file), 'user', async () => {
      if (items.length === 0) return [];
      const createdAssets: ImportedAsset[] = [];
      // Thumbnail blobs, index-aligned with createdAssets (null = keep original).
      const thumbs: Array<Blob | null> = [];
      // The files actually imported, index-aligned with createdAssets. NOT the
      // caller's `items` files: ingest may have TRANSCODED (ProRes→mp4 etc.),
      // and persisting the original bytes meant the asset rendered fine all
      // session and went black after every reload — the re-minted blob URL
      // pointed at bytes the browser cannot decode.
      const files: File[] = [];

      // Process metadata + thumbnails in parallel chunks of 10 for max speed
      const CHUNK = 10;
      for (let i = 0; i < items.length; i += CHUNK) {
        const chunk = items.slice(i, i + CHUNK);
        const chunkResults = await Promise.all(
          chunk.map(async ({ file, folderId }) => {
            // Same ingest gate as addAsset — this path historically skipped
            // shared steps (see the element-pass note below) and paid for it.
            file = (await maybeIngestForImport(file, (msg) =>
              useUIStore.getState().notify({ level: 'info', message: msg, durationMs: 4000 }))) ?? file;
            const id = `asset_${shortId()}`;
            const src = URL.createObjectURL(file);
            const type = mediaTypeOf(file);

            const batchPath = originPathOf(file, undefined);
            const asset: ImportedAsset = {
              id,
              name: file.name,
              type,
              src,
              size: file.size,
              folderId: folderId ?? null,
              importedAt: Date.now(),
              ...(batchPath ? { path: batchPath } : {}),
            };

            let thumb: Blob | null = null;
            if (type === 'image') {
              const svgSize = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name)
                ? await readSvgIntrinsicSize(file)
                : null;
              if (svgSize) {
                asset.metadata = svgSize;
              } else {
                await probeWithTimeout((done) => {
                  const img = new Image();
                  img.onload = () => {
                    asset.metadata = {
                      width: img.naturalWidth || img.width,
                      height: img.naturalHeight || img.height,
                    };
                    done();
                  };
                  img.onerror = () => done();
                  img.src = src;
                });
              }
              // Downscaled preview so the panel doesn't decode full-res originals.
              thumb = await makeImageThumb(file);
              if (thumb) asset.thumbSrc = URL.createObjectURL(thumb);
            } else if (type === 'video') {
              // Same element pass as addAsset. This path skipped it for years,
              // so every PANEL-imported video (vs drag-to-canvas) had no
              // width/height/duration — footageSourceOf reported 0×0, insert
              // sizing fell back, and everything downstream that asks "how big
              // is this source" quietly degraded. Parallel within the chunk,
              // so the batch stays fast.
              await probeWithTimeout((done) => {
                const video = document.createElement('video');
                video.onloadedmetadata = () => {
                  asset.metadata = {
                    width: video.videoWidth,
                    height: video.videoHeight,
                    duration: video.duration,
                  };
                  done();
                };
                video.onerror = () => done();
                video.src = src;
              });
            } else if (type === 'audio') {
              await probeWithTimeout((done) => {
                const audio = new Audio();
                audio.onloadedmetadata = () => {
                  asset.metadata = { duration: audio.duration };
                  done();
                };
                audio.onerror = () => done();
                audio.src = src;
              });
            }
            // Real stream facts where a demuxer exists (desktop + ffprobe) —
            // corrects duration, adds fps/PAR/audio facts. No-op on web.
            await applyProbe(file, asset);
            return { asset, thumb, file };
          })
        );
        for (const r of chunkResults) {
          createdAssets.push(r.asset);
          thumbs.push(r.thumb);
          files.push(r.file);
        }
      }

      // Save to IndexedDB in parallel
      await Promise.all(
        createdAssets.map((asset, index) => {
          const file = files[index];
          if (!file) return Promise.resolve();
          return AssetDatabase.saveAsset({
            id: asset.id,
            name: asset.name,
            type: asset.type,
            size: asset.size,
            metadata: asset.metadata,
            data: file,
            thumb: thumbs[index] ?? undefined,
          }).catch((err) => console.error('[AssetStore] failed to save to IndexedDB:', err));
        })
      );

      // Single Zustand state update + single localStorage assignment save
      set((s) => {
        s.assets.push(...createdAssets);
      });
      saveAssignments(get().assets);
      saveSources(get().assets);
      saveOrganisation(get().assets);
      // Same import-time proxy kick the single-file path does — batch-imported
      // video (the panel picker and OS drops) never got one.
      for (const asset of createdAssets) triggerAutoProxy(asset);

      return createdAssets;
    }),

    removeAsset: (id) => {
      const asset = get().assets.find((a) => a.id === id);
      if (asset) releaseAsset(asset);
      set((s) => {
        s.assets = s.assets.filter((a) => a.id !== id);
      });
      saveAssignments(get().assets);
      saveSources(get().assets);
      saveOrganisation(get().assets);
    },

    removeAssets: (ids) => {
      const doomed = new Set(ids);
      if (doomed.size === 0) return;
      for (const a of get().assets) if (doomed.has(a.id)) releaseAsset(a);
      set((s) => {
        s.assets = s.assets.filter((a) => !doomed.has(a.id));
      });
      saveAssignments(get().assets);
      saveSources(get().assets);
      saveOrganisation(get().assets);
    },

    setTags: (assetId, tags) => {
      set((s) => {
        const a = s.assets.find((x) => x.id === assetId);
        if (!a) return;
        if (tags.length > 0) a.tags = [...tags];
        else delete a.tags;
      });
      saveOrganisation(get().assets);
    },

    setLabel: (assetIds, label) => {
      const targets = new Set(assetIds);
      if (targets.size === 0) return;
      set((s) => {
        for (const a of s.assets) {
          if (!targets.has(a.id)) continue;
          if (label) a.label = label;
          else delete a.label;
        }
      });
      saveOrganisation(get().assets);
    },

    createFolder: (name, parentId = null) => {
      const folder: AssetFolder = { id: `folder_${shortId()}`, name: name.trim() || 'Untitled Folder', parentId };
      set((s) => {
        s.folders.push(folder);
      });
      saveFolders(get().folders);
      return folder;
    },

    renameFolder: (id, name) => {
      set((s) => {
        const f = s.folders.find((x) => x.id === id);
        if (f) f.name = name.trim() || f.name;
      });
      saveFolders(get().folders);
    },

    removeFolder: (id) => {
      const state = get();
      // Collect the folder and ALL nested descendant folders.
      const doomedFolders = new Set<string>([id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const f of state.folders) {
          if (f.parentId && doomedFolders.has(f.parentId) && !doomedFolders.has(f.id)) {
            doomedFolders.add(f.id);
            grew = true;
          }
        }
      }
      // Delete every asset inside any doomed folder (with the same cleanup as
      // removeAsset — revoke blob URLs and delete from the backend/local DB).
      const doomedAssets = state.assets.filter((a) => a.folderId != null && doomedFolders.has(a.folderId));
      for (const a of doomedAssets) releaseAsset(a);
      set((s) => {
        s.folders = s.folders.filter((f) => !doomedFolders.has(f.id));
        s.assets = s.assets.filter((a) => !(a.folderId != null && doomedFolders.has(a.folderId)));
      });
      saveFolders(get().folders);
      saveAssignments(get().assets);
    },

    moveAssetToFolder: (assetId, folderId) => {
      set((s) => {
        const a = s.assets.find((x) => x.id === assetId);
        if (a) a.folderId = folderId;
      });
      saveAssignments(get().assets);
    },

    setInterpretation: (assetId, patch) => {
      set((s) => {
        const a = s.assets.find((x) => x.id === assetId);
        if (!a) return;
        const next: FootageInterpretation = { ...(a.interpret ?? {}) };
        for (const [k, v] of Object.entries(patch)) {
          if (v === undefined) delete (next as Record<string, unknown>)[k];
          else (next as Record<string, unknown>)[k] = v;
        }
        a.interpret = next;
      });
      saveInterpretations(get().assets);
      // Every layer using this file just changed size/rate/alpha, so the
      // renderer's per-frame caches and the timeline's duration bounds are both
      // stale. Bumping the scene is what makes the change visible everywhere at
      // once rather than on the next unrelated edit.
      bumpScene();
    },

    /**
     * Write a proxy record. The ONE mutation point for `asset.proxy`, so a
     * generation job, a user attach and a failure all land the same way.
     *
     * `bumpScene` is what makes the change visible: `resolveRigImageSrc` reads
     * the store per snapshot, so without a bump the viewport would keep
     * decoding the previous source until some unrelated edit forced a rebuild.
     */
    setProxy: (assetId, proxy) => {
      set((s) => {
        const a = s.assets.find((x) => x.id === assetId);
        if (!a) return;
        if (proxy) a.proxy = proxy;
        else delete a.proxy;
      });
      saveProxies(get().assets);
      // Revision only — NOT `bumpScene()`. A proxy finishing (or starting: it
      // is automatic for restored footage) is device-local state, not an edit.
      // The structural event is wired to "unsaved change", so an untouched
      // project read "Unsaved changes" three seconds after it opened and asked
      // to discard work nobody had done; it also cost a full timeline
      // reconcile and a stray undo step. The renderer only needs the re-read.
      bumpSceneRevision();
    },

    /**
     * The analysis record. Deliberately does NOT `bumpScene`: nothing on screen
     * decodes this tier, so announcing it as a scene change would invalidate
     * every cached frame in the comp for a file the renderer will never open.
     */
    setAnalysisProxy: (assetId, proxy) => {
      set((s) => {
        const a = s.assets.find((x) => x.id === assetId);
        if (!a) return;
        if (proxy) a.analysisProxy = proxy;
        else delete a.analysisProxy;
      });
      saveProxies(get().assets);
    },

    /**
     * The whole cloud library, one page at a time.
     *
     * This asked for `{limit: 100}` once and treated the answer as everything,
     * so account number 101 onwards simply did not exist in the editor — no
     * error, no truncation notice, just missing footage in the Assets panel.
     * The store is the editor's asset index (documents reference assets by id),
     * so it does need all of them; what it must not do is pretend one page is
     * all of them.
     */
    loadFromCloud: async () => {
      if (!isAuthenticated()) return;
      const PAGE = 100;
      /** Backstop against a runaway loop, not a real ceiling on a library. */
      const MAX_PAGES = 50;
      try {
        const all: ImportedAsset[] = [];
        let offset = 0;
        let total = 0;
        for (let i = 0; i < MAX_PAGES; i++) {
          const page = await api.listAssets(undefined, { limit: PAGE, offset });
          all.push(...page.items);
          total = page.total;
          offset += page.items.length;
          if (page.items.length === 0 || all.length >= total) break;
        }
        if (all.length < total) {
          console.warn(
            `[assets] loaded ${all.length} of ${total} cloud assets (page cap reached)`,
          );
        }
        // MERGE, don't replace. The cloud list now only holds AI-generated
        // artifacts and legacy uploads — user library imports live on this
        // device's disk (IndexedDB) and are absent from it. A full replace would
        // wipe those local assets whenever this ran after IndexedDB hydration.
        set((s) => {
          const present = new Set(s.assets.map((a) => a.id));
          const incoming = applyAssignments(
            all.filter((a) => !present.has(a.id)),
            s.folders,
          );
          for (const a of incoming) s.assets.push(a);
        });
      } catch {
        /* offline — keep local list */
      }
    },

    initialize: async (opts = {}) => {
      const epoch = sessionEpoch;
      try {
        const all = await AssetDatabase.getAllAssets();
        // A reset landed while the library was being read — this hydration
        // belongs to the session that was just thrown away. Nothing has been
        // minted yet, so there is nothing to release. The rows are PARKED
        // rather than forgotten, so a later Open can still ask for the ones
        // its document references.
        if (epoch !== sessionEpoch) {
          for (const a of all) parkedIds.add(a.id);
          return;
        }
        const only = opts.only;
        const dbAssets = only ? all.filter((a) => only.has(a.id)) : all;
        // Filter FIRST, mint object URLs second.
        //
        // This used to createObjectURL for every asset in IndexedDB and only then
        // drop the ones already loaded — but a discarded URL stays registered and
        // pins its entire Blob (the whole video/PSD/image) in renderer memory
        // until the page reloads. `initialize` runs on every boot, twice under
        // StrictMode, and again on each editor re-entry, so a project with 2 GB of
        // footage leaked roughly that much every time.
        const existingIds = new Set(get().assets.map((a) => a.id));
        const hydratedAssets: ImportedAsset[] = dbAssets
          .filter((dbAsset) => !existingIds.has(dbAsset.id))
          .map((dbAsset) => ({
            id: dbAsset.id,
            name: dbAsset.name,
            type: dbAsset.type,
            src: URL.createObjectURL(dbAsset.data),
            size: dbAsset.size,
            metadata: dbAsset.metadata,
            // Reuse the persisted thumbnail so reload stays as fast as import.
            thumbSrc: dbAsset.thumb ? URL.createObjectURL(dbAsset.thumb) : undefined,
          }));
        set((s) => {
          // Re-check inside the transaction: a concurrent import may have landed
          // between the read above and this commit.
          const present = new Set(s.assets.map((a) => a.id));
          const fresh = applyAssignments(
            hydratedAssets.filter((ha) => !present.has(ha.id)),
            s.folders,
          );
          for (const ha of fresh) {
            s.assets.push(ha);
            parkedIds.delete(ha.id);
          }
        });
        // The urls minted above are NEW — any already-restored document still
        // points its layers at the dead ones it was saved with. Reconnect by
        // assetId (see assetRebind.ts); restoreDocument runs the same call for
        // the opposite arrival order.
        rebindAssetSrcs(get().assets);
      } catch (err) {
        console.error('[AssetStore] failed to initialize from IndexedDB:', err);
      }
    },

    resetSession: () => {
      sessionEpoch += 1;
      const dropped = get().assets;
      if (dropped.length === 0) return;
      // Revoke, but do NOT `releaseAsset`: that also deletes the IndexedDB and
      // cloud rows, which is what "the user deleted this footage" means. The
      // outgoing document has already been unloaded, so no layer is left
      // decoding from these urls.
      for (const a of dropped) {
        if (a.src.startsWith('blob:')) URL.revokeObjectURL(a.src);
        if (a.thumbSrc?.startsWith('blob:')) URL.revokeObjectURL(a.thumbSrc);
        parkedIds.add(a.id);
      }
      set((s) => {
        s.assets = [];
      });
      // No save* calls: the maps on disk are still right for the parked
      // assets, and writing them from an empty list is exactly the loss
      // `keepParked` exists to prevent.
    },
  })),
);
