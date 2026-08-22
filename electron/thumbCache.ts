/**
 * thumbCache — content-addressed project thumbnails in the app cache dir
 * (main process).
 *
 * Bundles deliberately exclude derived data (see bundle/types.ts), so a
 * project card's thumbnail lives in <userData>/thumbs/<hash>.png and the
 * index row carries only the hash (`thumb_hash` — a column the SQLite schema
 * has had since day one, waiting for this). Content addressing means a
 * re-render of an unchanged frame writes nothing and orphaned files are
 * harmless — they can be swept by hash-set difference whenever housekeeping
 * wants to.
 *
 * The hash is validated as hex before touching the filesystem: it arrives
 * from the renderer over IPC, and an unvalidated name would be a path — this
 * mirrors the containment check on `bundle:*`.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import type { App } from 'electron';
import { handle } from './ipcGuard';

const HASH_RE = /^[0-9a-f]{16,64}$/;

export function registerThumbIpc(app: App): void {
  const dirOf = (): string => path.join(app.getPath('userData'), 'thumbs');
  const fileOf = (hash: string): string => path.join(dirOf(), `${hash}.png`);

  handle('thumb:write', async (_e, hash: string, bytes: Uint8Array) => {
    if (typeof hash !== 'string' || !HASH_RE.test(hash)) return false;
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return false;
    await fs.mkdir(dirOf(), { recursive: true });
    const target = fileOf(hash);
    // Content-addressed: an existing file IS this content already.
    try {
      await fs.access(target);
      return true;
    } catch {
      /* not there — write it */
    }
    // Atomic-ish: temp then rename, so a crash never leaves a half thumbnail
    // that the hash claims is whole.
    const tmp = `${target}.tmp-${process.pid}`;
    await fs.writeFile(tmp, bytes);
    await fs.rename(tmp, target);
    return true;
  });

  handle('thumb:read', async (_e, hash: string) => {
    if (typeof hash !== 'string' || !HASH_RE.test(hash)) return null;
    try {
      const buf = await fs.readFile(fileOf(hash));
      return new Uint8Array(buf);
    } catch {
      return null;
    }
  });
}
