/**
 * The plugin store: browse native plugins, read one, install it.
 *
 * Built to be read before anything is installed: a Free account cannot run a
 * Premation Cloud plugin, so the card and the page have to show what it does —
 * cover image, icon, screenshots, About, what changed in each version — and
 * say plainly that it comes with Premation Cloud, with the way to get it.
 *
 * Installing is Electron main's job — it downloads, checks the hash and the
 * publisher signature, and stages the bundle — then the engine rescans and the
 * effects appear in the Effects panel with no restart (docs/PLUGIN_STORE.md §4).
 */

import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Badge } from '@components/Badge';
import { Button } from '@components/Button';
import { Dropdown } from '@components/Dropdown';
import { Icon } from '@components/Icon';
import { Modal } from '@components/Modal';
import { SearchField } from '@components/SearchField';
import {
  api,
  storeMediaUrl,
  type StorePluginDetail,
  type StorePluginSummary,
  type StorePluginVersion,
} from '@core/api/client';
import { billingEnabled, cloudProjectsEnabled } from '@core/config/edition';
import { canInstallFromStore, compareVersions, hostPlatformKeys, runsHere } from '@core/nativePlugins/pluginStore';
import type { InstalledState, StoreSort } from '@hooks/usePluginStore';
import { useStoreBrowse } from '@hooks/usePluginStore';
import { useCachedQuery } from '@hooks/useCachedQuery';
import { useCloudOffer, useCloudTrialDays } from '@hooks/useCloudOffer';
import { useProSalesOpen } from '@hooks/useProSalesOpen';
import { useEntitlementStore } from '@stores/entitlementStore';
import { PluginIcon } from './PluginIcon';
import { PluginListingEditor } from './PluginListingEditor';
import styles from './NativePlugins.module.css';
import { t } from '@core/i18n';

/**
 * Whether this account can run Premation Cloud plugins: true / false once the
 * server's decision is cached, null while unknown (signed out, local edition,
 * not fetched yet) — unknown never hides the Install button; the store's 402
 * still answers for it.
 */
export function useHasCloudPlugins(): boolean | null {
  const access = useEntitlementStore((s) => s.access);
  const refresh = useEntitlementStore((s) => s.refresh);
  useEffect(() => {
    if (!access) void refresh();
  }, [access, refresh]);
  if (!billingEnabled() || !access) return null;
  return access.plan === 'pro';
}

/**
 * Billing lives on the dashboard, which only the cloud edition registers.
 * Through the hash (AppRouter is a HashRouter) so the store also works where it
 * is rendered outside a router.
 */
export function useOpenBilling(): (() => void) | null {
  if (!billingEnabled() || !cloudProjectsEnabled()) return null;
  return () => { window.location.hash = '#/dashboard?tab=billing'; };
}

export function TierBadge({ plugin }: { plugin: StorePluginSummary }): JSX.Element {
  return plugin.tier === 'cloud' ? (
    <Badge variant="accent" size="sm" className={styles.inlineBadge}>Premation Cloud</Badge>
  ) : (
    <Badge variant="neutral" size="sm" className={styles.inlineBadge}>{t('plugins.store.free', 'Free')}</Badge>
  );
}

export function InstallButton({
  plugin,
  store,
  owner,
  hasCloud,
}: {
  plugin: StorePluginSummary;
  store: InstalledState;
  owner?: boolean;
  hasCloud: boolean | null;
}): JSX.Element {
  const openBilling = useOpenBilling();
  const here = hostPlatformKeys();
  const mine = store.installed?.plugins[plugin.id];
  const busy = store.busy === plugin.id;
  if (!canInstallFromStore()) return <span className={styles.status}>{t('plugins.store.desktopOnly', 'Desktop app only')}</span>;
  if (here && !runsHere(plugin.platforms, here)) {
    return (
      <span
        className={styles.status}
        title={t('plugins.store.shipsFor', 'Ships for: {platforms}', {
          platforms: plugin.platforms.join(', ') || t('plugins.store.noPlatform', 'no platform'),
        })}
      >
        {t('plugins.store.notForThisComputer', 'Not for this computer')}
      </span>
    );
  }
  if (mine && compareVersions(mine.version, plugin.latestVersion) >= 0) {
    return <span className={styles.statusLoaded}>{mine.pending ? t('plugins.store.restartToFinish', 'Restart to finish') : t('plugins.store.installed', 'Installed')}</span>;
  }
  // The publisher can always install their own; anyone else on Free is shown the way to get it.
  if (plugin.tier === 'cloud' && hasCloud === false && !owner) {
    return openBilling ? (
      <Button size="sm" variant="primary" leftIcon={<Icon name="lock" size="sm" />} onClick={openBilling}>
        {t('plugins.store.getCloud', 'Get Premation Cloud')}
      </Button>
    ) : (
      <span className={styles.status}>Premation Cloud</span>
    );
  }
  return (
    <Button
      size="sm"
      variant={mine ? 'secondary' : 'primary'}
      disabled={busy || store.busy !== null}
      onClick={() => void store.install(plugin.id, plugin.latestVersion, owner)}
    >
      {busy
        ? t('plugins.store.installing', 'Installing…')
        : mine
          ? t('plugins.store.updateTo', 'Update to {version}', { version: plugin.latestVersion })
          : t('plugins.store.install', 'Install')}
    </Button>
  );
}

export function PublisherLine({ plugin }: { plugin: StorePluginSummary }): JSX.Element {
  const name = plugin.publisher.displayName || plugin.publisher.namespace;
  return (
    <span className={styles.rowMeta}>
      {[name || null, `v${plugin.latestVersion}`, plugin.installs ? t('plugins.store.installs', '{n} installs', { n: plugin.installs.toLocaleString() }) : null]
        .filter(Boolean)
        .join(' · ')}
      {plugin.publisher.verified ? (
        <Badge variant="success" size="sm" className={styles.inlineBadge}>{t('plugins.store.verified', 'Verified')}</Badge>
      ) : null}
      {plugin.visibility === 'private' ? <Badge variant="neutral" size="sm" className={styles.inlineBadge}>{t('plugins.store.private', 'Private')}</Badge> : null}
    </span>
  );
}

/** Why Premation Cloud, on a Cloud plugin's page — shown to anyone who does not have it yet. */
export function CloudPitch({ plugin }: { plugin: StorePluginSummary }): JSX.Element {
  const openBilling = useOpenBilling();
  const salesOpen = useProSalesOpen();
  const offerLine = useCloudOffer();
  const trialDays = useCloudTrialDays();
  return (
    <div className={styles.pitch}>
      <Icon name="sparkles" size="md" className={styles.pitchIcon} />
      <div className={styles.pitchBody}>
        <strong>{t('plugins.store.comesWithCloud', '{name} comes with Premation Cloud', { name: plugin.name })}</strong>
        <span>
          {t(
            'plugins.store.cloudPitch',
            'Premation Cloud includes every Premation plugin, the full Library, unlimited cloud projects and 90 days of version history. Plugins run on your computer; you keep your projects if you stop.',
          )}
        </span>
        {openBilling && salesOpen && offerLine ? <span>{offerLine}</span> : null}
      </div>
      {openBilling ? (
        <Button size="sm" variant="primary" onClick={openBilling}>
          {salesOpen && trialDays > 0
            ? t('plugins.store.startTrial', 'Try it free')
            : t('plugins.store.seePlans', 'See plans')}
        </Button>
      ) : null}
    </div>
  );
}

export function Gallery({ shots, name }: { shots: NonNullable<StorePluginDetail['screenshots']>; name: string }): JSX.Element | null {
  const [active, setActive] = useState(0);
  const [zoom, setZoom] = useState(false);
  const current = shots[Math.min(active, shots.length - 1)];
  if (!current) return null;
  const src = storeMediaUrl(current.url) ?? '';
  return (
    <div className={styles.gallery}>
      <button type="button" className={styles.galleryMain} onClick={() => setZoom(true)} aria-label={t('plugins.store.enlargeScreenshot', 'Enlarge screenshot {n} of {name}', { n: active + 1, name })}>
        <img src={src} alt={t('plugins.store.screenshotOf', '{name} — screenshot {n}', { name, n: active + 1 })} />
      </button>
      {shots.length > 1 ? (
        <div className={styles.galleryThumbs} role="tablist" aria-label={t('plugins.store.screenshots', 'Screenshots')}>
          {shots.map((s, i) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={i === active}
              className={i === active ? styles.galleryThumbActive : styles.galleryThumb}
              onClick={() => setActive(i)}
            >
              <img src={storeMediaUrl(s.url) ?? ''} alt={t('plugins.store.screenshotN', 'Screenshot {n}', { n: i + 1 })} />
            </button>
          ))}
        </div>
      ) : null}
      <Modal open={zoom} onClose={() => setZoom(false)} size="fullscreen" title={name}>
        <img className={styles.galleryZoom} src={src} alt={t('plugins.store.screenshotOf', '{name} — screenshot {n}', { name, n: active + 1 })} />
      </Modal>
    </div>
  );
}

export function ReleaseNotes({ text }: { text: string }): JSX.Element {
  return (
    <div className={styles.markdown}>
      <ReactMarkdown>{text}</ReactMarkdown>
    </div>
  );
}

export function Versions({ versions, owner }: { versions: StorePluginVersion[]; owner?: boolean }): JSX.Element | null {
  if (versions.length === 0) return null;
  return (
    <ul className={styles.versions} aria-label={t('plugins.store.versions', 'Versions')}>
      {versions.map((v, i) => (
        <li key={v.version}>
          <details open={i === 0 && !!v.releaseNotes}>
            <summary>
              <span className={styles.versionName}>v{v.version}</span>
              <span className={styles.rowMeta}>{new Date(v.createdAt).toLocaleDateString()}</span>
              {owner && v.reviewStatus && v.reviewStatus !== 'approved' ? (
                <Badge variant="warning" size="sm" className={styles.inlineBadge}>{v.reviewStatus.replace('_', ' ')}</Badge>
              ) : null}
            </summary>
            {v.releaseNotes ? <ReleaseNotes text={v.releaseNotes} /> : <span className={styles.text}>{t('plugins.store.noReleaseNotes', 'No release notes.')}</span>}
          </details>
        </li>
      ))}
    </ul>
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
  // Remembered per plugin, so going back to a listing shows it at once; the
  // publisher's edits invalidate `plugins`, which refetches it.
  const query = useCachedQuery<StorePluginDetail>(
    `plugins:detail:${owner ? 'mine' : 'store'}:${id}`,
    () => (owner ? api.myPluginDetail(id) : api.storePluginDetail(id)),
    { tags: ['plugins'] },
  );
  const detail = query.data ?? null;
  const error = detail ? null : query.error;
  const hasCloud = useHasCloudPlugins();

  const versions = detail?.versionHistory ?? [];
  const shots = (detail?.screenshots ?? []).slice(0, 3);
  const about = detail?.readme?.trim() || '';

  return (
    <section className={styles.card} aria-label={t('plugins.store.detailsAria', 'Plugin details')}>
      <div className={styles.toolbar}>
        <Button variant="ghost" size="sm" leftIcon={<Icon name="chevron-left" size="sm" />} onClick={onBack}>
          {t('plugins.store.allPlugins', 'All plugins')}
        </Button>
      </div>
      {error ? <span className={styles.error} role="alert">{error}</span> : null}
      {!detail && !error ? <span className={styles.text} role="status">{t('plugins.store.loading', 'Loading…')}</span> : null}
      {detail ? (
        <>
          <div className={styles.detailHead}>
            <PluginIcon plugin={detail} size={64} />
            <div className={styles.rowBody}>
              <h3 className={styles.detailTitle}>
                {detail.name}
                <TierBadge plugin={detail} />
              </h3>
              <PublisherLine plugin={detail} />
              <p className={styles.text}>{detail.description}</p>
            </div>
            <InstallButton plugin={detail} store={store} owner={owner} hasCloud={hasCloud} />
          </div>
          {detail.blocked ? (
            <span className={styles.error} role="alert">
              {detail.blockedReason
                ? t('plugins.store.withdrawnReason', 'Withdrawn: {reason}', { reason: detail.blockedReason })
                : t('plugins.store.withdrawn', 'Withdrawn')}
            </span>
          ) : null}
          {detail.tier === 'cloud' && hasCloud !== true && !owner ? <CloudPitch plugin={detail} /> : null}

          <Gallery shots={shots} name={detail.name} />

          {detail.whatsNew ? (
            <div className={styles.section}>
              <h4 className={styles.sectionTitle}>{t('plugins.store.whatsNew', 'What\'s new in v{version}', { version: detail.whatsNew.version })}</h4>
              <ReleaseNotes text={detail.whatsNew.releaseNotes} />
            </div>
          ) : null}

          {about ? (
            <div className={styles.section}>
              <h4 className={styles.sectionTitle}>{t('plugins.store.about', 'About')}</h4>
              <div className={styles.markdown}>
                <ReactMarkdown>{about}</ReactMarkdown>
              </div>
            </div>
          ) : null}

          {detail.effects.length > 0 ? (
            <div className={styles.section}>
              <h4 className={styles.sectionTitle}>{t('plugins.store.whatItAdds', 'What it adds')}</h4>
              <div className={styles.chips}>
                {detail.effects.map((e) => (
                  <span key={e.matchName} className={styles.chip} title={e.category}>{e.name}</span>
                ))}
              </div>
            </div>
          ) : null}

          <div className={styles.section}>
            <h4 className={styles.sectionTitle}>{t('plugins.store.details', 'Details')}</h4>
            <dl className={styles.facts}>
              <dt>{t('plugins.store.runsOn', 'Runs on')}</dt>
              <dd>{detail.platforms.join(', ') || '—'}</dd>
              <dt>{t('plugins.store.builtForSdk', 'Built for SDK')}</dt>
              <dd>{detail.sdk ? `${detail.sdk.major}.${detail.sdk.minor}` : '—'}</dd>
              <dt>{t('plugins.store.price', 'Price')}</dt>
              <dd>{detail.tier === 'cloud' ? t('plugins.store.includedWithCloud', 'Included with Premation Cloud') : t('plugins.store.free', 'Free')}</dd>
              <dt>{t('plugins.store.licence', 'Licence')}</dt>
              <dd>{detail.license ?? '—'}</dd>
              {detail.categories.length > 0 ? (
                <>
                  <dt>{t('plugins.store.categories', 'Categories')}</dt>
                  <dd>{detail.categories.join(', ')}</dd>
                </>
              ) : null}
              {detail.homepage ? (
                <>
                  <dt>{t('plugins.store.homepage', 'Homepage')}</dt>
                  <dd className={styles.path}>{detail.homepage}</dd>
                </>
              ) : null}
              <dt>{t('plugins.store.updated', 'Updated')}</dt>
              <dd>{new Date(detail.updatedAt).toLocaleDateString()}</dd>
            </dl>
          </div>

          <div className={styles.section}>
            <h4 className={styles.sectionTitle}>{t('plugins.store.versions', 'Versions')}</h4>
            <Versions versions={versions} owner={owner} />
            {versions.length === 0 ? <span className={styles.text}>v{detail.latestVersion}</span> : null}
            {detail.changelog?.trim() && !versions.some((v) => v.releaseNotes) ? (
              <pre className={styles.changelog}>{detail.changelog}</pre>
            ) : null}
          </div>

          {owner ? <PluginListingEditor detail={detail} onChanged={() => void query.reload()} /> : null}

          <p className={styles.text}>
            {t(
              'plugins.store.safetyNote',
              'Plugins run inside the Premation engine on this computer, with the same access as Premation itself. The package is checked against the publisher\'s signature before it is installed.',
            )}
          </p>
        </>
      ) : null}
    </section>
  );
}

function PluginCard({
  plugin,
  store,
  owner,
  hasCloud,
  onOpen,
}: {
  plugin: StorePluginSummary;
  store: InstalledState;
  owner: boolean;
  hasCloud: boolean | null;
  onOpen: () => void;
}): JSX.Element {
  const here = hostPlatformKeys();
  const cover = storeMediaUrl(plugin.coverUrl);
  return (
    <li className={styles.storeCard}>
      <button type="button" className={styles.storeCardOpen} onClick={onOpen} aria-label={t('plugins.store.aboutPlugin', 'About {name}', { name: plugin.name })}>
        <span className={styles.storeCover}>
          {cover ? <img src={cover} alt="" loading="lazy" /> : <PluginIcon plugin={plugin} size={56} />}
        </span>
        <span className={styles.storeCardHead}>
          <PluginIcon plugin={plugin} size={32} />
          <span className={styles.rowBody}>
            <span className={styles.rowName} title={plugin.name}>{plugin.name}</span>
            <PublisherLine plugin={plugin} />
          </span>
        </span>
        <span className={styles.storeCardText}>
          {plugin.description}
          {here && !runsHere(plugin.platforms, here) ? t('plugins.store.notAvailableSuffix', ' — not available for this computer') : ''}
        </span>
      </button>
      <span className={styles.storeCardFoot}>
        <TierBadge plugin={plugin} />
        <span className={styles.spacer} />
        <InstallButton plugin={plugin} store={store} owner={owner} hasCloud={hasCloud} />
      </span>
    </li>
  );
}

export const SORT_KEYS: readonly StoreSort[] = ['installs', 'new', 'updated'];

export function sortLabel(sort: StoreSort): string {
  switch (sort) {
    case 'installs': return t('plugins.store.sortInstalls', 'Most installed');
    case 'new': return t('plugins.store.sortNew', 'Newest');
    case 'updated': return t('plugins.store.sortUpdated', 'Recently updated');
  }
}

export function PluginStoreBrowser({ store }: { store: InstalledState }): JSX.Element {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [tier, setTier] = useState<'all' | 'free' | 'cloud'>('all');
  // The whole catalogue is listed with no search; sorting orders it, searching narrows it.
  const [sort, setSort] = useState<StoreSort>('installs');
  const browse = useStoreBrowse(q, sort);
  const hasCloud = useHasCloudPlugins();
  const items = useMemo(
    () => (browse.items ?? []).filter((p) => tier === 'all' || p.tier === tier),
    [browse.items, tier],
  );

  // The publisher's own private plugins (listed from `/plugins/mine`) read and install as the owner.
  if (open) return <StorePluginDetailCard id={open} owner={browse.owned.has(open)} store={store} onBack={() => setOpen(null)} />;
  return (
    <section className={styles.card} aria-label={t('plugins.store.title', 'Plugin store')}>
      <div className={styles.toolbar}>
        <h3 className={styles.cardTitle}>{t('plugins.store.title', 'Plugin store')}</h3>
        <span className={styles.spacer} />
        <Button variant="ghost" size="sm" leftIcon={<Icon name="refresh" size="sm" />} disabled={browse.loading} onClick={browse.reload}>
          {t('plugins.store.refresh', 'Refresh')}
        </Button>
      </div>
      <div className={styles.toolbar}>
        <div className={styles.grow}>
          <SearchField value={q} onChange={setQ} placeholder={t('plugins.store.searchPlaceholder', 'Search plugins')} ariaLabel={t('plugins.store.searchAria', 'Search the plugin store')} debounceMs={250} fullWidth />
        </div>
        <div className={styles.filterChips} role="group" aria-label={t('plugins.store.price', 'Price')}>
          {(['all', 'free', 'cloud'] as const).map((key) => (
            <button
              key={key}
              type="button"
              className={tier === key ? styles.filterChipActive : styles.filterChip}
              aria-pressed={tier === key}
              onClick={() => setTier(key)}
            >
              {key === 'all' ? t('plugins.store.all', 'All') : key === 'free' ? t('plugins.store.free', 'Free') : 'Premation Cloud'}
            </button>
          ))}
        </div>
        <Dropdown
          placement="bottom-end"
          trigger={
            <Button variant="ghost" size="sm" rightIcon={<Icon name="chevron-down" size="sm" />} aria-label={t('plugins.store.sortAria', 'Sort: {sort}', { sort: sortLabel(sort) })}>
              {sortLabel(sort)}
            </Button>
          }
          items={SORT_KEYS.map((s) => ({
            type: 'checkbox' as const,
            id: s,
            label: sortLabel(s),
            checked: sort === s,
            onChange: () => setSort(s),
          }))}
        />
      </div>
      {browse.error ? <span className={styles.error} role="alert">{browse.error}</span> : null}
      {browse.items && items.length === 0 ? (
        <div className={styles.empty} role="status">
          <strong>{q || tier !== 'all' ? t('plugins.store.noMatch', 'No plugins match') : t('plugins.store.noneYet', 'No plugins yet')}</strong>
          <span>{t('plugins.store.publishHint', 'Publish one with the SDK — see docs/PLUGIN_SDK.md.')}</span>
        </div>
      ) : null}
      {items.length > 0 ? (
        <ul className={styles.storeGrid} aria-label={t('plugins.store.gridAria', 'Store plugins')}>
          {items.map((p) => (
            <PluginCard
              key={p.id}
              plugin={p}
              store={store}
              owner={browse.owned.has(p.id)}
              hasCloud={hasCloud}
              onOpen={() => setOpen(p.id)}
            />
          ))}
        </ul>
      ) : null}
      {!browse.items && !browse.error ? <span className={styles.text} role="status">{t('plugins.store.asking', 'Asking the store…')}</span> : null}
    </section>
  );
}
