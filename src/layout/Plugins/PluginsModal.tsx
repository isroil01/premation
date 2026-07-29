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

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Icon } from '@components/Icon';
import { cn } from '@utils/cn';
import { openModal, closeModal } from '@stores/modalStore';
import { usePluginStore, type InstalledPlugin } from '@stores/pluginStore';
import pluginHost from '@core/plugins/PluginHost';
import { PERMISSIONS, describePermissions, type PluginPermission } from '@core/plugins/manifest';
import { readPluginFile, readPluginFolder, readPluginZip, type PluginPackage } from '@core/plugins/pluginPackage';
import {
  browseRegistry,
  fetchRegistryPackage,
  checkForUpdates,
  type RegistryPlugin,
  type RegistryUpdate,
} from '@core/plugins/registry';
import { showPluginPanel } from './PluginPanel';
import { downloadStarterPlugin } from './starterPlugin';
import styles from './PluginsModal.module.css';

/** Re-render on any runtime change (start, stop, crash, command registered). */
function useRuntimeRevision(): number {
  return useSyncExternalStore(
    (cb) => pluginHost.subscribe(cb),
    () => pluginHost.getRevision(),
  );
}

/**
 * `stopped` is two different situations and used to be labelled as one:
 * the user turned it off, or it is switched on and simply has no runtime
 * (start refused, sandbox unavailable). Showing "Disabled" next to a toggle
 * reading "Enabled" is a contradiction the user cannot resolve.
 */
function statusLabel(status: string, enabled: boolean): string {
  if (status === 'running') return 'Running';
  if (status === 'starting') return 'Starting…';
  if (status === 'error') return 'Stopped';
  return enabled ? 'Not running' : 'Disabled';
}

// ── Install: step 2, the permission grant ──────────────────────────────────

function ConsentSheet({
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

      {/* The one provenance signal the package carries. It was parsed and
          validated to http(s) (see manifest.ts) and then never shown, which
          left the user deciding on a name and a description alone. Printed in
          full, not as friendly link text: the URL IS the information. */}
      {manifest.homepage && (
        <p className={styles.consentHomepage}>
          <Icon name="link" size={12} />
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
            <Icon name="warning" size={12} />
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

// ── Install: step 1, choosing a package ────────────────────────────────────

function InstallBar({
  onPackage,
}: {
  onPackage: (pkg: PluginPackage, source: 'folder' | 'file') => void;
}): JSX.Element {
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);

  const take = useCallback(async (
    result: { pkg: PluginPackage | null; errors: string[] },
    source: 'folder' | 'file',
  ) => {
    if (result.pkg) { setErrors([]); onPackage(result.pkg, source); return; }
    setErrors(result.errors);
  }, [onPackage]);

  const onDrop = useCallback(async (ev: React.DragEvent) => {
    ev.preventDefault();
    setDragging(false);
    const file = ev.dataTransfer.files[0];
    if (file) await take(await readPluginFile(file), 'file');
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
          if (f) await take(await readPluginFile(f), 'file');
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
          if (files.length) await take(await readPluginFolder(files), 'folder');
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

// ── The registry ───────────────────────────────────────────────────────────

/**
 * Browse and install from the registry.
 *
 * The install path is deliberately the SAME one a local file takes: the
 * downloaded bytes are verified, then parsed by the ordinary package reader,
 * then shown on the ordinary consent screen. A registry install is not a
 * shortcut past the permission decision — being listed somewhere is not a
 * reason to trust a plugin with your keyframes, and the signature only says
 * who published it, never whether they meant well.
 */
function RegistryBrowser({
  onPackage,
}: {
  onPackage: (pkg: PluginPackage, publisherKey: string) => void;
}): JSX.Element {
  const installed = usePluginStore((s) => s.plugins);
  const [q, setQ] = useState('');
  const [items, setItems] = useState<RegistryPlugin[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const search = useCallback(async (term: string) => {
    setError(null);
    try {
      setItems(await browseRegistry(term));
    } catch (err) {
      // Being offline is the common case here, not a defect. Say what happened
      // and leave the local install path — which needs no network — in place.
      setItems([]);
      setError((err as Error).message || 'The registry could not be reached.');
    }
  }, []);

  useEffect(() => { void search(''); }, [search]);

  const install = async (entry: RegistryPlugin): Promise<void> => {
    setBusyId(entry.id);
    setError(null);
    try {
      // The key from the listing is the pin for this first install. Everything
      // after — every update — is checked against the copy stored locally.
      const { bytes, publisherKey } = await fetchRegistryPackage(
        entry.id,
        entry.latestVersion,
        entry.publisherKey,
      );
      const result = readPluginZip(bytes);
      if (!result.pkg) { setError(result.errors.join(' ')); return; }
      onPackage(result.pkg, publisherKey);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className={styles.registry}>
      <div className={styles.registrySearch}>
        <Icon name="search" size={14} />
        <input
          type="search"
          value={q}
          placeholder="Search the plugin registry"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void search(q); }}
        />
        <button type="button" className={styles.secondary} onClick={() => void search(q)}>Search</button>
      </div>

      {error && (
        <div className={styles.errorBox}>
          <Icon name="warning" size={14} />
          <span>{error}</span>
        </div>
      )}

      {items === null ? (
        <p className={styles.emptyBody}>Loading…</p>
      ) : items.length === 0 ? (
        <p className={styles.emptyBody}>
          {error ? 'You can still install a plugin from a file or folder above.' : 'Nothing published yet.'}
        </p>
      ) : (
        <div className={styles.rows}>
          {items.map((entry) => {
            const have = installed.find((p) => p.manifest.id === entry.id);
            return (
              <div key={entry.id} className={styles.row}>
                <div className={styles.icon}><Icon name="plugin" size={16} /></div>
                <div className={styles.body}>
                  <span className={styles.name}>
                    {entry.name}
                    <span className={styles.version}>{entry.latestVersion}</span>
                  </span>
                  <span className={styles.desc}>{entry.description}</span>
                  <div className={styles.meta}>
                    <span className={styles.metaItem}>
                      {entry.permissions.length === 0
                        ? 'No access requested'
                        : describePermissions(entry.permissions)}
                    </span>
                    <span className={styles.metaItem}>{entry.installs} install{entry.installs === 1 ? '' : 's'}</span>
                  </div>
                </div>
                <div className={styles.rowActions}>
                  <button
                    type="button"
                    className={styles.secondary}
                    disabled={busyId === entry.id || have?.manifest.version === entry.latestVersion}
                    onClick={() => void install(entry)}
                  >
                    {busyId === entry.id
                      ? 'Verifying…'
                      : have?.manifest.version === entry.latestVersion
                        ? 'Installed'
                        : have
                          ? 'Update'
                          : 'Install'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Installed list ─────────────────────────────────────────────────────────

/** The plugin's own console output, plus the host's refusals and crashes. */
function LogDrawer({ pluginId }: { pluginId: string }): JSX.Element {
  useRuntimeRevision();
  const lines = pluginHost.log(pluginId);
  const endRef = useRef<HTMLDivElement>(null);

  // Optional call, not decoration: `scrollIntoView` is absent in jsdom and in
  // some embedded webviews, and a log viewer that throws while rendering is
  // the least useful thing a log viewer can do.
  useEffect(() => { endRef.current?.scrollIntoView?.({ block: 'nearest' }); }, [lines.length]);

  return (
    <div className={styles.logBox}>
      {lines.length === 0 ? (
        <p className={styles.logEmpty}>
          Nothing logged. A plugin&apos;s <code>console.log</code> appears here, along with
          any call the permission gate refused.
        </p>
      ) : (
        <>
          {lines.map((l, i) => (
            <div key={i} className={cn(styles.logLine, styles[`log_${l.level}`])}>
              <span className={styles.logTime}>{(l.at / 1000).toFixed(1)}s</span>
              <span>{l.text}</span>
            </div>
          ))}
          <div ref={endRef} />
        </>
      )}
      {lines.length > 0 && (
        <button type="button" className={styles.linkBtn} onClick={() => pluginHost.clearLog(pluginId)}>
          Clear
        </button>
      )}
    </div>
  );
}

/** Change what an already-installed plugin is allowed to do. */
function PermissionEditor({ entry, onDone }: { entry: InstalledPlugin; onDone: () => void }): JSX.Element {
  const { manifest } = entry;
  const [chosen, setChosen] = useState<PluginPermission[]>(() => [...entry.granted]);
  const dirty =
    chosen.length !== entry.granted.length || chosen.some((p) => !entry.granted.includes(p));

  return (
    <div className={styles.permEdit}>
      <span className={styles.permTitle}>What {manifest.name} may do</span>
      <ul className={styles.permList}>
        {manifest.permissions.map((p) => (
          <li key={p} className={styles.permItem}>
            <label className={styles.permCheck}>
              <input
                type="checkbox"
                checked={chosen.includes(p)}
                onChange={() =>
                  setChosen((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]))
                }
              />
              <span><strong>{PERMISSIONS[p].label}.</strong> {PERMISSIONS[p].detail}</span>
            </label>
          </li>
        ))}
      </ul>
      <div className={styles.permEditActions}>
        <span className={styles.note}>
          {dirty ? 'Applying restarts the plugin — its worker was told what it had at boot.' : ''}
        </span>
        <button type="button" className={styles.secondary} onClick={onDone}>Close</button>
        <button
          type="button"
          className={styles.primary}
          disabled={!dirty}
          onClick={() => { pluginHost.setGranted(manifest.id, chosen); onDone(); }}
        >
          Apply
        </button>
      </div>
    </div>
  );
}

function PluginRow({
  entry,
  onReload,
  update,
  onUpdate,
}: {
  entry: InstalledPlugin;
  onReload: (entry: InstalledPlugin) => void;
  /** Set when the registry reported a newer version, or a withdrawal. */
  update?: RegistryUpdate;
  onUpdate: (entry: InstalledPlugin, update: RegistryUpdate) => void;
}): JSX.Element {
  useRuntimeRevision();
  const info = pluginHost.info(entry.manifest.id);
  const { manifest } = entry;
  const [open, setOpen] = useState<'none' | 'log' | 'perms'>('none');

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
            {statusLabel(info.status, entry.enabled)}
          </span>
          {manifest.author && <span className={styles.metaItem}>{manifest.author}</span>}
          <span className={styles.metaItem}>
            {/* What the plugin may ACTUALLY do — `granted`, not what the
                manifest asked for. Those are now different things: a user who
                withheld a permission would otherwise read a row claiming the
                plugin can still do it. One summary function, so this and the
                consent screen cannot describe the same set differently. */}
            {entry.granted.length === 0
              ? manifest.permissions.length === 0 ? 'No access requested' : 'All access withheld'
              : describePermissions(entry.granted)}
            {entry.granted.length < manifest.permissions.length && (
              <span className={styles.metaNarrowed}>
                {' '}· narrowed from {manifest.permissions.length}
              </span>
            )}
          </span>
          {info.commands.length > 0 && (
            <span className={styles.metaItem}>
              {info.commands.length} command{info.commands.length === 1 ? '' : 's'} — in the Plugins menu and ⌘⇧P
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

        {update?.blocked && (
          <div className={styles.rowError}>
            <Icon name="warning" size={13} />
            <span>
              This plugin was withdrawn from the registry
              {update.blockedReason ? `: ${update.blockedReason}` : '.'} Your copy still works — but it
              will get no further updates, and it was pulled for a reason.
            </span>
          </div>
        )}
        {update && !update.blocked && (
          <div className={styles.rowUpdate}>
            <Icon name="arrow-up" size={13} />
            <span>Version {update.latestVersion} is available.</span>
            <button type="button" className={styles.linkBtn} onClick={() => onUpdate(entry, update)}>
              Update
            </button>
          </div>
        )}

        <div className={styles.rowLinks}>
          <button
            type="button"
            className={styles.linkBtn}
            onClick={() => setOpen(open === 'log' ? 'none' : 'log')}
          >
            {open === 'log' ? 'Hide log' : 'Log'}
          </button>
          {manifest.permissions.length > 0 && (
            <button
              type="button"
              className={styles.linkBtn}
              onClick={() => setOpen(open === 'perms' ? 'none' : 'perms')}
            >
              {open === 'perms' ? 'Hide permissions' : 'Permissions'}
            </button>
          )}
          {entry.source === 'folder' && (
            <button
              type="button"
              className={styles.linkBtn}
              // The author's edit/run loop. The browser still needs a gesture to
              // read a directory, so this opens the picker — what it removes is
              // the consent screen on every single iteration.
              onClick={() => onReload(entry)}
              title="Re-read this plugin from its folder"
            >
              Reload
            </button>
          )}
        </div>

        {open === 'log' && <LogDrawer pluginId={manifest.id} />}
        {open === 'perms' && <PermissionEditor entry={entry} onDone={() => setOpen('none')} />}
      </div>

      <div className={styles.rowActions}>
        {manifest.panel && info.status === 'running' && (
          <button
            type="button"
            className={styles.secondary}
            // Reveals the docked Plugins panel rather than opening a modal over
            // the editor — the panel is meant to be used while you work.
            onClick={() => showPluginPanel(manifest.id)}
            title="Show this plugin's panel in the dock"
          >
            Open Panel
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

/** Exported for tests: the modal wrapper adds nothing this needs. */
export function PluginsManager({ close }: { close: () => void }): JSX.Element {
  const plugins = usePluginStore((s) => s.plugins);
  const [pending, setPending] = useState<{
    pkg: PluginPackage;
    source: 'folder' | 'file' | 'registry';
    publisherKey?: string;
  } | null>(null);
  const reloadRef = useRef<HTMLInputElement>(null);
  const reloadingRef = useRef<InstalledPlugin | null>(null);
  const [tab, setTab] = useState<'installed' | 'browse'>('installed');
  const [updates, setUpdates] = useState<RegistryUpdate[]>([]);

  /**
   * The one moment the app talks to the registry about what is installed.
   *
   * Fires when this component mounts — i.e. when the user opens the manager —
   * and never on a timer. Plugins themselves still have no network path at all;
   * this is the editor asking, on the screen where the answer is the point.
   * Failure is silent by design (see checkForUpdates).
   */
  useEffect(() => {
    let alive = true;
    const installedSet = usePluginStore.getState().plugins.map((p) => ({
      id: p.manifest.id,
      version: p.manifest.version,
    }));
    void checkForUpdates(installedSet).then((found) => { if (alive) setUpdates(found); });
    return () => { alive = false; };
  }, []);

  /**
   * Take an offered update.
   *
   * The key checked against is the one stored with the INSTALLED copy, not the
   * one the update notice carried — otherwise a server that can lie about
   * updates could also nominate the key that makes its package verify.
   */
  const applyUpdate = useCallback(async (entry: InstalledPlugin, update: RegistryUpdate) => {
    const pinned = entry.publisherKey;
    if (!pinned) {
      window.alert(
        `"${entry.manifest.name}" was installed from a local file, so there is no publisher key to check `
        + 'an update against. Install it from the registry to get verified updates.',
      );
      return;
    }
    try {
      const { bytes } = await fetchRegistryPackage(entry.manifest.id, update.latestVersion, pinned);
      const result = readPluginZip(bytes);
      if (!result.pkg) { window.alert(result.errors.join('\n')); return; }

      const asksForMore = result.pkg.manifest.permissions.some((p) => !entry.granted.includes(p));
      if (asksForMore) {
        // A new version wanting MORE access is exactly the case that must not
        // be silent — it goes back through consent like a fresh install.
        setPending({ pkg: result.pkg, source: 'registry', publisherKey: pinned });
        return;
      }
      const err = pluginHost.install(result.pkg, entry.granted, { source: 'registry', publisherKey: pinned });
      if (err) { window.alert(err); return; }
      setUpdates((cur) => cur.filter((u) => u.id !== entry.manifest.id));
    } catch (err) {
      window.alert((err as Error).message);
    }
  }, []);

  /**
   * Re-read a plugin from its folder.
   *
   * Skips the consent screen when the new manifest asks for nothing the user
   * has not already granted — which is the normal case while iterating, and the
   * reason installing a work-in-progress plugin was tedious. Anything MORE, a
   * different id, or a package that no longer parses goes through consent (or
   * the errors) exactly as a fresh install does.
   */
  const finishReload = useCallback(async (files: File[]) => {
    const target = reloadingRef.current;
    reloadingRef.current = null;
    if (!target) return;

    const { pkg, errors } = await readPluginFolder(files);
    if (!pkg) { window.alert(`Could not read that folder:\n\n${errors.join('\n')}`); return; }
    if (pkg.manifest.id !== target.manifest.id) {
      window.alert(
        `That folder contains "${pkg.manifest.id}", not "${target.manifest.id}".\n\n`
        + 'Install it from the drop zone instead.',
      );
      return;
    }

    const asksForMore = pkg.manifest.permissions.some((p) => !target.granted.includes(p));
    if (asksForMore) { setPending({ pkg, source: 'folder' }); return; }

    const err = pluginHost.install(pkg, target.granted, { source: 'folder' });
    if (err) window.alert(err);
  }, []);

  if (pending) {
    return (
      <ConsentSheet
        pkg={pending.pkg}
        source={pending.source}
        {...(pending.publisherKey ? { publisherKey: pending.publisherKey } : {})}
        onDone={() => setPending(null)}
      />
    );
  }

  const updateFor = (id: string): RegistryUpdate | undefined => updates.find((u) => u.id === id);

  return (
    <div className={styles.list}>
      <div className={styles.tabs} role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'installed'}
          className={cn(styles.tab, tab === 'installed' && styles.tabActive)}
          onClick={() => setTab('installed')}
        >
          Installed
          {updates.length > 0 && <span className={styles.tabBadge}>{updates.length}</span>}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'browse'}
          className={cn(styles.tab, tab === 'browse' && styles.tabActive)}
          onClick={() => setTab('browse')}
        >
          Browse
        </button>
      </div>

      {tab === 'browse' ? (
        <RegistryBrowser
          onPackage={(pkg, publisherKey) => setPending({ pkg, source: 'registry', publisherKey })}
        />
      ) : (
      <>
      <InstallBar onPackage={(pkg, source) => setPending({ pkg, source })} />

      {/* One picker, reused by every row's Reload. */}
      <input
        ref={reloadRef}
        type="file"
        multiple
        // @ts-expect-error — non-standard but universally supported directory picker
        webkitdirectory=""
        className={styles.hiddenInput}
        onChange={async (e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length) await finishReload(files);
        }}
      />

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
            .map((p) => (
              <PluginRow
                key={p.manifest.id}
                entry={p}
                onReload={(e) => { reloadingRef.current = e; reloadRef.current?.click(); }}
                {...(updateFor(p.manifest.id) ? { update: updateFor(p.manifest.id)! } : {})}
                onUpdate={(e, u) => { void applyUpdate(e, u); }}
              />
            ))}
        </div>
      )}
      </>
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
