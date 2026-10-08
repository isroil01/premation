/**
 * The plugin store, page side (docs/PLUGIN_STORE.md §4–5).
 *
 * The page never downloads or writes a plugin. It asks Electron main to
 * install `{id, version}` (main fetches, verifies and stages — see
 * electron/ipc/nativePlugins.ts), then tells the engine to `rescanPlugins` so
 * the new effects are usable without a restart. Enable / disable goes to both:
 * the engine now (`setPluginEnabled`), main for the next launch.
 *
 * No React (src/core). The hook is src/hooks/usePluginStore.ts.
 */

import type { EngineClient, PluginInfo } from '@motion/engine-api';
import { refreshPluginEffectDefs } from '@core/inspector/pluginEffectDefs';
import type { NativePluginInstallOutcome, NativePluginStoreState } from '@/types/motionEditor';

type PluginsBridge = NonNullable<NonNullable<Window['motionEditor']>['plugins']>;

function bridge(): PluginsBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.motionEditor?.plugins;
}

/** Whether this build can install from the store (the desktop app). */
export function canInstallFromStore(): boolean {
  const b = bridge();
  return typeof b?.install === 'function' && typeof b.installed === 'function';
}

export type StoreInstallResult =
  | { ok: true; message: string; restartNeeded: boolean; plugins: PluginInfo[] | null }
  | { ok: false; message: string };

/** The engine's plugin list after a rescan; null when the engine has no plugin host. */
export async function rescanPlugins(client: Pick<EngineClient, 'execute'> & Partial<Pick<EngineClient, 'query'>>): Promise<PluginInfo[] | null> {
  try {
    const res = await client.execute({ type: 'rescanPlugins' });
    if (client.query) await refreshPluginEffectDefs({ query: client.query.bind(client) });
    return res.ok ? res.value.plugins : null;
  } catch {
    return null;
  }
}

/** Install a version from the store. `owner`: install your own (possibly private) plugin. Never throws. */
export async function installFromStore(
  client: Pick<EngineClient, 'execute'>,
  req: { id: string; version: string; owner?: boolean },
): Promise<StoreInstallResult> {
  const install = bridge()?.install;
  if (!install) return { ok: false, message: 'Installing plugins needs the desktop app.' };
  let out: NativePluginInstallOutcome;
  try {
    out = await install(req);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'The install failed.' };
  }
  return finishInstall(client, out);
}

/**
 * After main installed a package (store or file): rescan so its effects are
 * usable now, or say a restart is needed (an update over a loaded copy).
 */
export async function finishInstall(
  client: Pick<EngineClient, 'execute'>,
  out: NativePluginInstallOutcome,
): Promise<StoreInstallResult> {
  if (!out.ok) return { ok: false, message: out.reason };
  if (out.restartNeeded) {
    return {
      ok: true,
      restartNeeded: true,
      plugins: null,
      message: `Installed ${out.id} ${out.version}. Restart Premation to use this version.`,
    };
  }
  const plugins = await rescanPlugins(client);
  const loaded = plugins?.find((p) => p.id === out.id);
  return {
    ok: true,
    restartNeeded: false,
    plugins,
    message: loaded?.status === 'loaded'
      ? `Installed ${out.id} ${out.version}. Its effects are in the Effects panel.`
      : `Installed ${out.id} ${out.version}${loaded?.error ? `, but it did not load: ${loaded.error}` : '.'}`,
  };
}

/** Enable / disable now (engine) and from the next launch (main). Resolves the error to show, or null. */
export async function setPluginEnabled(client: Pick<EngineClient, 'execute'>, id: string, enabled: boolean): Promise<string | null> {
  try {
    const res = await client.execute({ type: 'setPluginEnabled', plugin: id, enabled });
    await bridge()?.setEnabled?.({ id, enabled });
    const q = (client as Partial<Pick<EngineClient, 'query'>>).query;
    if (q) await refreshPluginEffectDefs({ query: q.bind(client) });
    return res.ok ? null : res.error.message;
  } catch (e) {
    return e instanceof Error ? e.message : 'Could not change the plugin.';
  }
}

/** Disable now and remove at the next start (a loaded module cannot be unloaded safely). */
export async function uninstallPlugin(client: Pick<EngineClient, 'execute'>, id: string): Promise<string | null> {
  const uninstall = bridge()?.uninstall;
  if (!uninstall) return 'Uninstalling needs the desktop app.';
  try {
    await client.execute({ type: 'setPluginEnabled', plugin: id, enabled: false }).catch(() => undefined);
    const state = await uninstall(id);
    return state ? null : 'Could not uninstall that plugin.';
  } catch (e) {
    return e instanceof Error ? e.message : 'Could not uninstall that plugin.';
  }
}

/** The installed set as main keeps it (versions, pinned keys, enabled, pending). */
export async function installedPlugins(): Promise<NativePluginStoreState | null> {
  const get = bridge()?.installed;
  if (!get) return null;
  try {
    return await get();
  } catch {
    return null;
  }
}

/** Compare dotted versions numerically (`1.10.0` > `1.9.2`); non-numeric parts compare as text. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/);
  const pb = b.split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] ?? '0';
    const y = pb[i] ?? '0';
    const nx = Number(x);
    const ny = Number(y);
    const c = Number.isFinite(nx) && Number.isFinite(ny) ? nx - ny : x.localeCompare(y);
    if (c !== 0) return c < 0 ? -1 : 1;
  }
  return 0;
}

/** Platform keys a downloaded plugin can run on here (docs/PLUGIN_STORE.md §1). */
export function platformKeysHere(platform: string, arch: string): string[] {
  if (platform.startsWith('win')) return ['windows-x64', 'windows'];
  if (platform === 'darwin' || platform.startsWith('mac')) {
    return arch === 'arm64' ? ['macos-arm64', 'macos-universal', 'macos'] : ['macos-x64', 'macos-universal', 'macos'];
  }
  return arch === 'arm64' ? ['linux-arm64', 'linux'] : ['linux-x64', 'linux'];
}

/** This machine's keys (the desktop app's own OS / arch); null outside it. */
export function hostPlatformKeys(): string[] | null {
  const host = bridge()?.host;
  return host ? platformKeysHere(host.platform, host.arch) : null;
}

/** Whether a listing ships a binary for this machine. */
export function runsHere(platforms: readonly string[], here: readonly string[]): boolean {
  return platforms.some((p) => here.includes(p));
}

/**
 * Premation Cloud (docs/PLUGIN_PLATFORM_PLAN.md §3.2): ask main to refresh the
 * entitlement token now — after an upgrade — and say what happens next. A
 * plugin locked at engine start loads at the next start. Never throws.
 */
export async function checkPremationCloud(): Promise<{ text: string; error: boolean }> {
  const refresh = bridge()?.refreshEntitlement;
  if (!refresh) return { text: 'Premation Cloud plugins need the desktop app.', error: true };
  try {
    const s = await refresh();
    if (s.plan === 'pro' && s.validUntil !== null) {
      return { text: 'Premation Cloud is active on this computer. Restart Premation to load its plugins.', error: false };
    }
    if (s.plan === 'free') return { text: 'This account\'s plan does not include Premation plugins. Upgrade in Account ▸ Billing.', error: true };
    return { text: 'Could not check the plan. Sign in and try again.', error: true };
  } catch {
    return { text: 'Could not check the plan.', error: true };
  }
}
