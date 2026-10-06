/**
 * The plugin store: browse native plugins, read one, install it.
 *
 * Plugins are free and run locally inside the engine (owner decisions,
 * docs/AE_PARITY_PLAN.md step 2). Installing is Electron main's job — it
 * downloads, checks the hash and the publisher signature, and stages the
 * bundle — then the engine rescans and the effects appear in the Effects
 * panel with no restart (docs/PLUGIN_STORE.md §4).
 */

import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@components/Badge';
import { Button } from '@components/Button';
import { Icon } from '@components/Icon';
import { SearchField } from '@components/SearchField';
import { api, type StorePluginDetail, type StorePluginSummary } from '@core/api/client';
import { canInstallFromStore, compareVersions, hostPlatformKeys, runsHere } from '@core/nativePlugins/pluginStore';
import type { InstalledState } from '@hooks/usePluginStore';
import { useStoreBrowse } from '@hooks/usePluginStore';
import styles from './NativePlugins.module.css';

function InstallButton({ plugin, store, owner }: { plugin: StorePluginSummary; store: InstalledState; owner?: boolean }): JSX.Element {
  const here = hostPlatformKeys();
  const mine = store.installed?.plugins[plugin.id];
  const busy = store.busy === plugin.id;
  if (!canInstallFromStore()) return <span className={styles.status}>Desktop app only</span>;
  if (here && !runsHere(plugin.platforms, here)) {
    return <span className={styles.status} title={`Ships for: ${plugin.platforms.join(', ') || 'no platform'}`}>Not for this computer</span>;
  }
  if (mine && compareVersions(mine.version, plugin.latestVersion) >= 0) {
    return <span className={styles.statusLoaded}>{mine.pending ? 'Restart to finish' : 'Installed'}</span>;
  }
  return (
    <Button
      size="sm"
      variant={mine ? 'secondary' : 'primary'}
      disabled={busy || store.busy !== null}
      onClick={() => void store.install(plugin.id, plugin.latestVersion, owner)}
    >
      {busy ? 'Installing…' : mine ? `Update to ${plugin.latestVersion}` : 'Install'}
    </Button>
  );
}

function PublisherLine({ plugin }: { plugin: StorePluginSummary }): JSX.Element {
  const name = plugin.publisher.displayName || plugin.publisher.namespace;
  return (
    <span className={styles.rowMeta}>
      {[`v${plugin.latestVersion}`, name || null].filter(Boolean).join(' · ')}
      {plugin.publisher.verified ? (
        <Badge variant="success" size="sm" className={styles.inlineBadge}>Verified</Badge>
      ) : null}
      {plugin.visibility === 'private' ? <Badge variant="neutral" size="sm" className={styles.inlineBadge}>Private</Badge> : null}
    </span>
  );
}

export function StorePluginDetailCard({
  id,
  owner,
  store,
  onBack,
}: {
  id: string;
  owner?: boolean;
  store: InstalledState;
  onBack: () => void;
}): JSX.Element {
  const [detail, setDetail] = useState<StorePluginDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    (owner ? api.myPluginDetail(id) : api.storePluginDetail(id))
      .then((d) => { if (alive) setDetail(d); })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : 'Could not load the plugin.'); });
    return () => { alive = false; };
  }, [id, owner]);

  return (
    <section className={styles.card} aria-label="Plugin details">
      <div className={styles.toolbar}>
        <Button variant="ghost" size="sm" leftIcon={<Icon name="chevron-left" size="sm" />} onClick={onBack}>
          All plugins
        </Button>
      </div>
      {error ? <span className={styles.error} role="alert">{error}</span> : null}
      {!detail && !error ? <span className={styles.text} role="status">Loading…</span> : null}
      {detail ? (
        <>
          <div className={styles.toolbar}>
            <div className={styles.rowBody}>
              <h3 className={styles.cardTitle}>{detail.name}</h3>
              <PublisherLine plugin={detail} />
            </div>
            <span className={styles.spacer} />
            <InstallButton plugin={detail} store={store} owner={owner} />
          </div>
          {detail.blocked ? (
            <span className={styles.error} role="alert">Withdrawn{detail.blockedReason ? `: ${detail.blockedReason}` : ''}</span>
          ) : null}
          <p className={styles.text}>{detail.description}</p>
          <dl className={styles.facts}>
            <dt>Effects</dt>
            <dd>{detail.effects.map((e) => e.name).join(', ') || '—'}</dd>
            <dt>Runs on</dt>
            <dd>{detail.platforms.join(', ') || '—'}</dd>
            <dt>Built for SDK</dt>
            <dd>{detail.sdk ? `${detail.sdk.major}.${detail.sdk.minor}` : '—'}</dd>
            <dt>Licence</dt>
            <dd>{detail.license ?? '—'} · free</dd>
            {detail.homepage ? (
              <>
                <dt>Homepage</dt>
                <dd className={styles.path}>{detail.homepage}</dd>
              </>
            ) : null}
            <dt>Versions</dt>
            <dd>{(detail.versionHistory ?? []).map((v) => v.version).join(', ') || detail.latestVersion}</dd>
          </dl>
          <p className={styles.text}>
            Plugins run inside the Premation engine on this computer, with the same access as Premation itself.
            The package is checked against the publisher&apos;s signature before it is installed.
          </p>
        </>
      ) : null}
    </section>
  );
}

export function PluginStoreBrowser({ store }: { store: InstalledState }): JSX.Element {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const browse = useStoreBrowse(q);
  const here = useMemo(() => hostPlatformKeys(), []);

  if (open) return <StorePluginDetailCard id={open} store={store} onBack={() => setOpen(null)} />;
  return (
    <section className={styles.card} aria-label="Plugin store">
      <div className={styles.toolbar}>
        <h3 className={styles.cardTitle}>Plugin store</h3>
        <span className={styles.spacer} />
        <Button variant="ghost" size="sm" leftIcon={<Icon name="refresh" size="sm" />} disabled={browse.loading} onClick={browse.reload}>
          Refresh
        </Button>
      </div>
      <SearchField value={q} onChange={setQ} placeholder="Search plugins" ariaLabel="Search the plugin store" debounceMs={250} fullWidth />
      {browse.error ? <span className={styles.error} role="alert">{browse.error}</span> : null}
      {browse.items && browse.items.length === 0 ? (
        <div className={styles.empty} role="status">
          <strong>{q ? 'No plugins match' : 'No plugins yet'}</strong>
          <span>Publish one with the SDK — see docs/PLUGIN_SDK.md.</span>
        </div>
      ) : null}
      {browse.items && browse.items.length > 0 ? (
        <ul className={styles.list} aria-label="Store plugins">
          {browse.items.map((p) => (
            <li key={p.id} className={styles.row}>
              <Icon name="plugin" size="sm" className={styles.rowIcon} />
              <button type="button" className={styles.rowOpen} onClick={() => setOpen(p.id)} aria-label={`About ${p.name}`}>
                <span className={styles.rowName} title={p.name}>{p.name}</span>
                <PublisherLine plugin={p} />
                <span className={styles.rowMeta}>
                  {p.description}
                  {here && !runsHere(p.platforms, here) ? ' — not available for this computer' : ''}
                </span>
              </button>
              <InstallButton plugin={p} store={store} />
            </li>
          ))}
        </ul>
      ) : null}
      {!browse.items && !browse.error ? <span className={styles.text} role="status">Asking the store…</span> : null}
    </section>
  );
}
