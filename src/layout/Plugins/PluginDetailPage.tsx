/**
 * A plugin's page, a closable tab of the main body (EditorTabs, "Plugin:
 * <name>") — owner-approved mockup board 1 (2026-11-03), after VS Code's
 * extension page, drawn in the editor's own panel grammar:
 *
 *   [icon] Name  1.2.0
 *          Publisher ✓ · 12,400 installs · Premation Cloud
 *          One line of what it does.
 *          [Update] [Disable] [Uninstall]
 *   Details | Effects 3 | Presets 12 | Panels 1 | Changelog       Installation
 *   ...                                                           Version 1.2.0 …
 *
 * Works for a plugin the store lists (installed or not) and for one copied
 * into the plugins folder by hand (the manifest's facts only). Its effects and
 * presets apply to the selected layers from here; its panels can be shown as a
 * sidebar tab or opened.
 */

import { useMemo, useState, useSyncExternalStore, type DragEvent, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import { Button } from '@components/Button';
import { Checkbox } from '@components/Checkbox';
import { Icon, type IconName } from '@components/Icon';
import { api, type StorePluginDetail } from '@core/api/client';
import { cloudProjectsEnabled } from '@core/config/edition';
import { setCanvasDrag } from '@core/dnd/canvasDrag';
import { pluginEngine } from '@core/engine/engineInstance';
import {
  pluginEffectDefs,
  pluginEffectDefsRevision,
  subscribePluginEffectDefs,
} from '@core/inspector/pluginEffectDefs';
import {
  pluginContribRevision,
  pluginPanels,
  refreshPluginContrib,
  subscribePluginContrib,
} from '@core/nativePlugins/pluginContrib';
import { pluginPresets, subscribePluginPresets } from '@core/nativePlugins/pluginPresets';
import {
  canOpenNativePluginFolder,
  nativePluginStatusLabel,
  openNativePluginFolder,
  type NativePlugin,
} from '@core/nativePlugins/nativePlugins';
import { useCachedQuery } from '@hooks/useCachedQuery';
import { useInstalledPlugins, type InstalledState } from '@hooks/usePluginStore';
import { pluginIconUrl } from './pluginIcons';
import { useAllEffectDefs } from '@layout/Effects/effectCatalog';
import { useLayoutStore } from '@stores/layoutStore';
import { cn } from '@utils/cn';
import { applyPluginEffect, applyPluginPreset, useEnginePlugins } from './pluginActions';
import { pluginPanelTitle } from './pluginDockRules';
import { isCloudPlugin, pluginContents, pluginStatusWord, type PluginContents } from './pluginPanelRows';
import { PluginIcon } from './PluginIcon';
import { CloudPitch, Gallery, InstallButton, ReleaseNotes, Versions, useHasCloudPlugins } from './PluginStore';
import { StoreMessageLine } from './StoreMessageLine';
import styles from './PluginDetailPage.module.css';
import { t } from '@core/i18n';

type SubTab = 'details' | 'effects' | 'presets' | 'panels' | 'changelog';

interface StoreDetailState {
  detail: StorePluginDetail | null;
  /** True while the store has not answered (and has not failed). */
  loading: boolean;
}

/** The store's page for the plugin, asked only where the store exists. */
function WithStoreDetail({ id, owner, children }: { id: string; owner?: boolean; children: (s: StoreDetailState) => ReactNode }): JSX.Element {
  // The same key as the store's own detail card: one cache entry per plugin.
  const query = useCachedQuery<StorePluginDetail>(
    `plugins:detail:${owner ? 'mine' : 'store'}:${id}`,
    () => (owner ? api.myPluginDetail(id) : api.storePluginDetail(id)),
    { tags: ['plugins'] },
  );
  return <>{children({ detail: query.data ?? null, loading: !query.data && !query.error })}</>;
}

/** Every panel id docked on a side (the dock's `panelOrder`). */
function useDocked(): ReadonlySet<string> {
  const order = useLayoutStore((s) => s.panelOrder);
  return useMemo(() => {
    const out = new Set<string>();
    for (const list of Object.values(order) as Array<ReadonlyArray<string> | undefined>) for (const id of list ?? []) out.add(id);
    return out;
  }, [order]);
}

function usePluginContents(id: string): PluginContents {
  const effectsRevision = useSyncExternalStore(subscribePluginEffectDefs, pluginEffectDefsRevision, pluginEffectDefsRevision);
  const presets = useSyncExternalStore(subscribePluginPresets, pluginPresets, pluginPresets);
  const contribRevision = useSyncExternalStore(subscribePluginContrib, pluginContribRevision, pluginContribRevision);
  return useMemo(
    () => pluginContents(id, { effects: pluginEffectDefs(), presets, panels: pluginPanels() }),
    // The effect defs and panels are read through their revisions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id, effectsRevision, presets, contribRevision],
  );
}

function formatDate(iso: string | number | undefined): string | null {
  if (iso === undefined || iso === '') return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString();
}

/** The buttons under the description, for what this plugin is here and now. */
function Actions({
  id,
  plugin,
  detail,
  store,
  owner,
  hasCloud,
}: {
  id: string;
  plugin: NativePlugin | undefined;
  detail: StorePluginDetail | null;
  store: InstalledState;
  owner?: boolean;
  hasCloud: boolean | null;
}): JSX.Element | null {
  const mine = store.installed?.plugins[id];
  const queued = store.installed?.uninstall.includes(id) ?? false;
  const update = store.updates.get(id);
  const busy = store.busy !== null;
  if (!plugin && !mine) {
    // Not on this computer: the store's own Install (plan, platform and desktop checks included).
    return detail ? <InstallButton plugin={detail} store={store} owner={owner} hasCloud={hasCloud} /> : null;
  }
  if (queued) return <span className={styles.stateNote}>{t('plugins.list.removedOnRestart', 'Removed on restart')}</span>;
  const buttons: JSX.Element[] = [];
  if (mine?.pending) {
    buttons.push(<span key="pending" className={styles.stateNote}>{t('plugins.store.restartToFinish', 'Restart to finish')}</span>);
  } else if (update) {
    buttons.push(
      <Button key="update" size="sm" variant="primary" disabled={busy} onClick={() => void store.install(id, update.latestVersion)}>
        {store.busy === id ? t('plugins.store.installing', 'Installing…') : t('plugins.store.updateTo', 'Update to {version}', { version: update.latestVersion })}
      </Button>,
    );
  }
  if (plugin?.status === 'locked') {
    buttons.push(
      <Button key="plan" size="sm" variant="secondary" disabled={busy} onClick={() => void store.checkPlan()}>
        {t('plugins.list.checkPlan', 'Check plan')}
      </Button>,
    );
  } else if (plugin && plugin.status !== 'revoked') {
    const enabled = plugin.status !== 'disabled';
    buttons.push(
      <Button
        key="enable"
        size="sm"
        variant={enabled ? 'secondary' : 'primary'}
        disabled={busy || plugin.status === 'failed'}
        onClick={() => void store.setEnabled(id, !enabled)}
      >
        {enabled ? t('plugins.panel.disable', 'Disable') : t('plugins.panel.enable', 'Enable')}
      </Button>,
    );
  }
  // SDK 1.4 (X2): where an effect plugin runs — its own process (a crash there never ends the engine) or the engine.
  if (plugin && plugin.status === 'loaded' && plugin.effects.length > 0) {
    buttons.push(
      <select
        key="isolation"
        className={styles.isolation}
        value={plugin.isolationPin || 'auto'}
        disabled={busy}
        title={plugin.isolation === 'process'
          ? t('plugins.page.runsInProcess', 'Runs in its own process: a crash there never ends the engine.')
          : t('plugins.page.runsInEngine', 'Runs inside the engine (GPU path, overlays, every SDK feature).')}
        aria-label={t('plugins.page.isolation', 'Where this plugin runs')}
        onChange={(e) => void store.setIsolation(id, e.currentTarget.value as 'auto' | 'process' | 'engine')}
      >
        <option value="auto">{t('plugins.page.isolationAuto', 'Auto')}</option>
        <option value="process">{t('plugins.page.isolationProcess', 'Own process')}</option>
        <option value="engine">{t('plugins.page.isolationEngine', 'In the engine')}</option>
      </select>,
    );
  }
  if (mine) {
    buttons.push(
      <Button key="uninstall" size="sm" variant="secondary" disabled={busy} onClick={() => void store.uninstall(id)}>
        {t('plugins.sidebar.uninstall', 'Uninstall')}
      </Button>,
    );
  }
  return buttons.length > 0 ? <>{buttons}</> : null;
}

function ListRow({
  icon,
  label,
  hint,
  title,
  onActivate,
  onDragStart,
  children,
}: {
  icon: IconName;
  label: string;
  hint?: string;
  title?: string;
  onActivate?: () => void;
  onDragStart?: (e: DragEvent) => void;
  children?: ReactNode;
}): JSX.Element {
  return (
    <li
      className={styles.listRow}
      title={title}
      draggable={onDragStart ? true : undefined}
      onDragStart={onDragStart}
      onDoubleClick={onActivate}
    >
      <Icon name={icon} size="sm" className={styles.listIcon} />
      <span className={styles.listLabel}>{label}</span>
      {hint ? <span className={styles.listHint}>{hint}</span> : null}
      <span className={styles.spacer} />
      {children}
    </li>
  );
}

function EffectsTab({ contents, loaded, detail }: { contents: PluginContents; loaded: boolean; detail: StorePluginDetail | null }): JSX.Element {
  if (contents.effects.length === 0) {
    // Not loaded (or not installed): what the store says it adds, without Apply.
    const listed = detail?.effects ?? [];
    if (listed.length === 0) return <p className={styles.empty}>{t('plugins.page.noEffects', 'This plugin adds no effects.')}</p>;
    return (
      <ul className={styles.list} aria-label={t('plugins.page.effects', 'Effects')}>
        {listed.map((e) => <ListRow key={e.matchName} icon="magic-wand" label={e.name} hint={e.category} />)}
      </ul>
    );
  }
  return (
    <ul className={styles.list} aria-label={t('plugins.page.effects', 'Effects')}>
      {contents.effects.map((d) => (
        <ListRow
          key={d.type}
          icon="magic-wand"
          label={d.label}
          hint={d.category}
          title={t('plugins.panel.effectTitle', 'Double-click to apply {name} to the selected layers, or drag it onto a layer', { name: d.label })}
          onActivate={loaded ? () => applyPluginEffect(d) : undefined}
          onDragStart={loaded ? (e) => setCanvasDrag(e, { kind: 'effect', effectType: d.type }) : undefined}
        >
          <Button size="xs" variant="secondary" disabled={!loaded} onClick={() => applyPluginEffect(d)}>
            {t('plugins.page.apply', 'Apply')}
          </Button>
        </ListRow>
      ))}
    </ul>
  );
}

function PresetsTab({ contents, loaded }: { contents: PluginContents; loaded: boolean }): JSX.Element {
  if (contents.presets.length === 0) return <p className={styles.empty}>{t('plugins.page.noPresets', 'This plugin ships no presets.')}</p>;
  return (
    <ul className={styles.list} aria-label={t('plugins.page.presets', 'Presets')}>
      {contents.presets.map(({ preset, effectLabel }) => (
        <ListRow
          key={`${preset.effect}#${preset.name}`}
          icon="zap"
          label={preset.name}
          hint={effectLabel}
          title={t('plugins.panel.presetTitle', 'Double-click to apply the {effect} preset "{preset}" to the selected layers', { effect: effectLabel, preset: preset.name })}
          onActivate={loaded ? () => applyPluginPreset(preset) : undefined}
        >
          <Button size="xs" variant="secondary" disabled={!loaded} onClick={() => applyPluginPreset(preset)}>
            {t('plugins.page.apply', 'Apply')}
          </Button>
        </ListRow>
      ))}
    </ul>
  );
}

function PanelsTab({ contents, plugin }: { contents: PluginContents; plugin: NativePlugin | undefined }): JSX.Element {
  const docked = useDocked();
  if (contents.panels.length === 0) return <p className={styles.empty}>{t('plugins.page.noPanels', 'This plugin has no panels.')}</p>;
  return (
    <ul className={styles.list} aria-label={t('plugins.page.panels', 'Panels')}>
      {contents.panels.map((entry) => {
        // The dock's own title for it, so the row reads as the sidebar tab does.
        const name = pluginPanelTitle(entry, plugin);
        const isDocked = docked.has(entry.panelId);
        return (
          <ListRow
            key={entry.panelId}
            icon="panel-right"
            label={name}
            hint={entry.kind === 'effect' ? t('plugins.page.effectPanel', 'Effect panel') : t('plugins.page.toolPanel', 'Tool panel')}
            onActivate={() => useLayoutStore.getState().openPanel(entry.panelId)}
          >
            <Checkbox
              className={styles.dockToggle}
              label={t('plugins.page.showAsSidebarTab', 'Show as sidebar tab')}
              checked={isDocked}
              onChange={(e) => {
                const layout = useLayoutStore.getState();
                if (e.currentTarget.checked) layout.openPanel(entry.panelId);
                else layout.closePanel(entry.panelId);
              }}
            />
            <Button size="xs" variant="secondary" onClick={() => useLayoutStore.getState().openPanel(entry.panelId)}>
              {t('plugins.page.open', 'Open')}
            </Button>
          </ListRow>
        );
      })}
    </ul>
  );
}

/** A plugin the store does not list (copied in by hand, or a local build): what its manifest says. */
function ManifestDetails({ plugin }: { plugin: NativePlugin }): JSX.Element {
  return (
    <div className={styles.section}>
      <p className={styles.text}>{t('plugins.page.notInStore', 'This plugin was installed from a file or the plugins folder; the Premation Store does not list it.')}</p>
      <dl className={styles.facts}>
        <dt>{t('plugins.page.id', 'Identifier')}</dt>
        <dd className={styles.mono}>{plugin.id}</dd>
        {plugin.vendor ? (
          <>
            <dt>{t('plugins.page.vendor', 'Vendor')}</dt>
            <dd>{plugin.vendor}</dd>
          </>
        ) : null}
        <dt>{t('plugins.store.builtForSdk', 'Built for SDK')}</dt>
        <dd className={styles.mono}>{plugin.sdk || '—'}</dd>
        <dt>{t('plugins.page.gpu', 'GPU rendering')}</dt>
        <dd>{plugin.gpu ? t('plugins.page.yes', 'Yes') : t('plugins.page.no', 'No')}</dd>
      </dl>
    </div>
  );
}

function DetailsTab({ plugin, detail, loading, hasCloud, owner }: { plugin: NativePlugin | undefined; detail: StorePluginDetail | null; loading: boolean; hasCloud: boolean | null; owner?: boolean }): JSX.Element {
  if (!detail) {
    if (loading) return <p className={styles.empty} role="status">{t('plugins.store.loading', 'Loading…')}</p>;
    return plugin ? <ManifestDetails plugin={plugin} /> : <p className={styles.empty}>{t('plugins.page.noDetails', 'No details for this plugin.')}</p>;
  }
  const about = detail.readme?.trim() || '';
  const shots = (detail.screenshots ?? []).slice(0, 3);
  return (
    <>
      {detail.blocked ? (
        <p className={styles.error} role="alert">
          {detail.blockedReason
            ? t('plugins.store.withdrawnReason', 'Withdrawn: {reason}', { reason: detail.blockedReason })
            : t('plugins.store.withdrawn', 'Withdrawn')}
        </p>
      ) : null}
      {detail.tier === 'cloud' && hasCloud !== true && !owner && (!plugin || isCloudPlugin(plugin)) ? <CloudPitch plugin={detail} /> : null}
      {shots.length > 0 ? <Gallery shots={shots} name={detail.name} /> : null}
      {detail.whatsNew ? (
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>{t('plugins.store.whatsNew', 'What\'s new in v{version}', { version: detail.whatsNew.version })}</h3>
          <ReleaseNotes text={detail.whatsNew.releaseNotes} />
        </div>
      ) : null}
      {about ? (
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>{t('plugins.store.about', 'About')}</h3>
          <div className={styles.markdown}>
            <ReactMarkdown>{about}</ReactMarkdown>
          </div>
        </div>
      ) : null}
      {!about && !detail.whatsNew && shots.length === 0 ? <p className={styles.text}>{detail.description}</p> : null}
      <p className={styles.help}>
        {t(
          'plugins.store.safetyNote',
          'Plugins run inside the Premation engine on this computer, with the same access as Premation itself. The package is checked against the publisher\'s signature before it is installed.',
        )}
      </p>
    </>
  );
}

function ChangelogTab({ detail, owner }: { detail: StorePluginDetail; owner?: boolean }): JSX.Element {
  const versions = detail.versionHistory ?? [];
  return (
    <div className={styles.section}>
      <Versions versions={versions} owner={owner} />
      {versions.length === 0 ? <span className={styles.text}>v{detail.latestVersion}</span> : null}
      {detail.changelog?.trim() && !versions.some((v) => v.releaseNotes) ? <pre className={styles.changelog}>{detail.changelog}</pre> : null}
    </div>
  );
}

/** The right column: where and what is installed (or, before installing, what would be). */
function InstallationFacts({ id, plugin, detail, store }: { id: string; plugin: NativePlugin | undefined; detail: StorePluginDetail | null; store: InstalledState }): JSX.Element {
  const mine = store.installed?.plugins[id];
  const queued = store.installed?.uninstall.includes(id) ?? false;
  const update = store.updates.get(id)?.latestVersion;
  const installedHere = !!plugin || !!mine;
  const status = plugin ? pluginStatusWord(plugin, update, queued) : null;
  const installedAt = formatDate(mine?.installedAt);
  const updated = formatDate(detail?.updatedAt);
  return (
    <aside className={styles.aside} aria-label={t('plugins.page.installation', 'Installation')}>
      <h3 className={styles.asideTitle}>{installedHere ? t('plugins.page.installation', 'Installation') : t('plugins.page.listing', 'Listing')}</h3>
      <dl className={styles.facts}>
        <dt>{t('plugins.page.version', 'Version')}</dt>
        <dd className={styles.mono}>{plugin?.version || mine?.version || detail?.latestVersion || '—'}</dd>
        {update ? (
          <>
            <dt>{t('plugins.page.latest', 'Latest')}</dt>
            <dd className={styles.mono}>{update}</dd>
          </>
        ) : null}
        {installedHere ? (
          <>
            <dt>{t('plugins.page.status', 'Status')}</dt>
            <dd className={styles.status} data-tone={status?.tone}>
              {mine?.pending ? t('plugins.store.restartToFinish', 'Restart to finish') : status?.text ?? t('plugins.page.waitingForEngine', 'Waiting for the engine')}
            </dd>
            <dt>{t('plugins.page.source', 'Source')}</dt>
            <dd>{mine ? t('plugins.page.sourceStore', 'Premation Store') : t('plugins.page.sourceFolder', 'Plugins folder')}</dd>
          </>
        ) : null}
        {installedAt ? (
          <>
            <dt>{t('plugins.page.installed', 'Installed')}</dt>
            <dd>{installedAt}</dd>
          </>
        ) : null}
        {updated ? (
          <>
            <dt>{t('plugins.store.updated', 'Updated')}</dt>
            <dd>{updated}</dd>
          </>
        ) : null}
        {detail ? (
          <>
            <dt>{t('plugins.store.runsOn', 'Runs on')}</dt>
            <dd>{detail.platforms.join(', ') || '—'}</dd>
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
                <dd className={styles.mono}>{detail.homepage}</dd>
              </>
            ) : null}
          </>
        ) : null}
        <dt>{t('plugins.page.id', 'Identifier')}</dt>
        <dd className={styles.mono}>{id}</dd>
      </dl>
      {installedHere && canOpenNativePluginFolder() ? (
        <Button size="xs" variant="ghost" leftIcon={<Icon name="folder-open" size="sm" />} onClick={() => void openNativePluginFolder()}>
          {t('plugins.panel.showInFolder', 'Show in Folder')}
        </Button>
      ) : null}
    </aside>
  );
}

function Page({ id, owner, name, detail, loading }: { id: string; owner?: boolean; name: string; detail: StorePluginDetail | null; loading: boolean }): JSX.Element {
  const plugins = useEnginePlugins();
  const plugin = plugins?.find((p) => p.id === id);
  // Its own store state; every other one (the sidebar's) refreshes after an action here.
  const store = useInstalledPlugins(() => void refreshPluginContrib(pluginEngine()));
  useAllEffectDefs();
  const contents = usePluginContents(id);
  const hasCloud = useHasCloudPlugins();
  const [tab, setTab] = useState<SubTab>('details');

  const installedHere = !!plugin || !!store.installed?.plugins[id];
  const loaded = plugin?.status === 'loaded';
  const title = plugin?.name || detail?.name || name || id;
  const version = plugin?.version || detail?.latestVersion || '';
  const publisher = detail ? detail.publisher.displayName || detail.publisher.namespace : plugin?.vendor ?? '';
  const tier = detail ? detail.tier : plugin && isCloudPlugin(plugin) ? 'cloud' : null;
  const description = detail?.description ?? '';
  const effectCount = contents.effects.length || (installedHere ? 0 : detail?.effects.length ?? 0);
  const hasChangelog = !!detail && ((detail.versionHistory?.length ?? 0) > 0 || !!detail.changelog?.trim());

  const tabs: Array<{ id: SubTab; label: string; count?: number }> = [
    { id: 'details', label: t('plugins.page.details', 'Details') },
    { id: 'effects', label: t('plugins.page.effects', 'Effects'), count: effectCount },
    ...(installedHere
      ? [
          { id: 'presets' as const, label: t('plugins.page.presets', 'Presets'), count: contents.presets.length },
          { id: 'panels' as const, label: t('plugins.page.panels', 'Panels'), count: contents.panels.length },
        ]
      : []),
    ...(hasChangelog ? [{ id: 'changelog' as const, label: t('plugins.page.changelog', 'Changelog') }] : []),
  ];
  const current = tabs.some((x) => x.id === tab) ? tab : 'details';

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <PluginIcon plugin={{ name: title, iconUrl: detail?.iconUrl ?? null }} src={plugin ? pluginIconUrl(plugin) : null} size={72} />
        <div className={styles.headBody}>
          <div className={styles.titleLine}>
            <h2 className={styles.title}>{title}</h2>
            {version ? <span className={styles.version}>{version}</span> : null}
          </div>
          <div className={styles.metaLine}>
            {publisher ? (
              <span className={styles.publisher}>
                {publisher}
                {detail?.publisher.verified ? (
                  <Icon name="success" size="sm" className={styles.verified} aria-label={t('plugins.store.verified', 'Verified')} />
                ) : null}
              </span>
            ) : null}
            {detail && detail.installs > 0 ? (
              <span className={styles.meta}>
                <Icon name="download" size="sm" className={styles.metaIcon} />
                {t('plugins.store.installs', '{n} installs', { n: detail.installs.toLocaleString() })}
              </span>
            ) : null}
            {tier ? <span className={styles.meta}>{tier === 'cloud' ? 'Premation Cloud' : t('plugins.store.free', 'Free')}</span> : null}
            {plugin && plugin.status !== 'loaded' ? (
              <span className={styles.status} data-tone={plugin.status === 'disabled' ? 'dim' : 'danger'}>{nativePluginStatusLabel(plugin.status)}</span>
            ) : null}
          </div>
          {description ? <p className={styles.description}>{description}</p> : null}
          {plugin?.error ? <p className={styles.error} role="note">{plugin.error}</p> : null}
          <div className={styles.actions}>
            <Actions id={id} plugin={plugin} detail={detail} store={store} owner={owner} hasCloud={hasCloud} />
          </div>
          {store.message ? <StoreMessageLine message={store.message} /> : null}
        </div>
      </header>

      <div className={styles.tabs} role="tablist" aria-label={t('plugins.page.sections', 'Plugin sections')}>
        {tabs.map((x) => (
          <button
            key={x.id}
            type="button"
            role="tab"
            aria-selected={current === x.id}
            className={cn(styles.tab, current === x.id && styles.tabActive)}
            onClick={() => setTab(x.id)}
          >
            {x.label}
            {x.count !== undefined ? <span className={styles.tabCount}>{x.count}</span> : null}
          </button>
        ))}
      </div>

      <div className={styles.body}>
        <div className={styles.main} role="tabpanel">
          {current === 'details' ? <DetailsTab plugin={plugin} detail={detail} loading={loading} hasCloud={hasCloud} owner={owner} /> : null}
          {current === 'effects' ? <EffectsTab contents={contents} loaded={loaded} detail={detail} /> : null}
          {current === 'presets' ? <PresetsTab contents={contents} loaded={loaded} /> : null}
          {current === 'panels' ? <PanelsTab contents={contents} plugin={plugin} /> : null}
          {current === 'changelog' && detail ? <ChangelogTab detail={detail} owner={owner} /> : null}
          {(current === 'effects' || current === 'presets') && installedHere && !loaded ? (
            <p className={styles.help}>{t('plugins.page.notLoadedHint', 'Enable the plugin to apply its effects and presets.')}</p>
          ) : null}
        </div>
        <InstallationFacts id={id} plugin={plugin} detail={detail} store={store} />
      </div>
    </div>
  );
}

export function PluginDetailPage({ id, name, owner }: { id: string; name: string; owner?: boolean }): JSX.Element {
  if (!cloudProjectsEnabled()) return <Page id={id} name={name} owner={owner} detail={null} loading={false} />;
  return (
    <WithStoreDetail id={id} owner={owner}>
      {({ detail, loading }) => <Page id={id} name={name} owner={owner} detail={detail} loading={loading} />}
    </WithStoreDetail>
  );
}

export default PluginDetailPage;
