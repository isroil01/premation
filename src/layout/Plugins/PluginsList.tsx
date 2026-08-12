/**
 * Every plugin, in one searchable list.
 *
 * There are no Browse / Installed / My Plugins tabs, and removing them is the
 * point. A user looking for a plugin does not know, and should not have to
 * decide, whether the thing they want is already installed — that is a fact
 * about their machine, not a category of software. Tabs made them choose a
 * container before they could search, and split one answer across three places:
 * search "easing" in the wrong tab and it simply is not there.
 *
 * So: one query, one list, and each row STATES whether it is installed rather
 * than being filed under it.
 *
 * The list is also a UNION, not just the registry's answer. A plugin installed
 * from a folder — an author's own work in progress — exists on this machine and
 * in no registry, and a list that only showed registry results would hide the
 * plugin its user is actively building.
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Icon } from '@components/Icon';
import { Pagination } from '@components/Pagination';
import { cn } from '@utils/cn';
import { usePluginStore } from '@stores/pluginStore';
import pluginHost from '@core/plugins/PluginHost';
import {
  browseRegistry,
  checkForUpdates,
  registryMediaUrl,
  type RegistryPlugin,
  type RegistryUpdate,
} from '@core/plugins/registry';
import { pluginRegistryEnabled } from '@core/config/edition';
import { revocationListIsStale, revocationsConfirmedAt } from '@core/plugins/revocation';
import { pluginEffectsCanRender } from '@core/effects/pluginEffectDefs';
import { panelPlacements } from './pluginPanelDefs';
import { openPluginTab } from './openPluginTab';
import { installFromRegistry } from './installFromRegistry';
import { AddPluginButton } from './AddPluginButton';
import { ReportPluginDialog } from './ReportPluginDialog';
import { useDiskInstall } from './useDiskInstall';
import { openContextMenu } from '@stores/contextMenuStore';
import styles from './PluginsPanel.module.css';

/**
 * One page of registry results.
 *
 * Fixed, and the same on both surfaces this list appears on. A per-surface page
 * size would mean the sidebar and the dashboard disagree about which plugins
 * are "on page 2", and the only thing a reader could do with that is be wrong
 * about where they saw something.
 */
const PAGE_SIZE = 20;

/**
 * One row's worth of truth, whatever the plugin's origin.
 *
 * `installed` and `registry` are both optional and at least one is always set:
 * a plugin can be on this machine only (folder install), in the registry only
 * (not installed yet), or both.
 */
interface Row {
  id: string;
  name: string;
  description: string;
  publisher: string;
  verified: boolean;
  iconUrl: string | null;
  installs: number | null;
  version: string;
  installed: boolean;
  enabled: boolean;
  status: string;
  hasUpdate: boolean;
  /** Present when the registry knows it — the only way to install or update. */
  registry: RegistryPlugin | null;
}

export function PluginsList({
  /**
   * Icon-only chrome for the add control. Set by the dock panel, where the
   * column is 280px wide; the dashboard has room for the label and is the page
   * a user goes to when they are looking for how to add one.
   */
  compactActions = false,
  /**
   * Whether this copy of the list can install from disk.
   *
   * False in the editor's dock, where adding a plugin now belongs to the
   * dashboard's Plugins page alongside publishing it. It gates BOTH routes —
   * the Add control and the drop target — because a hidden button beside a live
   * drop zone is not a decision, it is a button someone forgot.
   *
   * The two surfaces render the same component precisely so they cannot drift,
   * and this is the one thing they are allowed to differ on. Note the cost,
   * since it is real: iterating on a plugin you are writing now means leaving
   * the editor for the dashboard to reinstall it. The row's own **Reload** is
   * unaffected and is still the fast path once a plugin is in.
   */
  canInstall = true,
  onPublishPlugin,
}: {
  compactActions?: boolean;
  canInstall?: boolean;
  onPublishPlugin?: () => void;
} = {}): JSX.Element {
  /*
    Re-render when a plugin starts, stops or crashes: the row shows status.

    ★ The revision is KEPT and fed to the `rows` memo below. Subscribing alone
    is not enough and looked like it was: the store's plugin array is unchanged
    by a plugin merely finishing its boot, so every dependency of that memo
    stays identical and the memo returns its previous rows — including the
    `status` it read from `pluginHost.info()` on the render before. The row sat
    on "Starting…" until something else remounted the list, at which point the
    correct status appeared and the whole thing looked like a slow update rather
    than a stale one.
  */
  const hostRevision = useSyncExternalStore(
    (cb) => pluginHost.subscribe(cb),
    () => pluginHost.getRevision(),
  );

  const installedPlugins = usePluginStore((s) => s.plugins);
  // Drop a `.zip` anywhere on the list. This is what the retired manager
  // modal's drop zone became: the same gesture, on the surface a user is
  // already looking at, instead of behind a menu.
  const { takeFile, sheet } = useDiskInstall();
  const [dragging, setDragging] = useState(false);
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [registryItems, setRegistryItems] = useState<RegistryPlugin[] | null>(null);
  const [total, setTotal] = useState(0);
  const [registryAvailable, setRegistryAvailable] = useState(true);
  const [failed, setFailed] = useState(false);
  const [updates, setUpdates] = useState<RegistryUpdate[]>([]);

  useEffect(() => {
    let alive = true;
    setRegistryItems(null);
    setFailed(false);
    // Debounced — a request per keystroke against an endpoint whose search has
    // no index behind it.
    const timer = setTimeout(() => {
      void browseRegistry({ q: query, limit: PAGE_SIZE, offset })
        .then((r) => {
          if (!alive) return;
          setRegistryAvailable(r.available);
          setRegistryItems(r.available ? r.items : []);
          setTotal(r.available ? r.total : 0);
        })
        .catch(() => { if (alive) { setFailed(true); setRegistryItems([]); setTotal(0); } });
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [query, offset]);

  // A plugin withdrawn between two requests can leave `offset` past the end of
  // a list that shrank. Without this the user sits on a page that renders
  // nothing, with a pager insisting the page exists.
  useEffect(() => {
    if (total > 0 && offset >= total) setOffset(0);
  }, [total, offset]);

  const installedKey = installedPlugins
    .map((p) => `${p.manifest.id}@${p.manifest.version}`)
    .join(',');

  useEffect(() => {
    let alive = true;
    // Read from the store rather than closing over `installedPlugins`, so the
    // effect can depend on `installedKey` alone. The store replaces its array
    // on every unrelated change, so depending on the array itself would re-run
    // this — a network call — on things like a plugin merely starting up.
    const installed = usePluginStore.getState().plugins
      .map((p) => ({ id: p.manifest.id, version: p.manifest.version }));
    void checkForUpdates(installed)
      .then((found) => { if (alive) setUpdates(found); })
      .catch(() => { /* an update check that fails costs a badge, not a session */ });
    return () => { alive = false; };
  }, [installedKey]);

  const rows = useMemo<Row[]>(() => {
    const byId = new Map<string, Row>();

    /*
      Installed plugins ride along with the FIRST page only.
      They are not part of the registry's paged stream — they are a fact about
      this machine — so repeating them on every page would show the same plugin
      eight times in a list whose whole job is to be a list of distinct
      plugins. Page one is where they belong: it is the page a user lands on,
      and the one they return to. A plugin that is both installed and in the
      registry's page 3 still appears there, once, marked installed.
    */
    const localRows = offset === 0 ? installedPlugins : [];

    // Installed first, so a locally-installed plugin always has a row even when
    // the registry has never heard of it.
    for (const entry of localRows) {
      const info = pluginHost.info(entry.manifest.id);
      byId.set(entry.manifest.id, {
        id: entry.manifest.id,
        name: entry.manifest.name,
        description: entry.manifest.description,
        publisher: entry.manifest.author ?? '',
        verified: false,
        iconUrl: null,
        installs: null,
        version: entry.manifest.version,
        installed: true,
        enabled: entry.enabled,
        status: info.status,
        hasUpdate: false,
        registry: null,
      });
    }

    // Then the registry, filling in what only it knows: publisher identity,
    // install count, icon, and the key an install has to verify against.
    for (const item of registryItems ?? []) {
      // From the STORE, not from `byId` — on any page after the first there is
      // no local row to merge with, and reading install state off the map would
      // report every plugin on page 2 as not installed while its Install button
      // sat next to a copy the user already has.
      const local = installedPlugins.find((p) => p.manifest.id === item.id);
      const info = local ? pluginHost.info(item.id) : null;
      byId.set(item.id, {
        id: item.id,
        name: item.name,
        description: item.description,
        publisher: item.publisher.displayName || item.publisher.namespace,
        verified: item.publisher.verified,
        iconUrl: item.iconUrl,
        installs: item.installs,
        version: local?.manifest.version ?? item.latestVersion,
        installed: !!local,
        enabled: local?.enabled ?? false,
        status: info?.status ?? 'stopped',
        hasUpdate: local ? local.manifest.version !== item.latestVersion : false,
        registry: item,
      });
    }

    // A locally-installed plugin is filtered CLIENT-SIDE; the registry already
    // applied the query to its own results.
    const q = query.trim().toLowerCase();
    const all = [...byId.values()].filter((r) =>
      !q || r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q)
      || r.id.toLowerCase().includes(q),
    );

    return all
      .map((r) => ({ ...r, hasUpdate: r.hasUpdate || updates.some((u) => u.id === r.id && !u.blocked) }))
      .sort((a, b) => {
        // Installed first — they are the ones the user acts on most — then by
        // reach, then by name so the order never reshuffles between renders.
        if (a.installed !== b.installed) return a.installed ? -1 : 1;
        if ((b.installs ?? -1) !== (a.installs ?? -1)) return (b.installs ?? -1) - (a.installs ?? -1);
        return a.name.localeCompare(b.name);
      });
    // `hostRevision` is read for its IDENTITY, not its value — it is what makes
    // a status change recompute these rows. See the note at the subscription.
  }, [installedPlugins, registryItems, query, updates, offset, hostRevision]);

  const loading = registryItems === null;

  return (
    <div
      className={cn(styles.root, dragging && styles.rootDropping)}
      onDragOver={(e) => {
        // Only claim the drop when the drag actually carries files. Without
        // this, dragging a layer across the panel would light it up as if it
        // were about to install something.
        if (!canInstall || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }}
      onDrop={async (e) => {
        // Gated with the button, not separately. A panel that still installed
        // on drop while showing no way to install would be the worst of both:
        // the affordance gone and the capability still there, discoverable only
        // by accident.
        if (!canInstall || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(false);
        const file = e.dataTransfer.files[0];
        if (file) await takeFile(file);
      }}
    >
      {dragging && (
        <div className={styles.dropHint} aria-hidden="true">
          <Icon name="upload" size="md" />
          <span>Drop a .zip or .mplugin package to install</span>
        </div>
      )}

      <div className={styles.searchRow}>
        <input
          className={styles.search}
          type="search"
          placeholder="Search plugins"
          aria-label="Search plugins"
          value={query}
          // Back to page one on every edit. Staying on page 4 of the previous
          // search would show a page of a list that no longer exists.
          onChange={(e) => { setQuery(e.target.value); setOffset(0); }}
        />
        {/*
          Two DIFFERENT actions, both on the list on purpose.

          Publish sends a package outward; Add installs one from this computer.
          Add was briefly replaced by Publish, which left install reachable only
          by dropping a file on the list — a real drop target (see `onDrop`
          below) with no visible affordance, so it works only for someone who
          already knows it is there. `installSurfaces.test.tsx` exists to keep
          this action out of the manager modal for exactly that reason, and it
          caught the removal.
        */}
        {canInstall && <AddPluginButton compact={compactActions} />}
        {onPublishPlugin && (
          <button
            type="button"
            className={cn(styles.publishBtn, compactActions && styles.publishBtnCompact)}
            onClick={onPublishPlugin}
            title="Publish a custom plugin package"
          >
            <Icon name="plus" size="sm" />
            {!compactActions && <span>Publish Plugin</span>}
          </button>
        )}
      </div>

      <PersistFailureNotice />
      <StorageReconciledNotice />
      <RestorableNotice />
      <RevocationStalenessNotice />

      <div className={styles.list}>
        {loading && <SkeletonRows />}

        {!loading && rows.length === 0 && (
          <EmptyState
            query={query}
            registryAvailable={registryAvailable}
            failed={failed}
            canInstall={canInstall}
          />
        )}

        {!loading && rows.map((row) => <PluginRow key={row.id} row={row} />)}

        {/* Said at the FOOT of the results, not instead of them: a self-hosted
            user still has their installed plugins listed above, and telling
            them "nothing published yet" would be both false and unactionable. */}
        {!loading && !registryAvailable && rows.length > 0 && (
          <p className={styles.listNote}>
            Only your installed plugins are shown — the registry isn&rsquo;t available in this
            edition.
          </p>
        )}
      </div>

      {/*
        Outside the scrolling list, not at the bottom of it.
        A pager that scrolls away is a pager nobody finds: the reader reaches
        the last row, sees no control, and concludes that is every plugin there
        is. Rendering it as a fixed foot of the panel is the whole reason paging
        is honest here rather than a silent cap.

        `Pagination` returns null at total 0, so the local edition — which has
        no registry and therefore no pages — gets no empty control.
      */}
      {registryAvailable && (
        <div className={styles.pagerRow}>
          <Pagination
            total={total}
            limit={PAGE_SIZE}
            offset={offset}
            busy={loading}
            itemLabel="plugin"
            // Fixed at PAGE_SIZE. A rows-per-page select is a third control in
            // a 280px column, and it buys a reader nothing they cannot get by
            // pressing Next.
            showPageSizes={false}
            onChange={(p) => setOffset(p.offset)}
          />
        </div>
      )}

      {sheet}
    </div>
  );
}

/**
 * A takedown the user has not yet acknowledged, stated on the row itself.
 *
 * Only for the `malicious` category, and only until acknowledged. The toast
 * that fired when the plugin was stopped is a moment; this is what a user who
 * dismissed it by reflex — or who was not looking at the screen — has left to
 * find. For a plugin withdrawn for stealing project data, "you may want to
 * check what this had access to" is not a thing to say once, in passing, in a
 * corner of the screen, for twelve seconds.
 *
 * Every other category gets nothing here. Most takedowns are a plugin that
 * broke on a new release, and a product that marks all of them permanently
 * teaches people to ignore the mark.
 */
function TakedownNotice({ pluginId, installed }: { pluginId: string; installed: boolean }): JSX.Element | null {
  useSyncExternalStore((cb) => pluginHost.subscribe(cb), () => pluginHost.getRevision());
  if (!installed || !pluginHost.hasUnacknowledgedTakedown(pluginId)) return null;

  return (
    <span className={styles.rowTakedown} role="alert">
      <Icon name="warning" size="sm" />
      <span>Withdrawn by the registry as malicious. It has been turned off.</span>
      <button
        type="button"
        className={styles.rowTakedownAck}
        onClick={(e) => { e.stopPropagation(); pluginHost.acknowledgeTakedown(pluginId); }}
      >
        I&rsquo;ve read this
      </button>
    </span>
  );
}

/**
 * This plugin contributes effects, and this machine cannot render them.
 *
 * Permanent, not a toast. The toast fires once when an effect is added; this is
 * what a user sees when they come back tomorrow and wonder why the plugin they
 * installed appears to do nothing. Without it the only evidence is an effect
 * that sits in the stack showing parameters and changing no pixels, which reads
 * as a broken plugin rather than as a machine that lacks WebGPU.
 *
 * Deliberately not phrased as an error. The plugin is fine, the effects are
 * saved with the project, and they will draw on a machine that has the backend.
 */
function InertEffectsNote({ pluginId, installed }: { pluginId: string; installed: boolean }): JSX.Element | null {
  const entry = usePluginStore((s) => s.get(pluginId));
  if (!installed || pluginEffectsCanRender()) return null;
  if ((entry?.manifest.contributes.effects.length ?? 0) === 0) return null;

  return (
    <span className={styles.rowInert}>
      Effects need WebGPU — this machine is on the WebGL2 fallback.
    </span>
  );
}

function PluginRow({ row }: { row: Row }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [reporting, setReporting] = useState(false);
  const icon = registryMediaUrl(row.iconUrl);

  const install = async (e: React.MouseEvent): Promise<void> => {
    e.stopPropagation();
    if (!row.registry) return;
    setBusy(true);
    try {
      await installFromRegistry(row.id, row.registry.latestVersion, row.registry.publisherKey);
    } finally {
      setBusy(false);
    }
  };

  // Enter opens a PINNED tab and switches to it; a single click previews. Both
  // land on the same detail view — the difference is only whether the tab
  // survives the next thing the user clicks.
  const open = (preview: boolean): void => { openPluginTab(row.id, row.name, { preview }); };

  /*
    Reporting lives in the row's context menu rather than as a fourth button.

    This column is 280px wide and already carries Install/Update, Enable/Disable
    and a status pill. A visible Report button would crowd the two actions
    people use constantly in order to surface one they will use twice a year —
    and a row that cannot fit its primary action is a worse trade than a
    secondary action costing a right-click. The detail tab, which has room,
    shows it outright.
  */
  const openRowMenu = (e: React.MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu(e.clientX, e.clientY, [
      { id: 'open', label: 'Open', onSelect: () => open(false) },
      ...(row.installed
        ? [{
            id: 'toggle',
            label: row.enabled ? 'Disable' : 'Enable',
            onSelect: () => pluginHost.setEnabled(row.id, !row.enabled),
          }]
        : []),
      { id: 'sep', separator: true },
      { id: 'report', label: 'Report…', danger: true, onSelect: () => setReporting(true) },
    ]);
  };

  return (
    <div
      className={styles.row}
      role="button"
      tabIndex={0}
      title={row.description}
      onClick={() => open(true)}
      onDoubleClick={() => open(false)}
      onContextMenu={openRowMenu}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(false); }
      }}
    >
      <span className={styles.rowIcon}>
        {icon ? <img src={icon} alt="" /> : <Icon name="plugin" size="md" />}
      </span>

      <span className={styles.rowBody}>
        <span className={styles.rowTop}>
          <span className={styles.rowName}>{row.name}</span>
          {row.publisher && <span className={styles.rowPublisher}>{row.publisher}</span>}
          {row.verified && (
            <span className={styles.rowVerified} title="Verified publisher">
              <Icon name="success" size="sm" />
            </span>
          )}
        </span>

        <span className={styles.rowDesc}>{row.description}</span>

        <TakedownNotice pluginId={row.id} installed={row.installed} />
        <InertEffectsNote pluginId={row.id} installed={row.installed} />

        <span className={styles.rowMeta}>
          {/* Reach, when the registry knows it. A locally-installed plugin has
              no install count and showing "0" would be a claim, not a blank. */}
          {row.installs !== null && <span>{formatInstalls(row.installs)} installs</span>}
          <span>{row.version}</span>
          {row.installed && <InstalledPill row={row} />}
          {row.installed && <PanelLocationNote pluginId={row.id} />}
        </span>
      </span>

      <span className={styles.rowActions}>
        {row.hasUpdate && row.registry && (
          <button
            type="button"
            className={cn(styles.mini, styles.miniPrimary)}
            disabled={busy}
            onClick={(e) => void install(e)}
          >
            {busy ? '…' : 'Update'}
          </button>
        )}
        {!row.installed && row.registry && (
          <button
            type="button"
            className={cn(styles.mini, styles.miniPrimary)}
            disabled={busy}
            onClick={(e) => void install(e)}
          >
            {busy ? '…' : 'Install'}
          </button>
        )}
        {row.installed && (
          <button
            type="button"
            className={styles.mini}
            title={row.enabled ? 'Disable this plugin' : 'Enable this plugin'}
            onClick={(e) => {
              e.stopPropagation();
              pluginHost.setEnabled(row.id, !row.enabled);
            }}
          >
            {row.enabled ? 'Disable' : 'Enable'}
          </button>
        )}
      </span>

      <ReportPluginDialog
        pluginId={row.id}
        pluginName={row.name}
        // Only when this machine actually has it. A version taken from the
        // registry row would open a case against the newest build rather than
        // the one the reporter is looking at.
        {...(row.installed ? { version: row.version } : {})}
        open={reporting}
        onClose={() => setReporting(false)}
      />
    </div>
  );
}

/**
 * Whether this machine has it, and what it is doing.
 *
 * The fact a tab used to encode, said in the row instead. It has to be legible
 * at a glance and never contradict the button beside it — "Disabled" next to a
 * control reading "Enable" is consistent; next to one reading "Enabled" it is a
 * contradiction the user cannot resolve.
 */
function InstalledPill({ row }: { row: Row }): JSX.Element {
  const [label, cls] =
    !row.enabled ? ['Disabled', styles.statusStopped]
    : row.status === 'running' ? ['Running', styles.statusRunning]
    : row.status === 'starting' ? ['Starting…', styles.statusStarting]
    : row.status === 'error' ? ['Error', styles.statusError]
    : row.status === 'inactive' ? ['Installed', styles.statusInactive]
    : ['Not running', styles.statusStopped];

  return (
    <span className={cn(styles.status, cls)}>
      <span className={styles.dot} />
      {label}
    </span>
  );
}

/**
 * Where this plugin's UI ended up.
 *
 * The row is the only honest place for this. A plugin that asked for its own
 * sidebar tab and did not get one (the rail hands out a fixed number of slots —
 * see `pluginPanelDefs.ts`) still works and still opens; it just opens somewhere
 * else. Saying nothing would leave the author's screenshot and the user's editor
 * disagreeing, with no way to find out why. This is also the row that explains
 * where to go looking after an install, which is the question every plugin that
 * ships UI raises and none of them can answer for themselves.
 */
function PanelLocationNote({ pluginId }: { pluginId: string }): JSX.Element | null {
  const placements = panelPlacements().filter((p) => p.pluginId === pluginId);
  if (placements.length === 0) return null;

  const demoted = placements.find((p) => p.demoted);
  if (demoted) {
    const where = demoted.requested === 'sidebar' ? 'Sidebar' : 'Inspector';
    return (
      <span title={`This plugin asked for its own ${where.toLowerCase()} tab. Disable a plugin that has one to free a slot.`}>
        {where} full — in Plugin Panels
      </span>
    );
  }

  const granted = placements[0]!.granted;
  if (granted === 'sidebar') return <span>Own tab, left sidebar</span>;
  if (granted === 'inspector') return <span>Own tab, right inspector</span>;
  return <span>In Plugin Panels</span>;
}

/** 12345 → "12.3k". A six-figure number in a 28px row is just noise. */
function formatInstalls(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * What boot had to throw away, said out loud.
 *
 * An index entry and its package are stored separately — metadata in
 * `localStorage`, bytes in IndexedDB — so a crash, a quota failure or a cleared
 * origin can leave one without the other. `hydrate()` reconciles both
 * directions and records what it did in `lastHydration`, which until now
 * NOTHING read. The store's own comment called it "the structured channel a
 * surface should read"; this is that surface.
 *
 * Without it a plugin the user installed disappears between sessions with no
 * message anywhere — the single behaviour most likely to make someone stop
 * trusting a plugin manager, because it is indistinguishable from the app
 * quietly deciding for them.
 *
 * `orphansRemoved` is reported too, even though nothing visible was lost:
 * megabytes were freed, and a user who cleared their storage and wonders where
 * the space went deserves the answer.
 */
function StorageReconciledNotice(): JSX.Element | null {
  const report = usePluginStore((s) => s.lastHydration);
  const [dismissed, setDismissed] = useState(false);

  const dropped = report?.droppedNoPayload ?? [];
  const orphans = report?.orphansRemoved ?? [];
  if (dismissed || (dropped.length === 0 && orphans.length === 0)) return null;

  return (
    <div className={styles.state} role="status">
      {dropped.length > 0 && (
        <>
          <span className={styles.stateTitle}>
            {dropped.length === 1
              ? 'A plugin could not be restored.'
              : `${dropped.length} plugins could not be restored.`}
          </span>
          <span>
            Their packages were missing from this machine&rsquo;s storage, so the
            entries were removed: {dropped.join(', ')}. Installing again will fix
            it — nothing about the plugins themselves is wrong.
          </span>
        </>
      )}
      {orphans.length > 0 && (
        <span>
          {orphans.length === 1 ? 'One leftover package was' : `${orphans.length} leftover packages were`}
          {' '}cleared from storage.
        </span>
      )}
      <button type="button" className={styles.stateAction} onClick={() => setDismissed(true)}>
        Dismiss
      </button>
    </div>
  );
}

/**
 * A package that could not be written to this machine, said out loud NOW.
 *
 * `StorageReconciledNotice` above reports the same failure one boot too late:
 * by then the plugin is already gone and the message is an apology. This is
 * the same fact caught at the moment it happens, while the plugin is still
 * running and the user can act — retry the install, free some space, or at
 * least not be surprised tomorrow.
 *
 * It exists because that failure used to be discarded entirely: `put()` fired
 * the write and threw away its result, so a plugin worked all session and
 * vanished at the next start with nothing said anywhere. That is the exact
 * shape of "I have to reinstall my plugins every time I reopen the app".
 *
 * Not dismissible. Nothing about the situation improves by being hidden, and
 * it clears itself the moment a write succeeds.
 */
function PersistFailureNotice(): JSX.Element | null {
  const message = usePluginStore((s) => s.persistError);
  if (!message) return null;
  return (
    <div className={styles.state} role="alert">
      <span className={styles.stateTitle}>Could not save to this machine.</span>
      <span>{message} Check free disk space, then install it again.</span>
    </div>
  );
}

/**
 * Plugins the ACCOUNT has that this machine does not.
 *
 * Offered, never installed automatically. Pulling packages onto a machine
 * because an account elsewhere had them would run the permission consent
 * screen past nobody, and "software appeared while I was not looking" is worse
 * than the inconvenience it saves. So this is a list and a sentence; the
 * install is still the user's click, through the normal path that verifies the
 * publisher signature here.
 *
 * Hidden while offline. A reconcile that could not reach the account knows
 * nothing about what is missing, and guessing would mean telling a user with a
 * flaky connection that their plugins are gone.
 */
function RestorableNotice(): JSX.Element | null {
  const sync = usePluginStore((s) => s.lastSync);
  const [dismissed, setDismissed] = useState(false);
  const restorable = sync?.restorable ?? [];
  if (dismissed || sync?.offline || restorable.length === 0) return null;

  return (
    <div className={styles.state} role="status">
      <span className={styles.stateTitle}>
        {restorable.length === 1
          ? 'One plugin from your account is not on this machine.'
          : `${restorable.length} plugins from your account are not on this machine.`}
      </span>
      <span>
        {restorable.map((r) => r.name).join(', ')}. Find them in Browse to install
        again — they are re-downloaded and signature-checked here, the same as a
        first install.
      </span>
      <button type="button" className={styles.stateAction} onClick={() => setDismissed(true)}>
        Dismiss
      </button>
    </div>
  );
}

/**
 * The kill switch has not heard from the registry in a while.
 *
 * Stated, never acted on. A client that stopped enforcing a stale revocation
 * list would make "block the fetch" the entire exploit, so everything on the
 * list keeps being enforced and this is only a line of text. What it buys is
 * that the one person who can do something about a machine that cannot reach
 * the registry — the person using it — finds out.
 *
 * Deliberately not dismissible and deliberately not alarming. It is a fact
 * about this machine's network, not an accusation about any plugin, and it
 * disappears by itself the moment a fetch succeeds.
 */
function RevocationStalenessNotice(): JSX.Element | null {
  if (!pluginRegistryEnabled()) return null;
  if (!revocationListIsStale()) return null;

  const confirmed = revocationsConfirmedAt();
  const days = confirmed
    ? Math.floor((Date.now() - Date.parse(confirmed)) / 86_400_000)
    : null;

  return (
    <div className={styles.state} role="status">
      <span className={styles.stateTitle}>Withdrawal list is out of date.</span>
      <span>
        {days !== null && days > 0
          ? `This machine last reached the plugin registry ${days} day${days === 1 ? '' : 's'} ago. `
          : 'This machine has not been able to reach the plugin registry recently. '}
        Plugins already withdrawn are still blocked; anything withdrawn since
        will not be, until the next successful check.
      </span>
    </div>
  );
}

function EmptyState({
  query, registryAvailable, failed, canInstall,
}: {
  query: string;
  registryAvailable: boolean;
  failed: boolean;
  /** False in the dock, where there is no way to add one from here. */
  canInstall: boolean;
}): JSX.Element {
  /*
    Where to go, whenever this copy of the list cannot install.

    An empty panel whose only advice is an action it does not offer is a dead
    end — and this one is empty exactly when a new user first looks at it. The
    dashboard is named rather than implied, because "somewhere else" is not a
    direction.
  */
  const elsewhere = canInstall ? null : (
    <span>Add one from the dashboard&rsquo;s Plugins page.</span>
  );

  if (failed) {
    return (
      <div className={styles.state}>
        <span className={styles.stateTitle}>Couldn&rsquo;t reach the registry.</span>
        <span>Your installed plugins are still available. Check your connection.</span>
      </div>
    );
  }
  if (!registryAvailable) {
    return (
      <div className={styles.state}>
        <span className={styles.stateTitle}>The plugin registry isn&rsquo;t available in this edition.</span>
        <span>
          {canInstall
            ? 'You can still install plugins from a folder or a .zip package.'
            : 'Plugins are installed from the dashboard’s Plugins page, from a folder or a .zip package.'}
        </span>
      </div>
    );
  }
  return (
    <div className={styles.state}>
      <span className={styles.stateTitle}>
        {query.trim() ? `No plugins match “${query.trim()}”.` : 'No plugins yet.'}
      </span>
      <span>{query.trim() ? 'Try a broader search.' : 'Published plugins will appear here.'}</span>
      {!query.trim() && elsewhere}
    </div>
  );
}

function SkeletonRows(): JSX.Element {
  return (
    <div aria-busy="true" aria-label="Loading plugins">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className={styles.skelRow}>
          <span className={styles.skelIcon} />
          <span className={styles.skelText} />
        </div>
      ))}
    </div>
  );
}
