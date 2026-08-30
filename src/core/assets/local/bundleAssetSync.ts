/**
 * Making a `.motion` bundle carry its own footage — both directions.
 *
 * The bundle format has had a content-addressed asset store since local-first
 * landed: `assets/registry.json` beside `blobs/<hash>`, written by
 * `importAssetToBundle` and read by `loadAssetRegistry`. What it did not have
 * was either end of the round trip actually wired up, which left two holes with
 * the same shape — bytes that exist somewhere the project cannot reach.
 *
 * ── Collect (save) ─────────────────────────────────────────────────────
 * Footage imported BEFORE a bundle existed lives only in this session's object
 * URLs. Saving to a bundle wrote the document — which references those URLs by
 * `assetId` — and none of the bytes. The project reopened on the same machine
 * (IndexedDB still had them) and was empty everywhere else: the bundle looked
 * complete, weighed nothing, and rendered black on any other computer. This
 * copies those bytes in before the save, and repoints the document at them.
 *
 * That is After Effects' "Collect Files", except it is not a menu item you have
 * to remember: a bundle that does not carry its footage is not a bundle.
 *
 * ── Restore (open) ─────────────────────────────────────────────────────
 * Layers already survived a move, because a `motion-blob:<hash>` src resolves
 * straight out of the bundle (see `localBlobSource`). The LIBRARY did not: the
 * Assets panel came back empty, so footage that was visibly on screen could not
 * be dragged into a second layer. The registry has said what is in the bundle
 * all along and nothing read it.
 *
 * ── Ids are the link ───────────────────────────────────────────────────
 * A layer binds to a library entry by `assetId` and keeps `src` as a cache
 * (`assetRebind.ts`). So both halves preserve ids: collecting keeps the id the
 * document already uses, and restoring re-creates entries under the ids the
 * registry recorded. Get that wrong and the bytes are present, reachable, and
 * bound to nothing.
 */

import { detectBundleFs } from '@core/project/bundle/bundleFsEnv';
import { loadAssetRegistry, saveAssetRegistry } from './assetBundleIO';
import { localBlobRef, isLocalBlobRef } from '@core/rendering/localBlobSource';
import { inferAssetType } from './blobTypes';
import type { AssetRecord } from './blobTypes';
import type { EditorDocument } from '@core/api/cloudDocument';

/** The subset of an imported asset this module needs. */
export interface SyncableAsset {
  id: string;
  name: string;
  type: 'image' | 'video' | 'audio';
  src: string;
  size?: number;
  metadata?: { width?: number; height?: number; duration?: number };
}

/**
 * Read the bytes behind a session-local src.
 *
 * Injected so the sync logic can be tested without a browser: `fetch` on an
 * object URL is the real implementation and is exactly what jsdom does not have.
 */
export type ByteReader = (src: string) => Promise<Uint8Array | null>;

export const fetchBytes: ByteReader = async (src) => {
  try {
    const response = await fetch(src);
    if (!response.ok) return null;
    return new Uint8Array(await response.arrayBuffer());
  } catch {
    // A dead object URL — the session that minted it is gone. Nothing to
    // collect, and nothing anyone can do about it now.
    return null;
  }
};

/** MIME for an asset that only knows its coarse kind and a filename. */
export function mimeFor(asset: SyncableAsset): string {
  const ext = /\.([a-z0-9]+)$/i.exec(asset.name)?.[1]?.toLowerCase();
  if (ext) {
    const known: Record<string, string> = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
      webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp',
      mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4',
      mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac',
    };
    const mime = known[ext];
    if (mime) return mime;
  }
  // No extension to go on: the coarse kind still beats
  // `application/octet-stream`, which would classify the record as 'other' and
  // hide it from every media picker.
  return `${asset.type}/*`;
}

/** True for a src whose bytes live in the bundle already. */
export function isCollected(src: string): boolean {
  return isLocalBlobRef(src);
}

/**
 * True for a src worth collecting.
 *
 * Only session-local ones. An `http(s)` or `/files/` src is durable and belongs
 * to someone else's server; copying it into the bundle would silently turn a
 * reference into a copy, which is a licensing decision rather than a storage
 * one. `data:` URLs already travel inside the document.
 */
export function needsCollecting(src: string): boolean {
  const s = src.trim();
  if (s === '' || isCollected(s)) return false;
  return s.startsWith('blob:');
}

export interface CollectResult {
  /** Assets copied into the bundle by this pass. */
  collected: string[];
  /** Already content-addressed — nothing to do. */
  alreadyLocal: number;
  /** Assets whose bytes could not be read (a dead object URL). */
  unreadable: string[];
}

/** Every `src`/`assetId` pair a media component can carry. */
const SRC_PAIRS: ReadonlyArray<readonly [idKey: string, srcKey: string]> = [
  ['assetId', 'src'],
  // Audio layers keep the `__`-prefixed pair, hidden from the generic
  // inspector — the same two keys `rebindAssetSrcs` walks.
  ['__assetId', '__src'],
];

/**
 * Repoint a captured document's media srcs at the bundle.
 *
 * Operates on the DOCUMENT rather than the live scene graph, because this runs
 * inside the save: the document has already been captured, and rewriting only
 * the scene would leave the bytes collected and the file still pointing at dead
 * URLs. The live scene is repaired separately, by the caller, through the
 * normal rebind.
 */
export function rewriteDocumentSrcs(doc: EditorDocument, srcById: ReadonlyMap<string, string>): number {
  let rewritten = 0;
  for (const node of doc.scene?.nodes ?? []) {
    for (const component of node.components) {
      const props = component.props as Record<string, unknown>;
      for (const [idKey, srcKey] of SRC_PAIRS) {
        const assetId = props[idKey];
        if (typeof assetId !== 'string') continue;
        const next = srcById.get(assetId);
        if (!next || props[srcKey] === next) continue;
        props[srcKey] = next;
        rewritten += 1;
      }
    }
  }
  return rewritten;
}

/**
 * Copy every session-local asset into the bundle at `root`.
 *
 * Returns which ids were collected and their new `motion-blob:` srcs, so the
 * caller can repoint the document and the live library. Never throws for one
 * bad asset: a single unreadable object URL must not fail a save that would
 * otherwise store everything else.
 */
export async function collectAssetsIntoBundle(
  root: string,
  assets: ReadonlyArray<SyncableAsset>,
  readBytes: ByteReader = fetchBytes,
): Promise<CollectResult & { srcById: Map<string, string> }> {
  const result: CollectResult & { srcById: Map<string, string> } = {
    collected: [],
    alreadyLocal: 0,
    unreadable: [],
    srcById: new Map(),
  };

  const pending = assets.filter((a) => {
    if (isCollected(a.src)) {
      result.alreadyLocal += 1;
      return false;
    }
    return needsCollecting(a.src);
  });
  if (pending.length === 0) return result;

  const fs = detectBundleFs();
  // ONE registry for the whole pass, saved once. `importAssetToBundle` loads and
  // writes the registry per asset, so collecting forty clips would read and
  // rewrite the file forty times — and, worse, each load would discard records
  // added by an in-flight sibling.
  const registry = await loadAssetRegistry(fs, root);

  for (const asset of pending) {
    const bytes = await readBytes(asset.src);
    if (!bytes || bytes.byteLength === 0) {
      result.unreadable.push(asset.id);
      continue;
    }
    try {
      const record = await registry.importBytes(bytes, {
        // The id the document already binds to — see the header.
        id: asset.id,
        name: asset.name,
        mime: mimeFor(asset),
        type: inferAssetType(mimeFor(asset)),
        ...(asset.metadata?.width != null ? { width: asset.metadata.width } : {}),
        ...(asset.metadata?.height != null ? { height: asset.metadata.height } : {}),
        ...(asset.metadata?.duration != null ? { duration: asset.metadata.duration } : {}),
      });
      result.collected.push(asset.id);
      result.srcById.set(asset.id, localBlobRef(record.hash));
    } catch {
      result.unreadable.push(asset.id);
    }
  }

  if (result.collected.length > 0) await saveAssetRegistry(fs, root, registry);
  return result;
}

/**
 * The library entries a bundle's registry describes.
 *
 * Pure: records in, asset-shaped rows out. The store merge is the caller's, so
 * this can be tested without one.
 */
export function assetsFromRecords(records: ReadonlyArray<AssetRecord>): SyncableAsset[] {
  const out: SyncableAsset[] = [];
  for (const record of records) {
    // Only the kinds the library can show. A 'font' or 'json' record is a real
    // bundle asset but not a media library entry, and inventing a row for it
    // would put an unopenable card in the Assets panel.
    const type = record.type === 'video' ? 'video' : record.type === 'audio' ? 'audio' : record.type === 'image' ? 'image' : null;
    if (!type) continue;
    out.push({
      id: record.id,
      name: record.name,
      type,
      src: localBlobRef(record.hash),
      size: record.size,
      ...(record.width != null || record.height != null || record.duration != null
        ? {
            metadata: {
              ...(record.width != null ? { width: record.width } : {}),
              ...(record.height != null ? { height: record.height } : {}),
              ...(record.duration != null ? { duration: record.duration } : {}),
            },
          }
        : {}),
    });
  }
  return out;
}

/** Read the bundle's registry as library entries. Empty when there is none. */
export async function readBundleAssets(root: string): Promise<SyncableAsset[]> {
  const registry = await loadAssetRegistry(detectBundleFs(), root);
  return assetsFromRecords(registry.all());
}
