/**
 * Where each plugin panel actually goes — the host's half of the bargain.
 *
 * A manifest states an intent (`contributes.panels[].placement`); it does not
 * get to act on it. This module is the arbiter, and it exists because the two
 * failure modes of just obeying the manifest are both bad and both certain:
 *
 *  • **The rail is finite.** Left holds Scene, Assets, Library, Plugins, AI;
 *    right holds Properties, Rigging, Effects, Graph, Presets. Ten installed
 *    plugins each asking for a tab does not produce a busy rail, it produces a
 *    rail where the app's own panels have scrolled out of reach. So there is a
 *    budget, and past it a panel is DEMOTED to the shared host rather than
 *    refused — it still opens, it just does not own a glyph.
 *  • **Silence is the worst outcome.** A demoted panel that says nothing reads
 *    as a broken plugin. `panelPlacements()` reports what happened for every
 *    panel, and `PluginsList` prints it on the plugin's row.
 *
 * The allocation is INSTALL ORDER, not name order, and that is deliberate: it
 * is stable across launches and across renames, so a plugin does not lose its
 * spot because another one was installed or retitled. Plugins in `error` are
 * allocated last — a broken plugin should not hold a slot a working one wants.
 */

import type { IconName } from '@components/Icon';
import type { PanelDef } from '@layout/EditorLayout/panelDefs';
import type { PluginPanelContribution, PluginPanelPlacement } from '@core/plugins/manifest';
import type { RegionId } from '@stores/layoutStore';
import { usePluginStore } from '@stores/pluginStore';
import pluginHost from '@core/plugins/PluginHost';

/**
 * How many rail tabs each region will hand out to plugins.
 *
 * Small on purpose, and not configurable: this is a budget for the editor's
 * own legibility, not a user preference. Someone who wants eleven plugin
 * panels on screen at once wants a different application.
 */
export const RAIL_SLOTS: Readonly<Record<'sidebar' | 'inspector', number>> = {
  sidebar: 3,
  inspector: 2,
};

/** Which dock each non-shared placement means. */
const PLACEMENT_REGION: Readonly<Record<'sidebar' | 'inspector', RegionId>> = {
  sidebar: 'leftSidebar',
  inspector: 'rightInspector',
};

/**
 * Rail weight for plugin tabs — below every built-in.
 *
 * The lowest built-ins are `project` (3) on the left and `plugins` (0.6) on the
 * right, so these sit after the app's own panels in both. Within the plugin
 * block, later allocations get a smaller weight so rail order matches
 * allocation order rather than being decided by a tie.
 */
const BASE_WEIGHT: Readonly<Record<'sidebar' | 'inspector', number>> = {
  sidebar: 2.5,
  inspector: 0.5,
};

/**
 * The dock-panel id for a plugin panel that owns a tab.
 *
 * Namespaced, so a plugin declaring a panel called `scene` cannot register
 * itself over the Scene panel. Plugin ids are reverse-DNS (dots, never colons)
 * and panel ids are `[a-z0-9-]`, so splitting on `:` is unambiguous.
 */
export function dedicatedPanelId(pluginId: string, panelId: string): string {
  return `plugin:${pluginId}:${panelId}`;
}

/** The inverse. Returns null for any id that is not a plugin panel's. */
export function parseDedicatedPanelId(id: string): { pluginId: string; panelId: string } | null {
  const parts = id.split(':');
  if (parts.length !== 3 || parts[0] !== 'plugin') return null;
  const [, pluginId, panelId] = parts;
  if (!pluginId || !panelId) return null;
  return { pluginId, panelId };
}

/** Where one declared panel ended up, and why. */
export interface PanelPlacementReport {
  pluginId: string;
  panel: PluginPanelContribution;
  /** What the manifest asked for. */
  requested: PluginPanelPlacement;
  /** What it got. Differs from `requested` only when the rail was full. */
  granted: PluginPanelPlacement;
  /** Set when `granted` is `shared` but `requested` was not. */
  demoted: boolean;
}

/**
 * Every panel of every installed, ENABLED plugin, with its granted placement.
 *
 * Enabled — not running. That distinction is the whole point of `onPanel:<id>`
 * as an activation event: a lazily-activated plugin's panel has to be visible
 * before it starts, or the only thing that can start it is the one event that
 * requires it to already be started. Selecting the tab is what activates it.
 *
 * A disabled plugin contributes nothing here, which is what makes the Plugins
 * panel's toggle the way to clear a tab off the rail.
 */
export function panelPlacements(): PanelPlacementReport[] {
  const entries = usePluginStore.getState().plugins.filter((p) => p.enabled);

  // Working plugins are served first, so a plugin that fails to boot cannot sit
  // on a slot that a plugin which actually runs is asking for. Stable within
  // each group: `sort` on a boolean key preserves install order among equals.
  const ordered = [...entries].sort(
    (a, b) =>
      Number(pluginHost.info(a.manifest.id).status === 'error') -
      Number(pluginHost.info(b.manifest.id).status === 'error'),
  );

  const used: Record<'sidebar' | 'inspector', number> = { sidebar: 0, inspector: 0 };
  const out: PanelPlacementReport[] = [];

  for (const entry of ordered) {
    for (const panel of entry.manifest.contributes.panels) {
      const requested = panel.placement;
      let granted: PluginPanelPlacement = 'shared';

      if (requested !== 'shared' && used[requested] < RAIL_SLOTS[requested]) {
        used[requested] += 1;
        granted = requested;
      }

      out.push({
        pluginId: entry.manifest.id,
        panel,
        requested,
        granted,
        demoted: requested !== 'shared' && granted === 'shared',
      });
    }
  }

  return out;
}

/** Just the ones that got a rail tab. */
export function dedicatedPlacements(): PanelPlacementReport[] {
  return panelPlacements().filter((p) => p.granted !== 'shared');
}

/** Just the ones that live as tabs inside the shared host. */
export function sharedPlacements(): PanelPlacementReport[] {
  return panelPlacements().filter((p) => p.granted === 'shared');
}

/**
 * `PanelDef`s for the plugin panels that own a tab, for `registerPanel` and for
 * everything that resolves a panel's title and icon by id — including a pop-out
 * window, which never runs the registration effect.
 *
 * `closable: false` on every one of them, and that is not an oversight. A plugin
 * panel is not a document the user opened; it is a place the plugin lives for as
 * long as it is installed and on. An ✕ here would offer to "close" something
 * whose only route back is a menu the user would have to know about — while the
 * honest control, the one that also stops the worker, is the toggle on the
 * plugin's own row in the Plugins panel.
 */
export function pluginPanelDefs(): PanelDef[] {
  const perRegion: Record<'sidebar' | 'inspector', number> = { sidebar: 0, inspector: 0 };

  return dedicatedPlacements().map((p) => {
    const kind = p.granted as 'sidebar' | 'inspector';
    const nth = perRegion[kind]++;
    return {
      id: dedicatedPanelId(p.pluginId, p.panel.id),
      title: p.panel.title,
      // Validated at parse time for exactly this placement, so the fallback is
      // unreachable for a panel that got here — it is here for the type, and for
      // a package that predates the check.
      icon: (p.panel.icon ?? 'plugin') as IconName,
      region: PLACEMENT_REGION[kind],
      weight: BASE_WEIGHT[kind] - nth * 0.01,
      closable: false,
    };
  });
}

/** Look up one plugin panel's def by dock-panel id. */
export function pluginPanelDef(id: string): PanelDef | undefined {
  if (!parseDedicatedPanelId(id)) return undefined;
  return pluginPanelDefs().find((d) => d.id === id);
}
