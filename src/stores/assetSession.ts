/**
 * The page's SESSION state per footage item (B4 round 5) — what this window
 * holds about an item that is not document state: its thumbnail object URL,
 * where the import came from (`source`), when it entered the library, the
 * probe's container name, and the PROXY JOBS — the viewport stand-in and the
 * analysis stand-in (generating / ready / failed, the stand-in's size, a
 * failure's reason, whether the user attached the file). A generated proxy is
 * a machine cache, not document (assetStore.ts `FootageDocRecord`: only a
 * user-attached proxy's file travels with the project, as `ItemInfo.proxyPath`
 * / `proxyEnabled`), so the proxy record lives here, fed by the proxy jobs'
 * state changes, never in the document mirror.
 *
 * Written by the items store as its records change (the one place thumbnails
 * are minted and `setProxy` — the proxy jobs' single mutation point — lands);
 * read by the Assets panel, the dashboard's cards and the Inspector's proxy
 * row, which take the item's DOCUMENT facts from the mirror (`ItemInfo`) and
 * merge these on top (`mirrorAssetRecord`; the hooks are src/hooks/useAssetRecords.ts).
 */

import { create } from 'zustand';
import type { ItemInfo } from '@motion/engine-api';
import type { ProxyRecord } from '@core/assets/proxy';
import { itemAsset } from '@core/mirror/itemAssets';
import type { AssetSource, ImportedAsset } from './assetStore';
import { documentMirror } from './documentMirror';

/** One item's session half. Absent fields: nothing known this session. */
export interface AssetSession {
  thumbSrc?: string;
  source?: AssetSource;
  importedAt?: number;
  container?: string;
  proxy?: ProxyRecord;
  analysisProxy?: ProxyRecord;
}

interface AssetSessionState {
  /** By item id. A record keeps its identity until one of its fields changes. */
  byItem: Readonly<Record<string, AssetSession>>;
}

export const useAssetSessionStore = create<AssetSessionState>(() => ({ byItem: {} }));

function sessionOf(a: ImportedAsset): AssetSession {
  const s: AssetSession = {};
  if (a.thumbSrc) s.thumbSrc = a.thumbSrc;
  if (a.source) s.source = a.source;
  if (typeof a.importedAt === 'number') s.importedAt = a.importedAt;
  if (a.metadata?.container) s.container = a.metadata.container;
  if (a.proxy) s.proxy = a.proxy;
  if (a.analysisProxy) s.analysisProxy = a.analysisProxy;
  return s;
}

function sameProxy(a: ProxyRecord | undefined, b: ProxyRecord | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.status === b.status && a.src === b.src && a.width === b.width && a.height === b.height
    && a.userSupplied === b.userSupplied && a.error === b.error;
}

/** Field for field: the items store re-clones every record on an undo (`replaceProjectItems`). */
function sameSession(a: AssetSession, b: AssetSession): boolean {
  return a.thumbSrc === b.thumbSrc && a.source === b.source && a.importedAt === b.importedAt
    && a.container === b.container && sameProxy(a.proxy, b.proxy) && sameProxy(a.analysisProxy, b.analysisProxy);
}

/**
 * Publish the session half of the items store's records (called by the items
 * store on every change of its records). Unchanged items keep their record;
 * nothing is set when nothing changed.
 */
export function publishAssetSessions(assets: readonly ImportedAsset[]): void {
  const prev = useAssetSessionStore.getState().byItem;
  const next: Record<string, AssetSession> = {};
  let changed = Object.keys(prev).length !== assets.length;
  for (const a of assets) {
    const s = sessionOf(a);
    const old = prev[a.id];
    if (old && sameSession(old, s)) next[a.id] = old;
    else {
      next[a.id] = s;
      changed = true;
    }
  }
  if (changed) useAssetSessionStore.setState({ byItem: next });
}

/** An item's session record (undefined when the page knows nothing of it). */
export function assetSessionOf(itemId: string): AssetSession | undefined {
  return useAssetSessionStore.getState().byItem[itemId];
}

/** A footage item as the page's record: the document facts (ItemInfo) with this session's half on top. */
export function mirrorAssetRecord(info: ItemInfo, session: AssetSession | undefined): ImportedAsset | null {
  const base = itemAsset(info);
  if (!base) return null;
  if (!session) return base;
  const out: ImportedAsset = { ...base };
  if (session.thumbSrc) out.thumbSrc = session.thumbSrc;
  if (session.source) out.source = session.source;
  if (session.importedAt !== undefined) out.importedAt = session.importedAt;
  if (session.container) out.metadata = { ...out.metadata, container: session.container };
  if (session.proxy) out.proxy = session.proxy;
  if (session.analysisProxy) out.analysisProxy = session.analysisProxy;
  return out;
}

const recordCache = new WeakMap<ItemInfo, { session: AssetSession | undefined; record: ImportedAsset | null }>();

/** `mirrorAssetRecord`, the same object while neither half changed (render reads, React.memo rows). */
export function cachedAssetRecord(info: ItemInfo, session: AssetSession | undefined): ImportedAsset | null {
  const hit = recordCache.get(info);
  if (hit && hit.session === session) return hit.record;
  const record = mirrorAssetRecord(info, session);
  recordCache.set(info, { session, record });
  return record;
}

/**
 * A footage item's page record NOW (a callback's read): the mirror's ItemInfo
 * with its session half merged; undefined for an unknown or non-footage item.
 */
export function assetRecordNow(itemId: string | undefined): ImportedAsset | undefined {
  if (!itemId) return undefined;
  const info = documentMirror().item(itemId);
  if (!info || info.kind !== 'footage') return undefined;
  return cachedAssetRecord(info, useAssetSessionStore.getState().byItem[itemId]) ?? undefined;
}
