/**
 * syncCurrentProject — the one call a "Sync now" action makes.
 *
 * Composes the encrypted-sync stack for the currently open local-first bundle:
 * derives the project key from the user's passphrase, runs one reconcile cycle
 * against the vault, and applies any pulled remote changes to disk.
 *
 * The passphrase never leaves the device; the KDF salt is derived deterministically
 * from the projectId so every device that knows the passphrase derives the SAME
 * key (a random per-device salt would make cross-device decryption impossible),
 * while still being unique per project. The passphrase itself is never stored —
 * the UI collects it per sync (or caches it in memory for the session).
 */

import { getProjectManager } from '@core/services/coreServices';
import { detectBundleFs } from '@core/project/bundle/bundleFsEnv';
import { isBundlePath } from '@core/project/bundle/bundleProjectIO';
import { isLocalFirst } from '@core/config/flags';
import { WebCryptoCipher } from './ProjectCipher';
import { HttpSyncTransport } from './httpSyncTransport';
import { ProjectSyncService, type SyncOutcome } from './ProjectSyncService';

/** 16-byte KDF salt, deterministic per project (same on every device). */
async function saltForProject(projectId: string): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('sync requires WebCrypto');
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(`motion-sync-salt:${projectId}`));
  return new Uint8Array(digest).slice(0, 16);
}

/** True when the current project can sync (local-first, a bundle, and open). */
export function canSyncCurrentProject(): boolean {
  if (!isLocalFirst()) return false;
  const cur = getProjectManager().getState().current;
  return !!(cur?.path && isBundlePath(cur.path));
}

/**
 * Run one sync of the current project with the given passphrase. Returns the
 * outcome (`synced` / `conflict` / `failed`); on conflict the caller should
 * snapshot a conflict-copy version and let the user choose.
 */
export async function syncCurrentProject(passphrase: string): Promise<SyncOutcome> {
  const cur = getProjectManager().getState().current;
  const root = cur?.path ?? null;
  if (!isLocalFirst() || !root || !isBundlePath(root)) return { status: 'failed' };

  const salt = await saltForProject(cur!.id);
  const cipher = await WebCryptoCipher.fromPassphrase(passphrase, salt);
  const service = new ProjectSyncService(detectBundleFs(), new HttpSyncTransport(), cipher);
  return service.sync(root, cur!.id);
}
