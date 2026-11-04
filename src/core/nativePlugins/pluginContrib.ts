/**
 * P7 — what native plugins contribute besides effects (docs/PLUGIN_SDK.md
 * "Commands", "Importers", "Output modules", "Panels"): AE's AEGP menu
 * commands, AEIO footage formats, output-module formats and effect-less
 * panels. All of it is the engine's own answer to `listPlugins`
 * (PluginInfo.commands / importers / outputModules / panels), cached here with
 * listeners so the menu bar, the command palette, the import dialog, the
 * Render Queue's format list and the panel registry all read one list and
 * follow an install, a rescan or enable / disable.
 *
 * A disabled (failed, quarantined, locked…) plugin contributes nothing: its
 * commands are hidden, its formats and panels gone.
 *
 * Pure registry with listeners: no React, no zustand (src/core). React reads
 * it through `usePluginContrib` (src/hooks).
 */

import type {
  EngineClient,
  PluginCommandInfo,
  PluginInfo,
  PluginLayerTypeInfo,
  PluginOutputModuleInfo,
  PluginPanelInfo,
} from '@motion/engine-api';

/** A plugin output module as an export format id: `plugin:<plugin id>/<module id>`. */
export type PluginFormatId = `plugin:${string}`;

export interface PluginOutputFormat {
  readonly id: PluginFormatId;
  readonly plugin: string;
  readonly pluginName: string;
  readonly module: PluginOutputModuleInfo;
}

export interface PluginPanelEntry {
  /** The dock panel id: `plugin:<plugin id>/<panel id>`, or `plugin:<plugin id>` for an effect plugin's own panel. */
  readonly panelId: string;
  readonly plugin: string;
  readonly pluginName: string;
  readonly panel: PluginPanelInfo;
  /**
   * `tool`: a manifest `panels` entry (no effect behind it, the tool-panel
   * protocol). `effect`: the bundle's effect page (`ui/index.html`,
   * PluginInfo.panel), docked as the plugin's own sidebar panel and bound to
   * the selected layer's instance of the plugin's effect (the effect-panel
   * protocol) — Element 3D's Scene Setup with a home of its own instead of a
   * frame inside the effect card.
   */
  readonly kind: 'tool' | 'effect';
}

let plugins: readonly PluginInfo[] = [];
let revision = 0;
const listeners = new Set<() => void>();

export function setPluginContrib(list: readonly PluginInfo[]): void {
  plugins = list;
  revision += 1;
  for (const l of listeners) l();
}

/** Bumps on every change (the native menu's memo key). */
export function pluginContribRevision(): number {
  return revision;
}

export function subscribePluginContrib(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const loaded = (p: PluginInfo) => p.status === 'loaded';

/** Every command a LOADED plugin offers that has not crashed this session, in load order. */
export function pluginCommands(): readonly PluginCommandInfo[] {
  return plugins.filter(loaded).flatMap((p) => (p.commands ?? []).filter((c) => c.enabled));
}

/** Whether the engine has any plugin loaded (the Plugins tab docks itself the first time). */
export function hasLoadedPlugins(): boolean {
  return plugins.some(loaded);
}

/**
 * Every plugin the engine listed, loaded or not — the Plugins sidebar and a
 * plugin's page read this one list, so an install, rescan or enable / disable
 * made from either shows in both.
 */
export function pluginInfos(): readonly PluginInfo[] {
  return plugins;
}

/** The plugin's display name. */
export function pluginName(id: string): string {
  return plugins.find((p) => p.id === id)?.name || id;
}

/** The engine's record of a plugin, loaded or not (undefined when the engine does not list it). */
export function pluginInfo(id: string): PluginInfo | undefined {
  return plugins.find((p) => p.id === id);
}

/**
 * The plugin the engine lists for an effect type, loaded or not (locked,
 * disabled, failed): by its effects' match names, else by the id the match
 * name starts with (`<id>` or `<id>.<name>`). Undefined when no plugin claims it.
 */
export function pluginForEffect(type: string): PluginInfo | undefined {
  return plugins.find((p) => p.effects.includes(type))
    ?? plugins.find((p) => type === p.id || type.startsWith(`${p.id}.`));
}

export function pluginFormatId(plugin: string, module: string): PluginFormatId {
  return `plugin:${plugin}/${module}`;
}

export function isPluginFormat(format: string): format is PluginFormatId {
  return format.startsWith('plugin:') && format.indexOf('/') > 7;
}

/** The output modules of loaded plugins, as export formats. */
export function pluginOutputFormats(): readonly PluginOutputFormat[] {
  return plugins.filter(loaded).flatMap((p) =>
    (p.outputModules ?? []).map((m) => ({ id: pluginFormatId(p.id, m.id), plugin: p.id, pluginName: p.name || p.id, module: m })),
  );
}

export function pluginOutputFormat(id: string): PluginOutputFormat | undefined {
  return pluginOutputFormats().find((f) => f.id === id);
}

/** File extensions (lower case, no dot) loaded plugins import. */
export function pluginImportExtensions(): readonly string[] {
  const out = new Set<string>();
  for (const p of plugins.filter(loaded)) for (const i of p.importers ?? []) for (const e of i.extensions) out.add(e);
  return [...out];
}

export function pluginPanelId(plugin: string, panel: string): string {
  return `plugin:${plugin}/${panel}`;
}

/** An effect plugin's own panel: `plugin:<plugin id>` (no `/`, so it never meets a manifest panel id). */
export function pluginEffectPanelId(plugin: string): string {
  return `plugin:${plugin}`;
}

/**
 * The dockable panels of loaded plugins: each effect plugin's own panel (when
 * the bundle ships a page) first, then its manifest panels.
 */
export function pluginPanels(): readonly PluginPanelEntry[] {
  return plugins.filter(loaded).flatMap((p) => {
    const pluginName = p.name || p.id;
    const own: PluginPanelEntry[] = p.panel && p.effects.length > 0
      ? [{ panelId: pluginEffectPanelId(p.id), plugin: p.id, pluginName, panel: { id: '', name: pluginName, page: 'index.html' }, kind: 'effect' }]
      : [];
    return [
      ...own,
      ...(p.panels ?? []).map((panel): PluginPanelEntry => ({ panelId: pluginPanelId(p.id, panel.id), plugin: p.id, pluginName, panel, kind: 'tool' })),
    ];
  });
}

export function pluginPanel(panelId: string): PluginPanelEntry | undefined {
  return pluginPanels().find((p) => p.panelId === panelId);
}

/** Option values with every declared default filled in (what BEGIN receives; the engine clamps again). */
export function defaultOutputOptions(module: PluginOutputModuleInfo): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {};
  for (const o of module.options) out[o.id] = o.type === 'checkbox' ? o.defaultValue !== 0 : o.defaultValue;
  return out;
}

/** Ask the engine again (start, an install, a rescan, enable / disable). Never throws. */
export async function refreshPluginContrib(client: Pick<EngineClient, 'query'>): Promise<void> {
  try {
    const res = await client.query({ type: 'listPlugins' });
    if (res.ok) setPluginContrib(res.value.plugins);
  } catch {
    // The engine is restarting: the next refresh fills it in.
  }
}

/** What the user has when they run a command: the active composition, the selection (top first), the playhead. */
export interface PluginCommandTarget {
  comp?: string;
  layers?: readonly string[];
  /** Composition time, flicks. */
  time?: number;
  args?: Record<string, unknown>;
}

export type PluginCommandOutcome = { ok: true; message: string; edits: number } | { ok: false; error: string };

/**
 * runPluginCommand with origin `plugin`: the plugin runs in the engine (crash-guarded, under
 * the watchdog); its edits are ONE undo entry. A plain execute (never a batch): the engine
 * logs the plugin's edits in place of the command. Never throws.
 */
export async function runPluginCommand(
  client: Pick<EngineClient, 'execute'>,
  plugin: string,
  command: string,
  target: PluginCommandTarget = {},
): Promise<PluginCommandOutcome> {
  try {
    const res = await client.execute(
      {
        type: 'runPluginCommand',
        plugin,
        command,
        layers: [...(target.layers ?? [])],
        ...(target.comp ? { comp: target.comp } : {}),
        ...(target.time !== undefined ? { time: Math.round(target.time) } : {}),
        ...(target.args ? { args: JSON.stringify(target.args) } : {}),
      },
      { origin: 'plugin' },
    );
    if (!res.ok) return { ok: false, error: res.error.message || 'The command failed.' };
    return { ok: true, message: res.value.message, edits: res.value.edits };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'The command failed.' };
  }
}

/** SDK 1.4: every layer type a loaded plugin offers (Layer ▸ New), with its plugin's id, in load order. */
export function pluginLayerTypes(): readonly (PluginLayerTypeInfo & { plugin: string })[] {
  return plugins.filter(loaded).flatMap((p) => (p.layerTypes ?? []).map((lt) => ({ ...lt, plugin: p.id })));
}

/**
 * SDK 1.4 (E2): every keyframe interpolator a loaded plugin offers, "<pluginId>:<name>", with a
 * label ("<name> (<plugin name>)") for the keyframe menu's Plugin Interpolator submenu.
 */
export function pluginInterpolators(): readonly { id: string; label: string }[] {
  return plugins
    .filter(loaded)
    .flatMap((p) => (p.interpolators ?? []).map((id) => ({ id, label: `${id.slice(id.lastIndexOf(':') + 1)} (${p.name})` })));
}

/** SDK 1.4 (U): a viewer tool a loaded plugin offers — its drags run `command` with the stroke. */
export interface PluginTool {
  /** "<pluginId>:<toolId>" */
  id: string;
  plugin: string;
  tool: string;
  name: string;
  command: string;
  /** The manifest's default shortcut ("Shift+S"; "" = none). */
  shortcut: string;
}

/** SDK 1.4 (U): every viewer tool of the loaded plugins, in load order. */
export function pluginTools(): readonly PluginTool[] {
  return plugins.filter(loaded).flatMap((p) =>
    (p.tools ?? []).map((tl) => ({
      id: tl.id,
      plugin: p.id,
      tool: tl.id.slice(tl.id.lastIndexOf(':') + 1),
      name: tl.name,
      command: tl.command,
      shortcut: tl.shortcut,
    })),
  );
}

/** SDK 1.4 (A): a CLAP audio effect a loaded plugin offers, as the Audio Effects list shows it. */
export interface PluginAudioEffect {
  /** The layer audio effect's type: `clap:<descriptor id>`. */
  type: `clap:${string}`;
  label: string;
  params: ReadonlyArray<{ key: string; label: string; min: number; max: number; default: number }>;
}

/** SDK 1.4 (A): every CLAP audio effect of the loaded plugins. */
export function pluginAudioEffects(): readonly PluginAudioEffect[] {
  return plugins.filter(loaded).flatMap((p) =>
    (p.audio ?? []).map((a) => ({
      type: `clap:${a.id}` as const,
      label: a.name,
      params: a.params.map((q) => ({ key: `p${q.id}`, label: q.name, min: q.min, max: q.max, default: q.default })),
    })),
  );
}

export type PluginLayerOutcome = { ok: true; layer: string } | { ok: false; error: string };

/**
 * createLayer kind=generator: a layer the plugin draws — a solid of the comp's size carrying the
 * type's generator as its effect `layer`, whose params are the layer's own properties. One undo
 * entry. Never throws.
 */
export async function createPluginLayer(client: Pick<EngineClient, 'execute'>, comp: string, type: string): Promise<PluginLayerOutcome> {
  try {
    const res = await client.execute({ type: 'createLayer', comp, kind: 'generator', generator: type, init: [] });
    if (!res.ok) return { ok: false, error: res.error.message || 'The layer was not created.' };
    return { ok: true, layer: res.value.layer };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'The layer was not created.' };
  }
}

/** Test seam. */
export function resetPluginContribForTest(): void {
  plugins = [];
  revision = 0;
  listeners.clear();
}
