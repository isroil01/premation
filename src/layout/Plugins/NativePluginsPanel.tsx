/**
 * The editor's Plugins sidebar, the way VS Code lists extensions
 * (owner-approved mockup board 1, 2026-11-03): one search field over two
 * collapsible sections —
 *
 *   INSTALLED N ................................. 2 updates
 *   PREMATION STORE N ......................... Most installed ▾
 *
 * — one row per plugin: icon, name and version, a line of description, and a
 * meta line (vendor · ↓ installs · status word) with ONE bordered button at
 * the right (Install / Update / Enable / Uninstall). Everything else is the
 * row's right-click menu.
 *
 * A click (or Enter) opens the plugin's page in the main body
 * (PluginDetailPage, a closable tab of EditorTabs): its effects, presets and
 * panels live there now. Up / Down walk the rows of both sections.
 *
 * The store is inline (no trip to the dashboard). Where it cannot be asked —
 * not part of this edition, offline — its section says so quietly and the
 * installed list is untouched.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { Button } from '@components/Button';
import { Dropdown } from '@components/Dropdown';
import { Icon } from '@components/Icon';
import { SearchField } from '@components/SearchField';
import { invalidate } from '@core/api/cache';
import { cloudProjectsEnabled } from '@core/config/edition';
import { canOpenNativePluginFolder, openNativePluginFolder, type NativePlugin } from '@core/nativePlugins/nativePlugins';
import { canInstallFromStore, hostPlatformKeys, runsHere } from '@core/nativePlugins/pluginStore';
import { useNativePlugins } from '@hooks/useNativePlugins';
import {
  useInstalledPlugins,
  useStoreBrowse,
  type InstalledState,
  type PluginStoreBrowse,
  type StoreSort,
} from '@hooks/usePluginStore';
import { pluginIconUrl } from './pluginIcons';
import { useAllEffectDefs } from '@layout/Effects/effectCatalog';
import { openContextMenu } from '@stores/contextMenuStore';
import { usePluginPageStore } from '@stores/pluginPageStore';
import { cn } from '@utils/cn';
import { openPluginPage, pluginMenuItems, useEnginePlugins } from './pluginActions';
import {
  buildPluginSidebar,
  rowMeta,
  rowPluginId,
  visibleRows,
  type PluginSidebarRow,
  type StorePluginRow,
} from './pluginPanelRows';
import { PluginIcon } from './PluginIcon';
import { SORT_KEYS, sortLabel, useHasCloudPlugins } from './PluginStore';
import { StoreMessageLine } from './StoreMessageLine';
import styles from './NativePluginsPanel.module.css';
import { t } from '@core/i18n';

type StoreBrowse = PluginStoreBrowse & { reload: () => void };

/** The store's listing, asked only where the store exists (a hook cannot be called conditionally). */
function WithStore({ q, sort, children }: { q: string; sort: StoreSort; children: (browse: StoreBrowse) => ReactNode }): JSX.Element {
  const browse = useStoreBrowse(q, sort);
  return <>{children(browse)}</>;
}

/** The search as the store sees it: settled for a moment, so typing is not a request per key. */
function useSettled(value: string, ms: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (value === settled) return undefined;
    const id = setTimeout(() => setSettled(value), value.trim() ? ms : 0);
    return () => clearTimeout(id);
  }, [value, settled, ms]);
  return settled;
}

function RowButton({ row, store, hasCloud }: { row: PluginSidebarRow; store: InstalledState; hasCloud: boolean | null }): JSX.Element | null {
  const busy = store.busy !== null;
  const stop = (e: MouseEvent): void => e.stopPropagation();
  if (row.kind === 'store') {
    const p = row.listing;
    const here = hostPlatformKeys();
    if (!canInstallFromStore() || (here && !runsHere(p.platforms, here))) return null;
    const gated = p.tier === 'cloud' && hasCloud === false && !row.owner;
    return (
      <Button
        size="xs"
        variant="primary"
       
        disabled={busy}
        leftIcon={gated ? <Icon name="lock" size="sm" /> : undefined}
        title={gated ? t('plugins.sidebar.cloudInstallTitle', 'Included with Premation Cloud — open the page to see how to get it') : undefined}
        onClick={(e) => {
          stop(e);
          // Without the plan the store would only answer 402: the page says how to get it.
          if (gated) openPluginPage(p.id, p.name, row.owner);
          else void store.install(p.id, p.latestVersion, row.owner);
        }}
      >
        {store.busy === p.id ? t('plugins.store.installing', 'Installing…') : t('plugins.store.install', 'Install')}
      </Button>
    );
  }
  const id = row.plugin.id;
  switch (row.action) {
    case 'update':
      return (
        <Button size="xs" variant="primary" disabled={busy} onClick={(e) => { stop(e); void store.install(id, row.update!); }}>
          {store.busy === id ? t('plugins.store.installing', 'Installing…') : t('plugins.sidebar.update', 'Update')}
        </Button>
      );
    case 'enable':
      return (
        <Button size="xs" variant="secondary" disabled={busy} onClick={(e) => { stop(e); void store.setEnabled(id, true); }}>
          {t('plugins.panel.enable', 'Enable')}
        </Button>
      );
    case 'uninstall':
      return (
        <Button size="xs" variant="secondary" disabled={busy} onClick={(e) => { stop(e); void store.uninstall(id); }}>
          {t('plugins.sidebar.uninstall', 'Uninstall')}
        </Button>
      );
    default:
      return null;
  }
}

function storeStateWord(row: StorePluginRow): { text: string; tone?: string } {
  const here = hostPlatformKeys();
  if (here && !runsHere(row.listing.platforms, here)) return { text: t('plugins.store.notForThisComputer', 'Not for this computer'), tone: 'dim' };
  return row.listing.tier === 'cloud'
    ? { text: 'Premation Cloud' }
    : { text: t('plugins.store.free', 'Free') };
}

function PluginRow({
  row,
  selected,
  focusable,
  store,
  hasCloud,
  onSelect,
}: {
  row: PluginSidebarRow;
  selected: boolean;
  focusable: boolean;
  store: InstalledState;
  hasCloud: boolean | null;
  onSelect: (row: PluginSidebarRow) => void;
}): JSX.Element {
  const installed = row.kind === 'installed' ? row : null;
  const listing = row.listing;
  const name = row.kind === 'installed' ? row.plugin.name || row.plugin.id : row.listing.name;
  const version = row.kind === 'installed' ? row.plugin.version : row.listing.latestVersion;
  const error = installed?.plugin.error ?? '';
  const description = error || listing?.description || installed?.plugin.id || '';
  const state: { text: string; tone?: string } = row.kind === 'installed' ? row.status : storeStateWord(row);
  const meta = rowMeta(row);
  const open = (): void => {
    onSelect(row);
    openPluginPage(rowPluginId(row), name, row.kind === 'store' ? row.owner : undefined);
  };
  const onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
    onSelect(row);
    const items = installed
      ? pluginMenuItems(installed.plugin, store)
      : [{ id: 'details', label: t('plugins.sidebar.openPage', 'Open Plugin Page'), onSelect: open }];
    if (items.length > 0) openContextMenu(e.clientX, e.clientY, items);
  };
  return (
    <div
      id={`plugin-row-${row.id}`}
      data-row-id={row.id}
      className={styles.row}
      data-selected={selected || undefined}
      role="option"
      aria-selected={selected}
      tabIndex={focusable ? 0 : -1}
      onFocus={() => onSelect(row)}
      onClick={open}
      onContextMenu={onContextMenu}
    >
      <PluginIcon
        plugin={{ name, iconUrl: listing?.iconUrl ?? null }}
        src={installed ? pluginIconUrl(installed.plugin) : null}
        size={36}
      />
      <div className={styles.rowBody}>
        <div className={styles.rowTitle}>
          <span className={styles.name}>{name}</span>
          {version ? <span className={styles.version}>{version}</span> : null}
        </div>
        <div className={cn(styles.description, error && styles.descriptionError)} title={description}>
          {description}
        </div>
        <div className={styles.metaLine}>
          {meta.length > 0 ? <span className={styles.meta}>{meta.join(' · ')}</span> : null}
          {meta.length > 0 ? <span className={styles.meta} aria-hidden>·</span> : null}
          <span className={styles.status} data-tone={state.tone}>{state.text}</span>
          <span className={styles.spacer} />
          <RowButton row={row} store={store} hasCloud={hasCloud} />
        </div>
      </div>
    </div>
  );
}

function SectionHead({
  label,
  count,
  open,
  onToggle,
  children,
}: {
  label: string;
  count: number | null;
  open: boolean;
  onToggle: () => void;
  children?: ReactNode;
}): JSX.Element {
  return (
    <div className={styles.sectionHead}>
      <button type="button" className={styles.sectionToggle} aria-expanded={open} onClick={onToggle}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size="sm" className={styles.twirl} />
        <span className={styles.sectionLabel}>{label}</span>
        {count !== null ? <span className={styles.sectionCount}>{count}</span> : null}
      </button>
      <span className={styles.spacer} />
      {children}
    </div>
  );
}

function PluginList({
  plugins,
  engineError,
  store,
  browse,
  query,
  sort,
  setSort,
}: {
  plugins: readonly NativePlugin[] | null;
  engineError: string | null;
  store: InstalledState;
  /** Null: the store is not part of this edition. */
  browse: StoreBrowse | null;
  query: string;
  sort: StoreSort;
  setSort: (sort: StoreSort) => void;
}): JSX.Element {
  const [collapsed, setCollapsed] = useState({ installed: false, store: false });
  const [selected, setSelected] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const hasCloud = useHasCloudPlugins();
  // The page in front marks its row (as VS Code marks the open extension).
  const activePage = usePluginPageStore((s) => s.active);

  const sidebar = useMemo(
    () => buildPluginSidebar({
      plugins: plugins ?? [],
      listings: browse?.items ?? null,
      owned: browse?.owned,
      managed: new Set(Object.keys(store.installed?.plugins ?? {})),
      updates: new Map([...store.updates].map(([id, u]) => [id, u.latestVersion])),
      uninstalling: new Set(store.installed?.uninstall ?? []),
      query,
    }),
    [plugins, browse?.items, browse?.owned, store.installed, store.updates, query],
  );
  const rows = visibleRows(sidebar, collapsed);
  const selectedId = selected ?? (activePage ? rows.find((r) => rowPluginId(r) === activePage)?.id ?? null : null);
  const focusIndex = Math.max(0, rows.findIndex((r) => r.id === selectedId));

  const focusRow = (i: number): void => {
    const row = rows[i];
    if (!row) return;
    setSelected(row.id);
    const el = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-row-id]') ?? [])].find((n) => n.dataset.rowId === row.id);
    el?.focus();
    el?.scrollIntoView?.({ block: 'nearest' });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const target = e.target as HTMLElement;
    if (!target.dataset.rowId) return; // the section headers and the row buttons keep their keys
    const at = rows.findIndex((r) => r.id === target.dataset.rowId);
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        focusRow(Math.min(rows.length - 1, at + 1));
        return;
      case 'ArrowUp':
        e.preventDefault();
        focusRow(Math.max(0, at - 1));
        return;
      case 'Home':
        e.preventDefault();
        focusRow(0);
        return;
      case 'End':
        e.preventDefault();
        focusRow(rows.length - 1);
        return;
      case 'Enter': {
        const row = rows[at];
        if (!row) return;
        e.preventDefault();
        const name = row.kind === 'installed' ? row.plugin.name || row.plugin.id : row.listing.name;
        openPluginPage(rowPluginId(row), name, row.kind === 'store' ? row.owner : undefined);
        return;
      }
      default:
    }
  };

  const rowEl = (row: PluginSidebarRow): JSX.Element => (
    <PluginRow
      key={row.id}
      row={row}
      selected={row.id === selectedId}
      focusable={rows[focusIndex]?.id === row.id}
      store={store}
      hasCloud={hasCloud}
      onSelect={(r) => setSelected(r.id)}
    />
  );

  const storeRows = sidebar.store;
  const storeCount = browse?.items ? storeRows.length : null;

  return (
    <div ref={listRef} className={styles.list} onKeyDown={onKeyDown}>
      <SectionHead
        label={t('plugins.sidebar.installed', 'Installed')}
        count={plugins ? sidebar.installed.length : null}
        open={!collapsed.installed}
        onToggle={() => setCollapsed((c) => ({ ...c, installed: !c.installed }))}
      >
        {sidebar.updateCount > 0 ? (
          <span className={styles.sectionNote}>
            {sidebar.updateCount === 1
              ? t('plugins.sidebar.oneUpdate', '1 update')
              : t('plugins.sidebar.updates', '{n} updates', { n: sidebar.updateCount })}
          </span>
        ) : null}
      </SectionHead>
      {collapsed.installed ? null : engineError && !plugins ? (
        <p className={cn(styles.note, styles.noteError)} role="alert">{engineError}</p>
      ) : !plugins ? (
        <p className={styles.note} role="status">{t('plugins.list.asking', 'Asking the engine…')}</p>
      ) : plugins.length === 0 ? (
        <div className={styles.emptyState} role="status">
          <strong>{t('plugins.list.emptyTitle', 'No native plugins installed')}</strong>
          <span>{t('plugins.sidebar.emptyText', 'Install one from the store below, or copy a plugin into the plugins folder.')}</span>
        </div>
      ) : sidebar.installed.length === 0 ? (
        <p className={styles.note} role="status">{t('plugins.panel.noMatch', 'No installed plugin matches “{query}”.', { query })}</p>
      ) : (
        <div role="listbox" aria-label={t('plugins.panel.treeAria', 'Installed plugins')}>
          {sidebar.installed.map(rowEl)}
        </div>
      )}

      <SectionHead
        label={t('plugins.sidebar.store', 'Premation Store')}
        count={storeCount}
        open={!collapsed.store}
        onToggle={() => setCollapsed((c) => ({ ...c, store: !c.store }))}
      >
        {browse ? (
          <Dropdown
            placement="bottom-end"
            trigger={
              <Button variant="ghost" size="xs" rightIcon={<Icon name="chevron-down" size="sm" />} aria-label={t('plugins.store.sortAria', 'Sort: {sort}', { sort: sortLabel(sort) })}>
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
        ) : null}
      </SectionHead>
      {collapsed.store ? null : !browse ? (
        <p className={styles.note}>{t('plugins.sidebar.storeNotInEdition', 'The plugin store is not part of this edition. Copy plugins into the plugins folder.')}</p>
      ) : browse.error && !browse.items ? (
        <p className={styles.note} role="status">
          {t('plugins.sidebar.storeUnavailable', 'Store unavailable.')}{' '}
          <Button variant="ghost" size="xs" onClick={browse.reload}>{t('plugins.sidebar.retry', 'Retry')}</Button>
        </p>
      ) : !browse.items ? (
        <p className={styles.note} role="status">{t('plugins.store.asking', 'Asking the store…')}</p>
      ) : storeRows.length === 0 ? (
        <p className={styles.note} role="status">
          {query.trim()
            ? t('plugins.sidebar.storeNoMatch', 'No store plugin matches “{query}”.', { query })
            : t('plugins.sidebar.storeAllInstalled', 'Everything in the store is installed.')}
        </p>
      ) : (
        <div role="listbox" aria-label={t('plugins.store.gridAria', 'Store plugins')}>
          {storeRows.map(rowEl)}
        </div>
      )}
    </div>
  );
}

function FootRow({ native, store }: { native: ReturnType<typeof useNativePlugins>; store: InstalledState }): JSX.Element {
  const [folderError, setFolderError] = useState<string | null>(null);
  return (
    <>
      {folderError ? <span className={styles.footError} role="alert">{folderError}</span> : null}
      <div className={styles.foot}>
        <span className={styles.spacer} />
        {canOpenNativePluginFolder() ? (
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon={<Icon name="folder-open" size="sm" />}
            title={t('plugins.list.openFolder', 'Open plugins folder')}
            onClick={() => {
              setFolderError(null);
              void openNativePluginFolder().then(setFolderError);
            }}
          >
            {t('plugins.list.openFolder', 'Open plugins folder')}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon={<Icon name="refresh" size="sm" />}
          title={t('plugins.list.refresh', 'Refresh')}
          disabled={native.loading}
          onClick={() => {
            native.refresh();
            store.refresh();
            // "Refresh" means ask the store again too, not re-read what we have.
            if (cloudProjectsEnabled()) invalidate('plugins');
          }}
        >
          {native.loading ? t('plugins.list.checking', 'Checking…') : t('plugins.list.refresh', 'Refresh')}
        </Button>
      </div>
    </>
  );
}

export function NativePluginsPanel(): JSX.Element {
  const native = useNativePlugins();
  const store = useInstalledPlugins(native.refresh);
  // Asks the engine for the plugins' effects and presets once (their pages read them).
  useAllEffectDefs();
  // The one list both the sidebar and a plugin's page read; this panel's own
  // answer until the cache has one.
  const plugins = useEnginePlugins() ?? native.plugins;
  const [query, setQuery] = useState('');
  const storeQuery = useSettled(query, 250);
  const [sort, setSort] = useState<StoreSort>('installs');

  const list = (browse: StoreBrowse | null): JSX.Element => (
    <PluginList
      plugins={plugins}
      engineError={native.error}
      store={store}
      browse={browse}
      query={query}
      sort={sort}
      setSort={setSort}
    />
  );

  return (
    <div className={styles.panel}>
      <div className={styles.search}>
        <SearchField
          size="sm"
          fullWidth
          value={query}
          onChange={setQuery}
          placeholder={t('plugins.sidebar.search', 'Search plugins in store and installed')}
          ariaLabel={t('plugins.sidebar.search', 'Search plugins in store and installed')}
        />
      </div>
      {cloudProjectsEnabled() ? <WithStore q={storeQuery} sort={sort}>{list}</WithStore> : list(null)}
      {store.message ? (
        <div className={styles.messageLine}>
          <StoreMessageLine message={store.message} />
        </div>
      ) : null}
      <FootRow native={native} store={store} />
    </div>
  );
}
