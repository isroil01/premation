/**
 * The Plugins sidebar's rows (owner-approved mockup board 1, 2026-11-03): a
 * flat list in two sections, the way VS Code lists extensions —
 *
 *   INSTALLED N          one row per plugin the engine found;
 *   PREMATION STORE N    one row per store plugin not installed here.
 *
 * Each row carries the ONE action its inline button offers (Install, Update,
 * Enable, Uninstall, or none); everything else is the row's context menu, and
 * a plugin's effects, presets and panels are on its page in the main body
 * (`pluginContents`, PluginDetailPage.tsx).
 *
 * Pure: the panel hands in the engine's plugin list, main's installed set and
 * the store's listing, and draws what comes back. One search filters both
 * sections.
 */

import type { StorePluginSummary } from '@core/api/client';
import type { PluginEffectDef } from '@core/inspector/pluginEffectDefs';
import type { PluginPanelEntry } from '@core/nativePlugins/pluginContrib';
import type { PluginPreset } from '@core/nativePlugins/pluginPresets';
import { nativePluginStatusLabel, type NativePlugin } from '@core/nativePlugins/nativePlugins';
import { t } from '@core/i18n';

/** How the status word on a plugin row reads: its colour role. */
export type PluginStatusTone = 'ok' | 'dim' | 'danger' | 'warning';

export interface PluginStatusWord {
  text: string;
  tone: PluginStatusTone;
}

/** The one inline button a row offers. */
export type PluginRowAction = 'install' | 'update' | 'enable' | 'uninstall';

export interface InstalledPluginRow {
  kind: 'installed';
  /** The row's own id (`installed:<plugin id>`). */
  id: string;
  plugin: NativePlugin;
  /** The store's listing of it, when the store lists it (installs, icon, description). */
  listing: StorePluginSummary | undefined;
  status: PluginStatusWord;
  action: PluginRowAction | null;
  /** The store's newer version, when there is one and no removal is queued. */
  update: string | undefined;
}

export interface StorePluginRow {
  kind: 'store';
  /** The row's own id (`store:<plugin id>`). */
  id: string;
  listing: StorePluginSummary;
  /** Listed from the signed-in publisher's own private plugins: installs as the owner. */
  owner: boolean;
}

export type PluginSidebarRow = InstalledPluginRow | StorePluginRow;

export interface PluginSidebarInputs {
  plugins: readonly NativePlugin[];
  /** The store's plugins (null: not asked, or unreachable). */
  listings: readonly StorePluginSummary[] | null;
  /** Ids the store listing came from the publisher's own private plugins. */
  owned?: ReadonlySet<string>;
  /** Ids main installed from the store (or a package) — the ones it can uninstall. */
  managed: ReadonlySet<string>;
  /** Available store updates: plugin id → latest version. */
  updates: ReadonlyMap<string, string>;
  /** Plugin ids queued for removal on the next start. */
  uninstalling: ReadonlySet<string>;
  query: string;
}

export interface PluginSidebar {
  installed: InstalledPluginRow[];
  store: StorePluginRow[];
  /** Installed plugins with a store update (the Installed header's "N updates"). */
  updateCount: number;
}

export function installedRowId(plugin: string): string {
  return `installed:${plugin}`;
}

export function storeRowId(plugin: string): string {
  return `store:${plugin}`;
}

/** The plugin id a row is about. */
export function rowPluginId(row: PluginSidebarRow): string {
  return row.kind === 'installed' ? row.plugin.id : row.listing.id;
}

/** Locked plugins, and those whose engine message names it, are Premation Cloud plugins. */
export function isCloudPlugin(p: NativePlugin): boolean {
  return p.status === 'locked' || /premation cloud/i.test(p.error);
}

export function pluginStatusWord(p: NativePlugin, update: string | undefined, uninstalling: boolean): PluginStatusWord {
  if (uninstalling) return { text: t('plugins.list.removedOnRestart', 'Removed on restart'), tone: 'dim' };
  if (update) return { text: t('plugins.rows.update', 'Update {version}', { version: update }), tone: 'warning' };
  switch (p.status) {
    case 'loaded': return { text: t('plugins.rows.loaded', 'Loaded'), tone: 'ok' };
    case 'disabled': return { text: t('plugins.rows.disabled', 'Disabled'), tone: 'dim' };
    // The long form ("Requires Premation Cloud") is on the plugin's page.
    case 'locked': return { text: t('plugins.rows.locked', 'Locked'), tone: 'danger' };
    default: return { text: nativePluginStatusLabel(p.status), tone: 'danger' };
  }
}

/**
 * The inline button of an installed plugin's row: Update when the store has a
 * newer version, Enable when it is switched off, Uninstall when main manages
 * it; nothing for one queued for removal, locked (Check plan is the menu's),
 * or copied into the folder by hand (main cannot remove what it did not put
 * there).
 */
export function installedAction(
  p: NativePlugin,
  opts: { update: string | undefined; managed: boolean; uninstalling: boolean },
): PluginRowAction | null {
  if (opts.uninstalling) return null;
  if (opts.update) return 'update';
  if (p.status === 'disabled') return 'enable';
  if (p.status === 'locked' || p.status === 'revoked') return null;
  return opts.managed ? 'uninstall' : null;
}

const has = (text: string | null | undefined, q: string): boolean => (text ?? '').toLowerCase().includes(q);

function installedHit(p: NativePlugin, listing: StorePluginSummary | undefined, q: string): boolean {
  return !q || has(p.name, q) || has(p.id, q) || has(p.vendor, q) || has(listing?.description, q);
}

function storeHit(s: StorePluginSummary, q: string): boolean {
  return !q || has(s.name, q) || has(s.id, q) || has(s.description, q)
    || has(s.publisher.displayName, q) || has(s.publisher.namespace, q);
}

export function buildPluginSidebar(input: PluginSidebarInputs): PluginSidebar {
  const q = input.query.trim().toLowerCase();
  const byId = new Map((input.listings ?? []).map((s) => [s.id, s]));
  const installed: InstalledPluginRow[] = [];
  let updateCount = 0;
  for (const p of input.plugins) {
    const listing = byId.get(p.id);
    const uninstalling = input.uninstalling.has(p.id);
    const update = uninstalling ? undefined : input.updates.get(p.id);
    if (update) updateCount += 1;
    if (!installedHit(p, listing, q)) continue;
    installed.push({
      kind: 'installed',
      id: installedRowId(p.id),
      plugin: p,
      listing,
      status: pluginStatusWord(p, update, uninstalling),
      action: installedAction(p, { update, managed: input.managed.has(p.id), uninstalling }),
      update,
    });
  }
  // A plugin main installed but the engine has not listed yet (it waits for a
  // restart) is installed too: it never shows as a store row to install again.
  const here = new Set([...input.plugins.map((p) => p.id), ...input.managed]);
  const store: StorePluginRow[] = (input.listings ?? [])
    .filter((s) => !here.has(s.id) && storeHit(s, q))
    .map((s) => ({ kind: 'store', id: storeRowId(s.id), listing: s, owner: input.owned?.has(s.id) ?? false }));
  return { installed, store, updateCount };
}

/** The rows the keyboard walks: the open sections' rows, in order. */
export function visibleRows(sidebar: PluginSidebar, collapsed: { installed: boolean; store: boolean }): PluginSidebarRow[] {
  return [...(collapsed.installed ? [] : sidebar.installed), ...(collapsed.store ? [] : sidebar.store)];
}

/** The meta line under a row: vendor · ↓ installs · and, for a store row, its tier. */
export function rowMeta(row: PluginSidebarRow): string[] {
  const listing = row.kind === 'installed' ? row.listing : row.listing;
  const vendor = row.kind === 'installed'
    ? row.plugin.vendor || listing?.publisher.displayName || ''
    : listing?.publisher.displayName || listing?.publisher.namespace || '';
  const parts: string[] = [];
  if (vendor) parts.push(vendor);
  if (listing && listing.installs > 0) parts.push(`↓ ${formatInstalls(listing.installs)}`);
  return parts;
}

/** 1234 → "1.2K", 1500000 → "1.5M" (the row has no room for the long form; the page has it). */
export function formatInstalls(n: number): string {
  if (n >= 1_000_000) return `${trim1(n / 1_000_000)}M`;
  if (n >= 1_000) return `${trim1(n / 1_000)}K`;
  return String(n);
}

function trim1(v: number): string {
  const s = (Math.floor(v * 10) / 10).toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

// ── A plugin's page: what it brings ──────────────────────────────────────────

export interface PluginPresetRow {
  preset: PluginPreset;
  effectLabel: string;
}

export interface PluginContents {
  effects: PluginEffectDef[];
  presets: PluginPresetRow[];
  panels: PluginPanelEntry[];
}

/** The effects, presets and panels one plugin contributes (its page's Effects / Presets / Panels tabs). */
export function pluginContents(
  pluginId: string,
  all: { effects: readonly PluginEffectDef[]; presets: readonly PluginPreset[]; panels: readonly PluginPanelEntry[] },
): PluginContents {
  const effects = all.effects.filter((d) => d.provider === pluginId);
  const label = new Map(effects.map((d) => [d.type, d.label]));
  const presets = all.presets
    .filter((s) => s.plugin === pluginId)
    .map((preset) => ({ preset, effectLabel: label.get(preset.effect) ?? preset.effect }));
  const panels = all.panels.filter((e) => e.plugin === pluginId);
  return { effects, presets, panels };
}
