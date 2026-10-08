/**
 * Install a plugin from a `.pplugin` file (plan P2): the confirm dialog, the
 * "Install from file…" flow, and the app-wide listener for double-clicked
 * files.
 *
 * The dialog names the plugin, its version, who signed it (verified store
 * publisher, store publisher, the key already trusted here, or unknown /
 * unsigned) and what it can access. A package from an unknown publisher
 * installs only through "Install anyway". Main did every check and does the
 * install (electron/pluginFileInstall.ts); this only shows and asks.
 */

import { useEffect } from 'react';
import { Badge } from '@components/Badge';
import { Button } from '@components/Button';
import { DialogFooter, customAlert } from '@components/Modal';
import { engine } from '@core/engine/engineInstance';
import {
  accessLine,
  installPackageFile,
  onPackageOpened,
  pickPackageFile,
  takeOpenedPackages,
  trustLine,
} from '@core/nativePlugins/pluginFiles';
import type { StoreInstallResult } from '@core/nativePlugins/pluginStore';
import { openModal } from '@stores/modalStore';
import { useUIStore } from '@stores/uiStore';
import type { NativePluginPackageInspect, NativePluginPackagePreview } from '@/types/motionEditor';
import styles from './InstallPackageDialog.module.css';

export type PackageChoice = 'install' | 'anyway' | null;

function PreviewBody({ p }: { p: NativePluginPackagePreview }): JSX.Element {
  const trust = trustLine(p);
  return (
    <div className={styles.body}>
      <div className={styles.headline}>
        <span className={styles.name}>{p.name}</span>
        <span className={styles.version}>{p.version}</span>
        {p.installedVersion ? <Badge size="sm">installed: {p.installedVersion}</Badge> : null}
      </div>
      <div className={styles.id}>{p.id}</div>
      <div className={trust.tone === 'ok' ? styles.trustOk : styles.trustWarn} role={trust.tone === 'warn' ? 'alert' : undefined}>
        <strong>{trust.label}</strong>
        <span>{trust.detail}</span>
      </div>
      <p className={styles.text}>{accessLine(p)}</p>
      {p.effects.length > 0 ? (
        <ul className={styles.effects}>
          {p.effects.map((e) => (
            <li key={e.matchName}>
              {e.name}
              {e.category ? <span className={styles.muted}> — {e.category}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <p className={styles.muted}>
        SDK {p.sdk} · builds for {p.platforms.join(', ') || 'no platform'}
        {p.entitlement === 'premation-cloud' ? ' · loads with Premation Cloud' : ''}
      </p>
      {p.problem ? <p className={styles.problem} role="alert">{p.problem}</p> : null}
    </div>
  );
}

/** Ask the user about one inspected package. Resolves their choice; null when they cancel. */
export function confirmPackageInstall(p: NativePluginPackagePreview): Promise<PackageChoice> {
  const trust = trustLine(p);
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v: PackageChoice, close: () => void): void => {
      settled = true;
      close();
      resolve(v);
    };
    const confirm: PackageChoice = trust.needsAnyway ? 'anyway' : 'install';
    openModal({
      title: p.problem ? 'This plugin cannot be installed' : `Install ${p.name}?`,
      size: 'sm',
      persistent: true,
      onClose: () => {
        if (!settled) {
          settled = true;
          resolve(null);
        }
      },
      render: () => <PreviewBody p={p} />,
      footer: (close) => (
        <DialogFooter
          secondary={
            <Button variant="ghost" onClick={() => settle(null, close)}>
              {p.problem ? 'Close' : 'Cancel'}
            </Button>
          }
          {...(p.problem
            ? {}
            : trust.needsAnyway
              ? { destructive: <Button variant="danger" onClick={() => settle(confirm, close)}>Install anyway</Button> }
              : { primary: <Button variant="primary" onClick={() => settle(confirm, close)}>Install</Button> })}
        />
      ),
      // Enter installs only a package from a known publisher: "Install anyway" is never one keystroke.
      ...(p.problem || trust.needsAnyway ? {} : { primaryAction: (close: () => void) => settle(confirm, close) }),
    });
  });
}

/** Show, ask, install. Resolves the outcome to report; null when nothing was attempted. */
export async function runPackageInstall(r: NativePluginPackageInspect): Promise<StoreInstallResult | null> {
  if (!r.ok) {
    await customAlert('Not a plugin package', r.fileName ? `${r.fileName}: ${r.reason}` : r.reason, { isDanger: true });
    return null;
  }
  const choice = await confirmPackageInstall(r.preview);
  if (!choice) return null;
  return installPackageFile(engine(), r.preview.token, choice === 'anyway');
}

/** Plugins ▸ Installed ▸ "Install from file…". */
export async function installFromFilePicker(): Promise<StoreInstallResult | null> {
  const r = await pickPackageFile();
  return r ? runPackageInstall(r) : null;
}

function report(out: StoreInstallResult | null): void {
  if (!out) return;
  useUIStore.getState().notify({ level: out.ok ? 'success' : 'error', message: out.message, durationMs: 9000 });
}

/**
 * Mounted once at the app root: a double-clicked `.pplugin` (main.ts) shows the
 * install dialog over whatever is open. Drains on mount too, for a file that
 * launched the app before the page was listening.
 */
export function PluginPackageOpener(): null {
  useEffect(() => {
    let alive = true;
    let running = false;
    const drain = async (): Promise<void> => {
      if (running) return;
      running = true;
      try {
        for (let batch = await takeOpenedPackages(); alive && batch.length > 0; batch = await takeOpenedPackages()) {
          for (const r of batch) {
            if (!alive) return;
            report(await runPackageInstall(r));
          }
        }
      } finally {
        running = false;
      }
    };
    void drain();
    const off = onPackageOpened(() => void drain());
    return () => {
      alive = false;
      off();
    };
  }, []);
  return null;
}
