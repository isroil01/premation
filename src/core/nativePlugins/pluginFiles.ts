/**
 * Installing a `.pplugin` from a file, page side (plan P2).
 *
 * Main reads and checks the file (electron/pluginFileInstall.ts) and answers a
 * preview; the page shows it, the user decides, and main installs it by its
 * token. The page never holds the bytes or names a path.
 *
 * No React (src/core). The dialog is src/layout/Plugins/InstallPackageDialog.tsx.
 */

import type { EngineClient } from '@motion/engine-api';
import type { NativePluginPackageInspect, NativePluginPackagePreview } from '@/types/motionEditor';
import { finishInstall, type StoreInstallResult } from './pluginStore';

type PluginsBridge = NonNullable<NonNullable<Window['motionEditor']>['plugins']>;

function bridge(): PluginsBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.motionEditor?.plugins;
}

/** Whether this build installs from files (the desktop app). */
export function canInstallFromFile(): boolean {
  return typeof bridge()?.pickPackageFile === 'function';
}

/** How the dialog states who the package is from. */
export interface TrustLine {
  /** One short line: "Verified publisher: Acme". */
  label: string;
  tone: 'ok' | 'warn';
  /** What that means for the user. */
  detail: string;
  /** Installing needs the explicit "Install anyway". */
  needsAnyway: boolean;
}

export function trustLine(p: NativePluginPackagePreview): TrustLine {
  const who = p.publisher || p.vendor || 'an unnamed publisher';
  switch (p.trust) {
    case 'store-verified':
      return { label: `Verified publisher: ${who}`, tone: 'ok', needsAnyway: false, detail: 'Signed with the key this plugin is published with in the Premation plugin store.' };
    case 'store':
      return { label: `Store publisher: ${who}`, tone: 'ok', needsAnyway: false, detail: 'Signed with the key this plugin is published with in the plugin store. The publisher is not verified.' };
    case 'pinned':
      return { label: `Same publisher as your installed copy: ${who}`, tone: 'ok', needsAnyway: false, detail: 'Signed with the key you trusted when you first installed this plugin.' };
    case 'unknown':
      return {
        label: `Unknown publisher${p.vendor ? ` (says it is from ${p.vendor})` : ''}`,
        tone: 'warn',
        needsAnyway: true,
        detail: p.storeUnreachable
          ? 'The plugin store could not be reached to check who signed it. Install it only if you trust where you got the file. Its key will be remembered, and later versions must be signed with it.'
          : 'Signed, but not by a publisher the plugin store knows for this plugin. Install it only if you trust where you got the file. Its key will be remembered, and later versions must be signed with it.',
      };
    case 'unsigned':
    default:
      return {
        label: 'Unsigned',
        tone: 'warn',
        needsAnyway: true,
        detail: 'Nothing proves who made this package or that it was not changed. Install it only if you built it yourself or fully trust where you got it.',
      };
  }
}

/** What the plugin can do once installed: native code is not sandboxed. */
export function accessLine(p: NativePluginPackagePreview): string {
  const effects = p.effects.length === 1 ? `1 effect (${p.effects[0]!.name})` : `${p.effects.length} effects`;
  return `Adds ${effects}. It runs as native code inside the Premation engine, with the same access to your computer as Premation itself.`;
}

/** Show the open dialog and have main inspect the chosen file; null when cancelled. */
export async function pickPackageFile(): Promise<NativePluginPackageInspect | null> {
  const pick = bridge()?.pickPackageFile;
  if (!pick) return { ok: false, fileName: '', reason: 'Installing from a file needs the desktop app.' };
  try {
    return await pick();
  } catch (e) {
    return { ok: false, fileName: '', reason: e instanceof Error ? e.message : 'Could not open the file.' };
  }
}

/** Packages opened by double-click that the page has not shown yet. */
export async function takeOpenedPackages(): Promise<NativePluginPackageInspect[]> {
  try {
    return (await bridge()?.takeOpenedPackages?.()) ?? [];
  } catch {
    return [];
  }
}

/** Subscribe to double-click opens; returns the unsubscribe (a no-op outside the desktop app). */
export function onPackageOpened(handler: () => void): () => void {
  return bridge()?.onPackageOpened?.(handler) ?? (() => {});
}

/** Install an inspected package, then rescan. Never throws. */
export async function installPackageFile(
  client: Pick<EngineClient, 'execute'>,
  token: string,
  allowUnknown: boolean,
): Promise<StoreInstallResult> {
  const install = bridge()?.installPackageFile;
  if (!install) return { ok: false, message: 'Installing from a file needs the desktop app.' };
  try {
    return await finishInstall(client, await install({ token, allowUnknown }));
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'The install failed.' };
  }
}
