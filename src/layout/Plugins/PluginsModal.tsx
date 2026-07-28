/**
 * The Plugins manager.
 *
 * This is where a user actually gets a plugin into the editor, which is the
 * thing that did not exist: the previous modal listed two plugins that shipped
 * with the app and had no way to add a third.
 *
 * The install flow is deliberately two-step — **pick, then approve** — because
 * the approval screen is the only moment the user can make an informed decision.
 * The package is parsed and validated first (no code runs), so what they are
 * shown is what the package actually declares: its name, version, author and
 * the exact list of things it wants to touch. Only after they accept does any
 * of it reach a sandbox.
 */

import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import { Icon } from '@components/Icon';
import { cn } from '@utils/cn';
import { openModal, closeModal } from '@stores/modalStore';
import { usePluginStore, type InstalledPlugin } from '@stores/pluginStore';
import pluginHost from '@core/plugins/PluginHost';
import { PERMISSIONS, type PluginPermission } from '@core/plugins/manifest';
import { readPluginFile, readPluginFolder, type PluginPackage } from '@core/plugins/pluginPackage';
import { openPluginPanel } from './PluginPanel';
import { downloadStarterPlugin } from './starterPlugin';
import styles from './PluginsModal.module.css';

/** Re-render on any runtime change (start, stop, crash, command registered). */
function useRuntimeRevision(): number {
  return useSyncExternalStore(
    (cb) => pluginHost.subscribe(cb),
    () => pluginHost.getRevision(),
  );
}

const STATUS_LABEL: Record<string, string> = {
  running: 'Running',
  starting: 'Starting…',
  stopped: 'Disabled',
  error: 'Stopped',
};

// ── Install: step 2, the permission grant ──────────────────────────────────

function ConsentSheet({ pkg, onDone }: { pkg: PluginPackage; onDone: () => void }): JSX.Element {
  const { manifest } = pkg;
  const existing = usePluginStore((s) => s.get(manifest.id));
  const [busy, setBusy] = useState(false);

  const install = (): void => {
    setBusy(true);
    const err = pluginHost.install(pkg, manifest.permissions);
    setBusy(false);
    if (err) { window.alert(err); return; }
    onDone();
  };

  return (
    <div className={styles.consent}>
      <div className={styles.consentHead}>
        <div className={styles.iconLg}><Icon name="plugin" size={22} /></div>
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
                <Icon name="check" size={13} />
                <span>
                  <strong>{PERMISSIONS[p].label}.</strong> {PERMISSIONS[p].detail}
                </span>
              </li>
            ))}
          </ul>
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

// ── Install: step 1, choosing a package ────────────────────────────────────

function InstallBar({ onPackage }: { onPackage: (pkg: PluginPackage) => void }): JSX.Element {
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);

  const take = useCallback(async (result: { pkg: PluginPackage | null; errors: string[] }) => {
    if (result.pkg) { setErrors([]); onPackage(result.pkg); return; }
    setErrors(result.errors);
  }, [onPackage]);

  const onDrop = useCallback(async (ev: React.DragEvent) => {
    ev.preventDefault();
    setDragging(false);
    const file = ev.dataTransfer.files[0];
    if (file) await take(await readPluginFile(file));
  }, [take]);

  return (
    <div className={styles.installArea}>
      <div
        className={cn(styles.dropZone, dragging && styles.dropZoneActive)}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <Icon name="upload" size={18} />
        <span className={styles.dropTitle}>Drop a plugin package here</span>
        <span className={styles.dropHint}>A .zip or .mplugin archive containing plugin.json</span>
        <div className={styles.dropActions}>
          <button type="button" className={styles.secondary} onClick={() => fileRef.current?.click()}>
            Choose package…
          </button>
          <button type="button" className={styles.secondary} onClick={() => folderRef.current?.click()}>
            Choose folder…
          </button>
        </div>
      </div>

      {/* The picked bytes are parsed as data and never evaluated here — the
          package's code only ever runs inside a Worker. */}
      <input
        ref={fileRef}
        type="file"
        accept=".zip,.mplugin,application/zip"
        className={styles.hiddenInput}
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) await take(await readPluginFile(f));
        }}
      />
      <input
        ref={folderRef}
        type="file"
        multiple
        // @ts-expect-error — non-standard but universally supported directory picker
        webkitdirectory=""
        className={styles.hiddenInput}
        onChange={async (e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length) await take(await readPluginFolder(files));
        }}
      />

      {errors.length > 0 && (
        <div className={styles.errorBox}>
          <Icon name="warning" size={14} />
          <ul>{errors.map((m) => <li key={m}>{m}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

// ── Installed list ─────────────────────────────────────────────────────────

function PluginRow({ entry }: { entry: InstalledPlugin }): JSX.Element {
  useRuntimeRevision();
  const info = pluginHost.info(entry.manifest.id);
  const { manifest } = entry;

  const confirmRemove = (): void => {
    if (window.confirm(`Uninstall “${manifest.name}”? Anything it added to your project stays.`)) {
      pluginHost.uninstall(manifest.id);
    }
  };

  return (
    <div className={styles.row}>
      <div className={styles.icon}><Icon name="plugin" size={16} /></div>

      <div className={styles.body}>
        <span className={styles.name}>
          {manifest.name}
          <span className={styles.version}>{manifest.version}</span>
        </span>
        <span className={styles.desc}>{manifest.description}</span>

        <div className={styles.meta}>
          <span className={cn(styles.status, styles[`status_${info.status}`])}>
            <span className={styles.dot} />
            {STATUS_LABEL[info.status] ?? info.status}
          </span>
          {manifest.author && <span className={styles.metaItem}>{manifest.author}</span>}
          <span className={styles.metaItem}>
            {manifest.permissions.length === 0
              ? 'No access requested'
              : manifest.permissions.map((p: PluginPermission) => PERMISSIONS[p].label).join(' · ')}
          </span>
          {info.commands.length > 0 && (
            <span className={styles.metaItem}>
              {info.commands.length} command{info.commands.length === 1 ? '' : 's'} — find them in ⌘⇧P
            </span>
          )}
        </div>

        {info.error && (
          <div className={styles.rowError}>
            <Icon name="warning" size={13} />
            <span>{info.error}</span>
            <button type="button" className={styles.linkBtn} onClick={() => pluginHost.restart(manifest.id)}>
              Restart
            </button>
          </div>
        )}
      </div>

      <div className={styles.rowActions}>
        {manifest.panel && info.status === 'running' && (
          <button type="button" className={styles.secondary} onClick={() => openPluginPanel(manifest.id)}>
            Open
          </button>
        )}
        <button
          type="button"
          className={cn(styles.secondary, entry.enabled && styles.toggleOn)}
          onClick={() => pluginHost.setEnabled(manifest.id, !entry.enabled)}
          title={entry.enabled ? 'Disable this plugin' : 'Enable this plugin'}
        >
          {entry.enabled ? 'Enabled' : 'Disabled'}
        </button>
        <button type="button" className={styles.iconBtn} onClick={confirmRemove} title="Uninstall">
          <Icon name="trash" size={14} />
        </button>
      </div>
    </div>
  );
}

// ── The modal body ─────────────────────────────────────────────────────────

function PluginsManager({ close }: { close: () => void }): JSX.Element {
  const plugins = usePluginStore((s) => s.plugins);
  const [pending, setPending] = useState<PluginPackage | null>(null);

  if (pending) {
    return <ConsentSheet pkg={pending} onDone={() => setPending(null)} />;
  }

  return (
    <div className={styles.list}>
      <InstallBar onPackage={setPending} />

      {plugins.length === 0 ? (
        <div className={styles.empty}>
          <Icon name="plugin" size={26} />
          <span className={styles.emptyTitle}>No plugins installed</span>
          <p className={styles.emptyBody}>
            Plugins add commands, panels and automations to the editor. They run sandboxed —
            no network, no access to your account or saved keys — and everything they change
            in your project is undoable.
          </p>
        </div>
      ) : (
        <div className={styles.rows}>
          {[...plugins]
            .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))
            .map((p) => <PluginRow key={p.manifest.id} entry={p} />)}
        </div>
      )}

      <div className={styles.footer}>
        <span className={styles.note}>
          Building one? The starter template is a complete, working package you can edit and re-install.
        </span>
        <button type="button" className={styles.linkBtn} onClick={() => { downloadStarterPlugin(); close(); }}>
          Download starter template
        </button>
      </div>
    </div>
  );
}

export function openPluginsModal(): void {
  const id = 'plugins-modal';
  openModal({
    id,
    title: 'Plugins',
    size: 'lg',
    render: () => <PluginsManager close={() => closeModal(id)} />,
  });
}
