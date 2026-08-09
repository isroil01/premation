/**
 * A plugin's page. The ONE place a plugin is inspected and managed.
 *
 * There used to be two. This tab showed the listing (README, screenshots,
 * permissions, versions) and a modal showed the machine's view of the same
 * plugin (status, log, granted permissions, reload). Two managers over one
 * plugin drift, and they drift in the worst possible direction: the modal said
 * what the user had granted, this page said what the manifest asked for, and
 * whichever screen they happened to open decided what they believed was true.
 *
 * So there is one page, and it is a merge of two sources rather than a choice
 * between them:
 *
 *   • The REGISTRY knows the listing — description, README, screenshots, the
 *     latest version, the install count. It may be absent (a folder install, a
 *     withdrawn listing, the whole local edition), and the page still works.
 *   • THIS MACHINE knows whether it is installed, enabled, running, what was
 *     actually granted, and what it has logged. The registry can never know
 *     any of that, and it is what the primary action reflects.
 *
 * Installing from here is NOT a shortcut past consent. The bytes are fetched,
 * the signature is verified against the pinned key, the package goes through
 * the same reader a local file does, and the same per-permission consent screen
 * opens. A "trusted source" path would make the registry a way to skip the one
 * screen that carries the whole security model.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Icon } from '@components/Icon';
import { cn } from '@utils/cn';
import { customAlert, customConfirm } from '@components/Modal/Dialogs';
import { PERMISSIONS, describeContributions, type PluginPermission } from '@core/plugins/manifest';
import {
  fetchRegistryDetail,
  fetchRegistryPackage,
  registryMediaUrl,
  type RegistryDetail,
} from '@core/plugins/registry';
import { readPluginFolder, readPluginZip } from '@core/plugins/pluginPackage';
import { usePluginStore, type InstalledPlugin } from '@stores/pluginStore';
import pluginHost from '@core/plugins/PluginHost';
import { pluginRegistryEnabled } from '@core/config/edition';
import { installFromRegistry, updateFromRegistry } from './installFromRegistry';
import { ConsentSheet, ConsentOverlay } from './ConsentSheet';
import { ReportPluginDialog } from './ReportPluginDialog';
import { ReadmeFrame } from './ReadmeFrame';
import type { PluginPackage } from '@core/plugins/pluginPackage';
import styles from './PluginDetailTab.module.css';

export function PluginDetailTab({ pluginId }: { pluginId: string }): JSX.Element {
  // Re-render when the plugin starts, stops or logs: this page states all three.
  useSyncExternalStore((cb) => pluginHost.subscribe(cb), () => pluginHost.getRevision());

  const [detail, setDetail] = useState<RegistryDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PluginPackage | null>(null);
  const [reporting, setReporting] = useState(false);
  const reloadRef = useRef<HTMLInputElement>(null);
  const installed = usePluginStore((s) => s.get(pluginId));

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void fetchRegistryDetail(pluginId).then((d) => {
      if (!alive) return;
      setDetail(d);
      setLoading(false);
    });
    return () => { alive = false; };
  }, [pluginId]);

  const install = useCallback(async () => {
    if (!detail) return;
    setBusy(true);
    try {
      await installFromRegistry(detail.id, detail.latestVersion, detail.publisherKey);
    } finally {
      setBusy(false);
    }
  }, [detail]);

  /**
   * Take an offered update.
   *
   * The key checked against is the one stored with the INSTALLED copy, never
   * one the registry response nominated — a server that could hand over both
   * the package and the key it should be checked with is a server that can hand
   * over anything.
   */
  const update = useCallback(async () => {
    if (!detail || !installed) return;
    const pinned = installed.publisherKey;
    if (!pinned) {
      void customAlert(
        'No publisher key',
        `"${installed.manifest.name}" was installed from a local file, so there is no publisher key `
        + 'to check an update against. Install it from the registry to get verified updates.',
      );
      return;
    }
    /*
      A signing-key change is handled BEFORE the download, not discovered by it.

      Verifying the new package against the OLD pin fails — correctly — but the
      failure is indistinguishable from a corrupted download, so a user whose
      publisher legitimately rotated would be told their plugin is broken. The
      whole rotation feature would surface as a mysterious verification error.

      `updateFromRegistry` asks the user first, and only then verifies against
      whichever key they decided to trust. Declining leaves the working version
      installed and is not an error.
    */
    if (detail.publisherKey && detail.publisherKey !== pinned) {
      setBusy(true);
      try {
        await updateFromRegistry(
          pluginId,
          detail.latestVersion,
          pinned,
          detail.publisherKey,
          installed.manifest.name,
          detail.sha256,
        );
      } finally {
        setBusy(false);
      }
      return;
    }

    setBusy(true);
    try {
      // The digest from the DETAIL response, not from the download. Both come
      // from the registry today; they stop sharing an origin when package
      // bytes move to object storage, and that is the case this guards.
      const { bytes } = await fetchRegistryPackage(
        pluginId, detail.latestVersion, pinned, detail.sha256,
      );
      const result = readPluginZip(bytes);
      if (!result.pkg) {
        void customAlert('Update package is not readable', result.errors.join('\n'), { isDanger: true });
        return;
      }
      // A new version wanting MORE access is exactly the case that must not be
      // silent — it goes back through consent like a fresh install.
      const asksForMore = result.pkg.manifest.permissions.some((p) => !installed.granted.includes(p));
      if (asksForMore) { setPending(result.pkg); return; }

      const err = pluginHost.install(result.pkg, installed.granted, { source: 'registry', publisherKey: pinned });
      if (err) void customAlert('Could not install update', err, { isDanger: true });
    } catch (err) {
      void customAlert('Update failed', (err as Error).message, { isDanger: true });
    } finally {
      setBusy(false);
    }
  }, [detail, installed, pluginId]);

  /**
   * Re-read the plugin from its folder — the author's edit/run loop.
   *
   * Skips consent when the new manifest asks for nothing already granted, which
   * is the normal case while iterating and the reason this loop used to be
   * tedious. Anything MORE, a different id, or a package that no longer parses
   * goes through consent exactly as a fresh install does.
   */
  const finishReload = useCallback(async (files: File[]) => {
    if (!installed) return;
    const { pkg, errors } = await readPluginFolder(files);
    if (!pkg) { void customAlert('Could not read that folder', errors.join('\n'), { isDanger: true }); return; }
    if (pkg.manifest.id !== installed.manifest.id) {
      void customAlert(
        'Wrong plugin',
        `That folder contains "${pkg.manifest.id}", not "${installed.manifest.id}".`,
      );
      return;
    }
    if (pkg.manifest.permissions.some((p) => !installed.granted.includes(p))) { setPending(pkg); return; }
    const err = pluginHost.install(pkg, installed.granted, { source: 'folder' });
    if (err) void customAlert('Could not reload plugin', err, { isDanger: true });
  }, [installed]);

  const confirmRemove = useCallback(() => {
    if (!installed) return;
    void (async () => {
      const ok = await customConfirm(
        'Uninstall plugin',
        `Uninstall “${installed.manifest.name}”? Anything it added to your project stays.`,
        { confirmLabel: 'Uninstall', isDanger: true },
      );
      if (ok) pluginHost.uninstall(installed.manifest.id);
    })();
  }, [installed]);

  if (loading) {
    // A skeleton, not a spinner: the shape of what is coming is itself
    // information, and a spinner in a full-width pane reads as a stall.
    return (
      <div className={styles.skeleton} aria-busy="true" aria-label="Loading plugin">
        <div className={styles.skelLine} />
        <div className={styles.skelLine} />
        <div className={styles.skelLine} />
        <div className={styles.skelLine} />
      </div>
    );
  }

  // Neither source knows it. The only genuinely empty case.
  if (!detail && !installed) {
    return (
      <div className={styles.state}>
        <span className={styles.stateTitle}>
          {pluginRegistryEnabled()
            ? 'This plugin is no longer in the registry.'
            : "The plugin registry isn't available in this edition."}
        </span>
        <span>
          {pluginRegistryEnabled()
            ? 'It may have been unpublished. An installed copy keeps working.'
            : 'You can still install plugins from a folder or a .zip package.'}
        </span>
      </div>
    );
  }

  const manifest = installed?.manifest ?? null;
  const info = installed ? pluginHost.info(pluginId) : null;
  const behind = !!(installed && detail && installed.manifest.version !== detail.latestVersion);

  // One line per fact, resolved once. Everything below reads these rather than
  // re-deciding which source wins, which is how the two views drifted before.
  const name = detail?.name ?? manifest!.name;
  const description = detail?.description ?? manifest!.description;
  const publisher = detail
    ? (detail.publisher.displayName || detail.publisher.namespace || 'Unknown publisher')
    : (manifest!.author || 'Unknown publisher');
  const version = installed?.manifest.version ?? detail!.latestVersion;
  // The permissions SHOWN are the installed manifest's when there is one: the
  // registry lists what the latest version asks for, which is not what this
  // machine is running.
  const permissions: PluginPermission[] = manifest
    ? [...manifest.permissions]
    : ((detail?.permissions ?? []) as PluginPermission[]);

  return (
    <div className={styles.root}>
      <div className={styles.head}>
        <div className={styles.icon}>
          {registryMediaUrl(detail?.iconUrl ?? null)
            ? <img src={registryMediaUrl(detail!.iconUrl)!} alt="" />
            : <Icon name="plugin" size="lg" />}
        </div>

        <div className={styles.headText}>
          <span className={styles.name}>{name}</span>
          <span className={styles.byline}>
            {publisher}
            {detail?.publisher.verified && (
              <span className={styles.verified} title="Verified publisher">
                <Icon name="success" size="sm" /> Verified
              </span>
            )}
          </span>
          <span className={styles.meta}>
            {version}
            {info && ` · ${statusText(info.status, installed!.enabled)}`}
            {detail && ` · ${detail.installs.toLocaleString()} install${detail.installs === 1 ? '' : 's'}`}
            {detail?.license ? ` · ${detail.license}` : ''}
            {installed?.source === 'folder' ? ' · installed from a folder' : ''}
          </span>
          <span className={styles.desc}>{description}</span>
        </div>

        <div className={styles.actions}>
          {!installed && detail && (
            <button type="button" className={styles.primary} disabled={busy} onClick={() => void install()}>
              {busy ? 'Installing…' : 'Install'}
            </button>
          )}
          {behind && (
            <button type="button" className={styles.primary} disabled={busy} onClick={() => void update()}>
              {busy ? 'Updating…' : `Update to ${detail!.latestVersion}`}
            </button>
          )}
          {installed && manifest!.contributes.panels.length > 0
            && info!.status !== 'stopped' && info!.status !== 'error' && (
            <button
              type="button"
              className={styles.secondary}
              title="Show this plugin's panel in the dock"
              // Offered for an INACTIVE plugin too: opening a panel is one of
              // the things that STARTS one, so greying it out is a dead end.
              onClick={() => { void pluginHost.showPanel(pluginId); }}
            >
              Open Panel
            </button>
          )}
          {installed && (
            <button
              type="button"
              className={styles.secondary}
              onClick={() => pluginHost.setEnabled(pluginId, !installed.enabled)}
            >
              {installed.enabled ? 'Disable' : 'Enable'}
            </button>
          )}
          {installed?.source === 'folder' && (
            <button
              type="button"
              className={styles.secondary}
              title="Re-read this plugin from its folder"
              // The browser still needs a gesture to read a directory, so this
              // opens the picker. What it removes is the consent screen on
              // every single iteration.
              onClick={() => reloadRef.current?.click()}
            >
              Reload
            </button>
          )}
          {installed && (
            <button type="button" className={styles.secondary} onClick={confirmRemove}>
              Uninstall
            </button>
          )}
          {/*
            Offered whether or not it is installed. Someone evaluating a listing
            is often the first to notice it is impersonating another plugin, and
            a report action that only appeared after installing would arrive
            too late to be the thing that stopped them.
          */}
          <button
            type="button"
            className={styles.secondary}
            title="Report this plugin to the registry"
            onClick={() => setReporting(true)}
          >
            Report
          </button>
        </div>
      </div>

      <ReportPluginDialog
        pluginId={pluginId}
        pluginName={name}
        // The version they actually have, so the case is opened against the
        // build that misbehaved rather than against whatever is newest.
        {...(installed?.manifest.version ? { version: installed.manifest.version } : {})}
        open={reporting}
        onClose={() => setReporting(false)}
      />

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

      {detail?.blocked && (
        <div className={styles.blocked}>
          <Icon name="warning" size="md" />
          <span>
            This plugin was withdrawn from the registry
            {detail.blockedReason ? `: ${detail.blockedReason}` : '.'} An installed copy keeps
            working — but it will get no further updates, and it was pulled for a reason.
          </span>
        </div>
      )}

      {info?.error && (
        <div className={styles.blocked}>
          <Icon name="warning" size="md" />
          <span>{info.error}</span>
          <button type="button" className={styles.linkBtn} onClick={() => pluginHost.restart(pluginId)}>
            Restart
          </button>
        </div>
      )}

      {detail && detail.screenshots.length > 0 && (
        <div className={styles.section}>
          <div className={styles.shots}>
            {detail.screenshots.map((shot) => {
              const url = registryMediaUrl(shot.url);
              return url ? (
                <img key={shot.id} className={styles.shot} src={url} alt="" width={shot.width} height={shot.height} />
              ) : null;
            })}
          </div>
        </div>
      )}

      <PermissionSection entry={installed ?? null} requested={permissions} />

      {manifest && (
        <div className={styles.section}>
          <span className={styles.sectionTitle}>What it adds</span>
          <span className={styles.permText}>{describeContributions(manifest.contributes)}</span>
          <ContributionList
            commands={manifest.contributes.commands}
            panels={manifest.contributes.panels}
          />
        </div>
      )}
      {!manifest && detail && (
        (detail.contributesDetail.commands.length > 0 || detail.contributesDetail.panels.length > 0) && (
          <div className={styles.section}>
            <span className={styles.sectionTitle}>What it adds</span>
            <ContributionList
              commands={detail.contributesDetail.commands}
              panels={detail.contributesDetail.panels}
            />
          </div>
        )
      )}

      {installed && <LogSection pluginId={pluginId} />}

      {detail?.readmeHtml && (
        <div className={styles.section}>
          <span className={styles.sectionTitle}>About</span>
          {/*
            Framed, not injected.

            The registry renders this with a construct-only Markdown renderer —
            raw HTML in a README is escaped to text and never interpreted —
            which is the primary control and a strong one. It is also code. A
            bug in it, injected here, would run in the renderer process that
            holds the user's session, their project and the preload bridge; and
            unlike a plugin, a README a user merely BROWSES has been granted
            nothing. So it renders in a sandboxed frame with no same-origin
            access and no network. See `readmeDocument.ts`.
          */}
          <ReadmeFrame html={detail.readmeHtml} />
        </div>
      )}

      {detail?.changelog && (
        <div className={styles.section}>
          <span className={styles.sectionTitle}>Changelog</span>
          <div className={styles.readme}>{detail.changelog}</div>
        </div>
      )}

      {detail && detail.versionHistory.length > 0 && (
        <div className={styles.section}>
          <span className={styles.sectionTitle}>Versions</span>
          <div className={styles.versions}>
            {detail.versionHistory.slice(0, 12).map((v) => (
              <div key={v.version} className={styles.versionRow}>
                <span className={styles.versionNum}>{v.version}</span>
                <span>API {v.apiVersion}</span>
                <span>{Math.round(v.size / 1024)} KB</span>
                <span>{new Date(v.createdAt).toLocaleDateString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {!detail && pluginRegistryEnabled() && (
        <span className={styles.meta}>
          This plugin is not in the registry, so there is no listing to show — only what its
          package declares.
        </span>
      )}
      {!pluginRegistryEnabled() && (
        <span className={styles.meta}>
          Listing details — screenshots, guide, changelog — come from the registry, which this
          edition does not include.
        </span>
      )}

      {pending && (
        <ConsentOverlay>
          <ConsentSheet
            pkg={pending}
            source={installed?.source === 'folder' ? 'folder' : 'registry'}
            {...(installed?.publisherKey ? { publisherKey: installed.publisherKey } : {})}
            onDone={() => setPending(null)}
          />
        </ConsentOverlay>
      )}
    </div>
  );
}

function ContributionList({
  commands,
  panels,
}: {
  commands: ReadonlyArray<{ id: string; label: string; icon?: string }>;
  panels: ReadonlyArray<{ id: string; title: string }>;
}): JSX.Element {
  return (
    <ul className={styles.permList}>
      {commands.map((c) => (
        <li key={c.id} className={styles.permItem}>
          <Icon name={(c.icon as never) ?? 'zap'} size="sm" />
          <span className={styles.permText}>{c.label}</span>
        </li>
      ))}
      {panels.map((p) => (
        <li key={p.id} className={styles.permItem}>
          <Icon name="layout" size="sm" />
          <span className={styles.permText}>{p.title} panel</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * What it may do, and the control to change it.
 *
 * The list describes what was GRANTED once the plugin is installed, not what
 * the manifest asked for. Those became different things the moment consent
 * allowed a partial grant, and a page claiming a plugin can do something the
 * user refused is the exact lie this screen exists to prevent.
 */
function PermissionSection({
  entry,
  requested,
}: {
  entry: InstalledPlugin | null;
  requested: PluginPermission[];
}): JSX.Element {
  const [editing, setEditing] = useState(false);

  return (
    <div className={styles.section}>
      <div className={styles.sectionHead}>
        <span className={styles.sectionTitle}>Permissions</span>
        {entry && requested.length > 0 && (
          <button type="button" className={styles.linkBtn} onClick={() => setEditing((v) => !v)}>
            {editing ? 'Done' : 'Change'}
          </button>
        )}
      </div>

      {requested.length === 0 ? (
        <span className={styles.permText}>This plugin asks for no access to your project.</span>
      ) : (
        <ul className={styles.permList}>
          {requested.map((p) => {
            const withheld = !!entry && !entry.granted.includes(p);
            return (
              <li key={p} className={cn(styles.permItem, withheld && styles.permWithheld)}>
                <Icon name={withheld ? 'eye-off' : 'lock'} size="sm" />
                <span className={styles.permText}>
                  {/* The SAME strings the consent screen uses. Two descriptions
                      of one permission is worse than none: whichever the user
                      read last is the one they think they agreed to. */}
                  <strong>{PERMISSIONS[p]?.label ?? p}.</strong> {PERMISSIONS[p]?.detail ?? ''}
                  {withheld && <em className={styles.withheldTag}> Withheld.</em>}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {entry && entry.granted.length < requested.length && (
        <span className={styles.meta}>
          You granted {entry.granted.length} of {requested.length}. Refused calls are written to
          the plugin&rsquo;s log below.
        </span>
      )}

      {editing && entry && <PermissionEditor entry={entry} onDone={() => setEditing(false)} />}

      <span className={styles.sandboxNote}>
        Plugins run in a sandbox with no access to your account, your sign-in or your
        saved API keys, and no network of their own — only the websites a plugin declares,
        and only if you approve them. Anything a plugin changes in your project is undoable.
      </span>
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
        <button type="button" className={styles.secondary} onClick={onDone}>Cancel</button>
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

/** The plugin's own console output, plus the host's refusals and crashes. */
function LogSection({ pluginId }: { pluginId: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const lines = pluginHost.log(pluginId);
  const endRef = useRef<HTMLDivElement>(null);

  // Optional call, not decoration: `scrollIntoView` is absent in jsdom and in
  // some embedded webviews, and a log viewer that throws while rendering is
  // the least useful thing a log viewer can be.
  useEffect(() => {
    if (open) endRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [lines.length, open]);

  return (
    <div className={styles.section}>
      <div className={styles.sectionHead}>
        <span className={styles.sectionTitle}>Log</span>
        <button type="button" className={styles.linkBtn} onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide' : `Show${lines.length ? ` (${lines.length})` : ''}`}
        </button>
      </div>

      {open && (
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
              <button type="button" className={styles.linkBtn} onClick={() => pluginHost.clearLog(pluginId)}>
                Clear
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Four situations that all look like "not running", resolved four ways.
 *
 * `stopped` used to cover the first three at once, and showing "Disabled" next
 * to a control reading "Enable" is a contradiction the user cannot resolve. The
 * parenthetical on `inactive` is the one lazy activation made necessary:
 * without it, "Inactive" reads as a fault and the user goes looking for the
 * thing to click to fix a plugin that is working exactly as intended.
 */
export function statusText(status: string, enabled: boolean): string {
  if (status === 'running') return 'Running';
  if (status === 'starting') return 'Starting…';
  if (status === 'error') return 'Stopped — see its log';
  if (status === 'inactive') return 'Inactive (starts when used)';
  return enabled ? 'Not running' : 'Disabled';
}
