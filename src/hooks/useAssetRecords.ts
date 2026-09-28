/**
 * Footage items as the page's records, from the document mirror with the
 * session half (src/stores/assetSession.ts) merged on top — the Assets panel,
 * the dashboard's cards and the Inspector's proxy row (B4 round 5).
 */

import { useMemo } from 'react';
import type { ProxyRecord } from '@core/assets/proxy';
import type { AssetFolder, ImportedAsset } from '@stores/assetStore';
import { cachedAssetRecord, useAssetSessionStore } from '@stores/assetSession';
import { useMirrorItems } from './useMirror';

/** The item's proxy JOB record (session state), re-rendering when it changes. */
export function useProxyRecord(itemId: string): ProxyRecord | undefined {
  return useAssetSessionStore((s) => s.byItem[itemId]?.proxy);
}

/**
 * Every footage item as a record, project order — the document mirror's items
 * with the session half merged. Same array until either side changes.
 */
export function useMirrorAssetRecords(): ImportedAsset[] {
  const items = useMirrorItems();
  const sessions = useAssetSessionStore((s) => s.byItem);
  return useMemo(() => {
    const out: ImportedAsset[] = [];
    for (const info of items.values()) {
      if (info.kind !== 'footage') continue;
      const r = cachedAssetRecord(info, sessions[info.id]);
      if (r) out.push(r);
    }
    return out;
  }, [items, sessions]);
}

/** The project's folders (the mirror's folder items), project order. Same array until the items change. */
export function useMirrorFolders(): AssetFolder[] {
  const items = useMirrorItems();
  return useMemo(() => {
    const out: AssetFolder[] = [];
    for (const info of items.values()) if (info.kind === 'folder') out.push({ id: info.id, name: info.name, parentId: info.parent ?? null });
    return out;
  }, [items]);
}
