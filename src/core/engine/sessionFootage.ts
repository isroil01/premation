/**
 * Session footage the C++ engine cannot open (`blob:` and `data:`) written to
 * a cache file, then `relinkItem`.
 *
 * The page can fetch those URLs; the engine process cannot. Jobs refuse them
 * (`resolve_footage_path`). A file under `<userData>/session-footage` is a
 * path the engine already reads, and relink is one undoable entry — a later
 * job sees that path and does not relink again. `http:` stays refused: the
 * page is not a reliable copy of a remote file.
 *
 * The rewrite runs for every footage item the document
 * mirror says the engine cannot open, so a viewport frame is not waiting on
 * a job.
 */

import type { EngineClient, JobSpec } from '@motion/engine-api';
import { useAssetStore } from '@stores/assetStore';

export interface SessionFootageRecord {
  src: string;
  name: string;
  path?: string;
}

export interface SessionFootageDeps {
  lookup(itemId: string): SessionFootageRecord | null;
  cacheDir(): Promise<string | null>;
  writeBytes(filePath: string, bytes: Uint8Array): Promise<void>;
  readUrl(url: string): Promise<Uint8Array | null>;
}

/** A path the engine process can open. `motion-blob:` stays: the bundle resolver owns it. */
export function engineCanReadFootage(filePath: string): boolean {
  const p = filePath.trim();
  if (!p) return false;
  return !p.startsWith('blob:') && !p.startsWith('data:') && !p.startsWith('http:') && !p.startsWith('https:');
}

function jobItem(spec: JobSpec): { item: string | null; layer: string | null } {
  const v = spec.value as { item?: unknown; layer?: unknown };
  return {
    item: typeof v.item === 'string' && v.item ? v.item : null,
    layer: typeof v.layer === 'string' && v.layer ? v.layer : null,
  };
}

function extOf(name: string): string {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name);
  return m ? `.${m[1]!.toLowerCase()}` : '.bin';
}

function safeId(id: string): string {
  const s = id.replace(/[^a-zA-Z0-9._-]+/g, '_');
  return s || 'footage';
}

function join(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return `${dir.replace(/[\\/]+$/, '')}${sep}${name}`;
}

async function layerSource(client: EngineClient, layer: string): Promise<string | null> {
  const res = await client.query({ type: 'getLayers', layers: [layer] });
  if (!res.ok) return null;
  const source = res.value.layers[0]?.source;
  return source || null;
}

async function itemPath(client: EngineClient, item: string): Promise<string | null> {
  const res = await client.query({ type: 'getItems', items: [item] });
  if (!res.ok) return null;
  const found = res.value.items[0];
  if (!found || found.id !== item) return null;
  return found.path ?? '';
}

async function materializeItem(client: EngineClient, item: string, deps: SessionFootageDeps): Promise<void> {
  const current = await itemPath(client, item);
  if (current === null || engineCanReadFootage(current)) return;
  const page = deps.lookup(item);
  const disk = page?.path?.trim() ?? '';
  if (disk && engineCanReadFootage(disk)) {
    if (disk === current) return;
    const relinked = await client.execute({ type: 'relinkItem', item, path: disk, keepInterpretation: true });
    if (!relinked.ok) throw new Error(relinked.error.message);
    return;
  }
  const url = page?.src?.trim() || current;
  if (!url.startsWith('blob:') && !url.startsWith('data:')) return;
  const bytes = await deps.readUrl(url);
  if (!bytes || bytes.byteLength === 0) return;
  const dir = await deps.cacheDir();
  if (!dir) return;
  const file = join(dir, `${safeId(item)}${extOf(page?.name ?? '')}`);
  await deps.writeBytes(file, bytes);
  if (file === current) return;
  const relinked = await client.execute({ type: 'relinkItem', item, path: file, keepInterpretation: true });
  if (!relinked.ok) throw new Error(relinked.error.message);
}

const defaultDeps: SessionFootageDeps = {
  lookup(itemId) {
    const asset = useAssetStore.getState().assets.find((a) => a.id === itemId);
    if (!asset) return null;
    return { src: asset.src, name: asset.name, path: asset.path };
  },
  async cacheDir() {
    const dir = typeof window !== 'undefined' ? window.motionEditor?.file?.sessionFootageDir : undefined;
    if (!dir) return null;
    try {
      return (await dir()) || null;
    } catch {
      return null;
    }
  },
  async writeBytes(filePath, bytes) {
    const write = typeof window !== 'undefined' ? window.motionEditor?.file?.writeBytes : undefined;
    if (!write) throw new Error('writing session footage needs the desktop app');
    await write(filePath, bytes);
  },
  async readUrl(url) {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      return new Uint8Array(await res.arrayBuffer());
    } catch {
      return null;
    }
  },
};

/** Point each footage item at a file when the engine cannot open what it has now. */

export async function materializeUnreadableFootage(
  client: EngineClient,
  ids: readonly string[],
  deps: SessionFootageDeps = defaultDeps,
): Promise<void> {
  for (const id of ids) await materializeItem(client, id, deps);
}

/**
 * When `spec` names a footage item (or a layer whose source is one) that the
 * engine cannot open, point it at a file. No-op when the item is already a
 * file path, or when the page has no bytes for it.
 */
export async function materializeSessionFootage(
  client: EngineClient,
  spec: JobSpec,
  deps: SessionFootageDeps = defaultDeps,
): Promise<void> {
  const { item, layer } = jobItem(spec);
  if (item) {
    await materializeItem(client, item, deps);
    return;
  }
  if (!layer) return;
  const source = await layerSource(client, layer);
  if (source) await materializeItem(client, source, deps);
}
