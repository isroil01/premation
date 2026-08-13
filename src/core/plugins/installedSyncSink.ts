/**
 * Where the plugin store announces install changes, without knowing who listens.
 *
 * ── Why this indirection exists ─────────────────────────────────────────────
 *
 * `pluginStore` is about LOCAL persistence. Making it import the registry
 * client so it could also push each change to the account inverted that: a
 * store whose job is IndexedDB suddenly depended on the network module, which
 * meant every test that renders anything touching the store had to know about
 * HTTP. Several already mocked `registry` partially, so the new calls resolved
 * to `undefined` and twenty-one unrelated tests failed with
 * "recordInstalled is not a function" — a good early warning that the
 * dependency pointed the wrong way, rather than a mocking inconvenience.
 *
 * So the store calls a SINK. It defaults to doing nothing, which is exactly
 * right for a test, for the local edition, and for a signed-out user; the app
 * installs the real one at boot. The store keeps working if nobody ever does.
 *
 * Deliberately fire-and-forget and returning `void`: a plugin IS installed on
 * this machine whether or not the account heard about it, so a failure here
 * must never look like an install failure. Whatever is missed is picked up by
 * the next `reconcileInstalledSet`, which is the actual source of truth for
 * "are these two in agreement".
 */

import type { PluginPermission } from './manifest';

export interface InstalledSyncSink {
  /** An install, an update, or an enable/disable — the same upsert. */
  record(pluginId: string, body: { version: string; enabled: boolean; granted: PluginPermission[] }): void;
  /** An uninstall. The one direction that MUST reach the account, or the next
   *  reconcile offers to restore what the user just removed. */
  forget(pluginId: string): void;
}

const NOOP: InstalledSyncSink = { record: () => {}, forget: () => {} };

let current: InstalledSyncSink = NOOP;

/** Wire the real sink. Called once at boot. */
export function setInstalledSyncSink(sink: InstalledSyncSink): void {
  current = sink;
}

/** Restore the default no-op. For tests that installed a fake. */
export function resetInstalledSyncSink(): void {
  current = NOOP;
}

export function installedSyncSink(): InstalledSyncSink {
  return current;
}
