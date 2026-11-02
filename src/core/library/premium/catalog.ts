/**
 * The premium library catalog — what every viewer may see about the server's
 * items (names, categories, preview media), never the items themselves.
 *
 * Read through the API cache (stale-while-revalidate, ETag), validated row by
 * row so one malformed item is skipped rather than blanking a tab, and kept in
 * localStorage so a paying user who opens the editor offline still sees the
 * shelf their downloaded items came from.
 */

import { cachedGet } from '@core/api/cache';
import { apiBaseUrl } from '@core/api/transport';
import { billingEnabled } from '@core/config/edition';
import { catalogItemProblem, type PremiumCatalogItem, type PremiumKind } from './packFormat';

export const CATALOG_PATH = '/library/catalog';
const STORAGE_KEY = 'premation.library.catalog.v1';
const TTL_MS = 5 * 60_000;

export type CatalogStatus = 'local' | 'loading' | 'ready' | 'offline' | 'error';

export interface CatalogState {
  status: CatalogStatus;
  items: PremiumCatalogItem[];
}

/** Keep the rows that pass the contract; report the rest once, quietly. */
export function sanitizeCatalog(raw: unknown): PremiumCatalogItem[] {
  const rows = (raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown }).items))
    ? (raw as { items: unknown[] }).items
    : [];
  const out: PremiumCatalogItem[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const problem = catalogItemProblem(row);
    if (problem) {
      console.warn(`[library] skipped a catalog row: ${problem}`);
      continue;
    }
    const item = { ...(row as PremiumCatalogItem) };
    // Absent media as null → absent, the shape PremiumCatalogItem promises.
    for (const k of ['poster', 'preview', 'audio'] as const) if (item[k] === null) delete item[k];
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

function readKept(): PremiumCatalogItem[] | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? sanitizeCatalog(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function keep(items: PremiumCatalogItem[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ items }));
  } catch {
    // A full or blocked storage only costs the offline shelf.
  }
}

let devUrls: string[] = [];

/**
 * Development only: packs Electron main reads from a local folder
 * (electron/ipc/libraryCache.ts `devPackDir`), their media as blob: urls —
 * how a new library item is seen in a dev build before it is uploaded. Empty
 * in a packaged app.
 */
async function devItems(): Promise<PremiumCatalogItem[]> {
  const bridge = typeof window !== 'undefined' ? window.motionEditor?.library : undefined;
  if (!bridge?.devCatalog) return [];
  let packs: Awaited<ReturnType<NonNullable<typeof bridge.devCatalog>>>;
  try {
    packs = await bridge.devCatalog();
  } catch {
    return [];
  }
  for (const u of devUrls) URL.revokeObjectURL(u);
  devUrls = [];
  const url = (bytes: Uint8Array | undefined, type: string): string | undefined => {
    if (!bytes) return undefined;
    const u = URL.createObjectURL(new Blob([bytes.slice()], { type }));
    devUrls.push(u);
    return u;
  };
  const items = sanitizeCatalog({
    items: packs.map((p) => ({
      ...(p.meta as object),
      poster: url(p.poster, 'image/webp'),
      preview: url(p.preview, 'video/mp4'),
      audio: url(p.audio, 'audio/ogg'),
    })),
  });
  return items;
}

/** Server rows first unless a dev pack of the same id overrides it. */
function merged(server: PremiumCatalogItem[], dev: PremiumCatalogItem[]): PremiumCatalogItem[] {
  const ids = new Set(dev.map((d) => d.id));
  return [...dev, ...server.filter((s) => !ids.has(s.id))];
}

/** Load the catalog. Never throws: failure is a status. */
export async function loadCatalog(opts: { force?: boolean } = {}): Promise<CatalogState> {
  const dev = await devItems();
  if (!billingEnabled()) return { status: dev.length > 0 ? 'ready' : 'local', items: dev };
  try {
    const raw = await cachedGet<unknown>(CATALOG_PATH, { tags: ['library'], ttlMs: TTL_MS, force: opts.force });
    const items = sanitizeCatalog(raw);
    keep(items);
    return { status: 'ready', items: merged(items, dev) };
  } catch (e) {
    const kept = readKept();
    // status 0 = never reached the server; anything else is the server refusing.
    const offline = (e as { status?: number }).status === 0;
    const status = dev.length > 0 ? 'ready' : offline ? 'offline' : 'error';
    return { status, items: merged(kept ?? [], dev) };
  }
}

export function itemsOfKind(items: readonly PremiumCatalogItem[], kind: PremiumKind): PremiumCatalogItem[] {
  return items.filter((i) => i.kind === kind);
}

/** An absolute URL for a catalog media path (`/library/media/<id>`); null for none. */
export function libraryMediaUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  return /^(https?|blob):/.test(path) ? path : `${apiBaseUrl()}${path}`;
}
