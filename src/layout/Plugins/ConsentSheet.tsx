/**
 * The permission grant. The one screen the whole plugin security model rests on.
 *
 * Installing is a two-step flow — **pick, then approve** — and this is step two.
 * By the time it renders, the package has been read and validated as DATA: no
 * plugin code has run, and nothing will until the user accepts. So what is
 * described here is what the package actually declares, not what a listing
 * claims about it.
 *
 * It lives in its own file because it outlives every container it has been
 * shown in. It was born inside the manager modal; the modal is gone, and this
 * is now raised from the plugin list, from a detail tab, from an install
 * picker, and from a `premation://` deep link. Every one of those lands HERE.
 * A surface that installed without it, for any reason at all, would quietly
 * make the permission model optional.
 */

import { useState } from 'react';
import { Icon } from '@components/Icon';
import { usePluginStore } from '@stores/pluginStore';
import pluginHost from '@core/plugins/PluginHost';
import { PERMISSIONS, type PluginPermission } from '@core/plugins/manifest';
import type { PluginPackage } from '@core/plugins/pluginPackage';
import { customAlert } from '@components/Modal/Dialogs';
import styles from './ConsentSheet.module.css';

export function ConsentSheet({
  pkg,
  source,
  publisherKey,
  onDone,
}: {
  pkg: PluginPackage;
  source?: 'folder' | 'file' | 'registry';
  /** Set for a registry install: the key the package was verified against. */
  publisherKey?: string;
  onDone: () => void;
}): JSX.Element {
  const { manifest } = pkg;
  const existing = usePluginStore((s) => s.get(manifest.id));
  const [busy, setBusy] = useState(false);
  /**
   * Which permissions the user is actually granting.
   *
   * All ticked by default — the plugin asked for these and refusing by default
   * would make every plugin arrive broken. But each one is separable, because
   * "install this, but not the part that rewrites my keyframes" is a reasonable
   * thing to want and used to be unsayable: consent was one yes over the whole
   * list, and the gate underneath supported partial grants all along.
   */
  const [chosen, setChosen] = useState<PluginPermission[]>(() => [...manifest.permissions]);

  const toggle = (p: PluginPermission): void => {
    setChosen((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));
  };

  const install = (): void => {
    setBusy(true);
    const err = pluginHost.install(pkg, chosen, {
      ...(source ? { source } : {}),
      ...(publisherKey ? { publisherKey } : {}),
    });
    setBusy(false);
    if (err) { void customAlert('Could not install plugin', err, { isDanger: true }); return; }
    onDone();
  };

  return (
    <div className={styles.consent}>
      <div className={styles.consentHead}>
        <div className={styles.iconLg}><Icon name="plugin" size="lg" /></div>
        <div className={styles.body}>
          <span className={styles.name}>{manifest.name}</span>
          <span className={styles.desc}>
            {manifest.version}
            {manifest.author ? ` · ${manifest.author}` : ''}
            {existing ? ` · updating from ${existing.manifest.version}` : ''}
          </span>
        </div>
      </div>

      <p className={styles.consentDesc}>{manifest.description}</p>

      {/* The one provenance signal the package carries. It was parsed and
          validated to http(s) (see manifest.ts) and then never shown, which
          left the user deciding on a name and a description alone. Printed in
          full, not as friendly link text: the URL IS the information. */}
      {manifest.homepage && (
        <p className={styles.consentHomepage}>
          <Icon name="link" size="sm" />
          <a href={manifest.homepage} target="_blank" rel="noreferrer noopener">{manifest.homepage}</a>
        </p>
      )}

      <div className={styles.permBlock}>
        <span className={styles.permTitle}>
          {manifest.permissions.length === 0 ? 'This plugin asks for no access' : 'This plugin will be able to:'}
        </span>
        {manifest.permissions.length === 0 ? (
          <p className={styles.permNone}>
            It runs sandboxed and can only contribute commands and its own panel.
          </p>
        ) : (
          <ul className={styles.permList}>
            {manifest.permissions.map((p) => (
              <li key={p} className={styles.permItem}>
                <label className={styles.permCheck}>
                  <input type="checkbox" checked={chosen.includes(p)} onChange={() => toggle(p)} />
                  <span>
                    <strong>{PERMISSIONS[p].label}.</strong> {PERMISSIONS[p].detail}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
        {manifest.permissions.length > 0 && chosen.length < manifest.permissions.length && (
          <p className={styles.permWarn}>
            <Icon name="warning" size="sm" />
            <span>
              Withholding access is supported, but the plugin may not work. A refused call
              tells it which permission is missing, so a well-written plugin degrades instead of failing.
            </span>
          </p>
        )}
      </div>

      <p className={styles.sandboxNote}>
        Plugins run in a sandbox with no network access and no access to your account,
        your sign-in or your saved API keys. Anything a plugin changes in your project is undoable.
      </p>

      <div className={styles.consentActions}>
        <button type="button" className={styles.secondary} onClick={onDone}>Cancel</button>
        <button type="button" className={styles.primary} disabled={busy} onClick={install}>
          {existing ? 'Update' : 'Install'}
        </button>
      </div>
    </div>
  );
}

/**
 * The overlay the sheet is shown in.
 *
 * Exported so every raiser mounts the same one. Three call sites building their
 * own overlay is three chances for one of them to be dismissable, or to render
 * behind something, on the single screen where neither may happen.
 */
export function ConsentOverlay({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className={styles.consentOverlay} role="dialog" aria-modal="true" aria-label="Install plugin">
      <div className={styles.consentHost}>{children}</div>
    </div>
  );
}
