/**
 * The rules for installed plugins' dock tabs (owner-approved mockup board 2,
 * 2026-11-03: plugins as their own tabs, like After Effects' Window ▸
 * Extensions). Pure — no React, no store — so each rule is tested on its own
 * (pluginDockRules.test.ts); usePluginPanels.ts and PluginEffectHomePanel.tsx
 * apply them.
 *
 *   • titles: an effect plugin's panel is named by the manifest's `panelTitle`
 *     ("Deep Glow Studio"), else the plugin; a tool panel by its own name, and
 *     in a menu that lists every plugin's panels, "<Plugin>: <Panel>";
 *   • docking: the first time this machine sees a plugin panel it is docked;
 *     after that the user's layout decides (a closed tab stays closed);
 *   • absence: a plugin that stops contributing a panel (uninstalled,
 *     disabled, failed, locked) leaves the dock only once the plugin list has
 *     SETTLED — the engine said so twice, a moment apart, or listed the plugin
 *     as not loaded. A restarting engine's empty first answer never costs the
 *     user a tab;
 *   • pins: an effect panel either follows the selection or stays on one
 *     layer's effect; a pin whose layer or effect is gone is dropped.
 */

import type { PluginInfo } from '@motion/engine-api';
import type { PluginPanelEntry } from '@core/nativePlugins/pluginContrib';
import type { PluginPanelPin } from '@stores/pluginPanelPinStore';

// ── Titles ──────────────────────────────────────────────────────────────

/** Does `text` already name the plugin ("Deep Glow Studio" names "Deep Glow")? Case-insensitive. */
function names(text: string, plugin: string): boolean {
  return plugin.trim() !== '' && text.toLocaleLowerCase().includes(plugin.trim().toLocaleLowerCase());
}

/**
 * The tab title. Effect panel: the manifest's `panelTitle`, prefixed with the
 * plugin's name unless it already carries it ("Studio" → "Deep Glow Studio"),
 * else the plugin's name. Tool panel: the panel's own name.
 */
export function pluginPanelTitle(entry: PluginPanelEntry, info?: Pick<PluginInfo, 'panelTitle'>): string {
  if (entry.kind === 'tool') return entry.panel.name || entry.pluginName;
  const panelTitle = info?.panelTitle?.trim();
  if (!panelTitle) return entry.pluginName;
  return names(panelTitle, entry.pluginName) ? panelTitle : `${entry.pluginName} ${panelTitle}`;
}

/**
 * The row in a menu listing every plugin's panels (the dock's "+", Open
 * Panel): a tool panel says whose it is — "Atelier: Palettes" — unless its
 * name already does.
 */
export function pluginPanelMenuTitle(entry: PluginPanelEntry, info?: Pick<PluginInfo, 'panelTitle'>): string {
  const title = pluginPanelTitle(entry, info);
  if (entry.kind === 'effect' || names(title, entry.pluginName)) return title;
  return `${entry.pluginName}: ${title}`;
}

// ── Docking on registration ─────────────────────────────────────────────

/**
 * What to do with a plugin panel being registered (registerPanel always docks):
 * keep it docked when the saved layout already had it there (its place is
 * kept) or when this machine has never seen it (docked by default); close it
 * when it was seen before and is not in the layout — the user closed it, or a
 * workspace without it was applied.
 */
export function dockOnRegister(opts: { inLayout: boolean; seen: boolean }): 'keep' | 'close' {
  return opts.inLayout || !opts.seen ? 'keep' : 'close';
}

// ── Absence: act only on a settled plugin list ──────────────────────────

/** A plugin panel seen missing: in which engine answer (contrib revision) and when (ms). */
export interface Absence {
  readonly revision: number;
  readonly at: number;
}

/** How far apart two answers that agree a panel is gone must be. */
export const ABSENCE_CONFIRM_MS = 1200;

export interface AbsenceStep {
  /** The panels still waiting for a second answer (feed back in next time). */
  readonly pending: ReadonlyMap<string, Absence>;
  /** The panels whose absence is settled: take them out of the dock. */
  readonly remove: readonly string[];
}

/**
 * One engine answer's worth of the absence rule.
 *
 * `missing` are the registered plugin panels this answer does not contribute;
 * `definitive` those whose plugin the answer LISTS but not as loaded (disabled,
 * failed, locked) — the engine scanned it, so that is settled at once. Any
 * other absence is settled by a LATER answer (higher revision) at least
 * `ABSENCE_CONFIRM_MS` after the first: a plugin list that was briefly empty
 * while the engine restarted comes back in between and nothing moves. A panel
 * no longer missing leaves `pending`.
 */
export function settleAbsences(
  pending: ReadonlyMap<string, Absence>,
  missing: ReadonlySet<string>,
  definitive: ReadonlySet<string>,
  revision: number,
  now: number,
  confirmMs: number = ABSENCE_CONFIRM_MS,
): AbsenceStep {
  const next = new Map<string, Absence>();
  const remove: string[] = [];
  for (const id of missing) {
    if (definitive.has(id)) {
      remove.push(id);
      continue;
    }
    const seen = pending.get(id);
    if (seen && revision > seen.revision && now - seen.at >= confirmMs) remove.push(id);
    else next.set(id, seen ?? { revision, at: now });
  }
  return { pending: next, remove };
}

// ── Pins: follow the selection, or stay on one effect ───────────────────

/** An effect panel pinned to one effect instance on one layer (editor state, never the document). */
export type { PluginPanelPin };

/**
 * Where a pin stands:
 *   • `none`    no pin — the panel follows the selection;
 *   • `active`  the pinned layer and effect are there — the panel shows them;
 *   • `pending` the document or the layer's effects are still loading — follow
 *               the selection meanwhile, keep the pin;
 *   • `stale`   the layer or the effect is gone — drop the pin (back to following).
 */
export function pinStatus(opts: {
  pin: PluginPanelPin | undefined;
  /** The document mirror has a document (status `ready`). */
  docReady: boolean;
  /** The pinned layer is in the document. */
  layerExists: boolean;
  /** The pinned layer's effects are loaded (its property tree, without holes). */
  effectsLoaded: boolean;
  /** The pinned effect is among them (and still this plugin's). */
  effectExists: boolean;
}): 'none' | 'active' | 'pending' | 'stale' {
  const { pin, docReady, layerExists, effectsLoaded, effectExists } = opts;
  if (!pin) return 'none';
  if (layerExists && effectExists) return 'active';
  if (!docReady) return 'pending';
  if (!layerExists) return 'stale';
  return effectsLoaded ? 'stale' : 'pending';
}
