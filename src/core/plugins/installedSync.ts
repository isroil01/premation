/**
 * Reconciling the local installed set against the account's.
 *
 * ── The problem this closes ─────────────────────────────────────────────────
 *
 * Installs lived only in this machine's IndexedDB, which made the local copy
 * the ONLY copy. A cleared origin, a new machine, or one failed write and the
 * user's plugins were gone with no record anywhere that they had ever had
 * them — the reported symptom being "I reinstall everything after restarting
 * the app". The server now holds the durable list; local stays the fast path.
 *
 * ── The rule that matters ───────────────────────────────────────────────────
 *
 * **This never deletes a local plugin.** Not once, not for any server
 * response. A sync that can delete is a sync that deletes everything the first
 * time it misreads an empty or partial response, and the cost is asymmetric to
 * the point of being silly: the worst case of keeping something is a stale row
 * the user can remove in one click, and the worst case of removing something
 * is a wiped library with no undo. So the reconcile is strictly additive in
 * both directions — anything the server has that we lack is reported as
 * RESTORABLE, and anything we have that the server lacks is pushed up.
 *
 * `pluginRegistryEnabled()` being false and "the request failed" therefore do
 * not need to be told apart with any subtlety: neither can destroy anything.
 *
 * ── Why the payload is not synced ───────────────────────────────────────────
 *
 * A restorable plugin is a NAME and a version, not bytes. Restoring re-fetches
 * from the registry and verifies the publisher signature on this machine, the
 * same as a first install. Shipping packages through this path would make the
 * account a second, unverified distribution channel — see `registry.ts`, where
 * running that check locally is the point of the whole module.
 */

import { fetchInstalledSet, forgetInstalled, recordInstalled, type ServerInstall } from './registry';
import { setInstalledSyncSink } from './installedSyncSink';
import type { InstalledPlugin } from '@stores/pluginStore';

/**
 * Point the plugin store's change announcements at the account.
 *
 * Called once at boot. Until it is — and in tests, and in the local edition —
 * the store's sink is a no-op, so nothing about local installs depends on
 * there being a registry at all.
 */
export function installInstalledSyncSink(): void {
  setInstalledSyncSink({
    record: (pluginId, body) => {
      void recordInstalled(pluginId, body).catch(() => undefined);
    },
    forget: (pluginId) => {
      void forgetInstalled(pluginId).catch(() => undefined);
    },
  });
}

/** What a reconcile found, for a UI that wants to explain itself. */
export interface SyncReport {
  /** On the account, absent here. Offer these; do not auto-install them. */
  restorable: ServerInstall[];
  /** Here, absent from the account. Pushed up. */
  pushed: string[];
  /** Push failures, by plugin id. The local copy is untouched. */
  failed: string[];
  /** True when the account could not be read at all — nothing was inferred. */
  offline: boolean;
}

const EMPTY: SyncReport = { restorable: [], pushed: [], failed: [], offline: false };

/**
 * Bring the account and this machine into agreement, additively.
 *
 * Returns what it found rather than acting on `restorable` itself. Installing
 * software is a thing a user says yes to: silently pulling packages onto a
 * machine because an account elsewhere had them is the behaviour that makes
 * people distrust sync, and it would run the consent screen for permissions
 * past nobody.
 */
export async function reconcileInstalledSet(
  local: readonly InstalledPlugin[],
): Promise<SyncReport> {
  let server: ServerInstall[];
  try {
    server = await fetchInstalledSet();
  } catch {
    // Could not read the account. Report it and change NOTHING — an unreadable
    // server must never look like an empty one, which is the single mistake
    // that would turn this into a delete.
    return { ...EMPTY, offline: true };
  }

  const onServer = new Map(server.map((s) => [s.pluginId, s]));
  const here = new Set(local.map((p) => p.manifest.id));

  const restorable = server.filter((s) => !here.has(s.pluginId));

  const pushed: string[] = [];
  const failed: string[] = [];
  for (const p of local) {
    const id = p.manifest.id;
    const remote = onServer.get(id);
    // Skip only when the account already agrees on all three synced fields —
    // comparing them rather than existence, so an enable/disable or an update
    // made on this machine while offline is still pushed on the next run.
    if (
      remote &&
      remote.version === p.manifest.version &&
      remote.enabled === p.enabled &&
      sameSet(remote.granted, p.granted)
    ) {
      continue;
    }
    try {
      await recordInstalled(id, {
        version: p.manifest.version,
        enabled: p.enabled,
        granted: p.granted,
      });
      pushed.push(id);
    } catch {
      // One plugin failing to record must not stop the rest — a single
      // unknown-plugin 404 (a local-only package the registry never saw) would
      // otherwise abandon the sync for everything after it.
      failed.push(id);
    }
  }

  return { restorable, pushed, failed, offline: false };
}

/** Order-insensitive comparison; grant lists are sets written as arrays. */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const seen = new Set(a);
  return b.every((x) => seen.has(x));
}
