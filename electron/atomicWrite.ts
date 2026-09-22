/**
 * Atomic file replacement for everything the editor persists.
 *
 * `writeFile(target)` truncates the target first and then streams the new
 * bytes in. A crash, a full disk or a killed process between those two steps
 * leaves the user's project as an empty or half-written file — and the
 * `file:write` / `file:writeBytes` IPC channels, which `localProjectIO` and
 * `FileManager` use for the project itself, did exactly that. Only the bundle
 * and blob channels had the temp-then-rename shape.
 *
 * The contract (NATIVE_CORE_PLAN §4 T1, CLAUDE.md "Reliability"): the bytes go
 * to a sibling temp file, are flushed to the device, and are renamed over the
 * target. The rename is the only step that touches the target, and on every
 * platform we ship it either fully succeeds or leaves the old file untouched.
 *
 * Windows detail: `rename` replaces an existing file (MoveFileEx +
 * REPLACE_EXISTING), but an antivirus or indexer holding the target open for a
 * few milliseconds makes it fail with EPERM/EBUSY. Those are retried briefly;
 * anything else propagates, and the temp file is removed on any failure so a
 * failed save never litters the project folder.
 */

import { mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RETRIES = 5;
const RETRY_DELAY_MS = 40;

export interface AtomicWriteOptions {
  /** Create missing parent directories (the bundle/blob channels want this). */
  mkdirp?: boolean;
  /** Test hook: sleep between rename retries. */
  sleep?: (ms: number) => Promise<void>;
  /** Test hook: the rename to use (defaults to fs.rename). */
  rename?: typeof rename;
}

/** The sibling temp path a write goes to; exported so tests can assert cleanup. */
export function tempPathFor(target: string): string {
  return `${target}.tmp-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Write `data` to `target` so that the target is either its old content or
 * the complete new content — never anything in between.
 */
export async function writeFileAtomic(
  target: string,
  data: string | Uint8Array,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  if (opts.mkdirp) await mkdir(path.dirname(target), { recursive: true });
  const tmp = tempPathFor(target);
  const doRename = opts.rename ?? rename;
  const sleep = opts.sleep ?? defaultSleep;
  try {
    const fh = await open(tmp, 'w');
    try {
      if (typeof data === 'string') await fh.writeFile(data, 'utf8');
      else await fh.writeFile(data);
      // Flush to the device: a rename of an unflushed file can survive a
      // process crash but not a power cut, and the point of this helper is
      // that the file on disk is always one complete version.
      await fh.sync();
    } finally {
      await fh.close();
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await doRename(tmp, target);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (attempt < RETRIES && code && RETRYABLE.has(code)) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        throw err;
      }
    }
  } catch (err) {
    try { await unlink(tmp); } catch { /* never created, or already renamed */ }
    throw err;
  }
}
